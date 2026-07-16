import { collection, query, orderBy, limit, startAfter, getDocs } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-firestore.js";
import { showToast } from './toast.js';
import { confirmDialog } from './confirm.js';
import { setButtonLoading, getSkeletonTableHTML } from './loading-components.js';

let firestoreDb = null;
let authInstance = null;

async function apiRequest(path, options = {}) {
  const token = authInstance && authInstance.currentUser ? await authInstance.currentUser.getIdToken() : null;
  const res = await fetch(`${window.VELYNC_CONFIG.apiBase}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const CLIENTERR_PAGE_SIZE = 50;
// Cap on automatic "keep fetching until something matches the filter"
// pages per reset cycle (see loadClientErrors) — bounds Firestore reads
// if a filter genuinely never matches anything in the collection.
const MAX_AUTO_CONTINUE_PAGES = 10;

let clientErrLastVisible = null;
let clientErrHasMore = false;
let clientErrLoading = false;
let clientErrFilters = { status: 'open', search: '' };
let clientErrSearchTimer = null;

// All fetched docs accumulate here (id -> normalized record), across pages
// within one reset cycle. Rendering/grouping/export/details all read from
// this instead of the DOM, since the table only shows a subset of fields.
let clientErrDocsById = new Map();
let clientErrSelectedIds = new Set();
let clientErrExpandedGroups = new Set();
let clientErrPendingReload = null;
let clientErrAutoContinueCount = 0;

const STATUS_BADGE = { open: 'badge-warning', resolved: 'badge-info', closed: 'badge-success' };
const STATUS_LABEL = { open: 'Open', resolved: 'Resolved', closed: 'Closed' };

// Action buttons per current status — matches the review workflow: Claude
// marks an error Resolved after shipping a fix, the user verifies it and
// either Closes it (confirmed fixed) or Reopens it (fix didn't hold).
function actionsFor(status) {
  if (status === 'open') return [{ to: 'resolved', label: 'Mark Resolved' }];
  if (status === 'resolved') return [{ to: 'closed', label: 'Close' }, { to: 'open', label: 'Reopen' }];
  return [{ to: 'open', label: 'Reopen' }]; // closed
}

function timeAgo(date) {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escAttr(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Same embedded-timestamp pattern app.js's console.error dedupe strips
// before hashing — several real error sources (e.g. the Firebase AppCheck
// ReCAPTCHA warning) prefix the message with a live `[2026-...Z]` stamp,
// which would otherwise make every occurrence fingerprint as unique.
const ISO_TIMESTAMP_RE = /\[?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\]?\s*/g;

// Normalizes a message + URL into a fingerprint so that the same
// underlying error reported many times (different uids, timestamps, or
// dynamic path segments) collapses into one group. Strips ISO timestamps,
// UUIDs, and long numeric runs from the message, and reduces the URL to
// its path (no query string/hash, which often carries per-request noise).
function fingerprintOf(d) {
  const msg = (d.message || '')
    .replace(ISO_TIMESTAMP_RE, '')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
    .replace(/\b\d{4,}\b/g, '<n>')
    .trim();
  let path = d.url || '';
  try { path = new URL(d.url, window.location.origin).pathname; } catch { /* keep raw url */ }
  return `${msg}::${path}`;
}

function buildGroups(docs) {
  const map = new Map();
  for (const d of docs) {
    const fp = fingerprintOf(d);
    if (!map.has(fp)) map.set(fp, { fp, instances: [] });
    map.get(fp).instances.push(d);
  }
  const groups = Array.from(map.values()).map(g => {
    g.instances.sort((a, b) => b.createdAt - a.createdAt);
    g.latest = g.instances[0];
    g.oldest = g.instances[g.instances.length - 1];
    g.count = g.instances.length;
    g.status = g.latest.status;
    g.uids = Array.from(new Set(g.instances.map(i => i.uid).filter(Boolean)));
    return g;
  });
  groups.sort((a, b) => b.latest.createdAt - a.latest.createdAt);
  return groups;
}

function getFilteredDocs() {
  const searchLower = clientErrFilters.search.toLowerCase();
  return Array.from(clientErrDocsById.values()).filter(d => {
    if (clientErrFilters.status && clientErrFilters.status !== d.status) return false;
    if (searchLower) {
      const haystack = `${d.message} ${d.url} ${d.uid || ''} ${d.workspaceId || ''}`.toLowerCase();
      if (!haystack.includes(searchLower)) return false;
    }
    return true;
  });
}

function emptyStateRowHtml() {
  const hasActiveFilter = clientErrFilters.status !== 'open' || clientErrFilters.search;
  return `
    <tr class="table-empty-row">
      <td colspan="7">
        <div style="padding: 32px 16px; text-align: center;">
          <div style="margin-bottom: 12px;">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="color: var(--violet);"><path d="M12 9v4M12 17h.01M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path></svg>
          </div>
          <h3 style="margin-bottom: 6px; color: var(--text-1);">${hasActiveFilter ? 'No matching errors' : 'No client errors reported'}</h3>
          <p style="color: var(--text-3); font-size: 0.88rem; margin-bottom: 0;">
            ${hasActiveFilter
              ? 'No errors match the current filters. Try a different status or search term.'
              : 'Uncaught exceptions and failed API calls from users’ browsers will show up here automatically.'}
          </p>
        </div>
      </td>
    </tr>`;
}

function actionButtonsHtml(status) {
  return actionsFor(status)
    .map(a => `<button class="btn btn-secondary btn-sm clienterr-status-btn" data-status="${escAttr(a.to)}" style="padding:4px 8px;font-size:12px;">${escHtml(a.label)}</button>`)
    .join(' ');
}

function groupRowHtml(g) {
  const d = g.latest;
  const caret = g.count > 1
    ? `<button class="clienterr-expand-btn${clientErrExpandedGroups.has(g.fp) ? ' expanded' : ''}" data-fp="${escAttr(g.fp)}" title="Show all ${g.count} occurrences">▶</button>`
    : '';
  const countBadge = g.count > 1 ? `<span class="clienterr-count-badge" title="${g.count} occurrences of this error">×${g.count}</span>` : '';
  return `
    <tr data-fp="${escAttr(g.fp)}" data-group-row="1" data-latest-id="${escAttr(d.id)}">
      <td><input type="checkbox" class="clienterr-group-checkbox" data-fp="${escAttr(g.fp)}"></td>
      <td data-label="Occurred" style="font-size:0.82rem;color:var(--text-2);white-space:nowrap;" title="${escHtml(d.createdAt.toLocaleString())}">${escHtml(timeAgo(d.createdAt))}</td>
      <td data-label="Message" style="font-size:0.85rem;max-width:340px;word-break:break-word;">${caret}${escHtml(d.message)} ${countBadge}</td>
      <td data-label="URL" style="font-size:0.78rem;color:var(--text-3);max-width:220px;word-break:break-all;">${escHtml(d.url)}</td>
      <td data-label="User" style="font-size:0.78rem;color:var(--text-3);">${g.uids.length > 1 ? `${g.uids.length} users` : escHtml(d.uid || '—')}</td>
      <td data-label="Status"><span class="badge ${STATUS_BADGE[g.status]}">${STATUS_LABEL[g.status]}</span></td>
      <td data-label="Actions" style="white-space:nowrap;">
        ${actionButtonsHtml(g.status)}
        <button class="btn btn-secondary btn-sm clienterr-details-btn" style="padding:4px 8px;font-size:12px;">Details</button>
        <button class="btn btn-secondary btn-sm clienterr-delete-group-btn" style="padding:4px 8px;font-size:12px;color:var(--rose);">Delete</button>
      </td>
    </tr>`;
}

function childRowHtml(d, fp) {
  // Mirrors the parent group row's 7 columns (checkbox/Occurred/Message/
  // URL/User/Status/Actions) so cells stay aligned; Message/URL/Status are
  // identical to the parent (same fingerprint) so they're left blank here.
  return `
    <tr class="clienterr-child-row" data-parent-fp="${escAttr(fp)}" data-id="${escAttr(d.id)}" style="display:${clientErrExpandedGroups.has(fp) ? 'table-row' : 'none'};">
      <td><input type="checkbox" class="clienterr-child-checkbox" data-id="${escAttr(d.id)}" data-fp="${escAttr(fp)}"></td>
      <td style="font-size:0.8rem;white-space:nowrap;" title="${escHtml(d.createdAt.toLocaleString())}">${escHtml(timeAgo(d.createdAt))}</td>
      <td></td>
      <td></td>
      <td style="font-size:0.78rem;">${escHtml(d.uid || 'anonymous')}</td>
      <td></td>
      <td style="white-space:nowrap;">
        <button class="btn btn-secondary btn-sm clienterr-details-child-btn" data-id="${escAttr(d.id)}" style="padding:3px 7px;font-size:11px;">Details</button>
        <button class="btn btn-secondary btn-sm clienterr-delete-child-btn" data-id="${escAttr(d.id)}" style="padding:3px 7px;font-size:11px;color:var(--rose);">Delete</button>
      </td>
    </tr>`;
}

function updateSelectionUI() {
  const bulkBtn = document.getElementById('admin-clienterr-bulk-delete-btn');
  if (bulkBtn) {
    bulkBtn.style.display = clientErrSelectedIds.size > 0 ? 'inline-block' : 'none';
    if (clientErrSelectedIds.size > 0) bulkBtn.textContent = `Delete Selected (${clientErrSelectedIds.size})`;
  }
  // Sync each group row's checkbox to reflect its children's selection state.
  document.querySelectorAll('.clienterr-group-checkbox').forEach(cb => {
    const fp = cb.dataset.fp;
    const ids = Array.from(document.querySelectorAll(`[data-parent-fp="${CSS.escape(fp)}"] .clienterr-child-checkbox`)).map(c => c.dataset.id);
    const groupRow = cb.closest('tr');
    const latestId = groupRow?.dataset.latestId;
    if (latestId) ids.push(latestId);
    const checkedCount = ids.filter(id => clientErrSelectedIds.has(id)).length;
    cb.checked = ids.length > 0 && checkedCount === ids.length;
    cb.indeterminate = checkedCount > 0 && checkedCount < ids.length;
  });
  const selectAll = document.getElementById('admin-clienterr-select-all');
  if (selectAll) {
    const total = getFilteredDocs().length;
    selectAll.checked = total > 0 && clientErrSelectedIds.size === total;
    selectAll.indeterminate = clientErrSelectedIds.size > 0 && clientErrSelectedIds.size < total;
  }
}

function renderClientErrTable() {
  const tbody = document.getElementById('admin-clienterr-tbody');
  if (!tbody) return;

  const filtered = getFilteredDocs();
  const groups = buildGroups(filtered);

  if (groups.length === 0) {
    tbody.innerHTML = emptyStateRowHtml();
  } else {
    tbody.innerHTML = groups.map(g => {
      const row = groupRowHtml(g).replace('data-group-row="1"', `data-group-row="1" data-latest-id="${escAttr(g.latest.id)}"`);
      const children = g.instances.slice(1).map(inst => childRowHtml(inst, g.fp)).join('');
      return row + children;
    }).join('');
  }

  const loadMoreWrap = document.getElementById('admin-clienterr-load-more-wrap');
  if (loadMoreWrap) loadMoreWrap.style.display = clientErrHasMore ? 'block' : 'none';

  updateSelectionUI();
}

async function loadClientErrors(reset = false) {
  if (clientErrLoading) {
    // A load is already in flight (e.g. the reset triggered by a status
    // change). Remember that a newer request came in so it's replayed
    // once the current one finishes, instead of silently being dropped —
    // that drop was why switching filters right after an action looked
    // like it "didn't refresh" until Load More was clicked.
    clientErrPendingReload = { reset: clientErrPendingReload?.reset || reset };
    return;
  }

  const tbody = document.getElementById('admin-clienterr-tbody');
  if (!tbody) return;

  clientErrFilters.status = document.getElementById('admin-clienterr-filter-status')?.value ?? 'open';
  clientErrFilters.search = document.getElementById('admin-clienterr-search')?.value?.trim() || '';

  clientErrLoading = true;

  if (reset) {
    clientErrLastVisible = null;
    clientErrHasMore = false;
    clientErrDocsById.clear();
    clientErrSelectedIds.clear();
    clientErrExpandedGroups.clear();
    clientErrAutoContinueCount = 0;
    tbody.innerHTML = getSkeletonTableHTML(7, 4);
  }

  try {
    const constraints = [orderBy('createdAt', 'desc'), limit(CLIENTERR_PAGE_SIZE)];
    if (clientErrLastVisible) constraints.push(startAfter(clientErrLastVisible));

    const q = query(collection(firestoreDb, 'client_errors'), ...constraints);
    const snap = await getDocs(q);

    snap.forEach(docSnap => {
      const d = docSnap.data();
      // status was added after this collection launched with a boolean
      // `resolved` field — no real data exists on that old schema (verified
      // before this migration), but fall back defensively just in case.
      const status = d.status || (d.resolved ? 'closed' : 'open');
      clientErrDocsById.set(docSnap.id, {
        id: docSnap.id,
        message: d.message || '',
        stack: d.stack || '',
        url: d.url || '',
        userAgent: d.userAgent || '',
        uid: d.uid || null,
        workspaceId: d.workspaceId || null,
        status,
        createdAt: d.createdAt?.toDate?.() || new Date(),
      });
    });

    clientErrLastVisible = snap.docs[snap.docs.length - 1] || null;
    clientErrHasMore = snap.docs.length === CLIENTERR_PAGE_SIZE;

    const matchCount = getFilteredDocs().length;
    if (matchCount === 0 && clientErrHasMore && clientErrAutoContinueCount < MAX_AUTO_CONTINUE_PAGES) {
      // Nothing in this page matched the active filter, but there may be
      // more history — keep paging automatically instead of showing a
      // confusing "no results" + "Load More" combination that required a
      // manual click to resolve.
      clientErrAutoContinueCount++;
      clientErrLoading = false;
      await loadClientErrors(false);
      return;
    }

    renderClientErrTable();
  } catch (err) {
    console.warn('[admin-client-errors] Load error:', err);
    showToast('Failed to load client errors', 'error');
  } finally {
    clientErrLoading = false;
    if (clientErrPendingReload) {
      const pending = clientErrPendingReload;
      clientErrPendingReload = null;
      loadClientErrors(pending.reset);
    }
  }
}

async function setStatusForIds(ids, newStatus, btn) {
  setButtonLoading(btn, true, null, 'Updating...');
  try {
    await Promise.all(ids.map(id => apiRequest(`/api/admin/client-errors/${id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: newStatus }),
    })));
    showToast(`Marked ${STATUS_LABEL[newStatus].toLowerCase()}`, 'success');
    loadClientErrors(true);
  } catch (err) {
    showToast('Failed to update: ' + err.message, 'error');
    setButtonLoading(btn, false);
  }
}

async function deleteIds(ids, btn) {
  setButtonLoading(btn, true, null, 'Deleting...');
  try {
    let success = 0;
    for (const id of ids) {
      try {
        await apiRequest(`/api/admin/client-errors/${id}`, { method: 'DELETE' });
        success++;
      } catch (err) {
        console.warn(`Failed to delete client error ${id}:`, err);
      }
    }
    showToast(`Deleted ${success} of ${ids.length}`, success === ids.length ? 'success' : 'info');
    loadClientErrors(true);
  } catch (err) {
    showToast('Failed to delete: ' + err.message, 'error');
    setButtonLoading(btn, false);
  }
}

function csvEscape(v) {
  const s = String(v ?? '');
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function exportCsv() {
  const docs = getFilteredDocs().sort((a, b) => b.createdAt - a.createdAt);
  const header = ['Occurred At', 'Status', 'Message', 'URL', 'User ID', 'Workspace ID', 'Browser (User-Agent)', 'Stack'];
  const rows = docs.map(d => [
    d.createdAt.toISOString(),
    STATUS_LABEL[d.status] || d.status,
    d.message,
    d.url,
    d.uid || '',
    d.workspaceId || '',
    d.userAgent,
    d.stack,
  ]);
  const csv = [header, ...rows].map(r => r.map(csvEscape).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `client-errors-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showToast(`Exported ${docs.length} error(s)`, 'success');
}

// ─── Details panel + "Copy AI Prompt" ──────────────────────────

function buildAiPrompt(g) {
  const d = g.latest;
  const lines = [
    "I'm debugging a frontend JavaScript error in a web app. Here are the details:",
    '',
    `Error message: ${d.message}`,
    `Occurred at URL: ${d.url || 'unknown'}`,
    `Browser / User-Agent: ${d.userAgent || 'unknown'}`,
    '',
    'Stack trace:',
    d.stack || '(no stack trace captured)',
    '',
    'Additional context:',
    `- Occurrences: ${g.count} time(s), first seen ${g.oldest.createdAt.toLocaleString()}, most recently ${g.latest.createdAt.toLocaleString()}`,
    `- Affected user ID(s): ${g.uids.length ? g.uids.join(', ') : 'anonymous / not signed in'}`,
    `- Workspace ID: ${d.workspaceId || 'n/a'}`,
    '',
    'Please help me identify the likely root cause and suggest a fix.',
  ];
  return lines.join('\n');
}

function findGroupByFp(fp) {
  const filtered = getFilteredDocs();
  const groups = buildGroups(filtered);
  return groups.find(g => g.fp === fp) || null;
}

function openClientErrDetail(g) {
  const overlay = document.getElementById('clienterr-detail-overlay');
  const panel = document.getElementById('clienterr-detail-panel');
  if (!overlay || !panel) return;
  const d = g.latest;

  panel.innerHTML = `
    <div class="panel-header">
      <h2 style="font-size:1.1rem;font-weight:700;">Error Details</h2>
      <button class="panel-close" id="clienterr-detail-close"><i data-feather="x"></i></button>
    </div>
    <div class="panel-body">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:20px;">
        <span class="badge ${STATUS_BADGE[g.status]}">${STATUS_LABEL[g.status]}</span>
        ${g.count > 1 ? `<span class="clienterr-count-badge">×${g.count} occurrences</span>` : ''}
      </div>

      <div class="log-detail-grid" style="grid-template-columns:1fr;">
        <div class="log-detail-item">
          <span class="log-detail-label">Message</span>
          <span class="log-detail-value" style="word-break:break-word;">${escHtml(d.message)}</span>
        </div>
        <div class="log-detail-item">
          <span class="log-detail-label">URL</span>
          <span class="log-detail-value" style="font-family:monospace;font-size:0.8rem;word-break:break-all;">${escHtml(d.url || '—')}</span>
        </div>
        <div class="log-detail-item">
          <span class="log-detail-label">Browser (User-Agent)</span>
          <span class="log-detail-value" style="font-size:0.8rem;word-break:break-word;">${escHtml(d.userAgent || '—')}</span>
        </div>
        <div class="log-detail-item">
          <span class="log-detail-label">First / Last Seen</span>
          <span class="log-detail-value">${escHtml(g.oldest.createdAt.toLocaleString())} → ${escHtml(g.latest.createdAt.toLocaleString())}</span>
        </div>
        <div class="log-detail-item">
          <span class="log-detail-label">Affected User(s)</span>
          <span class="log-detail-value" style="font-family:monospace;font-size:0.8rem;">${g.uids.length ? escHtml(g.uids.join(', ')) : '—'}</span>
        </div>
        <div class="log-detail-item">
          <span class="log-detail-label">Workspace ID</span>
          <span class="log-detail-value" style="font-family:monospace;font-size:0.8rem;">${escHtml(d.workspaceId || '—')}</span>
        </div>
      </div>

      <div style="margin-top:16px;padding:16px;background:var(--bg-3);border-radius:var(--radius-xs);border:1px solid var(--border);">
        <h3 style="font-size:0.85rem;font-weight:600;color:var(--text-2);margin-bottom:8px;">Stack Trace</h3>
        <pre style="font-size:0.75rem;color:var(--text-2);white-space:pre-wrap;word-break:break-word;font-family:monospace;margin:0;max-height:220px;overflow-y:auto;">${escHtml(d.stack || '(no stack trace captured)')}</pre>
      </div>

      <div style="margin-top:20px;">
        <button class="btn btn-primary btn-sm" id="clienterr-detail-copy-prompt" style="width:100%;justify-content:center;">
          Copy AI Debugging Prompt
        </button>
      </div>
      <div style="margin-top:10px;">
        ${actionButtonsHtml(g.status).replace(/class="btn btn-secondary btn-sm clienterr-status-btn"/g, 'class="btn btn-secondary btn-sm clienterr-detail-status-btn" style="width:100%;justify-content:center;margin-bottom:6px;"')}
      </div>
    </div>
  `;

  if (window.feather) window.feather.replace();

  panel.querySelector('#clienterr-detail-close')?.addEventListener('click', closeClientErrDetail);
  overlay.addEventListener('click', closeClientErrDetail);

  panel.querySelector('#clienterr-detail-copy-prompt')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const original = btn.textContent;
    try {
      await navigator.clipboard.writeText(buildAiPrompt(g));
      btn.textContent = 'Copied!';
      showToast('AI debugging prompt copied to clipboard', 'success');
    } catch (err) {
      showToast('Failed to copy to clipboard', 'error');
    } finally {
      setTimeout(() => { btn.textContent = original; }, 1500);
    }
  });

  panel.querySelectorAll('.clienterr-detail-status-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      await setStatusForIds(g.instances.map(i => i.id), btn.dataset.status, btn);
      closeClientErrDetail();
    });
  });

  overlay.classList.add('open');
  panel.classList.add('open');
}

function closeClientErrDetail() {
  const overlay = document.getElementById('clienterr-detail-overlay');
  const panel = document.getElementById('clienterr-detail-panel');
  if (overlay) overlay.classList.remove('open');
  if (panel) panel.classList.remove('open');
}

function wireClientErrorControls() {
  const refreshBtn = document.getElementById('admin-clienterr-refresh');
  if (refreshBtn) refreshBtn.addEventListener('click', () => loadClientErrors(true));

  const exportBtn = document.getElementById('admin-clienterr-export');
  if (exportBtn) exportBtn.addEventListener('click', exportCsv);

  const loadMoreBtn = document.getElementById('admin-clienterr-load-more');
  if (loadMoreBtn) loadMoreBtn.addEventListener('click', () => loadClientErrors(false));

  const statusEl = document.getElementById('admin-clienterr-filter-status');
  if (statusEl) statusEl.addEventListener('change', () => loadClientErrors(true));

  const searchEl = document.getElementById('admin-clienterr-search');
  if (searchEl) {
    searchEl.addEventListener('input', () => {
      clearTimeout(clientErrSearchTimer);
      clientErrSearchTimer = setTimeout(() => loadClientErrors(true), 300);
    });
  }

  const selectAll = document.getElementById('admin-clienterr-select-all');
  if (selectAll) {
    selectAll.addEventListener('change', () => {
      const ids = getFilteredDocs().map(d => d.id);
      if (selectAll.checked) ids.forEach(id => clientErrSelectedIds.add(id));
      else ids.forEach(id => clientErrSelectedIds.delete(id));
      renderClientErrTable();
    });
  }

  const bulkDeleteBtn = document.getElementById('admin-clienterr-bulk-delete-btn');
  if (bulkDeleteBtn) {
    bulkDeleteBtn.addEventListener('click', async () => {
      const ids = Array.from(clientErrSelectedIds);
      if (ids.length === 0) return;
      const ok = await confirmDialog({
        title: 'Delete client errors?',
        message: `Delete ${ids.length} error record(s)? This cannot be undone.`,
        confirmText: 'Delete',
      });
      if (!ok) return;
      clientErrSelectedIds.clear();
      await deleteIds(ids, bulkDeleteBtn);
    });
  }

  const tbody = document.getElementById('admin-clienterr-tbody');
  if (tbody) {
    tbody.addEventListener('click', async (e) => {
      const expandBtn = e.target.closest('.clienterr-expand-btn');
      if (expandBtn) {
        const fp = expandBtn.dataset.fp;
        const expanded = clientErrExpandedGroups.has(fp);
        if (expanded) clientErrExpandedGroups.delete(fp); else clientErrExpandedGroups.add(fp);
        expandBtn.classList.toggle('expanded', !expanded);
        document.querySelectorAll(`[data-parent-fp="${CSS.escape(fp)}"]`).forEach(tr => {
          tr.style.display = expanded ? 'none' : 'table-row';
        });
        return;
      }

      const groupRow = e.target.closest('tr[data-group-row]');
      const childRow = e.target.closest('tr.clienterr-child-row');

      if (e.target.classList.contains('clienterr-status-btn') && groupRow) {
        const fp = groupRow.dataset.fp;
        const g = findGroupByFp(fp);
        if (g) setStatusForIds(g.instances.map(i => i.id), e.target.dataset.status, e.target);
        return;
      }

      if (e.target.classList.contains('clienterr-delete-group-btn') && groupRow) {
        const fp = groupRow.dataset.fp;
        const g = findGroupByFp(fp);
        if (!g) return;
        const ok = await confirmDialog({
          title: 'Delete error group?',
          message: g.count > 1
            ? `Delete this error and all ${g.count} occurrences? This cannot be undone.`
            : 'Delete this error record? This cannot be undone.',
          confirmText: 'Delete',
        });
        if (!ok) return;
        deleteIds(g.instances.map(i => i.id), e.target);
        return;
      }

      if (e.target.classList.contains('clienterr-details-btn') && groupRow) {
        const fp = groupRow.dataset.fp;
        const g = findGroupByFp(fp);
        if (g) openClientErrDetail(g);
        return;
      }

      if (e.target.classList.contains('clienterr-delete-child-btn') && childRow) {
        const id = childRow.dataset.id;
        const ok = await confirmDialog({
          title: 'Delete error record?',
          message: 'Delete this error occurrence? This cannot be undone.',
          confirmText: 'Delete',
        });
        if (!ok) return;
        deleteIds([id], e.target);
        return;
      }

      if (e.target.classList.contains('clienterr-details-child-btn') && childRow) {
        const id = childRow.dataset.id;
        const d = clientErrDocsById.get(id);
        if (d) openClientErrDetail({ fp: fingerprintOf(d), instances: [d], latest: d, oldest: d, count: 1, status: d.status, uids: d.uid ? [d.uid] : [] });
        return;
      }
    });

    tbody.addEventListener('change', (e) => {
      if (e.target.classList.contains('clienterr-group-checkbox')) {
        const fp = e.target.dataset.fp;
        const groupRow = e.target.closest('tr');
        const ids = Array.from(document.querySelectorAll(`[data-parent-fp="${CSS.escape(fp)}"] .clienterr-child-checkbox`)).map(c => c.dataset.id);
        if (groupRow?.dataset.latestId) ids.push(groupRow.dataset.latestId);
        if (e.target.checked) ids.forEach(id => clientErrSelectedIds.add(id));
        else ids.forEach(id => clientErrSelectedIds.delete(id));
        updateSelectionUI();
      } else if (e.target.classList.contains('clienterr-child-checkbox')) {
        const id = e.target.dataset.id;
        if (e.target.checked) clientErrSelectedIds.add(id);
        else clientErrSelectedIds.delete(id);
        updateSelectionUI();
      }
    });
  }
}

let wired = false;

export function initAdminClientErrors(db, auth) {
  firestoreDb = db;
  authInstance = auth;
  if (!wired) {
    wireClientErrorControls();
    wired = true;
  }
  loadClientErrors(true);
}

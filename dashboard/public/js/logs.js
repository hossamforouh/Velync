import { navigateTo } from './navigation.js';
import { showToast } from './toast.js';
import {
  collection, query, where, orderBy, limit, getDocs, startAfter
} from "https://www.gstatic.com/firebasejs/10.9.0/firebase-firestore.js";

const PAGE_SIZE = 50;

let cachedLogs = [];
let lastVisible = null;
let hasMore = true;
let currentDb = null;
let currentWorkspaceId = null;
let currentAuth = null;
let filterListenersAttached = false;
let fetchRequestId = 0;
let autoRefreshTimer = null;
let autoRefreshEnabled = false;

/* ── Init ───────────────────────────────────────────────────── */

export async function initLogs(db, workspaceId, authInstance) {
  currentDb = db;
  currentWorkspaceId = workspaceId;
  currentAuth = authInstance || currentAuth;

  const logsTbody = document.getElementById('logs-tbody');
  if (!logsTbody) return;

  if (!filterListenersAttached) {
    attachFilterListeners();
    filterListenersAttached = true;
  }

  // Check view cache: skip re-fetch if fresh
  const cached = window.__getViewCache ? window.__getViewCache('logs') : null;
  if (cached) {
    cachedLogs = cached;
    await renderTable();
    return;
  }

  await fetchLogs(true);
  startAutoRefresh();

  // Visibility change: pause auto-refresh when tab hidden, resume when visible
  if (!window._logsVisibilityWired) {
    window._logsVisibilityWired = true;
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        stopAutoRefresh();
      } else if (autoRefreshEnabled) {
        // Refresh immediately on regaining focus (cheaper than a tight
        // interval, and gives fresher data than waiting for the next tick)
        // then resume the interval.
        fetchLogs(true);
        startAutoRefresh();
      }
    });
  }
}

/* ── Filters ───────────────────────────────────────────────── */

function getFilters() {
  const search = (document.getElementById('logs-search')?.value || '').trim();
  const activePill = document.querySelector('.logs-filter-pill.active');
  const status = activePill?.dataset?.status || 'all';
  const fromDate = document.getElementById('logs-date-from')?.value || '';
  const toDate = document.getElementById('logs-date-to')?.value || '';
  return { search, status, fromDate, toDate };
}

function hasActiveFilters() {
  const f = getFilters();
  return f.search || f.status !== 'all' || f.fromDate || f.toDate;
}

function validateDates(fromDate, toDate) {
  if (fromDate && isNaN(new Date(fromDate).getTime())) return false;
  if (toDate && isNaN(new Date(toDate).getTime())) return false;
  if (fromDate && toDate && new Date(fromDate) > new Date(toDate)) return false;
  return true;
}

/* ── Fetch Logs (paginated) ────────────────────────────────── */

async function fetchLogs(reset = false) {
  const logsTbody = document.getElementById('logs-tbody');
  const loadMoreRow = document.getElementById('logs-load-more-row');
  if (!logsTbody) return;
  if (!currentDb || !currentWorkspaceId) return;

  const reqId = ++fetchRequestId;

  if (reset) {
    lastVisible = null;
    hasMore = true;
    cachedLogs = [];
  }

  showSkeleton(logsTbody, reset);

  const f = getFilters();

  if (f.fromDate || f.toDate) {
    if (!validateDates(f.fromDate, f.toDate)) {
      logsTbody.innerHTML = `
        <tr><td colspan="4">
          <div class="empty-state" style="padding:40px 16px;">
            <p style="color:var(--rose);font-size:0.9rem;">Invalid date range. Please correct the dates and try again.</p>
          </div>
        </td></tr>`;
      updateCount(0, 0, f);
      if (loadMoreRow) loadMoreRow.style.display = 'none';
      return;
    }
  }

  // Firestore limitation: cannot have range filters on two different fields.
  // Use search (configName range) in Firestore when search is active, and
  // apply date range client-side. When only date range is active, use it
  // in Firestore for efficient server-side filtering.
  const useSearchInFirestore = !!f.search;
  const useDateInFirestore = !!f.fromDate || !!f.toDate;

  const constraints = [
    where("workspaceId", "==", currentWorkspaceId),
  ];

  if (f.status === 'failed') {
    // The engine writes status:'error' on failure, but the UI's "Failed"
    // filter/badge language is 'failed' — match both so the filter actually
    // returns results.
    constraints.push(where("status", "in", ['failed', 'error']));
  } else if (f.status !== 'all') {
    constraints.push(where("status", "==", f.status));
  }

  if (useSearchInFirestore && f.search) {
    const term = f.search.toLowerCase();
    constraints.push(where("configName", ">=", term));
    constraints.push(where("configName", "<=", term + '\uf8ff'));
  }

  if (!useSearchInFirestore && useDateInFirestore) {
    if (f.fromDate) {
      constraints.push(where("startTime", ">=", new Date(f.fromDate)));
    }
    if (f.toDate) {
      const endOfDay = new Date(f.toDate);
      endOfDay.setHours(23, 59, 59, 999);
      constraints.push(where("startTime", "<=", endOfDay));
    }
  }

  constraints.push(orderBy("startTime", "desc"));

  if (!reset && lastVisible) {
    constraints.push(startAfter(lastVisible));
  }

  constraints.push(limit(PAGE_SIZE));

  try {
    const q = query(collection(currentDb, "execution_logs"), ...constraints);
    const snapshot = await getDocs(q);

    if (reqId !== fetchRequestId) return;

    let rawDocs = [];
    const rawSnapshot = [];
    snapshot.forEach(doc => {
      rawSnapshot.push(doc);
      rawDocs.push({ id: doc.id, ...doc.data() });
    });

    // Client-side date filtering when search is active (date not in Firestore query)
    if (useSearchInFirestore && useDateInFirestore) {
      rawDocs = rawDocs.filter(log => {
        const logDate = toDate(log.startTime);
        let pass = true;
        if (f.fromDate && logDate < new Date(f.fromDate)) pass = false;
        if (f.toDate) {
          const endOfDay = new Date(f.toDate);
          endOfDay.setHours(23, 59, 59, 999);
          if (logDate > endOfDay) pass = false;
        }
        return pass;
      });
    }

    if (reset) {
      cachedLogs = rawDocs;
    } else {
      cachedLogs = cachedLogs.concat(rawDocs);
    }

    // lastVisible tracks the last doc from the raw Firestore snapshot for correct pagination
    lastVisible = rawSnapshot.length > 0 ? rawSnapshot[rawSnapshot.length - 1] : null;

    // hasMore based on raw snapshot size (before client-side filtering)
    if (rawSnapshot.length < PAGE_SIZE) {
      hasMore = false;
    }

    renderLogs();
    if (window.__setViewCache) window.__setViewCache('logs', cachedLogs);
  } catch (err) {
    console.error("Error fetching logs:", err);
    if (reqId !== fetchRequestId) return;
    logsTbody.innerHTML =
      `<tr><td colspan="4" style="text-align:center;padding:20px;color:var(--danger);">Failed to load logs: ${err.message}</td></tr>`;
    updateCount(0, 0, f);
    if (loadMoreRow) loadMoreRow.style.display = 'none';
  }
}

async function renderTable() {
  await renderLogs();
  updateLoadMoreVisibility();
}

/* ── Load More ─────────────────────────────────────────────── */

async function loadMore() {
  if (!hasMore) return;
  const loadMoreBtn = document.getElementById('logs-load-more-btn');
  if (loadMoreBtn) {
    loadMoreBtn.disabled = true;
    loadMoreBtn.textContent = 'Loading...';
  }
  await fetchLogs(false);
  if (loadMoreBtn) {
    loadMoreBtn.disabled = false;
    loadMoreBtn.textContent = 'Load More';
  }
  updateLoadMoreVisibility();
}

/* ── Render ────────────────────────────────────────────────── */

function renderLogs() {
  const logsTbody = document.getElementById('logs-tbody');
  if (!logsTbody) return;

  const f = getFilters();

  // If status filter was applied server-side, no client-side filtering needed
  // Only search remains client-side for prefix match + substring fallback
  let filtered = [...cachedLogs];

  if (f.search && filtered.length > 0) {
    const term = f.search.toLowerCase();
    filtered = filtered.filter(l =>
      (l.configName || '').toLowerCase().includes(term)
    );
  }

  const clearBtn = document.getElementById('logs-clear-filters');
  if (clearBtn) {
    clearBtn.style.display = hasActiveFilters() ? 'inline-flex' : 'none';
  }

  const partialHint = document.getElementById('logs-partial-filter-hint');
  if (partialHint) {
    // Firestore can only range-filter one field server-side at a time — when
    // both search and date range are active, the date filter only applies to
    // the pages already fetched, not the full matching set.
    partialHint.style.display = (f.search && (f.fromDate || f.toDate)) ? '' : 'none';
  }

  updateCount(filtered.length, cachedLogs.length, f);

  logsTbody.innerHTML = '';

  if (filtered.length === 0) {
    let emptyMsg = 'No execution logs found.';
    if (cachedLogs.length > 0 && hasActiveFilters()) {
      emptyMsg = 'No logs match the current filters. Try adjusting your search or filter criteria.';
    } else if (cachedLogs.length === 0 && hasActiveFilters() && (f.fromDate || f.toDate)) {
      emptyMsg = 'No logs found in the selected date range.';
    } else if (cachedLogs.length === 0) {
      emptyMsg = 'Logs will automatically appear here once your integrations start syncing.';
    }

    logsTbody.innerHTML = `
      <tr>
        <td colspan="4">
          <div style="padding:60px 16px;text-align:center;">
            <div style="margin-bottom:16px;color:var(--violet);display:inline-flex;align-items:center;justify-content:center;width:64px;height:64px;border-radius:50%;background:rgba(124,58,237,0.1);">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline>
              </svg>
            </div>
            <h3 style="margin-bottom:8px;color:var(--text-1);font-weight:600;font-size:1.1rem;">${emptyMsg}</h3>
          </div>
        </td>
      </tr>`;
    updateLoadMoreVisibility();
    return;
  }

  filtered.forEach(log => {
    const tr = document.createElement('tr');
    tr.style.cursor = 'pointer';
    tr.dataset.logId = log.id;
    tr.addEventListener('click', () => openLogDetail(log));

    const dateObj = toDate(log.startTime);
    const timeStr = dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const dateStr = dateObj.toLocaleDateString();

    let statusBadge = '';
    let details = '';

    if (log.status === 'running') {
      statusBadge = '<span class="badge badge-warning" style="background:rgba(245,158,11,0.2);color:#fcd34d;padding:4px 8px;border-radius:4px;font-size:0.8rem;font-weight:500;">Running</span>';
      details = 'Sync in progress...';
    } else if (log.status === 'success') {
      statusBadge = '<span class="badge badge-success" style="background:rgba(16,185,129,0.2);color:#6ee7b7;padding:4px 8px;border-radius:4px;font-size:0.8rem;font-weight:500;">Success</span>';
      const parts = [];
      if (log.syncedCount) parts.push(`Synced ${log.syncedCount}`);
      if (log.deletedCount) parts.push(`Deleted ${log.deletedCount}`);
      if (log.failedCount) parts.push(`Failed ${log.failedCount}`);
      details = parts.length > 0 ? parts.join('. ') + '.' : 'Sync completed.';
    } else {
      statusBadge = '<span class="badge badge-failed" style="background:rgba(239,68,68,0.2);color:#fca5a5;padding:4px 8px;border-radius:4px;font-size:0.8rem;font-weight:500;">Failed</span>';
      details = log.error || 'Unknown error occurred.';
    }

    const integrationLink = log.configId
      ? `<a href="#" class="log-config-link" data-config-id="${escAttr(log.configId)}" style="color:var(--text-1);text-decoration:none;font-weight:500;">${escHtml(log.configName || 'Unknown Integration')}</a>`
      : `<span style="font-weight:500;">${escHtml(log.configName || 'Unknown Integration')}</span>`;

    tr.innerHTML = `
      <td style="color:var(--text-3);white-space:nowrap;">${dateStr} ${timeStr}</td>
      <td>${integrationLink}</td>
      <td>${statusBadge}</td>
      <td style="color:var(--text-2);font-size:0.85rem;">${escHtml(details)}</td>
    `;

    // Attach config link click handler
    const configLink = tr.querySelector('.log-config-link');
    if (configLink) {
      configLink.addEventListener('click', (e) => {
        e.stopPropagation();
        navigateToConfig(log.configId);
      });
    }

    logsTbody.appendChild(tr);
  });

  updateLoadMoreVisibility();
}

/* ── Helpers ───────────────────────────────────────────────── */

function toDate(val) {
  if (!val) return new Date();
  if (val instanceof Date) return val;
  if (typeof val === 'object' && val.toDate) return val.toDate();
  if (typeof val === 'object' && val.toMillis) return new Date(val.toMillis());
  return new Date(val);
}

function escHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.appendChild(document.createTextNode(str));
  return div.innerHTML;
}

function escAttr(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* ── Count & Load More Visibility ──────────────────────────── */

function updateCount(shown, total, filters) {
  const el = document.getElementById('logs-count');
  if (!el) return;

  let label = `${shown} log${shown !== 1 ? 's' : ''}`;

  if (shown < total) {
    label += ` (filtered from ${total})`;
  } else if (total > 0 || shown > 0) {
    label += ` (showing up to ${total})`;
  }

  el.textContent = `Showing ${label}`;
}

function updateLoadMoreVisibility() {
  const loadMoreRow = document.getElementById('logs-load-more-row');
  if (!loadMoreRow) return;
  loadMoreRow.style.display = hasMore ? '' : 'none';
}

/* ── Skeleton Loading ──────────────────────────────────────── */

function showSkeleton(tbody, reset) {
  if (!reset) return; // only show skeleton on full reloads

  const rows = [];
  for (let i = 0; i < 5; i++) {
    rows.push(`
      <tr>
        <td><div class="skeleton-line short"></div></td>
        <td><div class="skeleton-line medium"></div></td>
        <td><div class="skeleton-line short"></div></td>
        <td><div class="skeleton-line long"></div></td>
      </tr>`);
  }
  tbody.innerHTML = rows.join('');
}

/* ── Log Detail Panel ──────────────────────────────────────── */

function openLogDetail(log) {
  const overlay = document.getElementById('log-detail-overlay');
  const panel = document.getElementById('log-detail-panel');
  if (!overlay || !panel) return;

  const dateObj = toDate(log.startTime);
  const startStr = dateObj.toLocaleString();
  const endStr = log.endTime ? toDate(log.endTime).toLocaleString() : '—';
  let duration = '—';
  if (log.startTime && log.endTime) {
    const diffMs = toDate(log.endTime) - toDate(log.startTime);
    if (diffMs >= 0) {
      const sec = Math.floor(diffMs / 1000);
      duration = sec >= 60 ? `${Math.floor(sec / 60)}m ${sec % 60}s` : `${sec}s`;
    }
  }

  let statusColor = 'var(--text-3)';
  let statusIcon = '';
  let statusLabel = log.status || 'Unknown';
  if (log.status === 'success') { statusColor = '#6ee7b7'; statusIcon = '✓'; }
  else if (log.status === 'running') { statusColor = '#fcd34d'; statusIcon = '↻'; }
  else { statusColor = '#fca5a5'; statusIcon = '✕'; statusLabel = 'Failed'; }

  panel.innerHTML = `
    <div class="panel-header">
      <h2 style="font-size:1.1rem;font-weight:700;">Execution Details</h2>
      <button class="panel-close" id="log-detail-close"><i data-feather="x"></i></button>
    </div>
    <div class="panel-body">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:24px;padding:16px;background:var(--bg-3);border-radius:var(--radius-xs);border:1px solid var(--border);">
        <span style="font-size:1.2rem;color:${statusColor};font-weight:700;">${statusIcon}</span>
        <span style="font-size:1rem;font-weight:600;color:${statusColor};text-transform:capitalize;">${statusLabel}</span>
      </div>

      <div class="log-detail-grid">
        <div class="log-detail-item">
          <span class="log-detail-label">Integration</span>
          <span class="log-detail-value">${escHtml(log.configName || '—')}</span>
        </div>
        <div class="log-detail-item">
          <span class="log-detail-label">Config ID</span>
          <span class="log-detail-value" style="font-family:monospace;font-size:0.8rem;color:var(--text-3);">${escHtml(log.configId || '—')}</span>
        </div>
        <div class="log-detail-item">
          <span class="log-detail-label">Start Time</span>
          <span class="log-detail-value">${startStr}</span>
        </div>
        <div class="log-detail-item">
          <span class="log-detail-label">End Time</span>
          <span class="log-detail-value">${endStr}</span>
        </div>
        <div class="log-detail-item">
          <span class="log-detail-label">Duration</span>
          <span class="log-detail-value">${duration}</span>
        </div>
      </div>

      <div style="margin-top:20px;padding:16px;background:var(--bg-3);border-radius:var(--radius-xs);border:1px solid var(--border);">
        <h3 style="font-size:0.85rem;font-weight:600;color:var(--text-2);margin-bottom:12px;">Summary</h3>
        <div class="log-detail-grid" style="grid-template-columns:1fr 1fr 1fr;">
          <div style="text-align:center;padding:12px;background:rgba(16,185,129,0.08);border-radius:var(--radius-xs);">
            <div style="font-size:1.3rem;font-weight:700;color:#6ee7b7;">${log.syncedCount || 0}</div>
            <div style="font-size:0.75rem;color:var(--text-3);margin-top:4px;">Synced</div>
          </div>
          <div style="text-align:center;padding:12px;background:rgba(239,68,68,0.08);border-radius:var(--radius-xs);">
            <div style="font-size:1.3rem;font-weight:700;color:#fca5a5;">${log.failedCount || 0}</div>
            <div style="font-size:0.75rem;color:var(--text-3);margin-top:4px;">Failed</div>
          </div>
          <div style="text-align:center;padding:12px;background:rgba(245,158,11,0.08);border-radius:var(--radius-xs);">
            <div style="font-size:1.3rem;font-weight:700;color:#fcd34d;">${log.deletedCount || 0}</div>
            <div style="font-size:0.75rem;color:var(--text-3);margin-top:4px;">Deleted</div>
          </div>
        </div>
      </div>

      ${log.error ? `
      <div style="margin-top:16px;padding:16px;background:rgba(239,68,68,0.08);border-radius:var(--radius-xs);border:1px solid rgba(239,68,68,0.2);">
        <h3 style="font-size:0.85rem;font-weight:600;color:#fca5a5;margin-bottom:8px;">Error</h3>
        <pre style="font-size:0.8rem;color:var(--text-2);white-space:pre-wrap;word-break:break-word;font-family:inherit;margin:0;">${escHtml(log.error)}</pre>
      </div>` : ''}

      ${log.configId && log.status !== 'success' && log.status !== 'running' ? `
      <div style="margin-top:20px;">
        <button class="btn btn-primary btn-sm" id="log-detail-retry" style="width:100%;justify-content:center;">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
          Retry Sync
        </button>
      </div>` : ''}

      ${log.configId ? `
      <div style="margin-top:12px;">
        <button class="btn btn-secondary btn-sm" id="log-detail-goto-config" style="width:100%;justify-content:center;">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
          Open Config
        </button>
      </div>` : ''}
    </div>
  `;

  if (window.feather) window.feather.replace();

  // Attach close handler
  const closeBtn = panel.querySelector('#log-detail-close');
  if (closeBtn) closeBtn.addEventListener('click', closeLogDetail);
  overlay.addEventListener('click', closeLogDetail);

  // Attach "Retry Sync" handler
  const retryBtn = panel.querySelector('#log-detail-retry');
  if (retryBtn) {
    retryBtn.addEventListener('click', () => retrySync(log.configId, retryBtn));
  }

  // Attach "Open Config" handler
  const gotoBtn = panel.querySelector('#log-detail-goto-config');
  if (gotoBtn) {
    gotoBtn.addEventListener('click', () => {
      closeLogDetail();
      navigateToConfig(log.configId);
    });
  }

  overlay.classList.add('open');
  panel.classList.add('open');
}

function closeLogDetail() {
  const overlay = document.getElementById('log-detail-overlay');
  const panel = document.getElementById('log-detail-panel');
  if (overlay) overlay.classList.remove('open');
  if (panel) panel.classList.remove('open');
}

/* ── Retry ─────────────────────────────────────────────────── */

async function retrySync(configId, btn) {
  if (!configId) return;
  const originalText = btn ? btn.textContent : '';
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Retrying...';
  }
  try {
    const token = currentAuth && currentAuth.currentUser ? await currentAuth.currentUser.getIdToken() : null;
    const res = await fetch(`${window.VELYNC_CONFIG.apiBase}/api/sync-configs/${configId}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    showToast('Sync re-run triggered.', 'success');
    closeLogDetail();
    fetchLogs(true);
  } catch (err) {
    showToast('Failed to retry sync: ' + err.message, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  }
}

function navigateToConfig(configId) {
  if (!configId) return;
  navigateTo('flows');
  setTimeout(() => {
    if (typeof window.openPanel === 'function') {
      window.openPanel(configId);
    }
  }, 300);
}

/* ── CSV Export ────────────────────────────────────────────── */

async function exportLogsCSV() {
  if (cachedLogs.length === 0 && !hasMore) return;

  const exportBtn = document.getElementById('logs-export-btn');
  const originalTitle = exportBtn ? exportBtn.title : '';
  if (exportBtn) {
    exportBtn.disabled = true;
    exportBtn.title = 'Loading all logs before export…';
    exportBtn.style.opacity = '0.6';
  }

  try {
    // Load every remaining page first — otherwise this would silently only
    // export whatever happened to be paginated in so far.
    while (hasMore) {
      await fetchLogs(false);
    }
  } finally {
    if (exportBtn) {
      exportBtn.disabled = false;
      exportBtn.title = originalTitle;
      exportBtn.style.opacity = '';
    }
  }

  const f = getFilters();
  let data = [...cachedLogs];

  if (f.search) {
    const term = f.search.toLowerCase();
    data = data.filter(l =>
      (l.configName || '').toLowerCase().includes(term)
    );
  }
  if (f.status === 'failed') {
    data = data.filter(l => l.status === 'failed' || l.status === 'error');
  } else if (f.status !== 'all') {
    data = data.filter(l => l.status === f.status);
  }

  const headers = ['Timestamp', 'Integration', 'Config ID', 'Status', 'Synced', 'Deleted', 'Failed', 'Error'];
  const rows = data.map(log => {
    const date = toDate(log.startTime).toISOString();
    return [
      date,
      log.configName || '',
      log.configId || '',
      log.status || '',
      log.syncedCount || 0,
      log.deletedCount || 0,
      log.failedCount || 0,
      (log.error || '').replace(/"/g, '""')
    ];
  });

  const csv = [headers.join(','), ...rows.map(r => r.map(c => `"${c}"`).join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `execution-logs-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/* ── Auto-Refresh ──────────────────────────────────────────── */

function startAutoRefresh() {
  stopAutoRefresh();
  const toggle = document.getElementById('logs-auto-refresh');
  autoRefreshEnabled = toggle ? toggle.checked : false;
  if (autoRefreshEnabled) {
    autoRefreshTimer = setInterval(async () => {
      const logsView = document.getElementById('view-logs');
      if (logsView && logsView.style.display !== 'none') {
        await fetchLogs(true);
      }
    }, 60000);
  }
}

function stopAutoRefresh() {
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
}

function toggleAutoRefresh(checked) {
  autoRefreshEnabled = checked;
  if (checked) {
    startAutoRefresh();
  } else {
    stopAutoRefresh();
  }
}

/* ── Filter Listeners ──────────────────────────────────────── */

function attachFilterListeners() {
  const searchInput = document.getElementById('logs-search');
  const searchClear = document.getElementById('logs-search-clear');
  const refreshBtn = document.getElementById('logs-refresh');
  const clearFiltersBtn = document.getElementById('logs-clear-filters');
  const dateFrom = document.getElementById('logs-date-from');
  const dateTo = document.getElementById('logs-date-to');
  const loadMoreBtn = document.getElementById('logs-load-more-btn');
  const exportBtn = document.getElementById('logs-export-btn');
  const autoRefreshToggle = document.getElementById('logs-auto-refresh');

  let searchTimer = null;
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      if (searchClear) {
        searchClear.style.display = searchInput.value ? 'flex' : 'none';
      }
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => fetchLogs(true), 300);
    });
  }

  if (searchClear) {
    searchClear.addEventListener('click', () => {
      searchInput.value = '';
      searchClear.style.display = 'none';
      fetchLogs(true);
    });
    searchClear.style.display = 'none';
  }

  document.querySelectorAll('.logs-filter-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('.logs-filter-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      fetchLogs(true);
    });
  });

  if (dateFrom) {
    dateFrom.addEventListener('change', () => fetchLogs(true));
  }
  if (dateTo) {
    dateTo.addEventListener('change', () => fetchLogs(true));
  }

  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => fetchLogs(true));
  }

  if (clearFiltersBtn) {
    clearFiltersBtn.addEventListener('click', () => {
      if (searchInput) { searchInput.value = ''; }
      if (searchClear) { searchClear.style.display = 'none'; }
      if (dateFrom) { dateFrom.value = ''; }
      if (dateTo) { dateTo.value = ''; }
      document.querySelectorAll('.logs-filter-pill').forEach(p => p.classList.remove('active'));
      const allPill = document.querySelector('.logs-filter-pill[data-status="all"]');
      if (allPill) allPill.classList.add('active');
      fetchLogs(true);
    });
  }

  if (loadMoreBtn) {
    loadMoreBtn.addEventListener('click', () => loadMore());
  }

  if (exportBtn) {
    exportBtn.addEventListener('click', () => exportLogsCSV());
  }

  if (autoRefreshToggle) {
    autoRefreshToggle.addEventListener('change', (e) => {
      toggleAutoRefresh(e.target.checked);
    });
  }
}

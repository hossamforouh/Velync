import { collection, query, orderBy, limit, startAfter, getDocs } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-firestore.js";
import { showToast } from './toast.js';

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
let clientErrLastVisible = null;
let clientErrHasMore = false;
let clientErrLoading = false;
let clientErrFilters = { status: 'unresolved', search: '' };
let clientErrSearchTimer = null;

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

async function loadClientErrors(reset = false) {
  if (clientErrLoading) return;

  const tbody = document.getElementById('admin-clienterr-tbody');
  const emptyMsg = document.getElementById('admin-clienterr-empty');
  if (!tbody) return;

  clientErrFilters.status = document.getElementById('admin-clienterr-filter-status')?.value ?? 'unresolved';
  clientErrFilters.search = document.getElementById('admin-clienterr-search')?.value?.trim() || '';

  clientErrLoading = true;

  if (reset) {
    clientErrLastVisible = null;
    clientErrHasMore = false;
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:20px;">Loading...</td></tr>';
    if (emptyMsg) emptyMsg.style.display = 'none';
  }

  try {
    // Filtered client-side (status + search) within the fetched page, same
    // pattern as the Audit Log's type filter — avoids needing a composite
    // Firestore index for every filter combination.
    const constraints = [orderBy('createdAt', 'desc'), limit(CLIENTERR_PAGE_SIZE)];
    if (clientErrLastVisible) constraints.push(startAfter(clientErrLastVisible));

    const q = query(collection(firestoreDb, 'client_errors'), ...constraints);
    const snap = await getDocs(q);
    if (reset) tbody.innerHTML = '';

    const searchLower = clientErrFilters.search.toLowerCase();
    let rowCount = 0;

    snap.forEach(docSnap => {
      const d = docSnap.data();
      const resolved = !!d.resolved;

      if (clientErrFilters.status === 'unresolved' && resolved) return;
      if (clientErrFilters.status === 'resolved' && !resolved) return;

      if (searchLower) {
        const haystack = ((d.message || '') + ' ' + (d.url || '') + ' ' + (d.uid || '') + ' ' + (d.workspaceId || '')).toLowerCase();
        if (!haystack.includes(searchLower)) return;
      }

      const ts = d.createdAt?.toDate?.() || new Date();
      const tr = document.createElement('tr');
      tr.dataset.id = docSnap.id;
      tr.innerHTML = `
        <td data-label="Occurred" style="font-size:0.82rem;color:var(--text-2);white-space:nowrap;" title="${escHtml(ts.toLocaleString())}">${escHtml(timeAgo(ts))}</td>
        <td data-label="Message" style="font-size:0.85rem;max-width:340px;word-break:break-word;">${escHtml(d.message || '')}</td>
        <td data-label="URL" style="font-size:0.78rem;color:var(--text-3);max-width:220px;word-break:break-all;">${escHtml(d.url || '')}</td>
        <td data-label="User" style="font-size:0.78rem;color:var(--text-3);">${escHtml(d.uid || '—')}</td>
        <td data-label="Status"><span class="badge ${resolved ? 'badge-success' : 'badge-warning'}">${resolved ? 'Resolved' : 'Unresolved'}</span></td>
        <td data-label="Actions" style="white-space:nowrap;">
          <button class="btn btn-secondary btn-sm clienterr-toggle-btn" style="padding:4px 8px;font-size:12px;">${resolved ? 'Reopen' : 'Resolve'}</button>
          <button class="btn btn-secondary btn-sm clienterr-delete-btn" style="padding:4px 8px;font-size:12px;color:var(--rose);">Delete</button>
        </td>
      `;
      tbody.appendChild(tr);
      rowCount++;
    });

    clientErrLastVisible = snap.docs[snap.docs.length - 1] || null;
    clientErrHasMore = snap.docs.length === CLIENTERR_PAGE_SIZE;

    const loadMoreWrap = document.getElementById('admin-clienterr-load-more-wrap');
    if (loadMoreWrap) loadMoreWrap.style.display = clientErrHasMore ? 'block' : 'none';

    if (rowCount === 0) {
      if (reset && !clientErrLastVisible) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:20px;">No client errors reported yet.</td></tr>';
      } else if (emptyMsg) {
        emptyMsg.style.display = 'block';
      }
    } else if (emptyMsg) {
      emptyMsg.style.display = 'none';
    }
  } catch (err) {
    console.warn('[admin-client-errors] Load error:', err);
    showToast('Failed to load client errors', 'error');
  } finally {
    clientErrLoading = false;
  }
}

async function toggleResolved(id, currentlyResolved, btn) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = '...';
  try {
    await apiRequest(`/api/admin/client-errors/${id}/resolved`, {
      method: 'PATCH',
      body: JSON.stringify({ resolved: !currentlyResolved }),
    });
    showToast(currentlyResolved ? 'Reopened' : 'Marked resolved', 'success');
    loadClientErrors(true);
  } catch (err) {
    showToast('Failed to update: ' + err.message, 'error');
    btn.disabled = false;
    btn.textContent = original;
  }
}

async function deleteError(id, btn) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = '...';
  try {
    await apiRequest(`/api/admin/client-errors/${id}`, { method: 'DELETE' });
    showToast('Deleted', 'success');
    loadClientErrors(true);
  } catch (err) {
    showToast('Failed to delete: ' + err.message, 'error');
    btn.disabled = false;
    btn.textContent = original;
  }
}

function wireClientErrorControls() {
  const refreshBtn = document.getElementById('admin-clienterr-refresh');
  if (refreshBtn) refreshBtn.addEventListener('click', () => loadClientErrors(true));

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

  const tbody = document.getElementById('admin-clienterr-tbody');
  if (tbody) {
    tbody.addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-id]');
      if (!tr) return;
      const id = tr.dataset.id;
      if (e.target.classList.contains('clienterr-toggle-btn')) {
        const resolved = tr.querySelector('.badge')?.textContent === 'Resolved';
        toggleResolved(id, resolved, e.target);
      } else if (e.target.classList.contains('clienterr-delete-btn')) {
        deleteError(id, e.target);
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

import { showToast } from './toast.js';

// Admin → Workspaces management tab.
// Powered by the server-side admin endpoints (/api/admin/stats + /api/admin/workspaces),
// which use Firestore count() aggregations and pagination — so this stays cheap at scale,
// unlike full-collection client-side reads.

let auth = null;
let cursor = null;
let rowsShown = 0;
let loading = false;
let hasLoaded = false;

export function initAdminWorkspaces(authInstance) {
  auth = authInstance;

  const tab = document.querySelector('.admin-tab[data-target="admin-pane-workspaces"]');
  if (tab) tab.addEventListener('click', () => { if (!hasLoaded) loadAll(); });

  const refresh = document.getElementById('admin-ws-refresh');
  if (refresh) refresh.addEventListener('click', () => loadAll());

  const more = document.getElementById('admin-ws-load-more');
  if (more) more.addEventListener('click', () => loadWorkspaces(false));
}

async function apiGet(path) {
  const token = auth && auth.currentUser ? await auth.currentUser.getIdToken() : null;
  const res = await fetch(path, { headers: { 'Authorization': `Bearer ${token}` } });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.error || `Request failed (${res.status})`);
  }
  return res.json();
}

async function loadAll() {
  hasLoaded = true;
  await Promise.all([loadStats(), loadWorkspaces(true)]);
}

async function loadStats() {
  try {
    const s = await apiGet('/api/admin/stats');
    setText('admin-ws-total', s.totalWorkspaces);
    setText('admin-ws-users', s.totalUsers);
    setText('admin-ws-conns', s.totalConnectedAccounts);
    setText('admin-ws-active', s.totalActiveConfigs);
    setText('admin-ws-paid', s.paidWorkspaces);
  } catch (err) {
    showToast('Failed to load admin stats: ' + err.message, 'error');
  }
}

async function loadWorkspaces(reset) {
  if (loading) return;
  loading = true;

  const tbody = document.getElementById('admin-ws-tbody');
  const moreBtn = document.getElementById('admin-ws-load-more');
  if (reset) {
    cursor = null;
    rowsShown = 0;
    if (tbody) tbody.innerHTML = '';
  }

  try {
    const q = cursor
      ? `?limit=50&startAfter=${encodeURIComponent(cursor)}`
      : '?limit=50';
    const { items, nextCursor } = await apiGet('/api/admin/workspaces' + q);

    if (reset && items.length === 0) {
      if (tbody) tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:20px;color:var(--text-3);">No workspaces.</td></tr>';
    } else if (tbody) {
      for (const w of items) {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td data-label="Name"><strong>${esc(w.name || '—')}</strong></td>
          <td data-label="Owner"><code style="font-size:0.82rem;">${esc(w.ownerId || '—')}</code></td>
          <td data-label="Plan"><span class="badge badge-info">${esc(w.planId)}</span></td>
          <td data-label="Members">${Number(w.memberCount) || 0}</td>
          <td data-label="ID"><code style="font-size:0.82rem;">${esc(w.id)}</code></td>`;
        tbody.appendChild(tr);
      }
      rowsShown += items.length;
    }

    cursor = nextCursor;
    if (moreBtn) moreBtn.style.display = nextCursor ? 'inline-flex' : 'none';
    setText('admin-ws-count', `${rowsShown} shown`);
  } catch (err) {
    showToast('Failed to load workspaces: ' + err.message, 'error');
  } finally {
    loading = false;
  }
}

function setText(id, v) {
  const el = document.getElementById(id);
  if (el) el.textContent = (v === null || v === undefined) ? '—' : v;
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

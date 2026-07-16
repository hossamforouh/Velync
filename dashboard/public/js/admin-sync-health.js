import { showToast } from './toast.js';
import { getSkeletonTableHTML } from './loading-components.js';

// Admin → Overview → "Recent Executions" (merged from the former standalone
// Sync Health tab — its summary stats duplicated numbers Overview's own
// stats bar already showed; this collapsible section keeps the one thing it
// added that Overview didn't have, the per-run execution log table, and
// stays lazily loaded so it doesn't add cost to Overview's initial paint.
// Reads /api/admin/sync-health (bounded, server-side).

let auth = null;
let hasLoaded = false;

export function initAdminSyncHealth(authInstance) {
  auth = authInstance;

  const toggleBtn = document.getElementById('admin-sh-toggle');
  const body = document.getElementById('admin-sh-body');
  const icon = document.getElementById('admin-sh-toggle-icon');
  if (toggleBtn && body) {
    toggleBtn.addEventListener('click', () => {
      const isOpen = body.style.display !== 'none';
      body.style.display = isOpen ? 'none' : 'block';
      if (icon) icon.style.transform = isOpen ? '' : 'rotate(180deg)';
      if (!isOpen && !hasLoaded) load();
    });
  }

  const refresh = document.getElementById('admin-sh-refresh');
  if (refresh) refresh.addEventListener('click', () => load());
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

async function load() {
  hasLoaded = true;
  const tbody = document.getElementById('admin-sh-tbody');
  if (!tbody) return;
  tbody.innerHTML = getSkeletonTableHTML(6, 4);
  try {
    const { recent } = await apiGet('/api/admin/sync-health?limit=100');

    if (!recent.length) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:20px;color:var(--text-3);">No recent executions.</td></tr>';
      return;
    }

    tbody.innerHTML = '';
    for (const l of recent) {
      const st = l.status || 'unknown';
      const badge = st === 'success' ? 'badge-success' : (st === 'running' ? 'badge-info' : 'badge-failed');
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td data-label="Config"><strong>${esc(l.configName || l.configId || '—')}</strong></td>
        <td data-label="Workspace"><code style="font-size:0.8rem;">${esc(l.workspaceId || '—')}</code></td>
        <td data-label="Status"><span class="badge ${badge}">${esc(st)}</span></td>
        <td data-label="Started">${esc(fmtDate(l.startTime))}</td>
        <td data-label="Results">${num(l.syncedCount)} ✓ / ${num(l.deletedCount)} ⌫ / ${num(l.failedCount)} ✕</td>
        <td data-label="Error"><span style="color:var(--text-3);font-size:0.8rem;">${esc((l.error || '').substring(0, 80))}</span></td>`;
      tbody.appendChild(tr);
    }
  } catch (err) {
    showToast('Failed to load sync health: ' + err.message, 'error');
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:20px;color:var(--rose);">${esc(err.message)}</td></tr>`;
  }
}

function num(v) { return Number(v) || 0; }
function fmtDate(t) {
  if (!t) return '—';
  try { return new Date(t).toLocaleString(); } catch { return String(t); }
}
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

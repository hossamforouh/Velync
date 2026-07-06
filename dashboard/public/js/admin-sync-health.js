import { showToast } from './toast.js';

// Admin → Sync Health tab. Reads /api/admin/sync-health (bounded, server-side)
// and shows a status summary plus the most recent execution logs across all workspaces.

let auth = null;
let hasLoaded = false;

export function initAdminSyncHealth(authInstance) {
  auth = authInstance;

  const tab = document.querySelector('.admin-tab[data-target="admin-pane-sync-health"]');
  if (tab) tab.addEventListener('click', () => { if (!hasLoaded) load(); });

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
  try {
    const { summary, recent } = await apiGet('/api/admin/sync-health?limit=100');

    const success = summary.byStatus.success || 0;
    const errors = (summary.byStatus.error || 0) + (summary.byStatus.failed || 0);
    setText('admin-sh-total', summary.total);
    setText('admin-sh-success', success);
    setText('admin-sh-errors', errors);
    setText('admin-sh-rate', summary.total > 0 ? `${Math.round((success / summary.total) * 100)}%` : '—');

    if (!tbody) return;
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
    if (tbody) tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:20px;color:var(--rose);">${esc(err.message)}</td></tr>`;
  }
}

function num(v) { return Number(v) || 0; }
function fmtDate(t) {
  if (!t) return '—';
  try { return new Date(t).toLocaleString(); } catch { return String(t); }
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

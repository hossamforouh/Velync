import { showToast } from './toast.js';

// Admin → Usage tab: per-user-per-month activity counts and estimated cost,
// served by /api/admin/usage* (usage_summaries aggregates — never a raw
// usage_events scan client-side). Dollar figures are estimates (count ×
// configured rate) and are labeled as such everywhere they appear.

let auth = null;
let hasLoaded = false;
let currentMonth = '';
let currentData = null; // last /api/admin/usage response (all users)

const TYPE_LABELS = {
  sync_execution: 'Sync Executions',
  compute_estimate: 'Compute (ms)',
  api_call: 'Platform API Calls',
  firestore_read: 'Firestore Reads',
  firestore_write: 'Firestore Writes',
  firestore_delete: 'Firestore Deletes',
  user_login: 'Logins',
  workspace_created: 'Workspaces Created',
  member_invited: 'Members Invited',
  flow_created: 'Flows Created',
  field_mapping_changed: 'Field Mapping Changes',
  platform_connected: 'Platforms Connected',
};

export function initAdminUsage(authInstance) {
  auth = authInstance;

  const tab = document.querySelector('.admin-tab[data-target="admin-pane-usage"]');
  if (tab) tab.addEventListener('click', () => { if (!hasLoaded) load(); });

  const monthInput = document.getElementById('admin-usage-month');
  if (monthInput) {
    monthInput.value = new Date().toISOString().slice(0, 7);
    monthInput.addEventListener('change', () => load());
  }

  const userSelect = document.getElementById('admin-usage-user');
  if (userSelect) userSelect.addEventListener('change', () => render());

  const refresh = document.getElementById('admin-usage-refresh');
  if (refresh) refresh.addEventListener('click', () => load());

  const exportBtn = document.getElementById('admin-usage-export');
  if (exportBtn) exportBtn.addEventListener('click', () => exportCsv());
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

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtCost(v) {
  if (v === null || v === undefined) return '—';
  if (v === 0) return '$0.00';
  // Per-unit Firestore rates are tiny — show enough precision to be meaningful
  // (a single sync execution is ~$0.0000004 and must not render as $0.000000).
  if (v < 0.000001) return `$${v.toFixed(9)}`;
  return v < 0.01 ? `$${v.toFixed(6)}` : `$${v.toFixed(2)}`;
}

function fmtCount(v) {
  return Number(v || 0).toLocaleString();
}

async function load() {
  const tbody = document.getElementById('admin-usage-tbody');
  currentMonth = document.getElementById('admin-usage-month')?.value || new Date().toISOString().slice(0, 7);
  if (tbody) tbody.innerHTML = '<tr><td style="text-align:center;padding:20px;color:var(--text-3);">Loading…</td></tr>';
  try {
    currentData = await apiGet(`/api/admin/usage?month=${encodeURIComponent(currentMonth)}`);
    hasLoaded = true;

    // Failure banner: usage writes are never allowed to fail silently — the
    // backend counts drops in usage_meta/write_failures and we surface it here.
    const banner = document.getElementById('admin-usage-failure-banner');
    if (banner) {
      const wf = currentData.writeFailures;
      if (wf && wf.count > 0) {
        banner.style.display = 'block';
        banner.textContent = `⚠ ${wf.count} usage event(s) failed to record (last: "${wf.lastActivityType}" at ${wf.lastAt} — ${wf.lastError}). Cost totals for this period may be undercounted.`;
      } else {
        banner.style.display = 'none';
      }
    }

    // Rebuild the user picker, preserving the current selection when possible.
    const userSelect = document.getElementById('admin-usage-user');
    if (userSelect) {
      const prev = userSelect.value;
      userSelect.innerHTML = '<option value="">All users</option>' +
        currentData.users.map(u =>
          `<option value="${escapeHtml(u.userId)}">${escapeHtml(u.email || u.userId)}</option>`
        ).join('');
      if ([...userSelect.options].some(o => o.value === prev)) userSelect.value = prev;
    }

    render();
  } catch (err) {
    if (tbody) tbody.innerHTML = `<tr><td style="text-align:center;padding:20px;color:var(--red,#ef4444);">${escapeHtml(err.message)}</td></tr>`;
    showToast('Failed to load usage data: ' + err.message, 'error');
  }
}

function render() {
  if (!currentData) return;
  const selectedUser = document.getElementById('admin-usage-user')?.value || '';
  if (selectedUser) renderUserBreakdown(selectedUser);
  else renderLeaderboard();
}

// All-users view: one row per user, count+cost for the cost-driving types.
function renderLeaderboard() {
  const thead = document.getElementById('admin-usage-thead');
  const tbody = document.getElementById('admin-usage-tbody');
  const { users, activityTypes } = currentData;

  const costTypes = activityTypes.filter(t => t.costDriving).map(t => t.type);
  thead.innerHTML = `<tr><th>User</th>${costTypes.map(t => `<th>${escapeHtml(TYPE_LABELS[t] || t)}</th>`).join('')}<th>Total Cost (est.)</th></tr>`;

  if (!users.length) {
    tbody.innerHTML = `<tr><td colspan="${costTypes.length + 2}" style="text-align:center;padding:20px;color:var(--text-3);">No usage recorded for ${escapeHtml(currentMonth)}.</td></tr>`;
    return;
  }

  tbody.innerHTML = users.map(u => `
    <tr>
      <td>${escapeHtml(u.email || u.userId)}</td>
      ${costTypes.map(t => {
        const cell = u.totals[t];
        return `<td>${fmtCount(cell.count)}<span style="color:var(--text-3);font-size:0.78rem;"> · ${fmtCost(cell.costUsd)}</span></td>`;
      }).join('')}
      <td><strong>${fmtCost(u.grandTotalCostUsd)}</strong></td>
    </tr>
  `).join('');
}

// Single-user view: one row per activity type with count and estimated $ side
// by side (both always visible for firestore_read/write/delete — never one or
// the other).
function renderUserBreakdown(userId) {
  const thead = document.getElementById('admin-usage-thead');
  const tbody = document.getElementById('admin-usage-tbody');
  const user = currentData.users.find(u => u.userId === userId);
  if (!user) {
    thead.innerHTML = '';
    tbody.innerHTML = `<tr><td style="text-align:center;padding:20px;color:var(--text-3);">No usage recorded for this user in ${escapeHtml(currentMonth)}.</td></tr>`;
    return;
  }

  thead.innerHTML = '<tr><th>Activity</th><th>Count</th><th>Estimated Cost</th></tr>';
  const rows = currentData.activityTypes.map(({ type, costDriving }) => {
    const cell = user.totals[type];
    const costLabel = costDriving ? fmtCost(cell.costUsd) : '<span style="color:var(--text-3);">— (no direct cost)</span>';
    return `
      <tr>
        <td>${escapeHtml(TYPE_LABELS[type] || type)}${costDriving ? ' <span style="color:var(--text-3);font-size:0.75rem;">(est.)</span>' : ''}</td>
        <td>${fmtCount(cell.count)}</td>
        <td>${costLabel}</td>
      </tr>`;
  }).join('');

  tbody.innerHTML = rows + `
    <tr>
      <td><strong>Grand Total (est.)</strong></td>
      <td></td>
      <td><strong>${fmtCost(user.grandTotalCostUsd)}</strong></td>
    </tr>`;
}

async function exportCsv() {
  const btn = document.getElementById('admin-usage-export');
  const month = document.getElementById('admin-usage-month')?.value || new Date().toISOString().slice(0, 7);
  if (btn) btn.disabled = true;
  try {
    const token = auth && auth.currentUser ? await auth.currentUser.getIdToken() : null;
    const res = await fetch(`/api/admin/usage/export?month=${encodeURIComponent(month)}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(e.error || `Export failed (${res.status})`);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `usage-${month}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    showToast('CSV export failed: ' + err.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

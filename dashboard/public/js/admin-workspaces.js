import { showToast } from './toast.js';
import { fmtCost, renderUsageStatCardsHtml } from './usage-format.js';

// Admin → Workspaces management tab.
// Powered by the server-side admin endpoints (/api/admin/stats + /api/admin/workspaces),
// which use Firestore count() aggregations and pagination — so this stays cheap at scale,
// unlike full-collection client-side reads.

let auth = null;
let cursor = null;
let rowsShown = 0;
let loading = false;
let hasLoaded = false;
let searchTerm = '';
let searchDebounce = null;
let plansCache = null;

export function initAdminWorkspaces(authInstance) {
  auth = authInstance;

  const tab = document.querySelector('.admin-tab[data-target="admin-pane-workspaces"]');
  if (tab) tab.addEventListener('click', () => { if (!hasLoaded) loadAll(); });

  const refresh = document.getElementById('admin-ws-refresh');
  if (refresh) refresh.addEventListener('click', () => loadAll());

  const more = document.getElementById('admin-ws-load-more');
  if (more) more.addEventListener('click', () => loadWorkspaces(false));

  const search = document.getElementById('admin-ws-search');
  if (search) {
    search.addEventListener('input', () => {
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => {
        searchTerm = search.value.trim();
        loadWorkspaces(true);
      }, 300);
    });
  }

  const modalOverlay = document.getElementById('ws-usage-modal-overlay');
  const modalClose = document.getElementById('ws-usage-modal-close');
  if (modalClose) modalClose.addEventListener('click', closeUsageModal);
  if (modalOverlay) modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeUsageModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeUsageModal(); });
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

async function apiPatch(path, body) {
  const token = auth && auth.currentUser ? await auth.currentUser.getIdToken() : null;
  const res = await fetch(path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

async function openPlanEditor(tr, workspace) {
  const cell = tr.querySelector('.plan-display')?.closest('td');
  if (!cell) return;
  const originalHtml = cell.innerHTML;

  cell.innerHTML = `<span style="color:var(--text-3);font-size:0.82rem;">Loading…</span>`;
  try {
    if (!plansCache) plansCache = await apiGet('/api/admin/plans');
  } catch (err) {
    showToast('Failed to load plans: ' + err.message, 'error');
    cell.innerHTML = originalHtml;
    return;
  }

  cell.innerHTML = `
    <div style="display:flex;align-items:center;gap:4px;">
      <select class="admin-input plan-select" style="padding:4px 6px;font-size:0.82rem;">
        ${plansCache.map(p => `<option value="${p.id}" ${p.id === workspace.planId ? 'selected' : ''}>${p.name}</option>`).join('')}
      </select>
      <button class="row-action-btn btn-confirm-plan" type="button" title="Save">✓</button>
      <button class="row-action-btn btn-cancel-plan" type="button" title="Cancel">✕</button>
    </div>
  `;

  cell.querySelector('.btn-cancel-plan').addEventListener('click', () => { cell.innerHTML = originalHtml; });
  cell.querySelector('.btn-confirm-plan').addEventListener('click', async () => {
    const newPlanId = cell.querySelector('.plan-select').value;
    if (newPlanId === workspace.planId) { cell.innerHTML = originalHtml; return; }
    try {
      await apiPatch(`/api/admin/workspaces/${workspace.id}/plan`, { planId: newPlanId });
      workspace.planId = newPlanId;
      cell.innerHTML = `<span class="badge badge-info plan-display">${esc(newPlanId)}</span>`;
      showToast(`Workspace moved to "${newPlanId}"`, 'success');
    } catch (err) {
      showToast('Failed to change plan: ' + err.message, 'error');
      cell.innerHTML = originalHtml;
    }
  });
}

// Opens a modal with a stat-card breakdown of one workspace's usage/cost for
// the current month, scoped to /api/admin/usage/workspace/:id — which sums
// ALL of that workspace's members (usage_workspace_summaries is incremented
// alongside the per-user summary — see src/domains/usage/index.js). Always
// clickable regardless of whether the workspace currently has any cost —
// showing an all-zeros modal is still useful (confirms nothing's wrong,
// rather than the cell looking inert either way).
async function openUsageModal(workspace) {
  const overlay = document.getElementById('ws-usage-modal-overlay');
  const title = document.getElementById('ws-usage-modal-title');
  const subtitle = document.getElementById('ws-usage-modal-subtitle');
  const body = document.getElementById('ws-usage-modal-body');
  if (!overlay || !body) return;

  title.textContent = workspace.name || workspace.id;
  subtitle.textContent = 'Loading…';
  body.innerHTML = '<p style="text-align:center;padding:30px;color:var(--text-3);">Loading usage…</p>';
  overlay.classList.add('open');

  try {
    const month = new Date().toISOString().slice(0, 7);
    const data = await apiGet(`/api/admin/usage/workspace/${encodeURIComponent(workspace.id)}?month=${month}`);
    subtitle.textContent = `${data.month} — all members combined`;
    body.innerHTML = renderUsageStatCardsHtml(data.activityTypes, data.workspace);
  } catch (err) {
    subtitle.textContent = '';
    body.innerHTML = `<p style="text-align:center;padding:30px;color:var(--red,#ef4444);">Failed to load usage: ${esc(err.message)}</p>`;
  }
}

function closeUsageModal() {
  const overlay = document.getElementById('ws-usage-modal-overlay');
  if (overlay) overlay.classList.remove('open');
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
    const params = new URLSearchParams({ limit: '50' });
    if (cursor) params.set('startAfter', cursor);
    if (searchTerm) params.set('search', searchTerm);
    const { items, nextCursor } = await apiGet('/api/admin/workspaces?' + params.toString());

    if (reset && items.length === 0) {
      if (tbody) tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:20px;color:var(--text-3);">${searchTerm ? 'No workspaces match your search.' : 'No workspaces.'}</td></tr>`;
    } else if (tbody) {
      for (const w of items) {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td data-label="Name"><strong>${esc(w.name || '—')}</strong></td>
          <td data-label="Owner"><code style="font-size:0.82rem;">${esc(w.ownerId || '—')}</code></td>
          <td data-label="Plan"><span class="badge badge-info plan-display">${esc(w.planId)}</span></td>
          <td data-label="Members">${Number(w.memberCount) || 0}</td>
          <td data-label="Est. Cost (mo)"><button class="row-action-btn btn-ws-usage" type="button" title="View usage breakdown" style="width:auto;padding:2px 8px;font-size:0.82rem;">${esc(fmtCost(w.estimatedCostUsd ?? 0))}</button></td>
          <td data-label="ID"><code style="font-size:0.82rem;">${esc(w.id)}</code></td>
          <td data-label="Actions"><button class="row-action-btn btn-change-plan" type="button" title="Change Plan">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg>
          </button></td>`;
        tbody.appendChild(tr);
        tr.querySelector('.btn-change-plan').addEventListener('click', () => openPlanEditor(tr, w));
        tr.querySelector('.btn-ws-usage').addEventListener('click', () => openUsageModal(w));
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

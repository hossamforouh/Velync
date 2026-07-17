import { showToast } from './toast.js';
import { fmtCost, renderUsageStatCardsHtml } from './usage-format.js';
import { getSkeletonCardGridHTML, getSkeletonTableHTML, getEmptyStateRowHTML } from './loading-components.js';
import { wireRowActionsMenus } from './row-actions-menu.js';

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
  const searchClear = document.getElementById('admin-ws-search-clear');
  if (search) {
    search.addEventListener('input', () => {
      if (searchClear) searchClear.style.display = search.value ? 'flex' : 'none';
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => {
        searchTerm = search.value.trim();
        loadWorkspaces(true);
      }, 300);
    });
    if (searchClear) {
      searchClear.addEventListener('click', () => {
        search.value = '';
        searchTerm = '';
        loadWorkspaces(true);
        searchClear.style.display = 'none';
      });
    }
  }

  const modalOverlay = document.getElementById('ws-usage-modal-overlay');
  const modalClose = document.getElementById('ws-usage-modal-close');
  if (modalClose) modalClose.addEventListener('click', closeUsageModal);
  if (modalOverlay) modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeUsageModal(); });

  const planModalOverlay = document.getElementById('ws-plan-modal-overlay');
  const planModalCancel = document.getElementById('ws-plan-modal-cancel');
  const planModalConfirm = document.getElementById('ws-plan-modal-confirm');
  if (planModalCancel) planModalCancel.addEventListener('click', closePlanModal);
  if (planModalOverlay) planModalOverlay.addEventListener('click', (e) => { if (e.target === planModalOverlay) closePlanModal(); });
  if (planModalConfirm) planModalConfirm.addEventListener('click', confirmPlanChange);

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    closeUsageModal();
    closePlanModal();
  });
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

let planModalWorkspace = null;
let planModalCell = null;

async function openPlanEditor(tr, workspace) {
  const cell = tr.querySelector('.plan-display')?.closest('td');
  if (!cell) return;

  const overlay = document.getElementById('ws-plan-modal-overlay');
  const nameEl = document.getElementById('ws-plan-modal-name');
  const select = document.getElementById('ws-plan-modal-select');
  const confirmBtn = document.getElementById('ws-plan-modal-confirm');
  if (!overlay || !select) return;

  planModalWorkspace = workspace;
  planModalCell = cell;
  nameEl.textContent = workspace.name || workspace.id;
  select.innerHTML = `<option>Loading…</option>`;
  select.disabled = true;
  confirmBtn.disabled = true;
  overlay.classList.add('open');

  try {
    if (!plansCache) plansCache = await apiGet('/api/admin/plans');
    select.innerHTML = plansCache.map(p => `<option value="${p.id}" ${p.id === workspace.planId ? 'selected' : ''}>${p.name}</option>`).join('');
    select.disabled = false;
    confirmBtn.disabled = false;
  } catch (err) {
    showToast('Failed to load plans: ' + err.message, 'error');
    closePlanModal();
  }
}

function closePlanModal() {
  const overlay = document.getElementById('ws-plan-modal-overlay');
  if (overlay) overlay.classList.remove('open');
  planModalWorkspace = null;
  planModalCell = null;
}

async function confirmPlanChange() {
  const workspace = planModalWorkspace;
  const cell = planModalCell;
  const select = document.getElementById('ws-plan-modal-select');
  const confirmBtn = document.getElementById('ws-plan-modal-confirm');
  if (!workspace || !cell || !select) return;

  const newPlanId = select.value;
  if (newPlanId === workspace.planId) { closePlanModal(); return; }

  confirmBtn.disabled = true;
  confirmBtn.textContent = 'Saving…';
  try {
    await apiPatch(`/api/admin/workspaces/${workspace.id}/plan`, { planId: newPlanId });
    workspace.planId = newPlanId;
    const display = cell.querySelector('.plan-display');
    if (display) display.textContent = newPlanId;
    showToast(`Workspace moved to "${newPlanId}"`, 'success');
    closePlanModal();
  } catch (err) {
    showToast('Failed to change plan: ' + err.message, 'error');
  } finally {
    confirmBtn.disabled = false;
    confirmBtn.textContent = 'Save';
  }
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
  body.innerHTML = getSkeletonCardGridHTML(4);
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
    if (tbody) tbody.innerHTML = getSkeletonTableHTML(7, 5);
  }

  try {
    const params = new URLSearchParams({ limit: '50' });
    if (cursor) params.set('startAfter', cursor);
    if (searchTerm) params.set('search', searchTerm);
    const { items, nextCursor } = await apiGet('/api/admin/workspaces?' + params.toString());

    if (reset && items.length === 0) {
      if (tbody) tbody.innerHTML = getEmptyStateRowHTML({
        colspan: 7,
        iconSvg: '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="color: var(--violet);"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>',
        title: searchTerm ? 'No matching workspaces' : 'No workspaces yet',
        message: searchTerm
          ? `No workspaces match "${esc(searchTerm)}". Try a different search term.`
          : 'Workspaces will show up here once users sign up.',
      });
    } else if (tbody) {
      // On a reset load, the skeleton rows set above are still sitting in the
      // DOM — appendChild() below would stack real rows underneath them
      // instead of replacing them, which is exactly what was happening.
      if (reset) tbody.innerHTML = '';
      for (const w of items) {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td data-label="Name"><strong>${esc(w.name || '—')}</strong></td>
          <td data-label="Owner"><code style="font-size:0.82rem;">${esc(w.ownerId || '—')}</code></td>
          <td data-label="Plan"><span class="badge badge-info plan-display">${esc(w.planId)}</span></td>
          <td data-label="Members">${Number(w.memberCount) || 0}</td>
          <td data-label="Est. Cost (mo)"><button class="row-action-btn btn-ws-usage" type="button" title="View usage breakdown" style="width:auto;padding:2px 8px;font-size:0.82rem;">${esc(fmtCost(w.estimatedCostUsd ?? 0))}</button></td>
          <td data-label="ID"><code style="font-size:0.82rem;">${esc(w.id)}</code></td>
          <td data-label="Actions">
            <div class="row-actions-dropdown">
              <button class="row-action-btn btn-row-more" type="button" title="More actions">⋮</button>
              <div class="row-actions-menu">
                <button class="row-action-menu-item btn-change-plan" type="button">
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg>
                  Change Plan
                </button>
              </div>
            </div>
          </td>`;
        tbody.appendChild(tr);
        tr.querySelector('.btn-change-plan').addEventListener('click', () => openPlanEditor(tr, w));
        tr.querySelector('.btn-ws-usage').addEventListener('click', () => openUsageModal(w));
      }
      rowsShown += items.length;
      wireRowActionsMenus();
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

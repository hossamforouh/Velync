import { navigateTo } from './navigation.js';
import { showToast } from './toast.js';

let auth = null;
let allPlans = [];
let editingPlan = null; // null = create mode, plan object = edit mode

export function initAdminPlans(dbInstance, authInstance) {
  auth = authInstance;

  const btnRefresh = document.getElementById('admin-plans-refresh-btn');
  if (btnRefresh) btnRefresh.addEventListener('click', () => loadPlans());

  const btnNewPlan = document.getElementById('btn-new-plan');
  if (btnNewPlan) btnNewPlan.addEventListener('click', () => openPlanEditor(null));

  // Wire the editor panel's buttons here (not on DOMContentLoaded — this
  // module is lazy-imported well after that event has already fired, so a
  // listener registered there would never attach; Save/Cancel/Close were
  // dead as a result).
  const btnClose = document.getElementById('plan-editor-close');
  const btnCancel = document.getElementById('btn-plan-cancel');
  const form = document.getElementById('plan-editor-form');
  if (btnClose && !btnClose.dataset.wired) { btnClose.dataset.wired = 'true'; btnClose.addEventListener('click', closePlanEditor); }
  if (btnCancel && !btnCancel.dataset.wired) { btnCancel.dataset.wired = 'true'; btnCancel.addEventListener('click', closePlanEditor); }
  if (form && !form.dataset.wired) { form.dataset.wired = 'true'; form.addEventListener('submit', onSavePlan); }

  loadPlans();
}

async function apiRequest(path, options = {}) {
  const token = auth && auth.currentUser ? await auth.currentUser.getIdToken() : null;
  const res = await fetch(path, {
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

async function loadPlans() {
  const tbody = document.getElementById('admin-plans-tbody');
  if (!tbody) return;

  try {
    allPlans = await apiRequest('/api/admin/plans');
    renderPlans();
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:20px;color:var(--rose);">
      Failed to load plans: ${escHtml(err.message)} —
      <a href="#" id="admin-plans-retry" style="color:var(--violet);">Retry</a>
    </td></tr>`;
    const retryLink = document.getElementById('admin-plans-retry');
    if (retryLink) retryLink.addEventListener('click', (e) => { e.preventDefault(); loadPlans(); });
  }
}

function renderPlans() {
  const tbody = document.getElementById('admin-plans-tbody');
  if (!tbody) return;

  if (allPlans.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:20px;color:var(--text-3);">No plans configured yet. Click "+ New Plan" to create your first one.</td></tr>';
    const countEl = document.getElementById('admin-plans-count');
    if (countEl) countEl.textContent = '';
    return;
  }

  tbody.innerHTML = '';
  allPlans.forEach(p => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td data-label="ID"><code style="font-size:0.85rem;">${escHtml(p.id)}</code></td>
      <td data-label="Name"><strong>${escHtml(p.name)}</strong></td>
      <td data-label="Price">${p.priceMonthly === 0 ? 'Free' : `$${p.priceMonthly}/mo · $${p.priceAnnual}/yr`}</td>
      <td data-label="Configs">${p.maxActiveConfigs}</td>
      <td data-label="Interval">${p.minSyncIntervalMinutes} min</td>
      <td data-label="Items">${p.maxItemsPerRun}</td>
      <td data-label="Status">
        <span class="badge ${p.isActive ? 'badge-success' : 'badge-warning'}">${p.isActive ? 'Active' : 'Inactive'}</span>
        ${p.isDefault ? '<span class="badge badge-info" style="margin-left:4px;">Default</span>' : ''}
      </td>
      <td data-label="Actions" class="col-actions">
        <button class="row-action-btn edit-plan-btn" data-id="${p.id}" type="button" title="Edit Plan">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg>
        </button>
        <button class="row-action-btn toggle-plan-btn" data-id="${p.id}" type="button" title="${p.isActive ? 'Deactivate' : 'Activate'} Plan">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>
        </button>
      </td>
    `;
    tbody.appendChild(tr);

    tr.querySelector('.edit-plan-btn').addEventListener('click', () => openPlanEditor(p));
    tr.querySelector('.toggle-plan-btn').addEventListener('click', () => togglePlan(p.id));
  });

  const countEl = document.getElementById('admin-plans-count');
  if (countEl) countEl.textContent = `${allPlans.length} plan(s)`;
}

function openPlanEditor(plan) {
  editingPlan = plan || null;
  document.getElementById('plan-editor-panel-title').textContent = plan ? 'Edit Plan' : 'Create New Plan';

  const idDisplay = document.getElementById('plan-editor-id-display');
  if (idDisplay) {
    idDisplay.textContent = plan ? `ID: ${plan.id}` : '';
    idDisplay.style.display = plan ? 'block' : 'none';
  }

  document.getElementById('f-plan-name').value = plan ? plan.name : '';
  document.getElementById('f-plan-desc').value = plan ? (plan.description || '') : '';
  document.getElementById('f-plan-price-monthly').value = plan ? plan.priceMonthly : 0;
  document.getElementById('f-plan-price-annual').value = plan ? plan.priceAnnual : 0;
  document.getElementById('f-plan-stripe-monthly').value = plan ? (plan.stripePriceIdMonthly || '') : '';
  document.getElementById('f-plan-stripe-annual').value = plan ? (plan.stripePriceIdAnnual || '') : '';
  document.getElementById('f-plan-max-configs').value = plan ? plan.maxActiveConfigs : 1;
  document.getElementById('f-plan-min-interval').value = plan ? plan.minSyncIntervalMinutes : 30;
  document.getElementById('f-plan-max-items').value = plan ? plan.maxItemsPerRun : 100;
  document.getElementById('f-plan-log-retention').value = plan ? plan.logRetentionDays : 7;
  document.getElementById('f-plan-connector-tiers').value = plan ? (plan.connectorTiers || ['basic']).join(', ') : 'basic';
  document.getElementById('f-plan-is-default').checked = plan ? !!plan.isDefault : false;

  navigateTo('admin-plan-editor');
  window.scrollTo(0, 0);
}

function closePlanEditor() {
  editingPlan = null;
  navigateTo('admin');
  loadPlans();
}

async function onSavePlan(e) {
  e.preventDefault();
  const isNew = !editingPlan;

  const data = {
    name: document.getElementById('f-plan-name').value.trim(),
    description: document.getElementById('f-plan-desc').value.trim(),
    priceMonthly: parseFloat(document.getElementById('f-plan-price-monthly').value) || 0,
    priceAnnual: parseFloat(document.getElementById('f-plan-price-annual').value) || 0,
    stripePriceIdMonthly: document.getElementById('f-plan-stripe-monthly').value.trim(),
    stripePriceIdAnnual: document.getElementById('f-plan-stripe-annual').value.trim(),
    maxActiveConfigs: parseInt(document.getElementById('f-plan-max-configs').value) || 1,
    minSyncIntervalMinutes: parseInt(document.getElementById('f-plan-min-interval').value) || 30,
    maxItemsPerRun: parseInt(document.getElementById('f-plan-max-items').value) || 100,
    logRetentionDays: parseInt(document.getElementById('f-plan-log-retention').value) || 7,
    connectorTiers: document.getElementById('f-plan-connector-tiers').value.split(',').map(s => s.trim()).filter(Boolean),
    isDefault: document.getElementById('f-plan-is-default').checked,
  };

  if (!data.name) {
    showToast('Plan Name is required', 'error');
    return;
  }

  const btnSave = document.getElementById('btn-plan-save');
  btnSave.disabled = true;
  btnSave.textContent = 'Saving...';

  try {
    if (isNew) {
      // No client-supplied id/sortOrder anymore — the backend generates a
      // stable slug from the name and appends the plan to the end of the
      // sort order automatically.
      await apiRequest('/api/admin/plans', { method: 'POST', body: JSON.stringify(data) });
    } else {
      await apiRequest(`/api/admin/plans/${editingPlan.id}`, { method: 'PUT', body: JSON.stringify(data) });
    }
    showToast(`Plan ${isNew ? 'created' : 'updated'}`, 'success');
    closePlanEditor();
  } catch (err) {
    showToast('Failed to save plan: ' + err.message, 'error');
  } finally {
    btnSave.disabled = false;
    btnSave.textContent = 'Save';
  }
}

async function togglePlan(planId) {
  try {
    const data = await apiRequest(`/api/admin/plans/${planId}/toggle`, { method: 'PATCH' });
    showToast(`Plan "${planId}" ${data.isActive ? 'activated' : 'deactivated'}`, 'success');
    loadPlans();
  } catch (err) {
    showToast('Failed to toggle plan: ' + err.message, 'error');
  }
}

function escHtml(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

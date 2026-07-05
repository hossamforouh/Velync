import { collection, doc, setDoc, getDoc, getDocs, query, orderBy } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-firestore.js";
import { showToast } from './toast.js';

let firestoreDb = null;
let auth = null;
let allPlans = [];

export function initAdminPlans(dbInstance, authInstance) {
  firestoreDb = dbInstance;
  auth = authInstance;

  const btnRefresh = document.getElementById('admin-plans-refresh-btn');
  if (btnRefresh) btnRefresh.addEventListener('click', () => loadPlans());

  const addForm = document.getElementById('admin-plans-add-form');
  if (addForm) addForm.addEventListener('submit', onCreatePlan);

  loadPlans();
}

async function loadPlans() {
  const tbody = document.getElementById('admin-plans-tbody');
  if (!tbody) return;

  try {
    const snap = await getDocs(query(collection(firestoreDb, 'plans'), orderBy('sortOrder', 'asc')));
    allPlans = [];
    snap.forEach(d => allPlans.push({ id: d.id, ...d.data() }));
    renderPlans();
  } catch (err) {
    showToast('Failed to load plans: ' + err.message, 'error');
  }
}

function renderPlans() {
  const tbody = document.getElementById('admin-plans-tbody');
  if (!tbody) return;

  if (allPlans.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:20px;color:var(--text-3);">No plans configured.</td></tr>';
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
  document.getElementById('plan-editor-panel-title').textContent = plan ? 'Edit Plan' : 'Create New Plan';
  document.getElementById('f-plan-id').value = plan ? plan.id : '';
  document.getElementById('f-plan-id').disabled = !!plan;
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
  document.getElementById('f-plan-sort-order').value = plan ? plan.sortOrder : 99;
  document.getElementById('f-plan-connector-tiers').value = plan ? (plan.connectorTiers || ['basic']).join(', ') : 'basic';
  document.getElementById('f-plan-is-default').checked = plan ? !!plan.isDefault : false;

  const editor = document.getElementById('view-admin-plan-editor');
  if (editor) editor.style.display = 'block';
  document.getElementById('admin-plans-pane').style.display = 'none';
}

function closePlanEditor() {
  document.getElementById('view-admin-plan-editor').style.display = 'none';
  document.getElementById('admin-plans-pane').style.display = 'block';
  loadPlans();
}

// Wire editor buttons
document.addEventListener('DOMContentLoaded', () => {
  const btnClose = document.getElementById('plan-editor-close');
  const btnCancel = document.getElementById('btn-plan-cancel');
  const form = document.getElementById('plan-editor-form');
  if (btnClose) btnClose.addEventListener('click', closePlanEditor);
  if (btnCancel) btnCancel.addEventListener('click', closePlanEditor);
  if (form) form.addEventListener('submit', onSavePlan);
});

async function onSavePlan(e) {
  e.preventDefault();
  const id = document.getElementById('f-plan-id').value.trim();
  const isNew = !id;

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
    sortOrder: parseInt(document.getElementById('f-plan-sort-order').value) || 99,
    connectorTiers: document.getElementById('f-plan-connector-tiers').value.split(',').map(s => s.trim()).filter(Boolean),
    isDefault: document.getElementById('f-plan-is-default').checked,
  };

  const btnSave = document.getElementById('btn-plan-save');
  btnSave.disabled = true;
  btnSave.textContent = 'Saving...';

  try {
    if (isNew) {
      await fetch(`/api/admin/plans`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${await auth.currentUser.getIdToken()}` },
        body: JSON.stringify({ id, ...data }),
      });
    } else {
      await fetch(`/api/admin/plans/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${await auth.currentUser.getIdToken()}` },
        body: JSON.stringify(data),
      });
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

async function onCreatePlan(e) {
  e.preventDefault();
  const input = document.getElementById('f-admin-new-plan-id');
  const id = input.value.trim();
  if (!id) return;
  try {
    const token = await auth.currentUser.getIdToken();
    const res = await fetch(`/api/admin/plans`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ id, name: id.charAt(0).toUpperCase() + id.slice(1) }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to create plan');
    }
    showToast(`Plan "${id}" created — edit it to configure limits`, 'success');
    input.value = '';
    loadPlans();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function togglePlan(planId) {
  try {
    const token = await auth.currentUser.getIdToken();
    const res = await fetch(`/api/admin/plans/${planId}/toggle`, {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) throw new Error('Failed to toggle');
    const data = await res.json();
    showToast(`Plan "${planId}" ${data.isActive ? 'activated' : 'deactivated'}`, 'success');
    loadPlans();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function escHtml(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

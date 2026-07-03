import { collection, doc, setDoc, deleteDoc, getDoc, onSnapshot, query, orderBy, addDoc } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-firestore.js";
import { getSkeletonTableHTML, setButtonLoading } from './loading-components.js';
import { showToast } from './toast.js';

let firestoreDb = null;
let integrationsUnsubscribe = null;
let allIntegrationsCache = [];
let searchTerm = '';
let adminIntegrationsWired = false;

export function initAdminIntegrations(db) {
  firestoreDb = db;
  
  let cachedPlatforms = [];
  onSnapshot(
    query(collection(db, 'platforms'), orderBy('name')),
    (snapshot) => {
      cachedPlatforms = [];
    const p1Select = document.getElementById('f-int-platform1');
    const p2Select = document.getElementById('f-int-platform2');
    
    const p1Val = p1Select.value;
    const p2Val = p2Select.value;

    let optionsHTML = '<option value="" disabled>Select Platform...</option>';
    
    snapshot.forEach(docSnap => {
      const p = docSnap.data();
      p.id = docSnap.id;
      cachedPlatforms.push(p);
      optionsHTML += `<option value="${escAttr(p.id)}">${escHtml(p.name)}</option>`;
    });

    p1Select.innerHTML = optionsHTML;
    p2Select.innerHTML = optionsHTML;

    if (p1Val) p1Select.value = p1Val;
    else p1Select.value = '';

    if (p2Val) p2Select.value = p2Val;
    else p2Select.value = '';
  },
  (err) => {
    console.warn('[admin-integrations] Platforms listener error:', err);
    if (!navigator.onLine) return;
    showToast('Failed to load platforms', 'error');
  });
  
  // Setup Tab Switching Logic
  const tabs = document.querySelectorAll('.admin-tab');
  const panes = document.querySelectorAll('.admin-pane');

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      panes.forEach(p => p.style.display = 'none');
      
      tab.classList.add('active');
      const targetId = tab.getAttribute('data-target');
      const targetPane = document.getElementById(targetId);
      if (targetPane) targetPane.style.display = 'block';

      // Lazy subscribe to integrations when Marketplace tab is shown
      if (targetId === 'admin-pane-marketplace') {
        subscribeIntegrations();
      } else {
        unsubscribeIntegrations();
      }
    });
  });

  // Setup Modal UI elements
  const modalOverlay = document.getElementById('integration-modal-overlay');
  const sidePanel = document.getElementById('integration-side-panel');
  const btnAdd = document.getElementById('btn-admin-add-integration');
  const btnClose = document.getElementById('integration-panel-close');
  const btnCancel = document.getElementById('btn-int-cancel');
  const form = document.getElementById('integration-form');

  // Create inline form error container
  const formErrorEl = document.createElement('div');
  formErrorEl.id = 'form-error-message';
  formErrorEl.style.cssText = 'color: var(--danger); margin-top: 12px; display: none; font-size: 0.9rem;';
  form.appendChild(formErrorEl);

  function openModal(integration = null) {
    if (integration) {
      document.getElementById('integration-panel-title').textContent = 'Edit Integration';
      document.getElementById('f-int-doc-id').value = integration.id || integration._id;
      document.getElementById('f-int-name').value = integration.name || '';
      document.getElementById('f-int-desc').value = integration.description || '';
      document.getElementById('f-int-status').value = integration.status || 'Active';
      document.getElementById('f-int-tags').value = (integration.tags || []).join(', ');

      document.getElementById('f-int-platform1').value = integration.platform1?.id || integration.platform1?.key || '';
      document.getElementById('f-int-platform2').value = integration.platform2?.id || integration.platform2?.key || '';
    } else {
      document.getElementById('integration-panel-title').textContent = 'Add Integration';
      document.getElementById('f-int-doc-id').value = '';
      document.getElementById('f-int-name').value = '';
      document.getElementById('f-int-desc').value = '';
      document.getElementById('f-int-status').value = 'Active';
      document.getElementById('f-int-tags').value = '';

      document.getElementById('f-int-platform1').value = '';
      document.getElementById('f-int-platform2').value = '';
    }
    
    modalOverlay.classList.add('open');
    sidePanel.classList.add('open');
  }

  function closeModal() {
    sidePanel.classList.remove('open');
    modalOverlay.classList.remove('open');
    setTimeout(() => {
      form.reset();
      const fe = document.getElementById('form-error-message');
      if (fe) fe.style.display = 'none';
    }, 300);
  }

  btnAdd.addEventListener('click', () => openModal(null));
  btnClose.addEventListener('click', closeModal);
  btnCancel.addEventListener('click', closeModal);
  modalOverlay.addEventListener('click', closeModal);

  // Form Submit (Save)
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btnSave = document.getElementById('btn-int-save');
    setButtonLoading(btnSave, true);

    try {
      const docId = document.getElementById('f-int-doc-id').value;

      const rawTags = document.getElementById('f-int-tags').value;
      const tagsArray = rawTags.split(',').map(t => t.trim()).filter(t => t.length > 0);

      const integrationData = {
        name: document.getElementById('f-int-name').value.trim(),
        description: document.getElementById('f-int-desc').value.trim(),
        status: document.getElementById('f-int-status').value,
        tags: tagsArray
      };

      const p1Id = document.getElementById('f-int-platform1').value;
      const p1Obj = cachedPlatforms.find(p => p.id === p1Id);
      if (p1Obj) {
        integrationData.platform1 = {
          id: p1Obj.id,
          name: p1Obj.name
        };
      }

      const p2Id = document.getElementById('f-int-platform2').value;
      const p2Obj = cachedPlatforms.find(p => p.id === p2Id);
      if (p2Obj) {
        integrationData.platform2 = {
          id: p2Obj.id,
          name: p2Obj.name
        };
      }

      if (docId) {
        await setDoc(doc(firestoreDb, 'integrations', docId), integrationData, { merge: true });
      } else {
        await addDoc(collection(firestoreDb, 'integrations'), integrationData);
      }
      
      const fe = document.getElementById('form-error-message');
      if (fe) fe.style.display = 'none';
      closeModal();
    } catch (err) {
      console.error("Failed to save integration", err);
      showToast("Error saving integration: " + err.message, 'error');
      const fe = document.getElementById('form-error-message');
      if (fe) {
        fe.textContent = "Error saving integration: " + err.message;
        fe.style.display = 'block';
      }
    } finally {
      setButtonLoading(btnSave, false);
    }
  });

  // Wire admin search
  wireAdminSearch();

  // Wire tab switching logic that's already been set up above
  // The lazy subscription is triggered in the tab click handler
}

// ─── Lazy Subscribe / Unsubscribe ───────────────────────────

function subscribeIntegrations() {
  if (integrationsUnsubscribe) return; // already subscribed

  const tbody = document.getElementById('admin-integrations-tbody');
  if (tbody) tbody.innerHTML = getSkeletonTableHTML(4, 5);

  const q = query(collection(firestoreDb, 'integrations'), orderBy('name'));
  integrationsUnsubscribe = onSnapshot(q, (snapshot) => {
    allIntegrationsCache = [];
    snapshot.forEach(docSnap => {
      allIntegrationsCache.push({ ...docSnap.data(), _id: docSnap.id });
    });
    renderAdminTable();
  }, (err) => {
    console.warn('[admin-integrations] Integrations listener error:', err);
    if (!navigator.onLine) return;
    const tbody = document.getElementById('admin-integrations-tbody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; padding:20px;color:var(--rose);">Failed to load integrations. <a href="#" onclick="location.reload()" style="color:var(--violet);">Reload</a></td></tr>';
    showToast('Failed to load integrations', 'error');
  });
}

function unsubscribeIntegrations() {
  if (integrationsUnsubscribe) {
    integrationsUnsubscribe();
    integrationsUnsubscribe = null;
  }
  allIntegrationsCache = [];
}

// ─── Admin Search ───────────────────────────────────────────

function wireAdminSearch() {
  if (adminIntegrationsWired) return;
  adminIntegrationsWired = true;

  const searchInput = document.getElementById('admin-int-search');
  const searchClear = document.getElementById('admin-int-search-clear');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      if (searchClear) {
        searchClear.style.display = searchInput.value ? 'flex' : 'none';
      }
      clearTimeout(searchInput._timer);
      searchInput._timer = setTimeout(() => {
        searchTerm = searchInput.value.trim();
        renderAdminTable();
      }, 200);
    });

    if (searchClear) {
      searchClear.addEventListener('click', () => {
        searchInput.value = '';
        searchTerm = '';
        renderAdminTable();
        searchClear.style.display = 'none';
      });
    }
  }
}

// ─── Render Admin Table ─────────────────────────────────────

function renderAdminTable() {
  const tbody = document.getElementById('admin-integrations-tbody');
  if (!tbody) return;

  const filtered = searchTerm
    ? allIntegrationsCache.filter(int =>
        (int.name || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
        (int._id || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
        (int.status || '').toLowerCase().includes(searchTerm.toLowerCase())
      )
    : allIntegrationsCache;

  tbody.innerHTML = '';

  if (filtered.length === 0) {
    const msg = searchTerm
      ? `No integrations match "${escHtml(searchTerm)}"`
      : 'No integrations found.';
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;padding:20px;">${msg}</td></tr>`;
    return;
  }

  filtered.forEach(intg => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td data-label="ID" style="font-family:monospace;font-size:0.85rem;color:var(--text-2);">${escHtml(intg._id)}</td>
      <td data-label="Name"><strong>${escHtml(intg.name)}</strong></td>
      <td data-label="Status">
        <span class="badge ${intg.status === 'Active' ? 'badge-success' : 'badge-warning'}">${escHtml(intg.status)}</span>
      </td>
      <td data-label="Actions" class="col-actions">
        <div class="row-actions-group">
          <button class="row-action-btn edit-int-btn" data-id="${intg._id}" type="button" title="Edit Integration"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg></button>
          <button class="row-action-btn del-int-btn" data-id="${intg._id}" type="button" title="Delete Integration"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg></button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);

    tr.querySelector('.edit-int-btn').addEventListener('click', () => {
      const found = allIntegrationsCache.find(i => i._id === intg._id);
      if (found) openModal(found);
    });

    tr.querySelector('.del-int-btn').addEventListener('click', () => {
      showDeleteModal(intg._id, intg.name || intg._id);
    });
  });
}

// ─── Delete Modal Logic ─────────────────────────────────────

let integrationToDelete = null;
const delOverlay = document.getElementById('integration-delete-modal-overlay');
const btnDelCancel = document.getElementById('int-del-modal-cancel');
const btnDelConfirm = document.getElementById('int-del-modal-confirm');
const delName = document.getElementById('int-del-modal-name');

function showDeleteModal(id, displayName) {
  integrationToDelete = id;
  delName.textContent = displayName || id;
  delOverlay.classList.add('open');
}

function hideDeleteModal() {
  integrationToDelete = null;
  delOverlay.classList.remove('open');
}

if (btnDelCancel) btnDelCancel.addEventListener('click', hideDeleteModal);
if (delOverlay) delOverlay.addEventListener('click', (e) => {
  if (e.target === delOverlay) hideDeleteModal();
});

if (btnDelConfirm) {
  btnDelConfirm.addEventListener('click', async () => {
    if (!integrationToDelete) return;
    const id = integrationToDelete;
    
    btnDelConfirm.disabled = true;
    btnDelConfirm.innerHTML = '<span class="spinner" style="width:16px;height:16px;border-width:2px;display:inline-block;vertical-align:middle;margin-right:8px;"></span><span style="vertical-align:middle;">Deleting...</span>';
    
    try {
      const snap = await getDoc(doc(firestoreDb, 'integrations', id));
      const deletedData = snap.exists() ? snap.data() : null;
      await deleteDoc(doc(firestoreDb, 'integrations', id));
      hideDeleteModal();
      showToast('Integration deleted', 'info', {
        actionLabel: 'Undo',
        onAction: async () => {
          if (deletedData) {
            await setDoc(doc(firestoreDb, 'integrations', id), deletedData);
            showToast('Integration restored', 'success');
          }
        }
      });
    } catch (err) {
      console.error("Delete failed", err);
      showToast("Failed to delete integration: " + err.message, 'error');
    } finally {
      btnDelConfirm.disabled = false;
      btnDelConfirm.textContent = 'Delete';
    }
  });
}

// ─── Utilities ──────────────────────────────────────────────
function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

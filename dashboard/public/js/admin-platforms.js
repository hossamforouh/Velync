import { collection, doc, setDoc, deleteDoc, getDoc, onSnapshot, query, orderBy, addDoc, where, getDocs, updateDoc } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-firestore.js";
import { navigateTo } from './navigation.js';
import { showToast } from './toast.js';
import { getSkeletonTableHTML, setButtonLoading } from './loading-components.js';

let firestoreDb = null;
let auth = null;
let platformsUnsubscribe = null;

export function initAdminPlatforms(dbInstance, authInstance) {
  firestoreDb = dbInstance;
  auth = authInstance;
  
  // Setup Editor UI elements
  const btnAdd = document.getElementById('btn-admin-add-platform');
  const btnClose = document.getElementById('platform-panel-close');
  const btnCancel = document.getElementById('btn-plat-cancel');
  const form = document.getElementById('platform-form');
  const attrsContainer = document.getElementById('platform-attributes-container');
  const btnAddAttr = document.getElementById('btn-plat-add-attr');
  const schemaContainer = document.getElementById('platform-schema-container');
  const btnAddSchemaField = document.getElementById('btn-plat-add-schema-field');
  const platError = document.getElementById('plat-error');
  
  // Stepper logic
  let currentStep = 0;
  const stepperItems = document.querySelectorAll('.stepper-item');
  const tabPanes = document.querySelectorAll('#view-admin-platform-editor .tab-pane');
  const btnPrev = document.getElementById('btn-plat-prev');
  const btnNext = document.getElementById('btn-plat-next');
  const btnSave = document.getElementById('btn-plat-save');
  const authTypeSelect = document.getElementById('f-plat-auth-type');

  function showStep(index) {
    // Bounds checking
    if (index < 0) index = 0;
    if (index >= tabPanes.length) index = tabPanes.length - 1;

    currentStep = index;

    // Update Panes
    tabPanes.forEach((p, i) => {
      if (i === currentStep) p.classList.add('active');
      else p.classList.remove('active');
    });

    // Update Stepper UI
    stepperItems.forEach((item) => {
      const stepIndex = parseInt(item.dataset.step);
      item.classList.remove('active', 'completed');
      if (stepIndex === currentStep) {
        item.classList.add('active');
      } else if (stepIndex < currentStep) {
        item.classList.add('completed');
      }
    });

    // Update Stepper Lines
    const lines = document.querySelectorAll('.stepper-line');
    lines.forEach((line, i) => {
      line.classList.remove('completed');
      if (i < currentStep) {
        line.classList.add('completed');
      }
    });

    // Update Buttons
    if (btnPrev) btnPrev.style.display = currentStep === 0 ? 'none' : 'inline-block';
    if (btnNext && btnSave) {
      if (currentStep === tabPanes.length - 1) {
        btnNext.style.display = 'none';
        btnSave.style.display = 'inline-block';
      } else {
        btnNext.style.display = 'inline-block';
        btnSave.style.display = 'none';
      }
    }
  }

  function validateCurrentStep() {
    const currentPane = tabPanes[currentStep];
    const inputs = currentPane.querySelectorAll('input[required], select[required], textarea[required]');
    let isValid = true;
    for (const input of inputs) {
      // Exclude hidden inputs from validation
      if (input.offsetParent !== null) {
        if (!input.checkValidity()) {
          input.reportValidity();
          isValid = false;
          break;
        }
      }
    }
    return isValid;
  }

  if (btnNext) {
    btnNext.addEventListener('click', () => {
      if (validateCurrentStep()) {
        showStep(currentStep + 1);
      }
    });
  }

  if (btnPrev) {
    btnPrev.addEventListener('click', () => {
      showStep(currentStep - 1);
    });
  }

  function resetTabs() {
    showStep(0);
  }

  function toCamelCase(str) {
    return str.toLowerCase().replace(/[^a-zA-Z0-9]+(.)/g, (m, chr) => chr.toUpperCase());
  }

  function updateDependencyDropdowns() {
    const schemaRows = Array.from(schemaContainer.querySelectorAll('.schema-row'));
    const allLabels = schemaRows.map(row => {
      const label = row.querySelector('.schema-label').value.trim();
      return { label, key: toCamelCase(label) };
    }).filter(x => x.key);

    schemaRows.forEach(row => {
      const select = row.querySelector('.schema-depends');
      if (!select) return;
      const currentKey = toCamelCase(row.querySelector('.schema-label').value.trim());
      const selectedVal = select.getAttribute('data-selected') || select.value;
      
      select.innerHTML = '<option value="">-- None --</option>';
      allLabels.forEach(l => {
        if (l.key !== currentKey) {
          const opt = document.createElement('option');
          opt.value = l.key;
          opt.textContent = `${l.label} (${l.key})`;
          if (l.key === selectedVal) opt.selected = true;
          select.appendChild(opt);
        }
      });
      select.setAttribute('data-selected', select.value);
    });
  }

  function createAttributeRow(label = '', type = 'text', required = false) {
    const initialKey = toCamelCase(label);
    const row = document.createElement('div');
    row.className = 'attr-row';
    row.style.cssText = 'display: flex; gap: 8px; align-items: flex-end; flex-wrap: wrap;';
    row.innerHTML = `
      <div class="form-row" style="flex: 0.8; min-width: 120px; margin-bottom: 0;">
        <label>Key <span style="color:var(--text-3);font-weight:400;">(auto)</span></label>
        <input type="text" class="attr-key" placeholder="OAuthScopes" value="${initialKey}" />
      </div>
      <div class="form-row" style="flex: 1; min-width: 130px; margin-bottom: 0;">
        <label>Value</label>
        <input type="text" class="attr-label" placeholder="e.g. https://..." value="${label}" />
      </div>
      <div class="form-row" style="flex: 0.6; min-width: 90px; margin-bottom: 0;">
        <label>Type</label>
        <select class="attr-type">
          <option value="text" ${type === 'text' ? 'selected' : ''}>Text</option>
          <option value="password" ${type === 'password' ? 'selected' : ''}>Password</option>
        </select>
      </div>
      <div class="form-row" style="width: 44px; margin-bottom: 0;">
        <label style="font-size: 0;">Required</label>
        <label class="toggle" style="margin-top: 6px;" title="Required field">
          <input type="checkbox" class="attr-required" ${required ? 'checked' : ''} />
          <span class="toggle-track"></span>
          <span class="toggle-thumb"></span>
        </label>
      </div>
      <button type="button" class="btn btn-secondary btn-remove-attr" style="padding: 8px 12px; color: var(--danger); margin-bottom: 0;">✕</button>
    `;
    
    // Auto-generate key from value (label)
    const labelInput = row.querySelector('.attr-label');
    const keyInput = row.querySelector('.attr-key');
    labelInput.addEventListener('input', () => {
      const generated = toCamelCase(labelInput.value);
      if (!keyInput.dataset.userEdited) {
        keyInput.value = generated;
      }
    });
    keyInput.addEventListener('input', () => {
      keyInput.dataset.userEdited = 'true';
    });
    
    row.querySelector('.btn-remove-attr').addEventListener('click', () => {
      row.remove();
    });
    
    attrsContainer.appendChild(row);
  }

  btnAddAttr.addEventListener('click', () => createAttributeRow());

  function createSchemaRow(id = '', label = '', type = 'text', options = '', dataSource = '', dependsOn = '', visibilityRule = '', required = false) {
    const row = document.createElement('div');
    row.className = 'schema-row schema-card';
    row.innerHTML = `
      <div style="display: flex; gap: 12px; flex-wrap: wrap; align-items: flex-end; margin-bottom: 12px;">
        <div class="form-row" style="flex: 1; min-width: 150px; margin-bottom: 0;">
          <label>Label</label>
          <input type="text" class="schema-label" placeholder="e.g. Target Entity" value="${label}" />
        </div>
        <div class="form-row" style="flex: 1; min-width: 150px; margin-bottom: 0;">
          <label>Type</label>
          <select class="schema-type">
            <option value="text" ${type === 'text' ? 'selected' : ''}>Text</option>
            <option value="toggle" ${type === 'toggle' ? 'selected' : ''}>Toggle Switch</option>
            <option value="static_select" ${type === 'static_select' ? 'selected' : ''}>Static Dropdown</option>
            <option value="dynamic_select" ${type === 'dynamic_select' ? 'selected' : ''}>Dynamic Dropdown</option>
          </select>
        </div>
        <div class="form-row schema-options-row" style="flex: 1.5; min-width: 150px; margin-bottom: 0; display: ${type === 'static_select' ? 'block' : 'none'};">
          <label>Options (comma separated)</label>
          <input type="text" class="schema-options" placeholder="Tasks, Notes" value="${options}" />
        </div>
        <div class="form-row schema-datasource-row" style="flex: 1.5; min-width: 150px; margin-bottom: 0; display: ${type === 'dynamic_select' ? 'block' : 'none'};">
          <label>Data Source Function</label>
          <select class="schema-datasource">
            <option value="">-- Select Source --</option>
            ${(cachedDataSources || []).map(ds => `<option value="${escAttr(ds.id)}" ${dataSource === ds.id ? 'selected' : ''}>${escHtml(ds.name)}</option>`).join('')}
          </select>
        </div>
      </div>
      
      <div style="display: flex; gap: 12px; align-items: flex-end;">
        <div class="form-row" style="flex: 1; min-width: 150px; margin-bottom: 0;">
          <label>Depends On (Key)</label>
          <select class="schema-depends" data-selected="${dependsOn}">
            <option value="">-- None --</option>
          </select>
        </div>
        <div class="form-row" style="flex: 1; min-width: 150px; margin-bottom: 0;">
          <label>Visible If (Values)</label>
          <input type="text" class="schema-visible" placeholder="Tasks, Notes" value="${visibilityRule}" />
        </div>
        <div class="form-row" style="width: 44px; margin-bottom: 0;">
          <label style="font-size: 0;">Required</label>
          <label class="toggle" style="margin-top: 6px;" title="Required field">
            <input type="checkbox" class="schema-required" ${required ? 'checked' : ''} />
            <span class="toggle-track"></span>
            <span class="toggle-thumb"></span>
          </label>
        </div>
        <button type="button" class="btn btn-secondary btn-remove-schema" style="padding: 8px 12px; color: var(--danger); margin-bottom: 0;">✕</button>
      </div>
    `;
    
    const selectType = row.querySelector('.schema-type');
    const optionsRow = row.querySelector('.schema-options-row');
    const dsRow = row.querySelector('.schema-datasource-row');
    
    selectType.addEventListener('change', () => {
      const v = selectType.value;
      optionsRow.style.display = v === 'static_select' ? 'block' : 'none';
      dsRow.style.display = v === 'dynamic_select' ? 'block' : 'none';
    });

    const labelInput = row.querySelector('.schema-label');
    labelInput.addEventListener('input', () => updateDependencyDropdowns());

    const dependsSelect = row.querySelector('.schema-depends');
    dependsSelect.addEventListener('change', (e) => e.target.setAttribute('data-selected', e.target.value));

    row.querySelector('.btn-remove-schema').addEventListener('click', () => {
      row.remove();
      updateDependencyDropdowns();
    });
    
    schemaContainer.appendChild(row);
    updateDependencyDropdowns();
  }

  btnAddSchemaField.addEventListener('click', () => createSchemaRow());

  let cachedDataSources = null;
  const API_URL = window.VELYNC_CONFIG.apiBase;

  async function openModal(platform = null) {
    const panelBody = document.querySelector('#view-admin-platform-editor .panel-body');
    const form = document.getElementById('platform-form');
    let loadingEl = panelBody.querySelector('.modal-loading');
    if (!loadingEl) {
      loadingEl = document.createElement('div');
      loadingEl.className = 'modal-loading';
      loadingEl.style.cssText = 'display:flex;align-items:center;justify-content:center;padding:60px 40px;flex-direction:column;gap:12px;color:var(--text-3);';
      loadingEl.innerHTML = '<span class="spinner" style="width:24px;height:24px;border-width:2.5px;"></span><span>Loading editor...</span>';
      panelBody.appendChild(loadingEl);
    }
    form.style.display = 'none';
    loadingEl.style.display = 'flex';

    if (!cachedDataSources) {
      try {
        const token = await auth.currentUser.getIdToken();
        const res = await fetch(`${API_URL}/api/data-sources`, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          }
        });
        if (res.ok) {
          cachedDataSources = await res.json();
        } else {
          console.error("Failed to fetch data sources");
          cachedDataSources = [];
        }
      } catch(err) {
        console.error("Error fetching data sources", err);
        showToast('Failed to load data sources: ' + err.message, 'error');
        cachedDataSources = [];
      }
    }
    form.style.display = '';
    loadingEl.style.display = 'none';
    platError.style.display = 'none';
    platError.textContent = '';
    attrsContainer.innerHTML = ''; // clear old rows
    schemaContainer.innerHTML = ''; // clear old schema rows
    resetTabs(); // Reset to first tab
    if (platform) {
      document.getElementById('platform-panel-title').textContent = 'Edit Platform';
      document.getElementById('f-plat-doc-id').value = platform.id;
      document.getElementById('f-plat-name').value = platform.name || '';
      document.getElementById('f-plat-logo').value = platform.logo || '';
      
      document.getElementById('f-plat-auth-type').value = platform.authType || 'manual';
      document.getElementById('f-plat-auth-url').value = platform.authUrl || '';
      document.getElementById('f-plat-token-url').value = platform.tokenUrl || '';
      document.getElementById('f-plat-client-id').value = platform.clientId || '';
      document.getElementById('f-plat-client-secret').value = platform.clientSecret || '';
      document.getElementById('f-plat-guide-url').value = platform.guideUrl || '';
      const attrs = platform.attributes || [];
      attrs.forEach(attr => {
        const label = attr.label || attr.name || '';
        createAttributeRow(label, attr.type || 'text', attr.required);
        if (attr.id || attr.key) {
          const row = attrsContainer.lastElementChild;
          if (row) {
            row.querySelector('.attr-key').value = attr.id || attr.key || '';
          }
        }
      });

      const schema = platform.configSchema || [];
      schema.forEach(field => {
        const opts = field.options ? field.options.join(', ') : '';
        createSchemaRow(field.id, field.label, field.type, opts, field.dataSource || '', field.dependsOn || '', field.visibilityRule || '', field.required);
      });
    } else {
      document.getElementById('platform-panel-title').textContent = 'Create New Platform';
      document.getElementById('f-plat-doc-id').value = '';
      document.getElementById('f-plat-name').value = '';
      document.getElementById('f-plat-logo').value = '';
      document.getElementById('f-plat-auth-type').value = 'manual';
      document.getElementById('f-plat-auth-url').value = '';
      document.getElementById('f-plat-token-url').value = '';
      document.getElementById('f-plat-client-id').value = '';
      document.getElementById('f-plat-client-secret').value = '';
      document.getElementById('f-plat-guide-url').value = '';

      createAttributeRow(); // one empty row by default
    }
    
    updateAuthUI(document.getElementById('f-plat-auth-type').value);
    
    navigateTo('admin-platform-editor');
    window.scrollTo(0, 0);
  }

  function closeModal() {
    navigateTo('admin');
    form.reset();
    attrsContainer.innerHTML = '';
    schemaContainer.innerHTML = '';
    platError.style.display = 'none';
    platError.textContent = '';
  }

  btnAdd.addEventListener('click', () => openModal(null));
  if (btnClose) btnClose.addEventListener('click', closeModal);
  if (btnCancel) btnCancel.addEventListener('click', closeModal);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    platError.style.display = 'none';
    platError.textContent = '';

    const btnSave = document.getElementById('btn-plat-save');
    setButtonLoading(btnSave, true);

    try {
      const docId = document.getElementById('f-plat-doc-id').value;

      // Gather attributes
      const attributes = [];
      const attrRows = attrsContainer.querySelectorAll('.attr-row');
      attrRows.forEach(row => {
        const label = row.querySelector('.attr-label').value.trim();
        const id = toCamelCase(row.querySelector('.attr-key').value.trim());
        const t = row.querySelector('.attr-type').value;
        const required = row.querySelector('.attr-required')?.checked || false;
        if (id && label) {
          const attr = { id, label, type: t };
          if (required) attr.required = true;
          attributes.push(attr);
        }
      });

      // Gather schema fields
      const configSchema = [];
      const schemaRows = schemaContainer.querySelectorAll('.schema-row');
      schemaRows.forEach(row => {
        const label = row.querySelector('.schema-label').value.trim();
        const id = toCamelCase(label);
        const type = row.querySelector('.schema-type').value;
        const optionsStr = row.querySelector('.schema-options').value.trim();
        const dataSource = row.querySelector('.schema-datasource').value;
        const dependsOn = row.querySelector('.schema-depends').value;
        const visibilityRule = row.querySelector('.schema-visible').value.trim();
        const required = row.querySelector('.schema-required').checked;
        
        if (id && label) {
          const field = { id, label, type };
          if (required) field.required = true;
          if (type === 'static_select' && optionsStr) {
            field.options = optionsStr.split(',').map(o => o.trim()).filter(o => o);
          }
          if (type === 'dynamic_select' && dataSource) {
            field.dataSource = dataSource;
          }
          if (dependsOn) field.dependsOn = dependsOn;
          if (visibilityRule) field.visibilityRule = visibilityRule;
          
          configSchema.push(field);
        }
      });

      const platformData = {
        name: document.getElementById('f-plat-name').value.trim(),
        logo: document.getElementById('f-plat-logo').value.trim(),
        authType: document.getElementById('f-plat-auth-type').value,
        authUrl: document.getElementById('f-plat-auth-url').value.trim(),
        tokenUrl: document.getElementById('f-plat-token-url').value.trim(),
        clientId: document.getElementById('f-plat-client-id').value.trim(),
        clientSecret: document.getElementById('f-plat-client-secret').value.trim(),
        guideUrl: document.getElementById('f-plat-guide-url').value.trim(),
        attributes: attributes,
        configSchema: configSchema
      };

      if (docId) {
        platformData.key = docId;
        await setDoc(doc(firestoreDb, 'platforms', docId), platformData);

        // Update name in any integrations that use this platform
        try {
          const q1 = query(collection(firestoreDb, 'integrations'), where('platform1.id', '==', docId));
          const snap1 = await getDocs(q1);
          snap1.forEach(docSnap => {
            updateDoc(docSnap.ref, { 'platform1.name': platformData.name });
          });

          const q2 = query(collection(firestoreDb, 'integrations'), where('platform2.id', '==', docId));
          const snap2 = await getDocs(q2);
          snap2.forEach(docSnap => {
            updateDoc(docSnap.ref, { 'platform2.name': platformData.name });
          });
        } catch (updateErr) {
          console.warn("Failed to update related integrations:", updateErr);
        }
      } else {
        const docRef = await addDoc(collection(firestoreDb, 'platforms'), platformData);
        await setDoc(docRef, { key: docRef.id }, { merge: true });
      }

      closeModal();
    } catch (err) {
      console.error("Failed to save platform", err);
      platError.textContent = "Error saving platform: " + err.message;
      platError.style.display = 'block';
    } finally {
      setButtonLoading(btnSave, false);
    }
  });

  // Listen to Firestore
  if (platformsUnsubscribe) platformsUnsubscribe();

  const q = query(collection(firestoreDb, 'platforms'), orderBy('name'));

  // Toggle Auth UI based on selection
  if (authTypeSelect) {
    authTypeSelect.addEventListener('change', (e) => updateAuthUI(e.target.value));
  }

  function updateAuthUI(authType) {
    const oauthGroup = document.getElementById('oauth-fields-group');
    const manualGroup = document.getElementById('manual-fields-group');

    if (!oauthGroup || !manualGroup) return;

    if (authType === 'oauth') {
      oauthGroup.classList.remove('hidden');
      manualGroup.classList.add('hidden');
      oauthGroup.querySelectorAll('input').forEach(i => i.setAttribute('required', 'true'));
    } else {
      oauthGroup.classList.add('hidden');
      manualGroup.classList.remove('hidden');
      oauthGroup.querySelectorAll('input').forEach(i => i.removeAttribute('required'));
    }
    showStep(currentStep);
  }

  document.getElementById('admin-platforms-tbody').innerHTML = getSkeletonTableHTML(4, 5);

  platformsUnsubscribe = onSnapshot(q, (snapshot) => {
    const tbody = document.getElementById('admin-platforms-tbody');
    tbody.innerHTML = '';
    
    if (snapshot.empty) {
      tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; padding: 20px;">No platforms found.</td></tr>';
      return;
    }

    const allPlatforms = [];

    snapshot.forEach(docSnap => {
      const data = docSnap.data();
      allPlatforms.push({ ...data, id: docSnap.id });
      
      const authTypeDisplay = data.authType === 'oauth' ? 'OAuth 2.0' : (data.authType === 'manual' ? 'Manual' : '<span style="color:var(--text-3)">None</span>');

      const badgeHtml = `<span class="conn-badge" style="background: rgba(99, 102, 241, 0.15); color: #818cf8;">${escHtml(data.name)}</span>`;

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td data-label="ID" style="font-weight: 500;">${data.key || docSnap.id}</td>
        <td data-label="Name">${badgeHtml}</td>
        <td data-label="Auth Type" style="font-size: 0.9rem; color: var(--text-2);">${authTypeDisplay}</td>
        <td data-label="Actions" class="col-actions">
          <div class="row-actions-group">
            <button class="row-action-btn edit-plat-btn" data-id="${docSnap.id}" type="button" title="Edit Platform"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg></button>
            <button class="row-action-btn del-plat-btn" data-id="${docSnap.id}" type="button" title="Delete Platform"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg></button>
          </div>
        </td>
      `;
      tbody.appendChild(tr);
    });

    // Attach Edit / Delete listeners
    document.querySelectorAll('.edit-plat-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const id = e.currentTarget.getAttribute('data-id');
        const plat = allPlatforms.find(i => i.id === id);
        if (plat) openModal(plat);
      });
    });

    document.querySelectorAll('.del-plat-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const id = e.currentTarget.getAttribute('data-id');
        showDeleteModal(id);
      });
    });
  }, (err) => {
    console.warn('[admin-platforms] Platforms listener error:', err);
    if (!navigator.onLine) return;
    const tbody = document.getElementById('admin-platforms-tbody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:20px;color:var(--rose);">Failed to load platforms. <a href="#" onclick="location.reload()" style="color:var(--violet);">Reload</a></td></tr>';
    showToast('Failed to load platforms', 'error');
  });

  // Delete Modal Logic
  let platformToDelete = null;
  const delOverlay = document.getElementById('platform-delete-modal-overlay');
  const btnDelCancel = document.getElementById('plat-del-modal-cancel');
  const btnDelConfirm = document.getElementById('plat-del-modal-confirm');
  const delName = document.getElementById('plat-del-modal-name');

  function showDeleteModal(id) {
    platformToDelete = id;
    delName.textContent = id;
    delOverlay.classList.add('open');
  }

  function hideDeleteModal() {
    platformToDelete = null;
    delOverlay.classList.remove('open');
  }

  if (btnDelCancel) btnDelCancel.addEventListener('click', hideDeleteModal);
  if (delOverlay) delOverlay.addEventListener('click', (e) => {
    if (e.target === delOverlay) hideDeleteModal();
  });
  
  if (btnDelConfirm) {
    btnDelConfirm.addEventListener('click', async () => {
      if (!platformToDelete) return;
      const id = platformToDelete;
      
      // UI Loading state
      btnDelConfirm.disabled = true;
      btnDelConfirm.innerHTML = '<span class="spinner" style="width: 16px; height: 16px; border-width: 2px; display: inline-block; vertical-align: middle; margin-right: 8px;"></span><span style="vertical-align: middle;">Deleting...</span>';
      
      try {
        const snap = await getDoc(doc(firestoreDb, 'platforms', id));
        const deletedData = snap.exists() ? snap.data() : null;
        await deleteDoc(doc(firestoreDb, 'platforms', id));
        hideDeleteModal();
        showToast('Platform deleted', 'info', {
          actionLabel: 'Undo',
          onAction: async () => {
            if (deletedData) {
              await setDoc(doc(firestoreDb, 'platforms', id), deletedData);
              showToast('Platform restored', 'success');
            }
          }
        });
      } catch (err) {
        console.error("Delete failed", err);
        showToast('Failed to delete platform: ' + err.message, 'error');
      } finally {
        btnDelConfirm.disabled = false;
        btnDelConfirm.textContent = 'Delete';
      }
    });
  }
}

/* =============================================================
   Sync Config Dashboard — app.js
   Firebase Web SDK Integration
   ============================================================= */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js";
import { getAuth, signInWithPopup, GoogleAuthProvider, onAuthStateChanged, signOut, createUserWithEmailAndPassword, signInWithEmailAndPassword, sendPasswordResetEmail } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-auth.js";
import { getFirestore, collection, getDocs, getDoc, doc, setDoc, addDoc, updateDoc, deleteDoc, serverTimestamp, query, where, arrayUnion, arrayRemove } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-firestore.js";
import { initializeAppCheck, ReCaptchaV3Provider } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-app-check.js";
import { getAnalytics, logEvent } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-analytics.js";
import { bindNavEvents, navigateTo } from './js/navigation.js';
import { renderHubView } from './js/hub.js';
import { loadConnections, renderConnectionsView, renderConnectionsSkeleton, initiateDirectOAuthFlow } from './js/connections.js';
import { initAdminIntegrations } from './js/admin-integrations.js';
import { initAdminPlatforms } from './js/admin-platforms.js';
import './js/integration-setup.js';
import { showToast } from './js/toast.js';
import { confirmDialog, alertDialog, threeWayConfirmDialog } from './js/confirm.js';
import { startLoad, endLoad, isLoading } from './js/loading.js';
import { getSkeletonFormHTML, setButtonLoading } from './js/loading-components.js';

// ─── Data Sources Registry (Dynamic) ────────────────────────────
async function fetchPlatformEntities(dataSourceId, connId, parentValue) {
  if (!auth.currentUser) return [];
  if (!connId) return [];

  // 1. Try backend
  try {
    const token = await auth.currentUser.getIdToken();
    const API_BASE = window.VELYNC_CONFIG.apiBase;
    const res = await fetch(`${API_BASE}/api/platform-entities`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ dataSourceId, connectionId: connId, parentValue })
    });
    if (res.ok) {
      const data = await res.json();
      return (data.entities || []).map(e => ({ value: e.id, label: e.name }));
    }
    showToast('Failed to fetch platform entities', 'error');
    console.warn('[fetchPlatformEntities] Backend error:', res.status);
  } catch (e) {
    showToast('Failed to fetch platform entities', 'error');
    console.warn('[fetchPlatformEntities] Network error:', e);
  }

  // 2. Client-side fallback for supported data sources
  const conn = _connectionsCache.find(c => c.id === connId);
  if (!conn) return [];

  switch (dataSourceId) {
    case 'ticktick.getProjects':
    case 'fetchTickTickLists':
      return clientTickTickProjects(conn);
    case 'fetchTickTickTags':
      return clientTickTickAllTags(conn);
    default:
      return [];
  }
}

// ── Client-side TickTick helpers ─────────────────────────────────
async function clientTickTickToken(conn) {
  if (conn.accessToken) return conn.accessToken;
  if (conn.clientId && conn.clientSecret && !conn.clientId.startsWith('your_ticktick')) {
    const res = await fetch('https://ticktick.com/oauth/token?grant_type=client_credentials', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + btoa(conn.clientId + ':' + conn.clientSecret),
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.access_token;
  }
  return null;
}

async function clientTickTickProjects(conn) {
  try {
    const token = await clientTickTickToken(conn);
    if (!token) return [];
    const res = await fetch('https://api.ticktick.com/open/v1/project', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) return [];
    const projects = await res.json();
    return (projects || []).map(p => ({ value: p.id || p.name, label: p.name }));
  } catch (e) {
    console.warn('[clientTickTickProjects]', e);
    showToast('Failed to load TickTick projects', 'error');
    return [];
  }
}

// Fetch all tags from a single TickTick project — extracted for readability
async function fetchTagsForProject(token, project) {
  try {
    const taskRes = await fetch(`https://api.ticktick.com/open/v1/project/${project.id}/data`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!taskRes.ok) return [];
    const data = await taskRes.json();
    return (data.tasks || []).flatMap(task =>
      (Array.isArray(task.tags) ? task.tags : [])
    );
  } catch (e) {
    console.warn(`[clientTickTickAllTags] Project ${project.name}:`, e);
    return [];
  }
}

async function clientTickTickAllTags(conn) {
  try {
    const token = await clientTickTickToken(conn);
    if (!token) return [];

    const projRes = await fetch('https://api.ticktick.com/open/v1/project', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!projRes.ok) return [];

    const projects = await projRes.json();
    const tagArrays = await Promise.all((projects || []).map(p => fetchTagsForProject(token, p)));
    const tagSet = new Set(tagArrays.flat());
    return Array.from(tagSet).map(name => ({ value: name, label: name }));
  } catch (e) {
    console.warn('[clientTickTickAllTags]', e);
    return [];
  }
}


window.renderSchemaForPlatform = async function(platformId, containerId, prefix, existingData = {}) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';
  
  if (!window.cachedPlatforms) {
    try {
      const snap = await getDocs(collection(db, 'platforms'));
      window.cachedPlatforms = snap.docs.map(d => ({id: d.id, ...d.data()}));
    } catch (e) {
      console.warn("Could not load platforms", e);
      showToast('Failed to load platform schemas', 'error');
    }
  }
  
  const plat = window.cachedPlatforms?.find(p => p.id === platformId || p.key === platformId);
  if (!plat || !plat.configSchema) return;
  
  for (const field of plat.configSchema) {
    const row = document.createElement('div');
    row.className = 'form-row';
    row.id = `row-${prefix}-${field.id}`;
    if (field.dependsOn) row.dataset.dependsOn = field.dependsOn;
    if (field.visibilityRule) row.dataset.visibilityRule = field.visibilityRule;
    
    const val = existingData[field.id] !== undefined ? existingData[field.id] : '';
    
    const rawLabel = String(field.label || '');
    const hasStar = rawLabel.trim().endsWith('*');
    const cleanLabel = hasStar ? rawLabel.replace(/\*$/, '').trim() : rawLabel;
    const isReq = field.required === true || field.required === 'true' || hasStar;
    
    if (field.type === 'text') {
      row.innerHTML = `<label for="f-${prefix}-${escAttr(field.id)}">${escHtml(cleanLabel)}${isReq ? ' <span class="required-mark">*</span>' : ''}</label>
                       <input type="text" id="f-${prefix}-${escAttr(field.id)}" data-schema-id="${escAttr(field.id)}" value="${escAttr(val)}" ${isReq ? 'required' : ''} />`;
    } else if (field.type === 'toggle') {
      row.innerHTML = `<label style="display:flex; justify-content:space-between; align-items:center;">
                         ${escHtml(cleanLabel)}${isReq ? ' <span class="required-mark">*</span>' : ''}
                         <label class="toggle">
                           <input type="checkbox" id="f-${prefix}-${escAttr(field.id)}" data-schema-id="${escAttr(field.id)}" ${val ? 'checked' : ''} ${isReq ? 'required' : ''} />
                           <span class="toggle-track"></span>
                           <span class="toggle-thumb"></span>
                         </label>
                       </label>`;
    } else if (field.type === 'static_select') {
      const opts = (field.options || []).map(o => `<option value="${escAttr(o)}" ${val === o ? 'selected' : ''}>${escHtml(o)}</option>`).join('');
      row.innerHTML = `<label for="f-${prefix}-${escAttr(field.id)}">${escHtml(cleanLabel)}${isReq ? ' <span class="required-mark">*</span>' : ''}</label>
                       <select id="f-${prefix}-${escAttr(field.id)}" data-schema-id="${escAttr(field.id)}" ${isReq ? 'required' : ''}>
                         <option value="">-- Select --</option>
                         ${opts}
                       </select>`;
    } else if (field.type === 'dynamic_select') {
      row.innerHTML = `<label for="f-${prefix}-${escAttr(field.id)}" style="display: flex; align-items: center; gap: 4px; width: 100%;">
                         <span>${escHtml(cleanLabel)}${isReq ? '<span class="required-mark">*</span>' : ''}</span>
                         <span style="margin-left: auto; display: flex; align-items: center;">
                           <span class="ds-loading-dots" style="display:none; font-size: 0.8rem; color: var(--text-3); margin-right: 6px;">Loading</span>
                           <a href="#" class="btn-refresh-ds" style="font-size: 0.8rem; color: var(--primary); text-decoration: underline;" onclick="event.preventDefault();">Refresh</a>
                         </span>
                       </label>
                       <select id="f-${prefix}-${escAttr(field.id)}" data-schema-id="${escAttr(field.id)}" style="width: 100%;" ${isReq ? 'required' : ''}>
                         <option value="${val ? escAttr(val) : ''}">${val ? escHtml(val) + ' (Saved)' : 'No data — click Refresh'}</option>
                       </select>`;
                       
      // Attach fetch logic
      setTimeout(async () => {
         const selectEl = row.querySelector('select');
         const btnRef = row.querySelector('.btn-refresh-ds');
         const dots = row.querySelector('.ds-loading-dots');
         if(window.feather) window.feather.replace();
         
         // Auto-load if a connection is already selected (always load, even with a saved value)
         const connId = document.getElementById(prefix === 'p1' ? 'f-tt-connection' : 'f-notion-connection')?.value;
         const shouldAutoLoad = !!connId;
         
          const loadData = async () => {
            if (field.dataSource) {
              const connId = document.getElementById(prefix === 'p1' ? 'f-tt-connection' : 'f-notion-connection')?.value;
              if (!connId) {
                selectEl.innerHTML = '<option value="">— Select a connection first —</option>';
                return;
              }
              dots.style.display = '';
              btnRef.style.display = 'none';
              selectEl.innerHTML = '<option value="">Loading...</option>';
              try {
                let parentVal = '';
                if (field.dependsOn) {
                  const parentEl = container.querySelector(`[data-schema-id="${field.dependsOn}"]`);
                  if (parentEl) {
                    parentVal = parentEl.type === 'checkbox' ? parentEl.checked : parentEl.value;
                  }
                }
                const items = await fetchPlatformEntities(field.dataSource, connId, parentVal);
                if (items.length === 0) {
                  selectEl.innerHTML = '<option value="">— No data available —</option>';
                  // Keep saved value as a fallback option so it isn't lost
                  if (val) selectEl.innerHTML += `<option value="${escAttr(val)}" selected>${escHtml(val)} (Saved)</option>`;
                } else {
                  selectEl.innerHTML = '<option value="">-- Select --</option>' + items.map(i => `<option value="${escAttr(i.value)}" ${val === i.value ? 'selected' : ''}>${escHtml(i.label)}</option>`).join('');
                  // Re-select saved value after loading (handles the case where val was set before options loaded)
                  if (val) selectEl.value = val;
                }
              } catch (e) {
                console.error("DataSource Error:", e);
                selectEl.innerHTML = `<option value="">Error loading</option>`;
                if (val) selectEl.innerHTML += `<option value="${escAttr(val)}" selected>${escHtml(val)} (Saved)</option>`;
              }
              dots.style.display = 'none';
              btnRef.style.display = '';
            }
          };
         btnRef.addEventListener('click', loadData);
         if (shouldAutoLoad) loadData();
      }, 0);
    }
    
    container.appendChild(row);

    // Attach listeners
    setTimeout(() => {
      const inputEl = row.querySelector('[data-schema-id]');
      if (inputEl) {
        inputEl.addEventListener('change', (e) => {
          if (typeof window.triggerAutoSave === 'function') window.triggerAutoSave();
          
          const changedId = field.id;
          const newVal = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
          
          // Cascading logic
          plat.configSchema.forEach(childField => {
            if (childField.dependsOn === changedId) {
               const childRow = container.querySelector(`#row-${prefix}-${childField.id}`);
               if (!childRow) return;
               
               if (childField.visibilityRule) {
                 const allowedVals = childField.visibilityRule.split(',').map(s => s.trim());
                 childRow.style.display = allowedVals.includes(String(newVal)) ? 'block' : 'none';
               }
               
                if (childField.type === 'dynamic_select') {
                  const connId = document.getElementById(prefix === 'p1' ? 'f-tt-connection' : 'f-notion-connection')?.value;
                  if (connId) {
                    const btnRef = childRow.querySelector('.btn-refresh-ds');
                    if (btnRef) btnRef.click();
                  }
                }
            }
          });
        });
        
        inputEl.addEventListener('input', () => {
          if (typeof window.triggerAutoSave === 'function') window.triggerAutoSave();
        });
      }
    }, 0);
  }
  
  // Initial visibility evaluation
  setTimeout(() => {
    plat.configSchema.forEach(field => {
       if (field.dependsOn) {
          const parentEl = container.querySelector(`[data-schema-id="${field.dependsOn}"]`);
          const parentVal = parentEl ? (parentEl.type === 'checkbox' ? parentEl.checked : parentEl.value) : '';
          const childRow = container.querySelector(`#row-${prefix}-${field.id}`);
          if (childRow && field.visibilityRule) {
             const allowedVals = field.visibilityRule.split(',').map(s => s.trim());
             childRow.style.display = allowedVals.includes(String(parentVal)) ? 'block' : 'none';
          }
       }
    });
  }, 100);
};

window.harvestDynamicFields = function(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return {};
  const data = {};
  container.querySelectorAll('[data-schema-id]').forEach(el => {
    const id = el.getAttribute('data-schema-id');
    data[id] = el.type === 'checkbox' ? el.checked : el.value;
  });
  return data;
};

// --- PWA Service Worker Registration ---
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    setTimeout(() => {
      navigator.serviceWorker.register('/sw.js')
        .then(() => {})
        .catch(err => console.warn('SW registration failed: ', err));
    }, 1500);
  });
}
// ---------------------------------------

// --- Online / Offline detection ---
const offlineBanner = document.getElementById('offline-banner');
const offlineDismiss = document.getElementById('offline-dismiss');

function showOfflineBanner() {
  if (offlineBanner) offlineBanner.style.display = 'flex';
}

function hideOfflineBanner() {
  if (offlineBanner) offlineBanner.style.display = 'none';
}

// ── Online connectivity: auto-reload to recover from stale state ──
let _wasOffline = !navigator.onLine;
window.addEventListener('online', () => {
  hideOfflineBanner();
  showToast('Back online', 'success');
  if (_wasOffline) {
    _wasOffline = false;
    location.reload();
  }
});
window.addEventListener('offline', () => {
  _wasOffline = true;
  showOfflineBanner();
});

if (!navigator.onLine) {
  _wasOffline = true;
  showOfflineBanner();
  const span = document.querySelector('#offline-banner span');
  if (span) span.textContent = 'No internet available';
}

if (offlineDismiss) {
  offlineDismiss.addEventListener('click', hideOfflineBanner);
}

// ── Timeout helper for Firestore operations ──────────────────────
function firestoreTimeout(ms = 15000) {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(navigator.onLine ? 'Request timed out' : 'No internet available')), ms);
  });
}
// -----------------------------------


const firebaseConfig = {
  apiKey: "AIzaSyBSMJMrR2lCYJP5D6e7wZDp-PmR8MZ5pIE",
  authDomain: "velync.web.app",
  projectId: "velync",
  storageBucket: "velync.firebasestorage.app",
  messagingSenderId: "632548720073",
  appId: "1:632548720073:web:521085551e7c24da27bc18"
};

const app = initializeApp(firebaseConfig);
let appCheck;
try {
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
  }
  appCheck = initializeAppCheck(app, {
    provider: new ReCaptchaV3Provider('6LdILigtAAAAAGO0Sn27U_bVMd83hGSjNpC16Mv6'),
    isTokenAutoRefreshEnabled: true
  });
} catch (e) {
  console.warn("App Check initialization failed.", e);
}

// Initialize Analytics
let analytics;
try {
  analytics = getAnalytics(app);
} catch(e) {
  // Analytics optional — may fail if measurementId is absent
}

const auth = getAuth(app);
const db = getFirestore(app);

// ─── Global Settings Initialization ───────────────────────────
(async () => {
  try {
    const settingsRef = doc(db, 'app_settings', 'general');
    const settingsSnap = await Promise.race([getDoc(settingsRef), firestoreTimeout(10000)]);
    if (settingsSnap.exists() && settingsSnap.data().whatsappNumber) {
      const waLink = document.getElementById('whatsapp-fab-link');
      if (waLink) waLink.href = `https://wa.me/${settingsSnap.data().whatsappNumber}`;
      const adminWaInput = document.getElementById('admin-whatsapp-number');
      if (adminWaInput) adminWaInput.value = settingsSnap.data().whatsappNumber;
    }
  } catch (err) {
    console.error("Error fetching global settings:", err);
    showToast('Failed to load global settings', 'error');
  }
})();

// ─── State ────────────────────────────────────────────────────
let configs = [];
let pendingDeleteId = null;
let editingId = null;
let selectedConfigIds = new Set();
let currentSortColumn = 'description';
let currentSortDirection = 'asc';
let isTextWrap = false;
let isZebraStriped = true;
let isCompact = true;
let isHeaderFrozen = false;
let isConfigDirty = false;
let currentUserRole = 'user';
let currentWorkspaceId = null;
let workspaceSelectTom = null;


// ─── DOM refs ─────────────────────────────────────────────────
const authOverlay   = document.getElementById('auth-overlay'); // Now the landing page
const appContainer  = document.getElementById('app-container');
const btnLogout     = document.getElementById('btn-logout');
const userEmailSpan = document.getElementById('user-email');

// Landing Page Auth Elements
const authForm         = document.getElementById('auth-form');
const authEmail        = document.getElementById('auth-email');
const authPassword     = document.getElementById('auth-password');
const btnAuthSubmit    = document.getElementById('btn-auth-submit');
const btnLogin         = document.getElementById('btn-login'); // Google button
const authError        = document.getElementById('auth-error');
const authToggleLink   = document.getElementById('auth-toggle-link');
const authToggleText   = document.getElementById('auth-toggle-text');
const authBoxTitle     = document.getElementById('auth-box-title');
const authBoxSubtitle  = document.getElementById('auth-box-subtitle');
const forgotPasswordLink = document.getElementById('forgot-password-link');
const authPasswordGroup  = document.getElementById('auth-password-group');
const authDivider        = document.getElementById('auth-divider');
let isSignUpMode       = false;
let isResetMode        = false;

const tableBody     = document.getElementById('table-body');
const selectAllCheckbox = document.getElementById('select-all-configs');
const configsTable = document.getElementById('configs-table');
const gridTableWrapper = document.getElementById('grid-table-wrapper');
const btnNew        = document.getElementById('btn-new');
const btnRefresh    = document.getElementById('btn-refresh');
const btnSave       = document.getElementById('btn-save');
const btnSubmit     = document.getElementById('btn-submit');
const configForm    = document.getElementById('config-form');
const btnCancel     = document.getElementById('btn-cancel');
const panelOverlay  = document.getElementById('panel-overlay');
const sidePanel     = document.getElementById('side-panel');
const panelTitle    = document.getElementById('panel-title');
const panelClose    = document.getElementById('panel-close');
const modalOverlay  = document.getElementById('modal-overlay');
const modalName     = document.getElementById('modal-name');
const modalCancel   = document.getElementById('modal-cancel');
const modalConfirm  = document.getElementById('modal-confirm');
const statTotal     = document.getElementById('stat-total');
const statEnabled   = document.getElementById('stat-enabled');
const statDisabled  = document.getElementById('stat-disabled');
const refreshIcon   = document.getElementById('refresh-icon');

// Toolbar & Dropdown DOM Refs
const menuAddConfig       = document.getElementById('menu-add-config');
const menuEditConfig      = document.getElementById('menu-edit-config');
const menuDuplicateConfig = document.getElementById('menu-duplicate-config');
const menuDeleteConfig    = document.getElementById('menu-delete-config');
const menuViewCompact     = document.getElementById('menu-view-compact');
const menuViewWrap        = document.getElementById('menu-view-wrap');
const menuFormatZebra     = document.getElementById('menu-format-zebra');

const tbAdd               = document.getElementById('tb-add');
const tbDoc               = document.getElementById('tb-doc');
const tbEdit              = document.getElementById('tb-edit');
const tbDuplicate         = document.getElementById('tb-duplicate');
const tbDelete            = document.getElementById('tb-delete');
const tbFilter            = document.getElementById('tb-filter');
const tbFreeze            = document.getElementById('tb-freeze');
const tbDetach            = document.getElementById('tb-detach');
const tbWrap              = document.getElementById('tb-wrap');
const tbSearch            = document.getElementById('tb-search');

// Form fields
const fId          = document.getElementById('form-id');
const fDescription = document.getElementById('f-description');
const fCron        = document.getElementById('f-cron');
const fIntervalValue = document.getElementById('f-interval-value');
const fIntervalUnit = document.getElementById('f-interval-unit');
const fTtConnection = document.getElementById('f-tt-connection');
const fNotionConnection = document.getElementById('f-notion-connection');
const fNDbId       = document.getElementById('f-n-dbid');
const fNToken      = document.getElementById('f-n-token');

// New configuration fields
const fSyncType      = document.getElementById('f-sync-type');
const fDeleteAfter   = document.getElementById('f-delete-after');

const deleteAfterRow = document.getElementById('delete-after-row');
const btnAddMapping  = document.getElementById('btn-add-mapping');
const mappingsContainer = document.getElementById('mappings-container');
const fTtList        = document.getElementById('f-tt-list');
const fTtTag         = document.getElementById('f-tt-tag');

const btnLoadTt    = document.getElementById('btn-load-tt');
const btnLoadNotion = document.getElementById('btn-load-notion');

const sectionStatusMapping = document.getElementById('section-status-mapping');
const fStatusIncomplete = document.getElementById('f-status-incomplete');
const fStatusIncompleteDefault = document.getElementById('f-status-incomplete-default');
const fStatusComplete = document.getElementById('f-status-complete');
const fStatusCompleteDefault = document.getElementById('f-status-complete-default');

let statusIncompleteSelect;
let statusCompleteSelect;

let notionDbSelect;
let notionDbProperties = {}; // name -> { type, ... } property metadata
let sourceSchema = {}; // fieldKey -> { type, label } from /api/schema
let _connectionsCache = [];
let currentSourcePlatform = '';
let currentDestPlatform = '';
document.addEventListener('DOMContentLoaded', () => {
  if (fIntervalUnit) {
    fIntervalUnit.addEventListener('change', () => {
      if (fIntervalUnit.value === 'advanced') {
        fCron.style.display = 'block';
        if (fIntervalValue) fIntervalValue.style.display = 'none';
      } else {
        fCron.style.display = 'none';
        if (fIntervalValue) fIntervalValue.style.display = 'block';
      }
    });
  }

  window.hasUnsavedConfigChanges = () => isConfigDirty;
  window.resetConfigDirty = () => {
    isConfigDirty = false;
    const ind = document.getElementById('unsaved-indicator');
    if (ind) ind.style.display = 'none';
  };
  window.markConfigDirty = () => {
    isConfigDirty = true;
    const ind = document.getElementById('unsaved-indicator');
    if (ind) ind.style.display = 'flex';
  };

  if (configForm) {
    configForm.addEventListener('input', window.markConfigDirty);
    configForm.addEventListener('change', window.markConfigDirty);
  }
  
  const nodeConfigModal = document.getElementById('node-config-modal');
  if (nodeConfigModal) {
    nodeConfigModal.addEventListener('input', window.markConfigDirty);
    nodeConfigModal.addEventListener('change', window.markConfigDirty);
  }

  window.addEventListener('beforeunload', (e) => {
    if (isConfigDirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  if (fNDbId && window.TomSelect) {
    notionDbSelect = new TomSelect("#f-n-dbid", {
      create: false,
      sortField: { field: "text", direction: "asc" },
      placeholder: "Select a database...",
      maxOptions: null
    });
    notionDbSelect.on('change', async (value) => {
      if (value) {
        try {
          const connId = document.getElementById('f-notion-connection')?.value;
          await fetchNotionDbSchema(value, connId);
          await fetchNotionDbTemplates(value, connId);
          updateStatusMappingUI();
        } catch (err) {
          console.error('Error handling database change:', err);
          showToast('Failed to load database schema', 'error');
        }
      } else {
        const row = document.getElementById('notion-template-row');
        if (row) row.style.display = 'none';
        const select = document.getElementById('f-n-template');
        if (select) select.innerHTML = '<option value="">No Template (Default Layout)</option>';
        updateStatusMappingUI();
      }
    });
  }

  if (fStatusIncomplete && window.TomSelect) {
    statusIncompleteSelect = new TomSelect("#f-status-incomplete", {
      create: false,
      plugins: ['remove_button'],
      placeholder: "Select status options...",
      maxOptions: null
    });
  }

  if (fStatusComplete && window.TomSelect) {
    statusCompleteSelect = new TomSelect("#f-status-complete", {
      create: false,
      plugins: ['remove_button'],
      placeholder: "Select status options...",
      maxOptions: null
    });
  }
});

// Cloud Run API endpoint
const API_URL = window.VELYNC_CONFIG.apiBase.replace(/\/$/, '') + '/api';
let currentProjects = [];

// ─── Auth Flow ────────────────────────────────────────────────
onAuthStateChanged(auth, async (user) => {
  
  if (user) {
    // If offline at startup, show landing page with retry instead of a broken app
    if (!navigator.onLine) {
      authOverlay.style.display = 'flex';
      appContainer.style.display = 'none';
      const landingMain = document.querySelector('.landing-main');
      if (landingMain && !document.getElementById('offline-retry-ui')) {
        landingMain.innerHTML = `
          <div id="offline-retry-ui" style="text-align:center;padding:40px 20px;">
            <div style="font-size:3rem;margin-bottom:16px;">📡</div>
            <h2 style="margin-bottom:8px;">No internet connection</h2>
            <p style="color:var(--text-3);margin-bottom:24px;">We detected you are offline. Please check your connection and try again.</p>
            <button class="btn btn-primary" id="btn-offline-retry" type="button">Retry</button>
          </div>
        `;
        document.getElementById('btn-offline-retry')?.addEventListener('click', () => {
          if (navigator.onLine) location.reload();
          else showToast('Still offline. Check your connection.', 'error');
        });
      }
      return;
    }

    authOverlay.style.display = 'none';
    appContainer.style.display = 'flex';
    
    // Set Avatar Initials
    const initials = user.email ? user.email.substring(0, 2).toUpperCase() : 'U';
    const userAvatar = document.getElementById('user-avatar');
    if (userAvatar) userAvatar.textContent = initials;
    const dropEmail = document.getElementById('dropdown-user-email');
    if (dropEmail) dropEmail.textContent = user.email;
    const settingsEmail = document.getElementById('settings-email');
    if (settingsEmail) settingsEmail.value = user.email;
    const collabDisplay = document.getElementById('collab-email-display');
    if (collabDisplay) collabDisplay.textContent = user.email;

    // Handle User Profile & RBAC
    currentWorkspaceId = user.uid;
    const userRef = doc(db, 'users', user.uid);
    let workspaceName = "Personal Workspace";
    if (user.displayName) workspaceName = user.displayName.split(' ')[0] + "'s Workspace";

    try {
      const userSnap = await Promise.race([getDoc(userRef), firestoreTimeout(10000)]);
      if (!userSnap.exists()) {
        await setDoc(userRef, {
          id: user.uid,
          email: user.email,
          role: 'user',
          workspaceName: workspaceName,
          name: user.displayName || '',
          workspaceId: user.uid,
          createdAt: serverTimestamp()
        });
        currentUserRole = 'user';
        const settingsName = document.getElementById('settings-name');
        if (settingsName && user.displayName) settingsName.value = user.displayName;
      } else {
        const uData = userSnap.data();
        currentUserRole = uData.role || 'user';
        
        // Populate UI with loaded data
        const settingsName = document.getElementById('settings-name');
        if (settingsName && uData.name) {
          settingsName.value = uData.name;
        }
        if (uData.name) {
          const avatarDropName = document.getElementById('dropdown-user-name');
          if (avatarDropName) avatarDropName.textContent = uData.name;
        }
      }

      // Ensure default workspace exists
      const workspaceRef = doc(db, 'workspaces', user.uid);
      const workspaceSnap = await Promise.race([getDoc(workspaceRef), firestoreTimeout(10000)]);
      if (!workspaceSnap.exists()) {
        await setDoc(workspaceRef, {
          id: user.uid,
          name: workspaceName,
          ownerId: user.uid,
          members: [user.uid],
          invitedEmails: []
        });
      }

      // Process pending invites
      try {
        const invitesQuery = query(collection(db, 'workspaces'), where('invitedEmails', 'array-contains', user.email));
        const invitesSnap = await getDocs(invitesQuery);
        for (const wDoc of invitesSnap.docs) {
          await updateDoc(doc(db, 'workspaces', wDoc.id), {
            members: arrayUnion(user.uid),
            invitedEmails: arrayRemove(user.email)
          });
        }
      } catch (inviteErr) {
        console.warn("Could not process invites:", inviteErr);
      }
    } catch (err) {
      console.error("Error fetching user profile:", err);
      if (navigator.onLine) showToast('Failed to load profile', 'error');
      // Fallback in case rules reject or network fails
      currentUserRole = 'user';
    }

    // Configure UI based on Role
    const adminSection = document.getElementById('admin-sidebar-section');
    if (adminSection) {
      adminSection.style.display = currentUserRole === 'superadmin' ? 'block' : 'none';
      if (currentUserRole === 'superadmin') {
        initAdminIntegrations(db);
        initAdminPlatforms(db, auth);
      }
    }

    // Setup Admin Global Settings Save
    const btnSaveGlobalSettings = document.getElementById('btn-save-global-settings');
    if (btnSaveGlobalSettings && !btnSaveGlobalSettings.dataset.bound) {
      btnSaveGlobalSettings.dataset.bound = 'true';
      btnSaveGlobalSettings.addEventListener('click', async () => {
        const num = document.getElementById('admin-whatsapp-number').value.trim();
        if (!num) return showToast('Please enter a valid number', 'error');
        
        setButtonLoading(btnSaveGlobalSettings, true);
        try {
          await setDoc(doc(db, 'app_settings', 'general'), { whatsappNumber: num }, { merge: true });
          const waLink = document.getElementById('whatsapp-fab-link');
          if (waLink) waLink.href = `https://wa.me/${num}`;
          showToast('Settings saved successfully', 'success');
        } catch (err) {
          showToast('Error saving settings: ' + err.message, 'error');
        } finally {
          setButtonLoading(btnSaveGlobalSettings, false);
        }
      });
    }

    // Wire sidebar navigation FIRST so clicks work immediately
    bindNavEvents();
    navigateTo('flows');
    wireViewRenderers();

    // Setup Workspace Switcher (non-blocking)
    setupWorkspaceSwitcher(user);

    window.currentWorkspaceId = currentWorkspaceId;
    window.currentUserRole = currentUserRole;

    // Load configs in background — renders when done
    loadConfigs();
    
    // Pre-render hub on login
    renderHubView(db, (v) => navigateTo(v));

    // Init Avatar Dropdown
    const avatarBtn = document.getElementById('user-avatar');
    const avatarDrop = document.getElementById('avatar-dropdown');
    if (avatarBtn && avatarDrop) {
      avatarBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        avatarDrop.classList.toggle('show');
      });
      document.addEventListener('click', () => {
        avatarDrop.classList.remove('show');
      });
      avatarDrop.addEventListener('click', (e) => e.stopPropagation());
    }

    // Sidebar toggle for mobile
    const sidebarToggle = document.getElementById('sidebar-toggle');
    const sidebar = document.getElementById('sidebar');
    const sidebarOverlay = document.getElementById('sidebar-overlay');
    if (sidebarToggle && sidebar && sidebarOverlay) {
      const toggleSidebar = () => {
        sidebar.classList.toggle('sidebar-open');
        sidebarOverlay.classList.toggle('show');
        document.body.classList.toggle('sidebar-open');
      };
      sidebarToggle.addEventListener('click', toggleSidebar);
      sidebarOverlay.addEventListener('click', toggleSidebar);
    }

    // Settings Modal Logic
    const settingsMenu = document.getElementById('menu-settings');

    const settingsModal = document.getElementById('settings-modal');
    const settingsClose = document.getElementById('settings-close');
    


    if (settingsMenu && settingsModal) {
      settingsMenu.addEventListener('click', (e) => {
        e.preventDefault();
        avatarDrop.classList.remove('show');
        settingsModal.classList.add('show');
      });
      settingsClose.addEventListener('click', () => {
        settingsModal.classList.remove('show');
      });
      settingsModal.addEventListener('click', (e) => {
        if (e.target === settingsModal) {
          settingsModal.classList.remove('show');
        }
      });
      
      // Tabs
      const tabs = document.querySelectorAll('.settings-tab');
      const panes = document.querySelectorAll('.settings-pane');
      tabs.forEach(tab => {
        tab.addEventListener('click', (e) => {
          e.preventDefault();
          tabs.forEach(t => t.classList.remove('active'));
          panes.forEach(p => {
            p.classList.remove('active');
            p.style.display = 'none';
          });
          tab.classList.add('active');
          const target = document.getElementById('pane-' + tab.dataset.tab);
          if (target) {
            target.classList.add('active');
            target.style.display = 'block';
            
            // If workspace tab, populate the collaborator list
            if (tab.dataset.tab === 'workspace' && currentWorkspaceId) {
              loadCollaborators();
            }
          }
        });
      });

      // Profile Save logic
      const btnSaveProfile = document.getElementById('btn-save-profile');
      const settingsNameInput = document.getElementById('settings-name');
      const profileMsg = document.getElementById('profile-msg');
      if (btnSaveProfile && settingsNameInput) {
        btnSaveProfile.addEventListener('click', async () => {
          if (profileMsg) profileMsg.textContent = '';
          const newName = settingsNameInput.value.trim();
          if (!newName) {
            settingsNameInput.reportValidity();
            return;
          }
          
          settingsNameInput.style.borderColor = 'var(--border)';
          setButtonLoading(btnSaveProfile, true);
          try {
            await updateDoc(doc(db, 'users', user.uid), {
              name: newName
            });
            if (profileMsg) {
              profileMsg.textContent = `Profile name updated to "${newName}" successfully!`;
              profileMsg.style.color = '#34d399';
            }
            // Also update the UI immediately
            const avatarDropName = document.getElementById('dropdown-user-name');
            if (avatarDropName) avatarDropName.textContent = newName;
          } catch (err) {
            if (profileMsg) {
              profileMsg.textContent = 'Failed to save: ' + err.message;
              profileMsg.style.color = '#f43f5e';
            }
          } finally {
            setButtonLoading(btnSaveProfile, false);
            setTimeout(() => {
              if (profileMsg && profileMsg.style.color === 'rgb(52, 211, 153)' || profileMsg.style.color === '#34d399') {
                profileMsg.textContent = '';
              }
            }, 3000);
          }
        });
      }

      // Save Workspace Logic
      const btnSaveWorkspace = document.getElementById('btn-save-workspace');
      const workspaceNameInput = document.getElementById('settings-workspace-name');
      const workspaceMsg = document.getElementById('workspace-msg');
      
      if (btnSaveWorkspace && workspaceNameInput) {
        btnSaveWorkspace.addEventListener('click', async () => {
          const newName = workspaceNameInput.value.trim();
          if (!newName || !currentWorkspaceId) return;
          setButtonLoading(btnSaveWorkspace, true);
          try {
            await updateDoc(doc(db, 'workspaces', currentWorkspaceId), {
              name: newName
            });
            // Update the user's profile as well to keep the redundant workspaceName field in sync
            if (currentWorkspaceId === user.uid) {
              await updateDoc(doc(db, 'users', user.uid), {
                workspaceName: newName
              });
            }
            if (workspaceMsg) {
              workspaceMsg.textContent = `Workspace name updated!`;
              workspaceMsg.style.color = '#34d399';
            }
            if (workspaceSelectTom) {
                workspaceSelectTom.updateOption(currentWorkspaceId, { value: currentWorkspaceId, text: newName });
                // Force UI to refresh the selected item text
                workspaceSelectTom.removeItem(currentWorkspaceId, true);
                workspaceSelectTom.addItem(currentWorkspaceId, true);
            }
          } catch (err) {
            if (workspaceMsg) {
              workspaceMsg.textContent = 'Failed to save: ' + err.message;
              workspaceMsg.style.color = '#f43f5e';
            }
          } finally {
            setButtonLoading(btnSaveWorkspace, false);
            setTimeout(() => {
              if (workspaceMsg) workspaceMsg.textContent = '';
            }, 3000);
          }
        });
      }

      // Invite UI logic
      const btnShowInvite = document.getElementById('btn-show-invite-form');
      const inviteForm = document.getElementById('invite-form');
      const btnSendInvite = document.getElementById('btn-send-invite');
      const inviteEmailInput = document.getElementById('invite-email-input');

      const inviteMsg = document.getElementById('invite-msg');
      const showInviteMsg = (msg, isError = false) => {
        if (inviteMsg) {
          inviteMsg.textContent = msg;
          inviteMsg.style.color = isError ? '#f43f5e' : '#34d399';
          setTimeout(() => { if (inviteMsg.textContent === msg) inviteMsg.textContent = ''; }, 4000);
        }
      };

      if (btnShowInvite && inviteForm) {
        btnShowInvite.addEventListener('click', () => {
          btnShowInvite.style.display = 'none';
          inviteForm.style.display = 'flex';
          if (inviteMsg) inviteMsg.textContent = '';
        });
      }

      if (btnSendInvite && inviteEmailInput) {
        btnSendInvite.addEventListener('click', async () => {
          const email = inviteEmailInput.value.trim().toLowerCase();
          if (!email) return showInviteMsg('Please enter an email', true);
          
          const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
          if (!emailRegex.test(email)) {
            return showInviteMsg('Please enter a valid email address', true);
          }
          
          const currentUserEmail = auth.currentUser ? auth.currentUser.email : null;
          if (email === currentUserEmail) {
            return showInviteMsg('You cannot invite yourself', true);
          }
          
          btnSendInvite.disabled = true;
          btnSendInvite.textContent = 'Sending...';
          try {
            const tSnap = await getDoc(doc(db, 'workspaces', currentWorkspaceId));
            let tenant = null;
            if (tSnap.exists()) {
              tenant = tSnap.data();
              if (tenant.invitedEmails && tenant.invitedEmails.includes(email)) {
                btnSendInvite.disabled = false;
                btnSendInvite.textContent = 'Send Invite';
                return showInviteMsg('User is already invited', true);
              }
            }
          
            await updateDoc(doc(db, 'workspaces', currentWorkspaceId), {
              invitedEmails: arrayUnion(email)
            });

            // Trigger Email Extension
            const workspaceName = tenant ? tenant.name : "a Workspace";
            await addDoc(collection(db, 'mail'), {
              to: [email],
              message: {
                subject: `Collaboration Invite: Access a Workspace on Velync`,
                html: `
<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background-color:#0a0819;color:#e2e8f0;font-family:'Helvetica Neue', Helvetica, Arial, sans-serif;">
  <table width="100%" border="0" cellspacing="0" cellpadding="0" style="background-color:#0a0819;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="600" border="0" cellspacing="0" cellpadding="0" style="background-color:#1e1b4b;border-radius:16px;overflow:hidden;box-shadow:0 10px 30px rgba(0,0,0,0.5);border:1px solid rgba(255,255,255,0.1);">
          <tr>
            <td align="center" style="padding:40px 0 35px 0;background:linear-gradient(135deg, #4f46e5 0%, #06b6d4 100%);">
              <h1 style="color:#ffffff;margin:0;font-size:32px;letter-spacing:1px;">Velync</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:40px 40px;">
              <h2 style="color:#ffffff;font-size:22px;margin-top:0;margin-bottom:20px;">Hi there,</h2>
              <p style="color:#cbd5e1;font-size:16px;line-height:24px;margin-bottom:24px;">
                You have been invited to collaborate on <strong>\${workspaceName}</strong> in Velync.
              </p>
              
              <p style="color:#cbd5e1;font-size:16px;line-height:24px;margin-bottom:16px;">
                By joining this workspace, you will be able to work together with your team to:
              </p>
              
              <ul style="color:#cbd5e1;font-size:16px;line-height:26px;margin-bottom:32px;padding-left:20px;">
                <li style="margin-bottom:10px;"><strong>Build Active Flows:</strong> Create, manage, and monitor automated sync pipelines.</li>
                <li style="margin-bottom:10px;"><strong>Connect Platforms:</strong> Securely link third-party tools like Notion, TickTick, and Google.</li>
                <li style="margin-bottom:10px;"><strong>Monitor Execution Logs:</strong> Track live data mapping and system operations in real time.</li>
              </ul>
              
              <p style="color:#cbd5e1;font-size:16px;line-height:24px;margin-bottom:40px;">
                Ready to align your workflows? Click the button below to accept your invitation, set up your account, and jump straight into the dashboard.
              </p>
              
              <div style="text-align:center;">
                <a href="https://velync.web.app" style="display:inline-block;padding:16px 32px;background:linear-gradient(135deg, #4f46e5 0%, #06b6d4 100%);color:#ffffff;text-decoration:none;border-radius:12px;font-size:16px;font-weight:bold;box-shadow:0 4px 15px rgba(79,70,229,0.4);">Join the Workspace</a>
              </div>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:24px;background-color:#161436;border-top:1px solid rgba(255,255,255,0.05);">
              <p style="color:#64748b;font-size:13px;margin:0;">
                © 2026 Velync. All rights reserved.<br>
                Secure integrations for modern teams.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
                `
              }
            });
            showInviteMsg(`Invite sent to ${email}`, false);
            inviteEmailInput.value = '';
            inviteForm.style.display = 'none';
            btnShowInvite.style.display = 'block';
            loadCollaborators(); // Refresh list
          } catch (err) {
            showInviteMsg('Failed to send invite: ' + err.message, true);
          } finally {
            btnSendInvite.disabled = false;
            btnSendInvite.textContent = 'Send Invite';
          }
        });
      }
      
      // Custom Confirm Modal Logic for Revoke
      function confirmRevoke(email) {
        return new Promise((resolve) => {
          const modal = document.getElementById('revoke-invite-modal');
          const emailDisplay = document.getElementById('revoke-modal-email');
          const btnConfirm = document.getElementById('revoke-modal-confirm');
          const btnCancel = document.getElementById('revoke-modal-cancel');
          
          if (!modal || !btnConfirm || !btnCancel) return resolve(false);
          
          emailDisplay.textContent = email;
          modal.classList.add('show');
          
          const cleanup = () => {
            modal.classList.remove('show');
            btnConfirm.removeEventListener('click', onConfirm);
            btnCancel.removeEventListener('click', onCancel);
          };
          
          const onConfirm = () => { cleanup(); resolve(true); };
          const onCancel = () => { cleanup(); resolve(false); };
          
          btnConfirm.addEventListener('click', onConfirm);
          btnCancel.addEventListener('click', onCancel);
        });
      }

      async function loadCollaborators() {
        const collabContainer = document.getElementById('collaborator-list-container');
        if (!collabContainer) return;
        collabContainer.innerHTML = `
          <div class="collaborator-item collab-skeleton">
            <div class="collab-avatar"></div>
            <div class="collab-info" style="width: 100%;">
              <div class="collab-skeleton-text" style="width: 40%;"></div>
              <div class="collab-skeleton-text" style="width: 70%;"></div>
            </div>
          </div>
          <div class="collaborator-item collab-skeleton" style="animation-delay: 0.2s;">
            <div class="collab-avatar"></div>
            <div class="collab-info" style="width: 100%;">
              <div class="collab-skeleton-text" style="width: 30%;"></div>
              <div class="collab-skeleton-text" style="width: 50%;"></div>
            </div>
          </div>
        `;
        try {
           const tSnap = await getDoc(doc(db, 'workspaces', currentWorkspaceId));
           if (!tSnap.exists()) return;
           const tenant = tSnap.data();
           let html = '';
           
           const wsInput = document.getElementById('settings-workspace-name');
           if (wsInput && tenant.name) {
             wsInput.value = tenant.name;
           }
           
           // List accepted members
           if (tenant.members) {
             for (const uid of tenant.members) {
               const uSnap = await getDoc(doc(db, 'users', uid));
               const uData = uSnap.exists() ? uSnap.data() : { email: 'Unknown' };
               const isOwner = tenant.ownerId === uid;
               const initials = uData.email ? uData.email.substring(0, 2).toUpperCase() : 'U';
               html += `
                 <div class="collaborator-item">
                   <div class="collab-avatar">${initials}</div>
                   <div class="collab-info">
                     <div class="collab-name">${escHtml(uData.name || 'Unknown User')} ${isOwner ? '(Owner)' : ''}</div>
                     <div class="collab-email">${escHtml(uData.email || '')}</div>
                   </div>
                 </div>
               `;
             }
           }
           
           // List pending invites
           if (tenant.invitedEmails) {
             for (const email of tenant.invitedEmails) {
               html += `
                 <div class="collaborator-item" style="opacity: 0.8;">
                   <div class="collab-avatar" style="background: transparent; border: 1px dashed var(--border); color: var(--text-2);">⏳</div>
                   <div class="collab-info" style="flex: 1;">
                     <div class="collab-name">Pending Invite</div>
                     <div class="collab-email">${email}</div>
                   </div>
                   <button class="btn btn-icon delete-invite-btn" title="Remove Invite" data-email="${email}" style="color: #f43f5e; background: rgba(244, 63, 94, 0.1); padding: 6px; border: none; cursor: pointer; border-radius: 6px;">
                     <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                   </button>
                 </div>
               `;
             }
           }
           collabContainer.innerHTML = html;

           // Bind delete invite events
           const deleteBtns = collabContainer.querySelectorAll('.delete-invite-btn');
           deleteBtns.forEach(btn => {
             btn.addEventListener('click', async (e) => {
               const deleteBtn = e.currentTarget;
               const targetEmail = deleteBtn.dataset.email;
               if (!targetEmail) return;
               
               const isConfirmed = await confirmRevoke(targetEmail);
               if (!isConfirmed) return;
               
               deleteBtn.disabled = true;
               deleteBtn.style.opacity = '0.5';
               try {
                 await updateDoc(doc(db, 'workspaces', currentWorkspaceId), {
                   invitedEmails: arrayRemove(targetEmail)
                 });
                 loadCollaborators();
                } catch (err) {
                  console.error('Error removing invite', err);
                  showToast('Failed to remove invite: ' + err.message, 'error');
                  deleteBtn.disabled = false;
                  deleteBtn.style.opacity = '1';
                }
             });
           });
        } catch (err) {
           collabContainer.innerHTML = '<div style="color: #f43f5e; font-size: 0.85rem;">Failed to load team</div>';
        }
      }    }
  } else {
    authOverlay.style.display = 'flex';
    appContainer.style.display = 'none';
    if (userEmailSpan) userEmailSpan.textContent = '';
    
    // If offline and no cached auth, show offline message on landing page
    if (!navigator.onLine) {
      const landingMain = document.querySelector('.landing-main');
      if (landingMain && !document.getElementById('offline-retry-ui')) {
        landingMain.innerHTML = `
          <div id="offline-retry-ui" style="text-align:center;padding:40px 20px;">
            <div style="font-size:3rem;margin-bottom:16px;">📡</div>
            <h2 style="margin-bottom:8px;">No internet connection</h2>
            <p style="color:var(--text-3);margin-bottom:24px;">You need an internet connection to sign in. Please check your connection and try again.</p>
            <button class="btn btn-primary" id="btn-offline-retry" type="button">Retry</button>
          </div>
        `;
        document.getElementById('btn-offline-retry')?.addEventListener('click', () => {
          if (navigator.onLine) location.reload();
          else showToast('Still offline. Check your connection.', 'error');
        });
      }
      return;
    }

    // Clear Avatar initials
    const userAvatar = document.getElementById('user-avatar');
    if (userAvatar) userAvatar.textContent = '';
    currentWorkspaceId = null;
    currentUserRole = 'user';
  }
});

// Wire additional view renderers to nav clicks
function wireViewRenderers() {
  const navConnections = document.getElementById('nav-connections');
  if (navConnections) {
    navConnections.addEventListener('click', async () => {
      renderConnectionsSkeleton();
      await loadConnections();
      renderConnectionsView();
    }, { once: false });
  }
  // Workspace selector
  const workspaceSel = document.getElementById('workspace-selector');
  if (workspaceSel) {
    workspaceSel.addEventListener('change', () => {
      const name = workspaceSel.options[workspaceSel.selectedIndex]?.text || 'Personal';
      const sidebarName = document.getElementById('sidebar-workspace-name');
      if (sidebarName) sidebarName.textContent = name.replace(/^[^ ]+ /, '');
      loadConfigs();
    });
  }
}

// ─── Landing Page Auth Handlers ───────────────────────────────

function getAuthErrorMessage(error) {
  switch (error.code) {
    case 'auth/email-already-in-use':
      return 'This email is already associated with an account. Please sign in instead.';
    case 'auth/invalid-email':
      return 'Please enter a valid email address.';
    case 'auth/user-not-found':
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
      return 'Invalid email or password. Please try again.';
    case 'auth/weak-password':
      return 'Your password is too weak. Please use at least 6 characters.';
    case 'auth/network-request-failed':
      return 'Network error. Please check your internet connection and try again.';
    case 'auth/too-many-requests':
      return 'Too many failed login attempts. Please try again later.';
    case 'auth/user-disabled':
      return 'This account has been disabled. Please contact support.';
    case 'auth/popup-closed-by-user':
      return 'Sign-in was cancelled.';
    default:
      return error.message ? error.message.replace('Firebase: ', '').split(' (auth/')[0] : 'An unexpected error occurred.';
  }
}

authToggleLink.addEventListener('click', (e) => {
  e.preventDefault();
  
  if (isResetMode) {
    isResetMode = false;
    isSignUpMode = false;
  } else {
    isSignUpMode = !isSignUpMode;
  }
  
  authError.style.display = 'none';
  authError.style.backgroundColor = 'rgba(239, 68, 68, 0.1)'; // Reset to red
  authError.style.color = '#EF4444';
  authError.style.borderColor = 'rgba(239, 68, 68, 0.2)';
  
  if(authPasswordGroup) authPasswordGroup.style.display = 'block';
  if(authPassword) authPassword.required = true;
  if(authDivider) authDivider.style.display = 'flex';
  if(btnLogin) btnLogin.style.display = 'flex';
  if(forgotPasswordLink) forgotPasswordLink.style.display = isSignUpMode ? 'none' : 'block';

  if (isSignUpMode) {
    authBoxTitle.textContent = "Create an Account";
    authBoxSubtitle.textContent = "Start automating your workflow today.";
    btnAuthSubmit.textContent = "Sign Up";
    authToggleText.textContent = "Already have an account?";
    authToggleLink.textContent = "Sign In";
  } else {
    authBoxTitle.textContent = "Welcome Back";
    authBoxSubtitle.textContent = "Sign in to manage your workspace.";
    btnAuthSubmit.textContent = "Sign In";
    authToggleText.textContent = "Don't have an account?";
    authToggleLink.textContent = "Sign Up";
  }
});

if (forgotPasswordLink) {
  forgotPasswordLink.addEventListener('click', (e) => {
    e.preventDefault();
    isResetMode = true;
    authError.style.display = 'none';
    
    authBoxTitle.textContent = "Reset Password";
    authBoxSubtitle.textContent = "Enter your email address to receive a reset link.";
    btnAuthSubmit.textContent = "Send Reset Link";
    
    if(authPasswordGroup) authPasswordGroup.style.display = 'none';
    if(authPassword) authPassword.required = false;
    if(authDivider) authDivider.style.display = 'none';
    if(btnLogin) btnLogin.style.display = 'none';
    forgotPasswordLink.style.display = 'none';
    
    authToggleText.textContent = "Remembered your password?";
    authToggleLink.textContent = "Sign In";
  });
}

authForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = authEmail.value.trim();
  const password = authPassword.value;
  
  if (!email || (!isResetMode && !password)) return;

  authError.style.display = 'none';
  authError.style.backgroundColor = 'rgba(239, 68, 68, 0.1)'; // Reset to red
  authError.style.color = '#EF4444';
  authError.style.borderColor = 'rgba(239, 68, 68, 0.2)';
  
  btnAuthSubmit.disabled = true;
  const originalText = btnAuthSubmit.textContent;
  btnAuthSubmit.textContent = isResetMode ? 'Sending...' : (isSignUpMode ? 'Creating Account...' : 'Signing In...');

  try {
    if (isResetMode) {
      try {
        await sendPasswordResetEmail(auth, email);
        authError.textContent = "Reset link sent! Please check your email.";
        authError.style.display = 'block';
        authError.style.backgroundColor = 'rgba(16, 185, 129, 0.1)'; // Green success
        authError.style.color = '#10B981';
        authError.style.borderColor = 'rgba(16, 185, 129, 0.2)';
        btnAuthSubmit.textContent = "Send Reset Link";
        btnAuthSubmit.disabled = false;
        return; // Stop here, don't trigger the auth state changes
      } catch (resetErr) {
        if (resetErr.code === 'auth/user-not-found' || resetErr.code === 'auth/invalid-credential') {
          throw new Error('This email is not registered. Please create an account first.');
        }
        throw resetErr;
      }
    } else if (isSignUpMode) {
      await createUserWithEmailAndPassword(auth, email, password);
      if (analytics) logEvent(analytics, 'sign_up', { method: 'email' });
    } else {
      await signInWithEmailAndPassword(auth, email, password);
      if (analytics) logEvent(analytics, 'login', { method: 'email' });
    }
  } catch (error) {
    authError.textContent = getAuthErrorMessage(error);
    authError.style.display = 'block';
  } finally {
    btnAuthSubmit.disabled = false;
    btnAuthSubmit.textContent = originalText;
  }
});

btnLogin.addEventListener('click', async () => {
  const provider = new GoogleAuthProvider();
  authError.style.display = 'none';
  btnLogin.disabled = true;
  btnLogin.innerHTML = 'Connecting...';
  try {
    await signInWithPopup(auth, provider);
    if (analytics) logEvent(analytics, 'login', { method: 'google' });
  } catch (error) {
    authError.textContent = getAuthErrorMessage(error);
    authError.style.display = 'block';
  } finally {
    btnLogin.disabled = false;
    btnLogin.innerHTML = '<img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" alt="Google" width="18" height="18" /> Continue with Google';
  }
});

btnLogout.addEventListener('click', async () => {
  try {
    await signOut(auth);
    currentProjects = [];
    if (authForm) authForm.reset();
  } catch (error) {
    showToast('Logout failed: ' + error.message, 'error');
  }
});

// ─── Toast ────────────────────────────────────────────────────
// ─── Stats ────────────────────────────────────────────────────
function updateStats() {
  const total    = configs.length;
  const enabled  = configs.filter(c => c.enabled).length;
  const disabled = total - enabled;
  if (statTotal) statTotal.textContent   = total;
  if (statEnabled) statEnabled.textContent = enabled;
  if (statDisabled) statDisabled.textContent= disabled;
}

// ─── Masking ──────────────────────────────────────────────────
function maskSecret(val) {
  if (!val) return '—';
  const s = String(val);
  if (s.length <= 8) return '••••••••';
  return s.slice(0, 4) + '••••••••' + s.slice(-4);
}

// ─── Sorting & Data Grid Helper Functions ──────────────────────
function getNestedValue(obj, path) {
  if (!obj) return '';
  return path.split('.').reduce((acc, part) => {
    return acc && acc[part] !== undefined ? acc[part] : '';
  }, obj);
}

function sortConfigs() {
  const sorted = [...configs];
  const columnMap = {
    list: 'p1Settings.listName',
    syncTag: 'p1Settings.syncTag',
    targetDb: 'p2Settings.databaseId',
  };
  const resolvedColumn = columnMap[currentSortColumn] || currentSortColumn;
  sorted.sort((a, b) => {
    let valA = getNestedValue(a, resolvedColumn) ?? getNestedValue(a, currentSortColumn);
    let valB = getNestedValue(b, resolvedColumn) ?? getNestedValue(b, currentSortColumn);

    if (typeof valA === 'boolean') valA = valA ? 1 : 0;
    if (typeof valB === 'boolean') valB = valB ? 1 : 0;

    if (typeof valA === 'string') valA = valA.toLowerCase();
    if (typeof valB === 'string') valB = valB.toLowerCase();

    if (valA < valB) return currentSortDirection === 'asc' ? -1 : 1;
    if (valA > valB) return currentSortDirection === 'asc' ? 1 : -1;
    return 0;
  });
  return sorted;
}

function updateToolbarButtonStates() {
  const editBtn = document.getElementById('tb-edit');
  const dupBtn = document.getElementById('tb-duplicate');
  const delBtn = document.getElementById('tb-delete');
  const menuEdit = document.getElementById('menu-edit-config');
  const menuDup = document.getElementById('menu-duplicate-config');
  const menuDel = document.getElementById('menu-delete-config');

  const hasSingle = selectedConfigIds.size === 1;

  if (hasSingle) {
    if (editBtn) { editBtn.removeAttribute('disabled'); editBtn.classList.remove('disabled'); }
    if (dupBtn) { dupBtn.removeAttribute('disabled'); dupBtn.classList.remove('disabled'); }
    if (delBtn) { delBtn.removeAttribute('disabled'); delBtn.classList.remove('disabled'); }

    if (menuEdit) menuEdit.classList.remove('disabled-menu-item');
    if (menuDup) menuDup.classList.remove('disabled-menu-item');
    if (menuDel) menuDel.classList.remove('disabled-menu-item');
  } else {
    if (editBtn) { editBtn.setAttribute('disabled', 'true'); editBtn.classList.add('disabled'); }
    if (dupBtn) { dupBtn.setAttribute('disabled', 'true'); dupBtn.classList.add('disabled'); }
    if (delBtn) { delBtn.setAttribute('disabled', 'true'); delBtn.classList.add('disabled'); }

    if (menuEdit) menuEdit.classList.add('disabled-menu-item');
    if (menuDup) menuDup.classList.add('disabled-menu-item');
    if (menuDel) menuDel.classList.add('disabled-menu-item');
  }
}

async function showDocSchema() {
  const schemaText = `Sync Config Schema (Firestore Document):
- description: string (e.g. "Work Inbox Sync")
- enabled: boolean
- syncType: "Source_to_Dest" | "Dest_to_Source" | "Bidirectional"
- deleteAfterSync: boolean
- targetEntity: "Tasks" | "Notes" | "Habits"
- cronSchedule: string (cron format)
- platform1ConnectionId: string
- platform2ConnectionId: string
- ticktick: { listName, syncTag }
- notion: { databaseId, templateId }
- fieldMappings: Array<{ ticktickField, notionProperty }>
- statusMappings: { incomplete: Array, incompleteDefault, complete: Array, completeDefault }`;
  await alertDialog({ title: 'Sync Config Schema', message: schemaText });
}

// Cached feather SVGs for renderCards
const _svgCache = {
  plus: feather.icons['plus'].toSvg({width: 14, height: 14}),
  'refresh-cw': feather.icons['refresh-cw'].toSvg({width: 12, height: 12, style: 'vertical-align: middle;'}),
  'edit-2': feather.icons['edit-2'].toSvg({width: 14, height: 14}),
  copy: feather.icons['copy'].toSvg({width: 14, height: 14}),
  'trash-2': feather.icons['trash-2'].toSvg({width: 14, height: 14}),
};
let _sortHeaders = null;

// ─── Platform logo helper ─────────────────────────────────────
function getPlatformLogoSvg(platformId) {
  if (!platformId || !window.cachedPlatforms) {
    return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/></svg>';
  }
  const plat = window.cachedPlatforms.find(p => p.id === platformId || p.key === platformId);
  if (plat && plat.logo) return plat.logo;
  return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/></svg>';
}

// ─── Multi-select bar helpers ─────────────────────────────────
function updateMultiSelectBar() {
  const bar = document.getElementById('multi-select-bar');
  const countEl = document.getElementById('multi-select-count');
  if (!bar || !countEl) return;
  const count = selectedConfigIds.size;
  if (count > 0) {
    countEl.textContent = count + ' selected';
    bar.style.display = 'flex';
  } else {
    bar.style.display = 'none';
  }
}

function clearSelection() {
  selectedConfigIds.clear();
  renderCards();
}

window.usersCache = window.usersCache || {};
async function fetchUserForCache(uid) {
  if (window.usersCache[uid] === 'fetching') return;
  window.usersCache[uid] = 'fetching';
  try {
    const uSnap = await getDoc(doc(db, 'users', uid));
    if (uSnap.exists()) {
      window.usersCache[uid] = uSnap.data();
      renderCards(); // Re-render to update the table
    } else {
      window.usersCache[uid] = { name: 'Unknown' };
    }
  } catch (err) {
    window.usersCache[uid] = null;
  }
}

// ─── Render cards ─────────────────────────────────────────────
function renderCards() {
  updateStats();

  // Update headers sort indicator — cache th.sortable query
  if (!_sortHeaders) _sortHeaders = document.querySelectorAll('th.sortable');
  _sortHeaders.forEach(th => {
    const col = th.dataset.col;
    const sortIcon = th.querySelector('.sort-icon');
    th.classList.remove('sort-asc', 'sort-desc');
    if (sortIcon) sortIcon.textContent = '';

    if (col === currentSortColumn) {
      th.classList.add(currentSortDirection === 'asc' ? 'sort-asc' : 'sort-desc');
      if (sortIcon) sortIcon.textContent = currentSortDirection === 'asc' ? ' ▲' : ' ▼';
    }
  });

  // Handle Wrap class on table
  if (isTextWrap) {
    configsTable.classList.add('text-wrap');
    if (menuViewWrap) menuViewWrap.classList.add('active-menu-item');
    if (tbWrap) tbWrap.classList.add('active');
  } else {
    configsTable.classList.remove('text-wrap');
    if (menuViewWrap) menuViewWrap.classList.remove('active-menu-item');
    if (tbWrap) tbWrap.classList.remove('active');
  }

  // Handle Zebra Striping
  if (isZebraStriped) {
    configsTable.classList.add('zebra-striped');
    if (menuFormatZebra) menuFormatZebra.classList.add('active-menu-item');
  } else {
    configsTable.classList.remove('zebra-striped');
    if (menuFormatZebra) menuFormatZebra.classList.remove('active-menu-item');
  }

  // Handle Compact Density
  if (isCompact) {
    configsTable.classList.remove('standard-density');
    if (menuViewCompact) menuViewCompact.classList.add('active-menu-item');
  } else {
    configsTable.classList.add('standard-density');
    if (menuViewCompact) menuViewCompact.classList.remove('standard-density');
  }

  // Handle Freeze Headers
  if (isHeaderFrozen) {
    configsTable.classList.add('headers-frozen');
    if (gridTableWrapper) gridTableWrapper.classList.add('frozen-wrapper');
    if (tbFreeze) tbFreeze.classList.add('active');
  } else {
    configsTable.classList.remove('headers-frozen');
    if (gridTableWrapper) gridTableWrapper.classList.remove('frozen-wrapper');
    if (tbFreeze) tbFreeze.classList.remove('active');
  }

  // Handle search value and filter
  const searchVal = tbSearch ? tbSearch.value.toLowerCase().trim() : '';
  let sortedConfigs = sortConfigs();

  if (searchVal) {
    sortedConfigs = sortedConfigs.filter(cfg => {
      const name = (cfg.description || '').toLowerCase();
      const id = (cfg.id || '').toLowerCase();
      const direction = (cfg.syncType || '').toLowerCase();
      const target = (cfg.p1Settings?.targetEntity || '').toLowerCase();
      const list = (cfg.ticktick?.listName || (cfg.p1Settings?.listName || cfg.p1Settings?.projectName) || '').toLowerCase();
      const tag = (cfg.ticktick?.syncTag || '').toLowerCase();
      const notionDb = (cfg.notion?.databaseId || cfg.p2Settings?.databaseId || '').toLowerCase();
      return name.includes(searchVal) ||
             id.includes(searchVal) ||
             direction.includes(searchVal) ||
             target.includes(searchVal) ||
             list.includes(searchVal) ||
             tag.includes(searchVal) ||
             notionDb.includes(searchVal);
    });
  }

  // Select all checkbox state
  if (selectAllCheckbox) {
    selectAllCheckbox.checked = sortedConfigs.length > 0 && sortedConfigs.every(cfg => selectedConfigIds.has(cfg.id));
  }

  // If no configs
  if (configs.length === 0) {
    tableBody.innerHTML = `
      <tr class="table-empty-row">
        <td colspan="8">
          <div style="padding: 32px 16px; text-align: center;">
            <div style="font-size: 2.5rem; margin-bottom: 12px;">📭</div>
            <h3 style="margin-bottom: 6px; color: var(--text-1);">No Flows Found</h3>
            <p style="color: var(--text-3); font-size: 0.88rem; margin-bottom: 16px;">Create your first configuration to start syncing data.</p>
          </div>
        </td>
      </tr>`;
      
    updateToolbarButtonStates();
    updateMultiSelectBar();
    return;
  }

  // If search matches nothing
  if (sortedConfigs.length === 0) {
    tableBody.innerHTML = `
      <tr class="table-empty-row">
        <td colspan="8">
          <div style="padding: 32px 16px; text-align: center;">
            <div style="font-size: 2rem; margin-bottom: 12px;">🔍</div>
            <h3 style="margin-bottom: 6px; color: var(--text-1);">No match found</h3>
            <p style="color: var(--text-3); font-size: 0.88rem;">Adjust your filter or search terms and try again.</p>
          </div>
        </td>
      </tr>`;
    updateToolbarButtonStates();
    updateMultiSelectBar();
    return;
  }

  tableBody.innerHTML = '';
  sortedConfigs.forEach((cfg) => {
    const row = document.createElement('tr');
    row.dataset.id = cfg.id;
    if (selectedConfigIds.has(cfg.id)) {
      row.classList.add('selected-row');
    }

    const p1Name = cfg.p1Settings?.platformName || 'Source';
    const p2Name = cfg.p2Settings?.platformName || 'Dest';

    let p1Id = cfg.platform1;
    let p2Id = cfg.platform2;
    if (!p1Id && cfg.platform1ConnectionId && typeof _connectionsCache !== 'undefined') {
      const c = _connectionsCache.find(x => x.id === cfg.platform1ConnectionId);
      if (c) p1Id = c.provider;
    }
    if (!p2Id && cfg.platform2ConnectionId && typeof _connectionsCache !== 'undefined') {
      const c = _connectionsCache.find(x => x.id === cfg.platform2ConnectionId);
      if (c) p2Id = c.provider;
    }
    const p1Logo = getPlatformLogoSvg(p1Id);
    const p2Logo = getPlatformLogoSvg(p2Id);
    let ownerName = cfg.ownerName || cfg.createdBy || '—';
    if (!cfg.ownerName && cfg.ownerId) {
      if (auth.currentUser && cfg.ownerId === auth.currentUser.uid && auth.currentUser.displayName) {
        ownerName = auth.currentUser.displayName;
      } else if (window.usersCache && window.usersCache[cfg.ownerId] && window.usersCache[cfg.ownerId] !== 'fetching') {
        const cachedUser = window.usersCache[cfg.ownerId];
        ownerName = cachedUser.name || cachedUser.displayName || cachedUser.email || ownerName;
      } else if (!window.usersCache[cfg.ownerId]) {
        fetchUserForCache(cfg.ownerId);
      }
    }
    const lastRun = cfg.lastRunAt ? fmtDate(cfg.lastRunAt) : '—';

    // Parse the cron schedule into a readable text format
    let scheduleText = 'Every 5 Minutes';
    if (cfg.cronSchedule) {
      const [cVal, cUnit] = parseCron(cfg.cronSchedule);
      let displayUnit = cUnit.charAt(0).toUpperCase() + cUnit.slice(1);
      if (cVal == 1 && displayUnit.endsWith('s')) displayUnit = displayUnit.slice(0, -1);
      scheduleText = cUnit === 'advanced' ? 'Custom' : `Every ${cVal} ${displayUnit}`;
    }

    row.innerHTML = `
      <td class="col-checkbox">
        <input type="checkbox" class="row-checkbox" data-id="${cfg.id}" ${selectedConfigIds.has(cfg.id) ? 'checked' : ''} />
      </td>
      <td data-label="Name" title="${escHtml(cfg.description || cfg.id)}">
        <span class="card-name-text">${escHtml(cfg.description || cfg.id)}</span>
        ${cfg.status === 'draft' ? '<span class="badge" style="background-color: var(--bg-2); color: var(--text-2); padding: 2px 6px; border-radius: 4px; font-size: 0.75rem; margin-left: 8px;">Draft</span>' : ''}
      </td>
      <td data-label="Apps" title="${escHtml(p1Name)} ➔ ${escHtml(p2Name)}">
        <div class="app-icons-row">
          <span class="app-icon-wrap">${p1Logo}</span>
          <span class="app-icon-wrap">${p2Logo}</span>
        </div>
      </td>
      <td data-label="Status">
        <label class="toggle" title="${cfg.enabled ? 'Disable' : 'Enable'} this config">
          <input type="checkbox" class="toggle-checkbox" data-id="${cfg.id}" ${cfg.enabled ? 'checked' : ''} />
          <span class="toggle-track"></span>
          <span class="toggle-thumb"></span>
        </label>
      </td>
      <td data-label="Sync Schedule">
        <span class="card-value schedule-value" data-id="${cfg.id}">${scheduleText}</span>
      </td>
      <td data-label="Last Run">
        <span class="card-value">${lastRun}</span>
      </td>
      <td data-label="Owner">
        <span class="card-value">${escHtml(ownerName)}</span>
      </td>
      <td class="col-actions">
        <div class="row-actions-dropdown">
          <button class="row-action-btn btn-row-more" data-id="${cfg.id}" type="button" title="More actions">⋮</button>
          <div class="row-actions-menu">
            <button class="row-action-menu-item btn-row-edit" data-id="${cfg.id}" type="button">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              Edit
            </button>
            <button class="row-action-menu-item btn-row-duplicate" data-id="${cfg.id}" type="button">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
              Duplicate
            </button>
            <div class="row-actions-menu-divider"></div>
            <button class="row-action-menu-item btn-row-delete" data-id="${cfg.id}" data-name="${escAttr(cfg.description || cfg.id)}" type="button" style="color:var(--danger);">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
              Delete
            </button>
          </div>
        </div>
      </td>
    `;

    tableBody.appendChild(row);
  });

  // Single delegated click listener for all row interactions
  if (!tableBody._delegated) {
    tableBody._delegated = true;
    tableBody.addEventListener('change', (e) => {
      const toggle = e.target.closest('.toggle-checkbox');
      if (toggle) {
        e.stopPropagation();
        toggleConfig(toggle.dataset.id, toggle);
      }
    });
    tableBody.addEventListener('click', (e) => {
      const row = e.target.closest('tr');
      if (!row || !row.dataset.id) return;

      const editBtn = e.target.closest('.btn-row-edit');
      if (editBtn) { e.stopPropagation(); openPanel(editBtn.dataset.id); return; }

      const dupBtn = e.target.closest('.btn-row-duplicate');
      if (dupBtn) { e.stopPropagation(); duplicateConfig(dupBtn.dataset.id); return; }

      const delBtn = e.target.closest('.btn-row-delete');
      if (delBtn) { e.stopPropagation(); confirmDelete(delBtn.dataset.id, delBtn.dataset.name); return; }

      const moreBtn = e.target.closest('.btn-row-more');
      if (moreBtn) {
        e.stopPropagation();
        document.querySelectorAll('.row-actions-menu.open').forEach(m => {
          if (m !== moreBtn.nextElementSibling) m.classList.remove('open');
          m.style.position = '';
          m.style.left = '';
          m.style.top = '';
          m.style.bottom = '';
        });
        const menu = moreBtn.nextElementSibling;
        if (!menu) return;
        const isOpening = !menu.classList.contains('open');
        if (isOpening) {
          const btnRect = moreBtn.getBoundingClientRect();
          const wrapperRect = document.getElementById('grid-table-wrapper').getBoundingClientRect();
          const menuWidth = 140;
          const menuHeight = menu.offsetHeight || 150;
          const left = Math.max(0, Math.min(btnRect.right - menuWidth, wrapperRect.right - menuWidth));
          const spaceBelow = window.innerHeight - btnRect.bottom - 4;
          if (spaceBelow >= menuHeight) {
            menu.style.position = 'fixed';
            menu.style.left = left + 'px';
            menu.style.top = btnRect.bottom + 4 + 'px';
            menu.style.bottom = 'auto';
          } else {
            menu.style.position = 'fixed';
            menu.style.left = left + 'px';
            menu.style.top = 'auto';
            menu.style.bottom = window.innerHeight - btnRect.top + 4 + 'px';
          }
          menu.classList.add('open');
        } else {
          menu.classList.remove('open');
          menu.style.position = '';
          menu.style.left = '';
          menu.style.top = '';
          menu.style.bottom = '';
        }
        return;
      }

      const chk = e.target.closest('.row-checkbox');
      if (chk) {
        e.stopPropagation();
        const id = chk.dataset.id;
        if (chk.checked) selectedConfigIds.add(id);
        else selectedConfigIds.delete(id);
        renderCards();
        return;
      }

      if (e.target.closest('.col-checkbox') || e.target.closest('.toggle') || e.target.closest('.col-actions') || e.target.closest('.app-icons-row')) return;

      const id = row.dataset.id;
      if (selectedConfigIds.has(id)) {
        selectedConfigIds.delete(id);
        if (selectedConfigIds.size === 0) clearSelection();
        else renderCards();
      } else {
        selectedConfigIds.add(id);
        renderCards();
      }
    });
    tableBody.addEventListener('dblclick', (e) => {
      const row = e.target.closest('tr');
      if (!row || !row.dataset.id) return;
      if (e.target.closest('.col-checkbox') || e.target.closest('.toggle') || e.target.closest('.col-actions')) return;
      openPanel(row.dataset.id);
    });
  }

  updateToolbarButtonStates();
  updateMultiSelectBar();
}

// ─── Load configs ─────────────────────────────────────────────
async function loadConfigs(silent = false) {
  const loadKey = 'loadConfigs';
  startLoad(loadKey);

  if (refreshIcon) {
    refreshIcon.style.transform = 'rotate(360deg)';
    refreshIcon.style.transition = 'transform 0.5s';
    setTimeout(() => { refreshIcon.style.transform = ''; refreshIcon.style.transition = ''; }, 600);
  }

  try {
    if (!window.cachedPlatforms) {
      const pSnap = await getDocs(collection(db, 'platforms'));
      window.cachedPlatforms = pSnap.docs.map(d => ({id: d.id, ...d.data()}));
    }
    if (typeof loadConnections === 'function' && (!_connectionsCache || _connectionsCache.length === 0)) {
      _connectionsCache = await loadConnections();
    }

    const q = collection(db, "workspaces", currentWorkspaceId, "sync_configs");
    const querySnapshot = await Promise.race([
      getDocs(q),
      firestoreTimeout(15000)
    ]);
    configs = querySnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    renderCards();
  } catch (err) {
    tableBody.innerHTML = `
      <tr class="table-empty-row">
        <td colspan="8" style="color: var(--rose); font-weight: 500; text-align: center; padding: 20px;">
          ${feather.icons['alert-triangle'].toSvg({width: 18, height: 18, style: 'vertical-align: middle; color: var(--warning);'})} ${!navigator.onLine ? 'No internet available' : 'Could not load configs: ' + escHtml(err.message)}
        </td>
      </tr>
      <tr class="table-empty-row">
        <td colspan="8" style="text-align: center; padding: 0 20px 20px;">
          <button class="btn btn-sm btn-secondary" id="btn-retry-load" type="button">
            ${feather.icons['refresh-cw'].toSvg({width: 12, height: 12})} Retry
          </button>
        </td>
      </tr>`;
    document.getElementById('btn-retry-load')?.addEventListener('click', () => loadConfigs());
    showToast(!navigator.onLine ? 'No internet available' : 'Failed to load configs: ' + err.message, 'error');
  } finally {
    endLoad(loadKey);
  }
}


// ─── Toggle enabled ───────────────────────────────────────────
async function toggleConfig(id, checkbox) {
  const prev = checkbox.checked;
  checkbox.disabled = true;
  try {
    const docRef = doc(db, "sync_configs", id);
    await updateDoc(docRef, {
      enabled: checkbox.checked,
      updatedAt: new Date().toISOString()
    });
    
    const cfg = configs.find(c => c.id === id);
    if (cfg) cfg.enabled = checkbox.checked;
    renderCards();
    showToast(`Config ${checkbox.checked ? 'enabled' : 'disabled'}`, checkbox.checked ? 'success' : 'info');
  } catch (err) {
    checkbox.checked = prev;
    showToast('Toggle failed: ' + err.message, 'error');
  } finally {
    checkbox.disabled = false;
  }
}

// ─── Panel open/close ─────────────────────────────────────────
async function openPanel(id = null) {
  editingId = id;
  if (!id) {
    window.currentConfigId = null;
  } else {
    window.currentConfigId = id;
  }
  clearForm();
  window.resetConfigDirty();

  sidePanel.classList.add('open');
  const formContainer = document.getElementById('form-container');
  if (formContainer) {
    formContainer.innerHTML = getSkeletonFormHTML();
  }

  const loadKey = 'openPanel';
  startLoad(loadKey);

  try {

  // 1. Fetch cachedPlatforms first so that populateConnectionDropdowns
  // can correctly resolve dynamic platform IDs.
  if (!window.cachedPlatforms) {
    try {
      const snap = await getDocs(collection(db, 'platforms'));
      window.cachedPlatforms = snap.docs.map(d => ({id: d.id, ...d.data()}));
    } catch(err) {
      console.warn('Failed to load platforms in openPanel', err);
      if (navigator.onLine) showToast('Failed to load platforms', 'error');
    }
  }

  // 2. Load connections and populate the dropdowns
  _connectionsCache = await loadConnections();

  // Determine platform providers for filtering connection dropdowns
  let p1Provider = null;
  let p2Provider = null;

  if (id) {
    // Edit mode: derive providers from saved connections
    let cfg = configs.find(c => c.id === id);
    if (!cfg) {
      try {
        const snap = await getDoc(doc(db, 'workspaces', currentWorkspaceId, 'sync_configs', id));
        if (snap.exists()) {
          cfg = { id: snap.id, ...snap.data() };
          configs.push(cfg);
        }
      } catch(err) {
        console.warn('[openPanel] Direct Firestore fetch failed:', err);
        showToast('Failed to load config data', 'error');
      }
    }
    if (cfg) {
      const p1c = _connectionsCache.find(c => c.id === cfg.platform1ConnectionId);
      const p2c = _connectionsCache.find(c => c.id === cfg.platform2ConnectionId);
      if (p1c) p1Provider = p1c.provider;
      if (p2c) p2Provider = p2c.provider;
      // Fall back to platform IDs stored directly on the config (saved by gatherFormData)
      if (!p1Provider && cfg.platform1) p1Provider = cfg.platform1;
      if (!p2Provider && cfg.platform2) p2Provider = cfg.platform2;
    }
  } else if (window.currentIntegration) {
    // New config from marketplace flow: use integration's platform definitions
    const integ = window.currentIntegration;
    p1Provider = typeof integ.platform1 === 'string' ? integ.platform1 : (integ.platform1?.key || integ.platform1?.id);
    p2Provider = typeof integ.platform2 === 'string' ? integ.platform2 : (integ.platform2?.key || integ.platform2?.id);
  }

  populateConnectionDropdowns(_connectionsCache, id, p1Provider, p2Provider);
  setConnectButtonProviders(p1Provider, p2Provider);

  if (id) {
    panelTitle.innerHTML = feather.icons['edit-2'].toSvg({width: 18, height: 18, style: 'margin-right: 6px; vertical-align: text-bottom;'}) + ' Edit Config';
    
    let cfg = configs.find(c => c.id === id);
      
    if (cfg) {
      fillForm(cfg);
      // Note: populateConnectionDropdowns was already called above with provider info.
      
      const p1Conn = _connectionsCache.find(c => c.id === cfg.platform1ConnectionId);
      if (p1Conn) {
        window.renderSchemaForPlatform(p1Conn.provider, 'p1-dynamic-container', 'p1', cfg.p1Settings || {});
        const entity = cfg.p1Settings?.targetEntity || 'Tasks';
        fetchSourceSchema(cfg.platform1ConnectionId, p1Conn.provider, entity);
      }
      
      const p2Conn = _connectionsCache.find(c => c.id === cfg.platform2ConnectionId);
      if (p2Conn) {
        window.renderSchemaForPlatform(p2Conn.provider, 'p2-dynamic-container', 'p2', cfg.p2Settings || {});
        if (cfg.p2Settings?.databaseId) {
          fetchNotionDbSchema(cfg.p2Settings.databaseId, cfg.platform2ConnectionId, false);
        }
      }
    }
  } else {
    panelTitle.innerHTML = feather.icons['plus'].toSvg({width: 18, height: 18, style: 'margin-right: 6px; vertical-align: text-bottom;'}) + ' New Config';
  }

  } finally {
    endLoad(loadKey);
  }

  goToStep(1);
  if (!id) {
    document.getElementById('f-tt-connection')?.dispatchEvent(new Event('change'));
    document.getElementById('f-notion-connection')?.dispatchEvent(new Event('change'));
  }
  sidePanel.classList.add('open');
  panelOverlay.classList.add('open');
  fDescription.focus();
}
window.openPanel = openPanel; // Expose globally for external scripts

let _dropdownP1Provider = null;
let _dropdownP2Provider = null;
let _dropdownP1Name = null;
let _dropdownP2Name = null;

function getPlatformDisplayName(providerId) {
  if (!providerId) return null;
  const plat = window.cachedPlatforms?.find(p => p.id === providerId || p.key === providerId);
  return plat?.name || providerId;
}

function setConnectButtonProviders(p1Provider, p2Provider) {
  _dropdownP1Provider = p1Provider;
  _dropdownP2Provider = p2Provider;
  _dropdownP1Name = getPlatformDisplayName(p1Provider);
  _dropdownP2Name = getPlatformDisplayName(p2Provider);

  const p1Name = _dropdownP1Name || 'Platform 1';
  const p2Name = _dropdownP2Name || 'Platform 2';

  const btn1 = document.getElementById('btn-connect-p1');
  const btn2 = document.getElementById('btn-connect-p2');
  const link1 = document.getElementById('p1-connect-link');
  const link2 = document.getElementById('p2-connect-link');
  const hint1 = document.getElementById('p1-connect-hint');
  const hint2 = document.getElementById('p2-connect-hint');
  if (btn1) btn1.dataset.provider = p1Provider || '';
  if (btn2) btn2.dataset.provider = p2Provider || '';
  if (link1) link1.dataset.provider = p1Provider || '';
  if (link2) link2.dataset.provider = p2Provider || '';
  if (hint1) hint1.dataset.provider = p1Provider || '';
  if (hint2) hint2.dataset.provider = p2Provider || '';

  // Update section titles
  const t1 = document.getElementById('p1-settings-title');
  const t2 = document.getElementById('p2-settings-title');
  if (t1) t1.textContent = p1Name + ' Settings';
  if (t2) t2.textContent = p2Name + ' Settings';

  // Update node labels in the workflow canvas
  const n1 = document.getElementById('node-p1-name');
  const n2 = document.getElementById('node-p2-name');
  if (n1) n1.textContent = p1Name;
  if (n2) n2.textContent = p2Name;

  // Store on window for openNodeModal to read
  window._p1DisplayName = p1Name;
  window._p2DisplayName = p2Name;
}

function buildSelectHtml(connections) {
  return {
    html: '<option value="">-- Select Connection --</option>' +
      connections.map(c => `<option value="${c.id}">${escHtml(c.label)}</option>`).join(''),
    hasConns: connections.length > 0
  };
}

function populateConnectionDropdowns(connections, id = null, p1Provider = null, p2Provider = null) {
  _dropdownP1Provider = p1Provider;
  _dropdownP2Provider = p2Provider;

  window._connectingProvider = null;

  // Remove any connecting indicators
  document.querySelectorAll('#section-p1 .loader1, #section-p2 .loader2').forEach(el => el.remove());

  const p1Conns = p1Provider ? connections.filter(c => c.provider === p1Provider) : connections;
  const p2Conns = p2Provider ? connections.filter(c => c.provider === p2Provider) : connections;

  const p1Result = buildSelectHtml(p1Conns);
  const p2Result = buildSelectHtml(p2Conns);

  fTtConnection.innerHTML = p1Result.html;
  fNotionConnection.innerHTML = p2Result.html;
  fTtConnection.disabled = false;
  fNotionConnection.disabled = false;

  const hint1 = document.getElementById('p1-connect-hint');
  const hint2 = document.getElementById('p2-connect-hint');
  const btn1 = document.getElementById('btn-connect-p1');
  const btn2 = document.getElementById('btn-connect-p2');

  if (!p1Result.hasConns) {
    if (hint1) hint1.style.display = '';
    if (btn1) btn1.style.display = 'none';
  } else {
    if (hint1) hint1.style.display = 'none';
    if (btn1) btn1.style.display = '';
  }
  if (!p2Result.hasConns) {
    if (hint2) hint2.style.display = '';
    if (btn2) btn2.style.display = 'none';
  } else {
    if (hint2) hint2.style.display = 'none';
    if (btn2) btn2.style.display = '';
  }

  if (id) {
    const cfg = configs.find(c => c.id === id);
    if (cfg) {
      if (cfg.platform1ConnectionId) fTtConnection.value = cfg.platform1ConnectionId;
      if (cfg.platform2ConnectionId) fNotionConnection.value = cfg.platform2ConnectionId;
    }
  }
}

function handleConnectionChange(prefix) {
  const connId = document.getElementById(prefix === 'p1' ? 'f-tt-connection' : 'f-notion-connection')?.value;
  const containerId = prefix === 'p1' ? 'p1-dynamic-container' : 'p2-dynamic-container';
  const container = document.getElementById(containerId);
  if (!container) return;

  if (!connId) {
    container.innerHTML = '';
    return;
  }

  const conn = _connectionsCache.find(c => c.id === connId);
  if (!conn) return;

  container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;padding:20px;color:var(--text-3);"><span class="spinner" style="width:16px;height:16px;border-width:2px;margin-right:8px;"></span> Loading fields...</div>';
  window.renderSchemaForPlatform(conn.provider, containerId, prefix, {});

  // Auto-trigger Refresh on visible dynamic_select fields after schema renders
  setTimeout(() => {
    container.querySelectorAll('.btn-refresh-ds').forEach(btn => {
      const row = btn.closest('.form-row');
      if (row && row.style.display !== 'none') btn.click();
    });
  }, 100);
}

async function closePanel() {
  window._connectingProvider = null;
  document.querySelectorAll('#section-p1 .loader1, #section-p2 .loader2').forEach(el => el.remove());
  const sidePanel = document.getElementById('side-panel');
  if (sidePanel && sidePanel.classList.contains('inline-mode')) {
    return;
  }
  if (isConfigDirty) {
    const action = await threeWayConfirmDialog({
      title: 'Unsaved Changes',
      message: 'You have unsaved changes. Would you like to save them before closing?',
      saveText: 'Save',
      discardText: 'Discard',
      cancelText: 'Cancel'
    });
    if (action === 'cancel') return;
    if (action === 'save') {
      const fakeEvent = { preventDefault: () => {} };
      await saveConfig(fakeEvent, false);
      if (isConfigDirty) {
        return; // Save failed or validation error prevented saving
      }
    }
  }
  sidePanel.classList.remove('open');
  panelOverlay.classList.remove('open');
  editingId = null;
  window.currentConfigId = null;
  wizardStep = 1;
  window.resetConfigDirty();
}

function duplicateConfig(id) {
  const cfg = configs.find(c => c.id === id);
  if (!cfg) return;

  editingId = null;
  clearForm();

  // Make a copy and clear the ID, append "(Copy)" to description
  const copy = JSON.parse(JSON.stringify(cfg));
  copy.id = '';
  copy.description = copy.description ? `${copy.description} (Copy)` : 'Copy Config';
  
  fillForm(copy);

  panelTitle.innerHTML = feather.icons['copy'].toSvg({width: 18, height: 18, style: 'margin-right: 6px; vertical-align: text-bottom;'}) + ' Duplicate Config';
  sidePanel.classList.add('open');
  panelOverlay.classList.add('open');
  fDescription.focus();
}

function buildSourceFieldOptions(entity, selectedField) {
  let fields = Object.entries(sourceSchema).map(([key, f]) => ({
    value: key, label: `${f.label || key} (${f.type})`
  }));
  if (!fields.length) {
    const legacy = { Tasks: 'title,desc,tags,status', Notes: 'title,content,tags', Habits: 'name,type,goal' };
    fields = (legacy[entity] || 'title').split(',').map(k => ({ value: k, label: k }));
  }
  return fields.map(f => `<option value="${f.value}" ${f.value === selectedField ? 'selected' : ''}>${f.label}</option>`).join('');
}

function addMappingRow(sourceField = '', destField = '', sourceFieldList = null, destFieldList = null) {
  const row = document.createElement('div');
  row.className = 'mapping-row';
  row.style = 'display: flex; gap: 0.5rem; align-items: center; background: rgba(255, 255, 255, 0.03); padding: 0.5rem; border-radius: 6px;';

  const entity = (window.harvestDynamicFields && window.harvestDynamicFields('p1-dynamic-container')['targetEntity']) || 'Tasks';

  if (!sourceFieldList) {
    sourceFieldList = Object.entries(sourceSchema).map(([key, f]) => ({
      value: key, label: `${f.label || key} (${f.type})`
    }));
    if (!sourceFieldList.length) {
      const legacy = { Tasks: 'title,desc,tags,status', Notes: 'title,content,tags', Habits: 'name,type,goal' };
      sourceFieldList = (legacy[entity] || 'title').split(',').map(k => ({ value: k, label: k }));
    }
  }

  if (!destFieldList) {
    destFieldList = Object.keys(notionDbProperties).map(prop => ({
      value: prop, label: `${prop} (${notionDbProperties[prop].type})`
    }));
    destFieldList.unshift({ value: '__content__', label: '[Page Content / Body]' });
  }

  let sOptions = sourceFieldList.map(f =>
    `<option value="${f.value}" ${f.value === sourceField ? 'selected' : ''}>${f.label}</option>`
  ).join('');

  let dOptions = destFieldList.map(f =>
    `<option value="${f.value}" ${f.value === destField ? 'selected' : ''}>${f.label}</option>`
  ).join('');

  row.innerHTML = `
    <select class="map-source" style="flex: 1; padding: 4px; border-radius: 4px; background: var(--bg-card); color: var(--text-1); border: 1px solid var(--border); font-size: 0.85rem;">${sOptions}</select>
    <span style="color: var(--text-3); font-size: 0.9rem;">➔</span>
    <select class="map-dest" style="flex: 1; padding: 4px; border-radius: 4px; background: var(--bg-card); color: var(--text-1); border: 1px solid var(--border); font-size: 0.85rem;">${dOptions}</select>
    <button type="button" class="btn-remove-mapping" style="background: none; border: none; color: var(--danger); font-size: 1.1rem; cursor: pointer; padding: 4px; display: flex; align-items: center; justify-content: center;">${feather.icons['x'].toSvg({width: 14, height: 14})}</button>
  `;

  row.querySelector('.map-source').addEventListener('change', () => updateStatusMappingUI());
  row.querySelector('.map-dest').addEventListener('change', () => updateStatusMappingUI());

  row.querySelector('.btn-remove-mapping').addEventListener('click', () => {
    row.remove();
    updateStatusMappingUI();
  });

  mappingsContainer.appendChild(row);
  updateStatusMappingUI();
}

function updateStatusMappingUI(savedStatusMappings = null) {
  if (!sectionStatusMapping) return;

  const statusRow = Array.from(mappingsContainer.querySelectorAll('.mapping-row'))
    .find(row => (row.querySelector('.map-source') || row.querySelector('.map-ticktick'))?.value === 'status');
    
  if (!statusRow) {
    sectionStatusMapping.style.display = 'none';
    return;
  }

  const propName = (statusRow.querySelector('.map-dest') || statusRow.querySelector('.map-notion')).value;
  const propSchema = notionDbProperties[propName];
  
  if (!propSchema || (propSchema.type !== 'status' && propSchema.type !== 'select')) {
    sectionStatusMapping.style.display = 'none';
    return;
  }

  sectionStatusMapping.style.display = 'block';

  const options = (propSchema.type === 'status' ? propSchema.status?.options : propSchema.select?.options) || [];
  
  if (statusIncompleteSelect) {
    statusIncompleteSelect.clear(true);
    statusIncompleteSelect.clearOptions();
  }
  if (statusCompleteSelect) {
    statusCompleteSelect.clear(true);
    statusCompleteSelect.clearOptions();
  }
  fStatusIncompleteDefault.innerHTML = '';
  fStatusCompleteDefault.innerHTML = '';

  options.forEach(opt => {
    const optionVal = opt.name;
    
    if (statusIncompleteSelect) {
      statusIncompleteSelect.addOption({ value: optionVal, text: optionVal });
    }
    if (statusCompleteSelect) {
      statusCompleteSelect.addOption({ value: optionVal, text: optionVal });
    }
    
    const defaultOpt1 = document.createElement('option');
    defaultOpt1.value = optionVal;
    defaultOpt1.textContent = optionVal;
    fStatusIncompleteDefault.appendChild(defaultOpt1);

    const defaultOpt2 = document.createElement('option');
    defaultOpt2.value = optionVal;
    defaultOpt2.textContent = optionVal;
    fStatusCompleteDefault.appendChild(defaultOpt2);
  });

  let incVal = [];
  let incDefVal = '';
  let compVal = [];
  let compDefVal = '';

  if (savedStatusMappings) {
    incVal = savedStatusMappings.incomplete || [];
    incDefVal = savedStatusMappings.incompleteDefault || '';
    compVal = savedStatusMappings.complete || [];
    compDefVal = savedStatusMappings.completeDefault || '';
  } else {
    const completedNames = options.filter(opt => ['completed', 'complete', 'done'].includes(opt.name.toLowerCase())).map(opt => opt.name);
    const incompleteNames = options.filter(opt => ['not started', 'to-do', 'todo', 'in progress'].includes(opt.name.toLowerCase())).map(opt => opt.name);
    
    compVal = completedNames.length > 0 ? completedNames : (options.length > 0 ? [options[options.length - 1].name] : []);
    compDefVal = completedNames.length > 0 ? completedNames[0] : (options.length > 0 ? options[options.length - 1].name : '');
    
    incVal = incompleteNames.length > 0 ? incompleteNames : (options.length > 0 ? [options[0].name] : []);
    incDefVal = incompleteNames.length > 0 ? incompleteNames[0] : (options.length > 0 ? options[0].name : '');
  }

  if (statusIncompleteSelect) {
    statusIncompleteSelect.setValue(incVal, true);
  }
  fStatusIncompleteDefault.value = incDefVal;

  if (statusCompleteSelect) {
    statusCompleteSelect.setValue(compVal, true);
  }
  fStatusCompleteDefault.value = compDefVal;
}

async function loadDefaultMappingsPreset() {
  mappingsContainer.innerHTML = '';
  const entity = (window.harvestDynamicFields && window.harvestDynamicFields('p1-dynamic-container')['targetEntity']) || 'Tasks';

  const sourceConnId = document.getElementById('f-tt-connection')?.value || document.querySelector('[data-source-connection]')?.value;
  const destConnId = document.getElementById('f-notion-connection')?.value || document.querySelector('[data-dest-connection]')?.value;

  if (sourceConnId && destConnId && Object.keys(sourceSchema).length && Object.keys(notionDbProperties).length) {
    try {
      const user = auth.currentUser;
      const idToken = await user.getIdToken();
      const res = await fetch(`${API_URL}/schema/suggest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
        body: JSON.stringify({ sourceSchema, destSchema: notionDbProperties })
      });
      const data = await res.json();
      if (data.success && data.suggestions) {
        data.suggestions.forEach(s => {
          if (s.destField) addMappingRow(s.sourceField, s.destField);
        });
        return;
      }
    } catch (e) {
      console.warn('Suggest API failed, falling back to presets:', e);
    }
  }

  // Fallback presets
  if (entity === 'Tasks') {
    addMappingRow('title', 'Name');
    addMappingRow('tags', 'Topic');
    addMappingRow('desc', '__content__');
  } else if (entity === 'Notes') {
    addMappingRow('title', 'Name');
    addMappingRow('tags', 'Topic');
    addMappingRow('content', '__content__');
  } else if (entity === 'Habits') {
    addMappingRow('name', 'Name');
  }
}

function filterAndPopulateTtLists() {
  const entity = (window.harvestDynamicFields && window.harvestDynamicFields('p1-dynamic-container')['targetEntity']) || 'Tasks';
  const currentVal = fTtList.value;

  fTtList.innerHTML = '';

  if (entity === 'Habits') {
    return;
  }

  if (currentProjects.length === 0) {
    const opt = document.createElement('option');
    opt.value = "";
    opt.textContent = "-- Click Load Data --";
    fTtList.appendChild(opt);
    return;
  }

  if (entity === 'Tasks') {
    const inboxOpt = document.createElement('option');
    inboxOpt.value = 'Inbox';
    inboxOpt.textContent = 'Inbox';
    fTtList.appendChild(inboxOpt);
  }

  const expectedKind = entity === 'Notes' ? 'NOTE' : 'TASK';
  const filtered = currentProjects.filter(p => String(p.kind).toUpperCase() === expectedKind);

  filtered.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.name;
    opt.textContent = p.name;
    fTtList.appendChild(opt);
  });

  if (currentVal && Array.from(fTtList.options).some(o => o.value === currentVal)) {
    fTtList.value = currentVal;
  } else if (fTtList.options.length > 0) {
    fTtList.value = fTtList.options[0].value;
  }
}

async function fetchNotionDbSchema(databaseId, connectionId, showToasts = true) {
  if (!connectionId || !databaseId) return;
  try {
    const user = auth.currentUser;
    const idToken = await user.getIdToken();
    const res = await fetch(`${API_URL}/notion-database-schema`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${idToken}`
      },
      body: JSON.stringify({ connectionId, databaseId })
    });
    const data = await res.json();
    if (!data.success) {
      throw new Error(data.error || 'Failed to load database schema');
    }
    notionDbProperties = data.schema || {};
    
    // Rerender destination property selectors in existing mapping rows
    const rows = mappingsContainer.querySelectorAll('.mapping-row');
    rows.forEach(row => {
      const selectDest = row.querySelector('.map-dest') || row.querySelector('.map-notion');
      const currentVal = selectDest.value;
      
      let dOptions = `<option value="__content__" ${currentVal === '__content__' ? 'selected' : ''}>[Page Content / Body]</option>`;
      Object.keys(notionDbProperties).forEach(prop => {
        const type = notionDbProperties[prop].type;
        dOptions += `<option value="${prop}" ${prop === currentVal ? 'selected' : ''}>${prop} (${type})</option>`;
      });
      selectDest.innerHTML = dOptions;
    });

    if (showToasts) showToast('Loaded database schema properties successfully!', 'success');
    updateStatusMappingUI();
  } catch (err) {
    console.error('Schema Load Error:', err);
    if (showToasts) showToast(`Error loading database properties: ${err.message}`, 'error');
  }
}

async function fetchNotionDbTemplates(dbId, connectionId, selectedTemplateId = null) {
  const row = document.getElementById('notion-template-row');
  const select = document.getElementById('f-n-template');
  if (!row || !select) return;

  if (!dbId || !connectionId) {
    row.style.display = 'none';
    select.innerHTML = '<option value="">No Template (Default Layout)</option>';
    return;
  }

  row.style.display = 'flex';
  select.innerHTML = '<option value="">Loading templates...</option>';
  select.disabled = true;

  try {
    const user = auth.currentUser;
    const idToken = await user.getIdToken();
    const res = await fetch(`${API_URL}/notion-database-templates`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${idToken}`
      },
      body: JSON.stringify({ connectionId, databaseId: dbId })
    });
    const data = await res.json();
    if (data.success) {
      let optionsHtml = '<option value="">No Template (Default Layout)</option>';
      const templates = data.templates || [];
      templates.forEach(tpl => {
        const selected = tpl.id === selectedTemplateId ? 'selected' : '';
        optionsHtml += `<option value="${escAttr(tpl.id)}" ${selected}>${escHtml(tpl.name || 'Untitled Template')}</option>`;
      });
      select.innerHTML = optionsHtml;
    } else {
      console.error('Failed to load templates:', data.error);
      select.innerHTML = `<option value="">Error: ${escHtml(data.error || 'Unknown error')}</option>`;
    }
  } catch (err) {
    console.error('Error loading templates:', err);
    select.innerHTML = '<option value="">Error loading templates</option>';
  } finally {
    select.disabled = false;
  }
}

async function fetchSourceSchema(connectionId, platform, entityType = 'Tasks') {
  if (!connectionId || !platform) return;
  // Resolve platform to key if an ID was incorrectly passed (e.g. custom platforms)
  const plat = window.cachedPlatforms?.find(p => p.id === platform || p.key === platform);
  let resolvedPlatform = plat ? (plat.key || plat.name?.toLowerCase() || plat.id) : platform;
  if (plat && resolvedPlatform === plat.id) {
     if (plat.authUrl?.includes('ticktick')) resolvedPlatform = 'ticktick';
     if (plat.authUrl?.includes('notion')) resolvedPlatform = 'notion';
  }
  try {
    const user = auth.currentUser;
    const idToken = await user.getIdToken();
    const res = await fetch(`${API_URL}/schema`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
      body: JSON.stringify({ connectionId, platform: resolvedPlatform, entityType })
    });
    const data = await res.json();
    if (data.success) {
      sourceSchema = data.schema || {};
      currentSourcePlatform = platform;
      // Rerender source selectors
      const rows = mappingsContainer.querySelectorAll('.mapping-row');
      rows.forEach(row => {
        const selectSrc = row.querySelector('.map-source') || row.querySelector('.map-ticktick');
        const currentVal = selectSrc.value;
        const fields = Object.entries(sourceSchema).map(([key, f]) =>
          `<option value="${key}" ${key === currentVal ? 'selected' : ''}>${f.label || key} (${f.type})</option>`
        ).join('');
        selectSrc.innerHTML = fields || '<option value="">No fields</option>';
      });
    }
  } catch (err) {
    console.warn('Failed to fetch source schema:', err);
    showToast('Failed to load schema fields', 'error');
  }
}

function triggerFormFieldVisibility() {
  const syncType = fSyncType.value;
  if (syncType === 'Bidirectional') {
    deleteAfterRow.style.display = 'none';
  } else {
    deleteAfterRow.style.display = 'flex';
  }
}

function clearForm() {
  window.currentConfigStatus = 'draft';
  // Only reset creationSource to 'manual' when not in marketplace/inline mode
  const sidePanel = document.getElementById('side-panel');
  if ((sidePanel && sidePanel.classList.contains('inline-mode')) || window.currentIntegration) {
    window.currentConfigCreationSource = 'marketplace';
  } else {
    window.currentConfigCreationSource = 'manual';
  }

  let fIntegrationId = document.getElementById('f-integration-id');
  if (!fIntegrationId) {
    fIntegrationId = document.createElement('input');
    fIntegrationId.type = 'hidden';
    fIntegrationId.id = 'f-integration-id';
    document.getElementById('config-form').appendChild(fIntegrationId);
  }
  document.getElementById('form-id').value = '';
  fIntegrationId.value = '';
  fDescription.value = '';
  fSyncType.value = 'Source_to_Dest';
  fDeleteAfter.checked = false;

  fTtConnection.value = '';
  fNotionConnection.value = '';
  
  if (fTtList) fTtList.innerHTML = '<option value="">-- Select Connection --</option>';
  if (fTtTag) fTtTag.innerHTML = '';
  
  fCron.value        = '*/5 * * * *';
  if (fIntervalValue) fIntervalValue.value = 5;
  if (fIntervalUnit) {
    fIntervalUnit.value = 'minutes';
    fIntervalUnit.dispatchEvent(new Event('change'));
  }
  if (notionDbSelect) {
    notionDbSelect.clear();
    notionDbSelect.clearOptions();
  } else if (fNDbId) {
    fNDbId.innerHTML   = '<option value="">Select a database...</option>';
    fNDbId.value       = '';
  }
  const templateRow = document.getElementById('notion-template-row');
  if (templateRow) templateRow.style.display = 'none';
  const templateSelect = document.getElementById('f-n-template');
  if (templateSelect) {
    templateSelect.innerHTML = '<option value="">No Template (Default Layout)</option>';
    templateSelect.value = '';
  }

  // Clear dynamic platform containers so legacy schema fields don't persist
  const p1Container = document.getElementById('p1-dynamic-container');
  if (p1Container) p1Container.innerHTML = '';
  const p2Container = document.getElementById('p2-dynamic-container');
  if (p2Container) p2Container.innerHTML = '';

  notionDbProperties = {};
  mappingsContainer.innerHTML = '';
  
  if (statusIncompleteSelect) statusIncompleteSelect.clear(true);
  if (statusCompleteSelect) statusCompleteSelect.clear(true);
  if (fStatusIncompleteDefault) fStatusIncompleteDefault.innerHTML = '';
  if (fStatusCompleteDefault) fStatusCompleteDefault.innerHTML = '';
  if (sectionStatusMapping) sectionStatusMapping.style.display = 'none';

  currentProjects = [];
  triggerFormFieldVisibility();
}

function parseCron(cronStr) {
  if (!cronStr) return [5, 'minutes', '*/5 * * * *'];
  if (cronStr.startsWith('*/') && cronStr.endsWith(' * * * *')) {
    const mins = cronStr.split(' ')[0].replace('*/', '');
    return [mins, 'minutes', cronStr];
  }
  if (cronStr.startsWith('0 */') && cronStr.endsWith(' * * *')) {
    const hrs = cronStr.split(' ')[1].replace('*/', '');
    return [hrs, 'hours', cronStr];
  }
  return [5, 'advanced', cronStr];
}

function buildCron(val, unit, raw) {
  if (unit === 'advanced') return raw || '*/5 * * * *';
  if (unit === 'minutes') return `*/${val || 5} * * * *`;
  if (unit === 'hours') return `0 */${val || 1} * * *`;
  return '*/5 * * * *';
}

async function fillForm(cfg) {
  window.currentConfigStatus = cfg.status || 'draft';
  window.currentConfigCreationSource = cfg.creationSource || 'manual';

  let fIntegrationId = document.getElementById('f-integration-id');
  if (!fIntegrationId) {
    fIntegrationId = document.createElement('input');
    fIntegrationId.type = 'hidden';
    fIntegrationId.id = 'f-integration-id';
    document.getElementById('config-form').appendChild(fIntegrationId);
  }
  document.getElementById('form-id').value = cfg.id;
  fIntegrationId.value = cfg.integrationId || '';
  fDescription.value = cfg.description || '';
  
  fSyncType.value      = cfg.syncType || 'Source_to_Dest';
  fDeleteAfter.checked = cfg.deleteAfterSync === true;


  if (cfg.platform1ConnectionId) fTtConnection.value = cfg.platform1ConnectionId;
  if (cfg.platform2ConnectionId) fNotionConnection.value = cfg.platform2ConnectionId;
  
  const listName = cfg.ticktick?.listName || '';
  if (listName && fTtList) {
    const opt = document.createElement('option');
    opt.value = listName;
    opt.textContent = listName;
    fTtList.appendChild(opt);
    fTtList.value = listName;
  }
  
  const syncTag = cfg.ticktick?.syncTag || '';
  if (syncTag && fTtTag) {
    const opt = document.createElement('option');
    opt.value = syncTag;
    opt.textContent = syncTag;
    fTtTag.appendChild(opt);
    fTtTag.value = syncTag;
  }
  
  const cronStr = cfg.cronSchedule || '*/5 * * * *';
  const [val, unit, raw] = parseCron(cronStr);
  if (fIntervalValue) fIntervalValue.value = val;
  if (fIntervalUnit) {
    fIntervalUnit.value = unit;
    fIntervalUnit.dispatchEvent(new Event('change'));
  }
  fCron.value = raw;
  
  const dbId = cfg.notion?.databaseId || '';
  if (dbId) {
    if (notionDbSelect) {
      notionDbSelect.addOption({value: dbId, text: `Current DB (${dbId.substring(0, 8)}...)`});
      notionDbSelect.setValue(dbId);
    } else {
      const opt = document.createElement('option');
      opt.value = dbId;
      opt.textContent = `Current DB (${dbId.substring(0, 8)}...)`;
      fNDbId.appendChild(opt);
      fNDbId.value = dbId;
    }
  }
  
  // Set field visibility
  triggerFormFieldVisibility();

  // Load field mappings
  mappingsContainer.innerHTML = '';
  const mappings = cfg.fieldMappings || [];
  if (mappings.length > 0) {
    mappings.forEach(m => addMappingRow(m.sourceField || m.ticktickField, m.destField || m.notionProperty));
  } else {
    loadDefaultMappingsPreset();
  }
  
  updateStatusMappingUI(cfg.statusMappings);

  // Update visual node builder UI to match form data
  if (typeof updateNodeStatuses === 'function') {
    updateNodeStatuses();
  }
}

function buildFormPayload(status) {
  
  // Read dynamic mapping rows
  const fieldMappings = [];
  const rows = mappingsContainer.querySelectorAll('.mapping-row');
  rows.forEach(row => {
    const sourceField = (row.querySelector('.map-source') || row.querySelector('.map-ticktick')).value;
    const destField = (row.querySelector('.map-dest') || row.querySelector('.map-notion')).value;
    if (sourceField && destField) {
      fieldMappings.push({ sourceField, destField });
    }
  });

  const creationSource = window.currentConfigCreationSource || 'manual';

  // Preserve existing connection IDs: only overwrite if the dropdown has a real selection.
  // A blank dropdown value must NOT wipe out a connection ID that was already saved.
  const resolvedFormId = editingId || document.getElementById('form-id')?.value?.trim() || null;
  const existingCfg = resolvedFormId ? configs.find(c => c.id === resolvedFormId) : null;

  let p1ConnId = fTtConnection.value || existingCfg?.platform1ConnectionId || '';
  let p2ConnId = fNotionConnection.value || existingCfg?.platform2ConnectionId || '';

  // If this config came from the marketplace flow, the connections are locked in step 1.
  // Ignore the form dropdowns and strictly preserve what was saved in the draft.
  if (creationSource === 'marketplace' && existingCfg) {
    p1ConnId = existingCfg.platform1ConnectionId || p1ConnId;
    p2ConnId = existingCfg.platform2ConnectionId || p2ConnId;
  }

  return {
    description: fDescription.value.trim() || 'New Sync Configuration',
    integrationId: document.getElementById('f-integration-id')?.value || null,
    status: status,
    creationSource: creationSource,
    enabled:     status === 'active',
    syncType:    fSyncType.value,
    deleteAfterSync: fDeleteAfter.checked,
    cronSchedule: buildCron(fIntervalValue?.value, fIntervalUnit?.value, fCron?.value),
    platform1: _dropdownP1Provider || (typeof _connectionsCache !== 'undefined' && _connectionsCache.find(c => c.id === fTtConnection.value)?.provider) || null,
    platform2: _dropdownP2Provider || (typeof _connectionsCache !== 'undefined' && _connectionsCache.find(c => c.id === fNotionConnection.value)?.provider) || null,
    platform1ConnectionId: p1ConnId,
    platform2ConnectionId: p2ConnId,
    p1Settings: window.harvestDynamicFields ? window.harvestDynamicFields('p1-dynamic-container') : {},
    p2Settings: window.harvestDynamicFields ? window.harvestDynamicFields('p2-dynamic-container') : {},
    fieldMappings,
    statusMappings: (Array.from(mappingsContainer.querySelectorAll('.mapping-row'))
      .some(row => (row.querySelector('.map-source') || row.querySelector('.map-ticktick')).value === 'status')) ? {
        incomplete: statusIncompleteSelect ? statusIncompleteSelect.getValue() : [],
        incompleteDefault: fStatusIncompleteDefault ? fStatusIncompleteDefault.value : '',
        complete: statusCompleteSelect ? statusCompleteSelect.getValue() : [],
        completeDefault: fStatusCompleteDefault ? fStatusCompleteDefault.value : ''
      } : null,
    updatedAt: serverTimestamp(),
    workspaceId: currentWorkspaceId,
  };
}

let isSavingConfig = false;

// ─── Save config ──────────────────────────────────────────────
async function saveConfig(e, isSubmit = false) {
  if (e && e.preventDefault) e.preventDefault();
  if (isSavingConfig) return;
  isSavingConfig = true;

  const status = isSubmit ? 'active' : 'draft';
  const payload = buildFormPayload(status);
  
  if (payload.platform1ConnectionId && payload.platform2ConnectionId && payload.platform1ConnectionId === payload.platform2ConnectionId) {
    showToast("Validation Error: The 'From' and 'To' connections cannot be the exact same account.", 'error');
    isSavingConfig = false;
    return;
  }
  
  const targetBtn = isSubmit ? btnSubmit : btnSave;
  if (btnSave) btnSave.disabled = true;
  if (btnSubmit) btnSubmit.disabled = true;
  
  const originalText = targetBtn ? targetBtn.innerHTML : '';
  if (targetBtn) targetBtn.innerHTML = '<span class="spin">⟳</span> Saving…';

  try {
    // ── Resolve which document to update ──────────────────────
    // Priority 1: editingId in memory (set by openPanel)
    // Priority 2: hidden form-id field in the DOM (set by fillForm)
    // Priority 3: when in marketplace/inline mode, query Firestore directly
    //             by integrationId to find the existing draft — this is the
    //             authoritative fallback that survives navigation.
    let resolvedId = editingId || document.getElementById('form-id')?.value?.trim() || null;

    if (!resolvedId) {
      const sidePanel = document.getElementById('side-panel');
      const isInlineMode = sidePanel && sidePanel.classList.contains('inline-mode');
      const integrationId = document.getElementById('f-integration-id')?.value?.trim();

      if (isInlineMode && integrationId && currentWorkspaceId) {
        // Directly query Firestore for an existing draft for this integration
        const q = query(
          collection(db, 'workspaces', currentWorkspaceId, 'sync_configs'),
          where('integrationId', '==', integrationId)
        );
        const snap = await getDocs(q);
        if (!snap.empty) {
          const sortedDocs = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => {
            const tA = a.updatedAt?.toMillis ? a.updatedAt.toMillis() : (new Date(a.updatedAt || 0).getTime());
            const tB = b.updatedAt?.toMillis ? b.updatedAt.toMillis() : (new Date(b.updatedAt || 0).getTime());
            if (tA !== tB) return tB - tA; // Descending
            // Tiebreaker: prefer drafts with actual settings
            const aHasSettings = (a.p1Settings && Object.keys(a.p1Settings).length > 0) ? 1 : 0;
            const bHasSettings = (b.p1Settings && Object.keys(b.p1Settings).length > 0) ? 1 : 0;
            return bHasSettings - aHasSettings;
          });
          resolvedId = sortedDocs[0].id;
          // Ensure creationSource is preserved from the original draft
          if (!payload.creationSource) {
            payload.creationSource = sortedDocs[0].creationSource || 'marketplace';
          }
        }
      }
    }

    if (resolvedId) {
      editingId = resolvedId; // keep in-memory state in sync
      document.getElementById('form-id').value = resolvedId;
      const docRef = doc(db, 'workspaces', currentWorkspaceId, 'sync_configs', resolvedId);
      
      // Enforce marketplace protection immediately before saving
      const existingDoc = await getDoc(docRef);
      if (existingDoc.exists()) {
        const existingData = existingDoc.data();
        if (existingData.creationSource === 'marketplace') {
           payload.platform1ConnectionId = existingData.platform1ConnectionId || payload.platform1ConnectionId;
           payload.platform2ConnectionId = existingData.platform2ConnectionId || payload.platform2ConnectionId;
           payload.creationSource = 'marketplace';
        }
      }
      
      payload.updatedAt = new Date().toISOString();
      await updateDoc(docRef, payload);
      showToast(isSubmit ? 'Config activated' : 'Config updated', 'success');
    } else {
      payload.createdAt = serverTimestamp();
      let fullName = auth.currentUser?.displayName;
      if (window.usersCache && window.usersCache[auth.currentUser.uid] && window.usersCache[auth.currentUser.uid] !== 'fetching') {
         fullName = fullName || window.usersCache[auth.currentUser.uid].name || window.usersCache[auth.currentUser.uid].displayName;
      }
      if (!fullName) {
        try {
          const uSnap = await getDoc(doc(db, 'users', auth.currentUser.uid));
          if (uSnap.exists()) {
            fullName = uSnap.data().name || uSnap.data().displayName;
          }
        } catch (err) {
          console.warn('Failed to fetch user name during config creation', err);
        }
      }
      payload.ownerName = fullName || auth.currentUser?.email || 'Unknown';
      payload.ownerId = auth.currentUser?.uid || null;
      const docRef = await addDoc(collection(db, 'workspaces', currentWorkspaceId, 'sync_configs'), payload);
      editingId = docRef.id;
      window.currentConfigId = docRef.id;
      document.getElementById('form-id').value = docRef.id;
      showToast(isSubmit ? 'Config activated' : 'Config created', 'success');
    }
    window.resetConfigDirty();
    await loadConfigs(true);
    
    // If submitted, close the panel automatically so they can see the Active flows
    if (isSubmit) {
      const sidePanel = document.getElementById('side-panel');
      if (sidePanel && sidePanel.classList.contains('inline-mode')) {
        // If we are inline, redirect to flows
        navigateTo('flows');
      } else {
        await closePanel();
      }
    }
  } catch (err) {
    showToast('Save failed: ' + err.message, 'error');
  } finally {
    isSavingConfig = false;
    if (btnSave) {
      btnSave.disabled = false;
      btnSave.innerHTML = `Save (Draft)`;
    }
    if (btnSubmit) {
      btnSubmit.disabled = false;
      btnSubmit.innerHTML = `Submit (Active)`;
    }
  }
}
window.saveConfig = saveConfig;

// ─── Delete flow ──────────────────────────────────────────────
function confirmDelete(id, name) {
  pendingDeleteId = id;
  modalName.textContent = `"${name}"`;
  modalOverlay.classList.add('open');
}

function closeModal() {
  modalOverlay.classList.remove('open');
  pendingDeleteId = null;
}

async function deleteConfig() {
  if (!pendingDeleteId) return;
  modalConfirm.disabled = true;
  try {
    const deletedCfg = configs.find(c => c.id === pendingDeleteId);
    await deleteDoc(doc(db, "workspaces", currentWorkspaceId, "sync_configs", pendingDeleteId));
    selectedConfigIds.delete(pendingDeleteId);
    closeModal();
    await loadConfigs(true);
    showToast('Config deleted', 'info', {
      actionLabel: 'Undo',
      onAction: async () => {
        if (deletedCfg) {
          const { id, ...data } = deletedCfg;
          await setDoc(doc(db, "workspaces", currentWorkspaceId, "sync_configs", id), data);
          await loadConfigs(true);
          showToast('Config restored', 'success');
        }
      }
    });
  } catch (err) {
    showToast('Delete failed: ' + err.message, 'error');
  } finally {
    modalConfirm.disabled = false;
  }
}

// ─── Event listeners ──────────────────────────────────────────
if (btnRefresh) btnRefresh.addEventListener('click', () => loadConfigs());
if (btnSave) btnSave.addEventListener('click', (e) => saveConfig(e, false));
if (btnSubmit) btnSubmit.addEventListener('click', (e) => saveConfig(e, true));
configForm.addEventListener('submit', (e) => saveConfig(e, false));
panelClose.addEventListener('click', closePanel);
panelOverlay.addEventListener('click', closePanel);
modalCancel.addEventListener('click', closeModal);
modalConfirm.addEventListener('click', deleteConfig);

// ─── Wizard Step Navigation ──────────────────────────────────
let wizardStep = 1;

function goToStep(n) {
  document.querySelectorAll('.step-panel').forEach(el => el.style.display = 'none');
  const step = document.querySelector(`.step-panel[data-step="${n}"]`);
  if (step) step.style.display = 'block';

  document.querySelectorAll('.wizard-step').forEach(el => {
    const sn = parseInt(el.dataset.wizStep);
    el.classList.remove('active', 'completed');
    if (sn === n) el.classList.add('active');
    else if (sn < n) el.classList.add('completed');
  });

  document.querySelectorAll('.wiz-step-line').forEach((el, idx) => {
    el.classList.toggle('completed', idx + 1 < n);
  });

  wizardStep = n;
  window.resetConfigDirty();
}

document.getElementById('btn-step1-next')?.addEventListener('click', () => {
  const p1 = document.getElementById('f-tt-connection')?.value;
  const p2 = document.getElementById('f-notion-connection')?.value;
  if (!p1) { showToast('Please select a saved account for Platform 1.', 'error'); return; }
  if (!p2) { showToast('Please select a saved account for Platform 2.', 'error'); return; }
  if (p1 === p2) { showToast('The source and destination accounts cannot be the same.', 'error'); return; }
  goToStep(2);
});

document.getElementById('btn-step2-back')?.addEventListener('click', () => goToStep(1));
document.getElementById('btn-step2-next')?.addEventListener('click', () => {
  const mappings = document.querySelectorAll('.mapping-row');
  if (mappings.length === 0) { showToast('Please add at least one field mapping.', 'error'); return; }
  goToStep(3);
});
document.getElementById('btn-step3-back')?.addEventListener('click', () => goToStep(2));

// Update node status indicators and load schema when connection changes
document.getElementById('f-tt-connection')?.addEventListener('change', () => {
  updateNodeStatuses();
  handleConnectionChange('p1');
});
document.getElementById('f-notion-connection')?.addEventListener('change', () => {
  updateNodeStatuses();
  handleConnectionChange('p2');
});

// Connect provider buttons in node modal
async function fireOpenAddConnection(provider) {
  if (window._connectingProvider) {
    return;
  }
  
  if (provider) {
    const plat = window.cachedPlatforms?.find(p => p.id === provider || p.key === provider);

    // If platform is OAuth, attempt direct flow
    if (plat?.authType === 'oauth' && plat?.authUrl) {
      window._connectingProvider = provider;
      const baseLabel = 'My ' + (plat.name || provider);
      const existingLabels = (_connectionsCache || []).map(c => c.label).filter(Boolean);
      let label = baseLabel;
      let idx = 1;
      while (existingLabels.includes(label)) {
        idx++;
        label = baseLabel + ' (' + idx + ')';
      }

      // Show loading indicator in the connection area
      const isP1 = provider === _dropdownP1Provider;
      const select = isP1 ? fTtConnection : fNotionConnection;
      const btn = isP1 ? document.getElementById('btn-connect-p1') : document.getElementById('btn-connect-p2');
      const hint = isP1 ? document.getElementById('p1-connect-hint') : document.getElementById('p2-connect-hint');
      const formRow = isP1 ? document.querySelector('#section-p1 .form-row') : document.querySelector('#section-p2 .form-row');
      if (select) select.disabled = true;
      if (btn) btn.style.display = 'none';
      if (hint) hint.style.display = 'none';
      if (formRow) {
        const ind = document.createElement('span');
        ind.className = 'loader' + (isP1 ? '1' : '2');
        ind.style.cssText = 'color:var(--text-3);font-size:0.85rem;display:flex;align-items:center;gap:8px;';
        ind.innerHTML = '<span class="spin">⟳</span> Connecting to ' + escHtml(plat.name || 'provider') + '…';
        formRow.appendChild(ind);
      }

      const opened = await initiateDirectOAuthFlow(plat, label);
      if (opened) return; // Popup opened — skip the dialog
      window._connectingProvider = null;
      // Clean up loading indicator — the fallback dialog will also call populateConnectionDropdowns on success
      document.querySelectorAll('#section-p1 .loader1, #section-p2 .loader2').forEach(el => el.remove());
      if (select) select.disabled = false;
      if (btn) btn.style.display = '';
      if (hint) hint.style.display = '';
    }
  }
  
  // Fallback to dialog
  window.dispatchEvent(new CustomEvent('open-add-connection', { detail: { provider } }));
}
document.getElementById('btn-connect-p1')?.addEventListener('click', () => {
  fireOpenAddConnection(document.getElementById('btn-connect-p1')?.dataset.provider || null);
});
document.getElementById('btn-connect-p2')?.addEventListener('click', () => {
  fireOpenAddConnection(document.getElementById('btn-connect-p2')?.dataset.provider || null);
});
document.getElementById('p1-connect-link')?.addEventListener('click', (e) => {
  e.preventDefault();
  fireOpenAddConnection(document.getElementById('p1-connect-link')?.dataset.provider || null);
});
document.getElementById('p2-connect-link')?.addEventListener('click', (e) => {
  e.preventDefault();
  fireOpenAddConnection(document.getElementById('p2-connect-link')?.dataset.provider || null);
});

// Refresh dropdowns when connections are saved/deleted elsewhere
window.addEventListener('connections-refreshed', async (e) => {
  _connectionsCache = await loadConnections();
  const cfgId = document.getElementById('form-id')?.value?.trim() || null;
  populateConnectionDropdowns(_connectionsCache, cfgId, _dropdownP1Provider, _dropdownP2Provider);

  const { newConnectionId, platformId } = e.detail || {};
  if (newConnectionId && platformId) {
    if (platformId === _dropdownP1Provider) {
      fTtConnection.value = newConnectionId;
      fTtConnection.dispatchEvent(new Event('change'));
    } else if (platformId === _dropdownP2Provider) {
      fNotionConnection.value = newConnectionId;
      fNotionConnection.dispatchEvent(new Event('change'));
    }
  }
});

// Spreadsheet Grid Toolbar listeners
if (tbAdd) tbAdd.addEventListener('click', () => openPanel());
const btnAddConfig = document.getElementById('btn-add-config');
if (btnAddConfig) btnAddConfig.addEventListener('click', () => openPanel());
if (menuAddConfig) menuAddConfig.addEventListener('click', (e) => { e.preventDefault(); openPanel(); });

if (tbEdit) {
  tbEdit.addEventListener('click', () => {
    if (selectedConfigIds.size === 1) openPanel([...selectedConfigIds][0]);
  });
}
if (menuEditConfig) {
  menuEditConfig.addEventListener('click', (e) => {
    e.preventDefault();
    if (selectedConfigIds.size === 1) openPanel([...selectedConfigIds][0]);
  });
}

if (tbDuplicate) {
  tbDuplicate.addEventListener('click', () => {
    if (selectedConfigIds.size === 1) duplicateConfig([...selectedConfigIds][0]);
  });
}
if (menuDuplicateConfig) {
  menuDuplicateConfig.addEventListener('click', (e) => {
    e.preventDefault();
    if (selectedConfigIds.size === 1) duplicateConfig([...selectedConfigIds][0]);
  });
}

if (tbDelete) {
  tbDelete.addEventListener('click', () => {
    if (selectedConfigIds.size === 1) {
      const id = [...selectedConfigIds][0];
      const cfg = configs.find(c => c.id === id);
      if (cfg) confirmDelete(cfg.id, cfg.description || cfg.id);
    }
  });
}
if (menuDeleteConfig) {
  menuDeleteConfig.addEventListener('click', (e) => {
    e.preventDefault();
    if (selectedConfigIds.size === 1) {
      const id = [...selectedConfigIds][0];
      const cfg = configs.find(c => c.id === id);
      if (cfg) confirmDelete(cfg.id, cfg.description || cfg.id);
    }
  });
}

if (tbDoc) tbDoc.addEventListener('click', showDocSchema);

if (tbWrap) {
  tbWrap.addEventListener('click', () => {
    isTextWrap = !isTextWrap;
    renderCards();
  });
}
if (menuViewWrap) {
  menuViewWrap.addEventListener('click', (e) => {
    e.preventDefault();
    isTextWrap = !isTextWrap;
    renderCards();
  });
}

if (menuFormatZebra) {
  menuFormatZebra.addEventListener('click', (e) => {
    e.preventDefault();
    isZebraStriped = !isZebraStriped;
    renderCards();
  });
}

if (menuViewCompact) {
  menuViewCompact.addEventListener('click', (e) => {
    e.preventDefault();
    isCompact = !isCompact;
    renderCards();
  });
}

if (tbFreeze) {
  tbFreeze.addEventListener('click', () => {
    isHeaderFrozen = !isHeaderFrozen;
    renderCards();
  });
}

if (tbDetach) {
  tbDetach.addEventListener('click', () => {
    clearSelection();
  });
}

if (tbFilter && tbSearch) {
  tbFilter.addEventListener('click', () => {
    tbSearch.focus();
    tbSearch.select();
  });
}

if (tbSearch) {
  let _searchTimer;
  tbSearch.addEventListener('input', () => {
    clearTimeout(_searchTimer);
    _searchTimer = setTimeout(renderCards, 150);
  });
}

// Search clear button
const tbSearchClear = document.getElementById('tb-search-clear');
if (tbSearchClear && tbSearch) {
  tbSearchClear.addEventListener('click', () => {
    tbSearch.value = '';
    tbSearch.focus();
    renderCards();
  });
  tbSearch.addEventListener('input', () => {
    tbSearchClear.style.display = tbSearch.value ? 'flex' : 'none';
  });
  tbSearchClear.style.display = 'none';
}

if (selectAllCheckbox) {
  selectAllCheckbox.addEventListener('change', () => {
    if (selectAllCheckbox.checked && configs.length > 0) {
      const sorted = sortConfigs();
      sorted.forEach(cfg => selectedConfigIds.add(cfg.id));
    } else {
      selectedConfigIds.clear();
    }
    renderCards();
  });
}

// Multi-select bar buttons
const msbDuplicate = document.getElementById('msb-duplicate');
const msbDelete = document.getElementById('msb-delete');
const msbClose = document.getElementById('msb-close');

if (msbDuplicate) {
  msbDuplicate.addEventListener('click', () => {
    const ids = [...selectedConfigIds];
    if (ids.length === 0) return;
    ids.forEach((id, i) => {
      setTimeout(() => duplicateConfig(id), i * 100);
    });
    clearSelection();
  });
}

if (msbDelete) {
  msbDelete.addEventListener('click', async () => {
    const ids = [...selectedConfigIds];
    if (ids.length === 0) return;
    if (ids.length === 1) {
      const cfg = configs.find(c => c.id === ids[0]);
      if (cfg) confirmDelete(cfg.id, cfg.description || cfg.id);
      return;
    }
    const confirmed = await confirmDialog({
      title: 'Delete configs',
      message: `Are you sure you want to delete ${ids.length} configurations? This action can be undone.`
    });
    if (!confirmed) return;
    for (const id of ids) {
      try {
        const deletedCfg = configs.find(c => c.id === id);
        await deleteDoc(doc(db, "workspaces", currentWorkspaceId, "sync_configs", id));
        if (deletedCfg) {
          showToast(`"${deletedCfg.description || id}" deleted`, 'info', {
            actionLabel: 'Undo',
            onAction: async () => {
              const { id: did, ...data } = deletedCfg;
              await setDoc(doc(db, "workspaces", currentWorkspaceId, "sync_configs", did), data);
              await loadConfigs(true);
              showToast('Config restored', 'success');
            }
          });
        }
      } catch (err) {
        showToast('Delete failed: ' + err.message, 'error');
      }
    }
    clearSelection();
  });
}

if (msbClose) {
  msbClose.addEventListener('click', clearSelection);
}

// Column sortable headers click handlers
document.querySelectorAll('th.sortable').forEach(th => {
  th.addEventListener('click', () => {
    const col = th.dataset.col;
    if (currentSortColumn === col) {
      currentSortDirection = currentSortDirection === 'asc' ? 'desc' : 'asc';
    } else {
      currentSortColumn = col;
      currentSortDirection = 'asc';
    }
    renderCards();
  });
});

fSyncType.addEventListener('change', triggerFormFieldVisibility);

btnAddMapping.addEventListener('click', () => addMappingRow('', ''));

// TickTick Data Loading
if (btnLoadTt) {
  btnLoadTt.addEventListener('click', async () => {
    const connId = fTtConnection?.value;
    if (!connId) {
      showToast('Please select a TickTick connection first', 'error');
      return;
    }
    
    const loadKey = 'loadTickTick';
    startLoad(loadKey);
    btnLoadTt.textContent = '⏳ Loading...';
    try {
      currentProjects = projects;
      
      filterAndPopulateTtLists();
      
      // Auto-trigger tag fetching for the current list
      fTtList.dispatchEvent(new Event('change'));
      
      showToast(`Loaded ${projects.length} projects successfully!`, 'success');
    } catch (err) {
      console.error('TickTick API Error:', err);
      showToast(!navigator.onLine ? 'No internet available' : `Error loading TickTick projects: ${err.message}. Check token or adblockers.`, 'error');
    } finally {
      btnLoadTt.innerHTML = `${feather.icons['refresh-cw'].toSvg({width: 12, height: 12})} Load Data`;
      endLoad(loadKey);
    }
  });
}

if (btnLoadNotion) {
  btnLoadNotion.addEventListener('click', async () => {
    const token = fNToken.value.trim();
    if (!token) {
      showToast('Please enter your Notion Integration Token first.', 'warning');
      return;
    }
    
    const loadKey = 'loadNotion';
    startLoad(loadKey);
    btnLoadNotion.textContent = '⏳ Loading...';
    try {
      const res = await fetch(`${API_URL}/notion-databases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token })
      });
      const data = await res.json();
      if (!data.success) {
        throw new Error(data.error || 'Failed to load databases');
      }
      
      const currentVal = fNDbId.value;
      
      if (notionDbSelect) {
        notionDbSelect.clearOptions();
        data.databases.forEach(db => {
          notionDbSelect.addOption({value: db.id, text: db.title});
        });
        notionDbSelect.refreshOptions(false);
        if (currentVal) notionDbSelect.setValue(currentVal);
      } else {
        fNDbId.innerHTML = '<option value="">Select a database...</option>';
        data.databases.forEach(db => {
          const opt = document.createElement('option');
          opt.value = db.id;
          opt.textContent = db.title;
          fNDbId.appendChild(opt);
        });
        if (Array.from(fNDbId.options).some(o => o.value === currentVal)) {
          fNDbId.value = currentVal;
        }
      }
      
      showToast(`Loaded ${data.databases.length} databases successfully!`, 'success');
    } catch (err) {
      console.error('Notion API Error:', err);
      showToast(!navigator.onLine ? 'No internet available' : `Error loading Notion databases: ${err.message}.`, 'error');
    } finally {
      btnLoadNotion.innerHTML = `${feather.icons['refresh-cw'].toSvg({width: 12, height: 12})} Load DBs`;
      endLoad(loadKey);
    }
  });
}

if (fTtList) {
  fTtList.addEventListener('change', async () => {
    const token = fTtToken.value.trim();
    const listName = fTtList.value;
    if (!token || listName === 'Inbox') {
      const currentTag = fTtTag.value;
      fTtTag.innerHTML = '';
      if (currentTag) {
        fTtTag.innerHTML = `<option value="${currentTag}">${currentTag}</option>`;
      }
      return;
    }
    
    const project = currentProjects.find(p => p.name === listName);
    if (!project) return;
    
    try {
      const res = await fetch(`https://api.ticktick.com/open/v1/project/${project.id}/data`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text}`);
      }
      
      const data = await res.json();
      const tasks = data.tasks || [];
      
      const uniqueTags = new Set();
      tasks.forEach(t => {
        if (t.tags) {
          t.tags.forEach(tag => uniqueTags.add(tag));
        }
      });
      
      const currentTag = fTtTag.value;
      fTtTag.innerHTML = '';
      
      if (currentTag && !uniqueTags.has(currentTag)) {
        const opt = document.createElement('option');
        opt.value = currentTag;
        opt.textContent = currentTag;
        fTtTag.appendChild(opt);
      }
      
      const defaultOpt = document.createElement('option');
      defaultOpt.value = "";
      defaultOpt.textContent = "-- No Tag --";
      fTtTag.appendChild(defaultOpt);
      
      uniqueTags.forEach(tag => {
        const opt = document.createElement('option');
        opt.value = tag;
        opt.textContent = tag;
        fTtTag.appendChild(opt);
      });
      
      if (currentTag) {
        fTtTag.value = currentTag;
      } else if (fTtTag.options.length > 0) {
        fTtTag.value = fTtTag.options[0].value;
      }
    } catch (err) {
      console.error('Failed to load tags for project', err);
      showToast('Failed to load tags for the selected project.', 'warning');
    }
  });
}

// Close dropdown menus on outside click
document.addEventListener('click', (e) => {
  if (!e.target.closest('.row-actions-dropdown')) {
    document.querySelectorAll('.row-actions-menu.open').forEach(m => {
      m.classList.remove('open');
      m.style.position = '';
      m.style.left = '';
      m.style.top = '';
      m.style.bottom = '';
    });
  }
});

// Close panel/modal on Escape
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closePanel(); closeModal(); closeNodeModal(); }
});

// ─── Node Config Modal Logic ────────────────────────────────────
const nodeModalOverlay = document.getElementById('node-config-modal');
const nodeModalClose = document.getElementById('node-modal-close');
const nodeModalSave = document.getElementById('node-modal-save');
const nodeModalBody = document.getElementById('node-modal-body');
const nodeModalTitle = document.getElementById('node-modal-title');

let currentNodeId = null;

function openNodeModal(nodeId) {
  currentNodeId = nodeId;
  const p1Name = window._p1DisplayName || 'Platform 1';
  const p2Name = window._p2DisplayName || 'Platform 2';
  if (nodeId === 'p1') {
    if (nodeModalTitle) nodeModalTitle.innerHTML = 'Setup Trigger <span style="color:var(--text-3); font-weight:normal;">(' + escHtml(p1Name) + ')</span>';
    const sectionP1 = document.getElementById('section-p1');
    if (sectionP1 && nodeModalBody) {
      sectionP1.style.display = 'block';
      nodeModalBody.appendChild(sectionP1);
    }
  } else if (nodeId === 'p2') {
    if (nodeModalTitle) nodeModalTitle.innerHTML = 'Setup Action <span style="color:var(--text-3); font-weight:normal;">(' + escHtml(p2Name) + ')</span>';
    const sectionP2 = document.getElementById('section-p2');
    if (sectionP2 && nodeModalBody) {
      sectionP2.style.display = 'block';
      nodeModalBody.appendChild(sectionP2);
    }
  }
  
  if (nodeModalOverlay) nodeModalOverlay.classList.add('open');
}

function closeNodeModal() {
  if (nodeModalOverlay) nodeModalOverlay.classList.remove('open');
  
  // Move contents back to hidden area
  const hiddenSections = document.getElementById('hidden-platform-sections');
  const sectionP1 = document.getElementById('section-p1');
  const sectionP2 = document.getElementById('section-p2');
  if (hiddenSections && sectionP1) {
    // sectionP1.style.display = 'none'; // We keep it visible so harvesting works, the parent is hidden
    hiddenSections.appendChild(sectionP1);
  }
  if (hiddenSections && sectionP2) {
    hiddenSections.appendChild(sectionP2);
  }
  
  updateNodeStatuses();
}

function isSectionValid(sectionId) {
  const section = document.getElementById(sectionId);
  if (!section) return false;
  
  const requiredFields = section.querySelectorAll('[required]');
  for (const field of requiredFields) {
    const row = field.closest('.form-row');
    if (row && row.style.display === 'none') continue; // Skip hidden fields
    if (field.type === 'checkbox') {
      if (!field.checked) return false;
    } else {
      if (!field.value || field.value.trim() === '') return false;
    }
  }
  return true;
}

function updateNodeStatuses() {
  const nodeP1Status = document.getElementById('node-p1-status');
  if (nodeP1Status) {
    if (isSectionValid('section-p1')) {
      nodeP1Status.innerHTML = '<i data-feather="check-circle" style="width: 16px; height: 16px;"></i>';
      nodeP1Status.className = 'node-status-icon success';
    } else {
      nodeP1Status.innerHTML = '<i data-feather="alert-triangle" style="width: 16px; height: 16px;"></i>';
      nodeP1Status.className = 'node-status-icon warning';
    }
  }

  const nodeP2Status = document.getElementById('node-p2-status');
  if (nodeP2Status) {
    if (isSectionValid('section-p2')) {
      nodeP2Status.innerHTML = '<i data-feather="check-circle" style="width: 16px; height: 16px;"></i>';
      nodeP2Status.className = 'node-status-icon success';
    } else {
      nodeP2Status.innerHTML = '<i data-feather="alert-triangle" style="width: 16px; height: 16px;"></i>';
      nodeP2Status.className = 'node-status-icon warning';
    }
  }
  
  if (window.feather) window.feather.replace();
}

function saveNodeModal() {
  const nodeModalBody = document.getElementById('node-modal-body');
  if (!nodeModalBody) return closeNodeModal();
  
  const activeSection = nodeModalBody.querySelector('.form-section');
  if (!activeSection) return closeNodeModal();
  
  let isValid = true;
  const requiredFields = activeSection.querySelectorAll('[required]');
  
  for (const field of requiredFields) {
    const row = field.closest('.form-row');
    if (row && row.style.display === 'none') continue;
    
    if (field.type === 'checkbox') {
      if (!field.checked) {
        isValid = false;
        field.style.outline = '2px solid var(--danger)';
      } else {
        field.style.outline = '';
      }
    } else {
      if (!field.value || field.value.trim() === '') {
        isValid = false;
        field.style.borderColor = 'var(--danger)';
      } else {
        field.style.borderColor = '';
      }
    }
  }
  
  if (!isValid) {
    showToast('Please fill in all mandatory fields.', 'warning');
    return;
  }
  
  closeNodeModal();
}

// Bind Node Modal clicks
document.getElementById('node-platform1')?.addEventListener('click', () => openNodeModal('p1'));
document.getElementById('node-platform2')?.addEventListener('click', () => openNodeModal('p2'));
nodeModalClose?.addEventListener('click', closeNodeModal);
nodeModalSave?.addEventListener('click', saveNodeModal);


// ─── Utility ──────────────────────────────────────────────────
function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
window.escHtml = escHtml;

function escAttr(str) {
  return String(str ?? '').replace(/'/g,"\\'");
}
window.escAttr = escAttr;
function fmtDate(iso) {
  try {
    if (iso && typeof iso === 'object' && iso.toDate) return iso.toDate().toLocaleDateString(undefined, { dateStyle:'medium' });
    if (iso && typeof iso === 'object' && iso.toMillis) return new Date(iso.toMillis()).toLocaleDateString(undefined, { dateStyle:'medium' });
    return new Date(iso).toLocaleDateString(undefined, { dateStyle:'medium' });
  } catch { return iso; }
}

// ─── God Mode Workspace Switcher ──────────────────────────────
async function setupWorkspaceSwitcher(user) {
  const selectEl = document.getElementById('workspace-selector');
  if (!selectEl) return;

  // Clear existing TomSelect if it exists
  if (workspaceSelectTom) {
    workspaceSelectTom.destroy();
    workspaceSelectTom = null;
  }
  selectEl.innerHTML = '';

  try {

    if (currentUserRole === 'superadmin') {
      // Superadmin: Fetch all tenants
      const tenantsSnap = await getDocs(collection(db, 'workspaces'));
      tenantsSnap.forEach(doc => {
        const t = doc.data();
        const opt = document.createElement('option');
        opt.value = t.id;
        opt.textContent = t.name || 'Organization';
        selectEl.appendChild(opt);
      });
    } else {
      // Normal User: Fetch tenants they belong to
      const tenantsQuery = query(collection(db, 'workspaces'), where('members', 'array-contains', user.uid));
      const tenantsSnap = await getDocs(tenantsQuery);
      
      tenantsSnap.forEach(doc => {
        const t = doc.data();
        const opt = document.createElement('option');
        opt.value = t.id;
        opt.textContent = t.name || 'Organization';
        selectEl.appendChild(opt);
      });
    }
  } catch (err) {
    console.error("Error setting up workspace switcher:", err);
    showToast('Failed to load workspaces', 'error');
    const opt = document.createElement('option');
    opt.value = user.uid;
    opt.textContent = `Personal Workspace`;
    selectEl.appendChild(opt);
  }

  // Initialize TomSelect
  workspaceSelectTom = new TomSelect("#workspace-selector", {
    create: false,
    sortField: { field: "text", direction: "asc" },
    maxOptions: null,
    onInitialize: function() {
      if (this.control_input) {
        this.control_input.readOnly = true;
      }
    }
  });

  // Set default value
  workspaceSelectTom.setValue(currentWorkspaceId, true);
  
  const selectedName = workspaceSelectTom.options[currentWorkspaceId]?.text || 'Workspace';

  workspaceSelectTom.on('change', async (value) => {
    if (value && value !== currentWorkspaceId) {
      currentWorkspaceId = value;
      window.currentWorkspaceId = currentWorkspaceId;
      
      showToast(`Switched workspace`, 'info');
      await loadConfigs();
      
      // Refresh connections if they are active
      if (typeof loadConnections === 'function') {
        renderConnectionsSkeleton();
        await loadConnections();
        renderConnectionsView();
      }
    }
  });
}

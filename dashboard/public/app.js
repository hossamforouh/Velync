/* =============================================================
   Sync Config Dashboard — app.js
   Firebase Web SDK Integration
   ============================================================= */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js";
import { getAuth, signInWithPopup, GoogleAuthProvider, onAuthStateChanged, signOut, createUserWithEmailAndPassword, signInWithEmailAndPassword, signInWithCustomToken, sendPasswordResetEmail, updatePassword, reauthenticateWithCredential, EmailAuthProvider, sendEmailVerification, setPersistence, browserLocalPersistence, browserSessionPersistence } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-auth.js";
import { getFirestore, collection, getDocs, getDoc, doc, setDoc, addDoc, updateDoc, deleteDoc, serverTimestamp, query, where } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-firestore.js";
import { initializeAppCheck, ReCaptchaV3Provider } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-app-check.js";
import { initLogs } from "./js/logs.js";
import { getAnalytics, logEvent } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-analytics.js";
import { bindNavEvents, navigateTo } from './js/navigation.js';
import { renderHubView } from './js/hub.js';
import { connections, loadConnections, renderConnectionsView, renderConnectionsSkeleton, initiateDirectOAuthFlow } from './js/connections.js';
import { initBilling } from './js/billing.js';
import { loadAndApplyPlanBadge } from './js/plan-badge.js';
import { initOnboarding } from './js/onboarding.js';
import './js/integration-setup.js';
import { showToast } from './js/toast.js';
import { confirmDialog, alertDialog, threeWayConfirmDialog } from './js/confirm.js';
import { startLoad, endLoad, isLoading } from './js/loading.js';
import { getSkeletonFormHTML, setButtonLoading } from './js/loading-components.js';

/** Show a plan-limit toast with an Upgrade button that opens billing settings */
function showPlanError(msg) {
  const isPlanError = /upgrade|plan.*limit|max.*config/i.test(msg);
  showToast(msg, 'error', isPlanError ? {
    actionLabel: 'Upgrade',
    onAction() {
      const modal = document.getElementById('settings-modal');
      const billingTab = modal?.querySelector('.settings-tab[data-tab="billing"]');
      if (modal && billingTab) {
        modal.classList.add('show');
        billingTab.click();
      }
    },
  } : undefined);
}

// ─── View Cache (Tab Switching) ────────────────────────────────
const viewCache = new Map();
const VIEW_CACHE_TTL = 60000;

window.addEventListener('view-left', (e) => {
  const viewName = e.detail?.view;
  if (viewName) viewCache.delete(viewName);
});

window.__getViewCache = (name) => {
  const entry = viewCache.get(name);
  if (entry && Date.now() - entry.time < VIEW_CACHE_TTL) return entry.data;
  viewCache.delete(name);
  return null;
};

window.__setViewCache = (name, data) => {
  viewCache.set(name, { data, time: Date.now() });
};
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
    case 'lists':
      return clientTickTickProjects(conn, parentValue);
    case 'fetchTickTickTags':
    case 'tags':
      return clientTickTickAllTags(conn);
    case 'fetchNotionDBs':
    case 'databases':
    case 'fetchNotionTemplates':
    case 'templates':
    case 'contactGroups':
    case 'google_contacts_fetch_groups':
      // These are handled server-side; no client fallback available
      return [];
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

async function clientTickTickProjects(conn, parentValue) {
  try {
    const token = await clientTickTickToken(conn);
    if (!token) return [];
    const res = await fetch('https://api.ticktick.com/open/v1/project', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) return [];
    const projects = await res.json();
    let filteredProjects = projects || [];
    
    if (parentValue) {
       const pValStr = String(parentValue).toLowerCase();
       
       if (pValStr.includes('note')) {
           // Target Entity is Notes: show lists of kind NOTE, or lists that contain 'note' in their name
           filteredProjects = filteredProjects.filter(p => 
               p.kind === 'NOTE' || p.name.toLowerCase().includes('note')
           );
       } else if (pValStr.includes('task')) {
           // Target Entity is Tasks: hide lists of kind NOTE, and hide lists containing 'note' in name
           filteredProjects = filteredProjects.filter(p => {
               if (p.kind === 'NOTE') return false;
               if (p.name.toLowerCase().includes('note')) return false;
               return true;
           });
       }
    }
    
    return filteredProjects.map(p => ({ value: p.id || p.name, label: p.name }));
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


// GET /api/platforms — same server-mediated endpoint every other page's
// platform list goes through. window.cachedPlatforms is the shared cache
// (also cleared at line ~4849 after platform CRUD in the admin panel).
async function ensureCachedPlatforms() {
  if (window.cachedPlatforms) return window.cachedPlatforms;
  const token = await auth.currentUser.getIdToken();
  const res = await fetch('/api/platforms', { headers: { 'Authorization': `Bearer ${token}` } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  window.cachedPlatforms = data.platforms;
  return window.cachedPlatforms;
}

// GET /api/sync-configs/:configId — single-config fetch, replacing a direct
// Firestore getDoc(). Returns null (not throw) for a 404 so callers can
// treat "doesn't exist" the same way `snap.exists()` used to.
async function fetchSyncConfig(configId) {
  const token = await auth.currentUser.getIdToken();
  const res = await fetch(`/api/sync-configs/${encodeURIComponent(configId)}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (res.status === 404) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data.item;
}

// GET /api/sync-configs?integrationId=... — replacing a direct Firestore
// query(collection(...), where('integrationId','==',integrationId)).
async function fetchSyncConfigsByIntegrationId(integrationId) {
  const token = await auth.currentUser.getIdToken();
  const res = await fetch(`/api/sync-configs?integrationId=${encodeURIComponent(integrationId)}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data.items;
}

window.renderSchemaForPlatform = async function(platformId, containerId, prefix, existingData = {}) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';

  if (!window.cachedPlatforms) {
    try {
      await ensureCachedPlatforms();
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
    if (field.dependsOn) {
      row.dataset.dependsOn = field.dependsOn;
      const parentVal = existingData[field.dependsOn] !== undefined ? String(existingData[field.dependsOn]) : '';
      let isVisible = true;
      if (field.visibilityRule) {
        const allowedVals = field.visibilityRule.split(',').map(s => s.trim());
        isVisible = allowedVals.includes(parentVal);
      } else {
        isVisible = parentVal.trim().length > 0;
      }
      if (!isVisible) row.style.display = 'none';
    }
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
                           <a href="#" class="btn-refresh-ds" style="font-size: 0.8rem; color: var(--primary); text-decoration: underline;" onclick="event.preventDefault();">Refresh</a>
                         </span>
                       </label>
                       <div class="ds-input-container" style="position: relative; width: 100%;">
                         <select id="f-${prefix}-${escAttr(field.id)}" class="ds-select" data-schema-id="${escAttr(field.id)}" style="width: 100%; transition: opacity 0.2s;" ${isReq ? 'required' : ''}>
                           <option value="${val ? escAttr(val) : ''}">${val ? escHtml(val) + ' (Saved)' : '-- Select --'}</option>
                         </select>
                       </div>`;
                       
      // Attach fetch logic
      setTimeout(async () => {
         const selectEl = row.querySelector('.ds-select');
         const btnRef = row.querySelector('.btn-refresh-ds');
         if(window.feather) window.feather.replace();
         
         // Auto-load if a connection is already selected (always load, even with a saved value)
         const connId = document.getElementById(prefix === 'p1' ? 'f-source-connection' : 'f-dest-connection')?.value;
         let shouldAutoLoad = !!connId;
         if (shouldAutoLoad && field.dependsOn) {
            const parentEl = container.querySelector(`[data-schema-id="${field.dependsOn}"]`);
            const pVal = parentEl ? (parentEl.type === 'checkbox' ? parentEl.checked : parentEl.value) : (existingData[field.dependsOn] !== undefined ? String(existingData[field.dependsOn]) : '');
            if (field.visibilityRule) {
              shouldAutoLoad = field.visibilityRule.split(',').map(s => s.trim()).includes(String(pVal));
            } else {
              shouldAutoLoad = String(pVal).trim().length > 0;
            }
         }
         
          const loadData = async () => {
            if (!selectEl || selectEl.classList.contains('is-loading')) return;
            if (field.dataSource) {
              const connId = document.getElementById(prefix === 'p1' ? 'f-source-connection' : 'f-dest-connection')?.value;
              if (!connId) {
                selectEl.innerHTML = '<option value="">— Select a connection first —</option>';
                return;
              }
              
              btnRef.style.display = 'none';
              selectEl.innerHTML = `<option value="">Fetching ${escHtml(cleanLabel)}...</option>`;
              selectEl.disabled = true;
              selectEl.classList.add('is-loading');
              
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
                  if (val) selectEl.innerHTML += `<option value="${escAttr(val)}" selected>${escHtml(val)} (Saved)</option>`;
                } else {
                  selectEl.innerHTML = '<option value="">-- Select --</option>' + items.map(i => `<option value="${escAttr(i.value)}" ${val === i.value ? 'selected' : ''}>${escHtml(i.label)}</option>`).join('');
                  if (val) selectEl.value = val;
                }
                selectEl.dispatchEvent(new Event('change'));
                
                // Reset button on success
                btnRef.textContent = 'Refresh';
                btnRef.style.color = 'var(--primary)';
              } catch (e) {
                console.error("DataSource Error:", e);
                selectEl.innerHTML = `<option value="">Error loading</option>`;
                if (val) selectEl.innerHTML += `<option value="${escAttr(val)}" selected>${escHtml(val)} (Saved)</option>`;
                
                // Error state on button
                btnRef.textContent = 'Fetch Failed — Retry';
                btnRef.style.color = '#ef4444';
              } finally {
                selectEl.classList.remove('is-loading');
                selectEl.disabled = false;
                btnRef.style.display = 'inline-block';
              }
            }
          };
         btnRef.addEventListener('click', loadData);
         if (shouldAutoLoad) loadData();
      }, 0);
    } else if (field.type === 'dynamic_multi_select') {
      const saved = parseSavedMultiValue(val);
      row.innerHTML = `<label for="f-${prefix}-${escAttr(field.id)}" style="display: flex; align-items: center; gap: 4px; width: 100%;">
                        <span>${escHtml(cleanLabel)}${isReq ? '<span class="required-mark">*</span>' : ''}</span>
                        <span style="margin-left: auto; display: flex; align-items: center;">
                          <a href="#" class="btn-refresh-ds" style="font-size: 0.8rem; color: var(--primary); text-decoration: underline;" onclick="event.preventDefault();">Refresh</a>
                        </span>
                      </label>
                      <div class="ds-input-container" style="position: relative; width: 100%;">
                        <div class="ds-multi-select ms-empty">
                          <div class="ms-placeholder">— Select a connection first —</div>
                        </div>
                        <input type="hidden" data-schema-id="${escAttr(field.id)}" value='${escAttr(JSON.stringify(saved))}' />
                      </div>`;
                        
      // Attach fetch logic
      setTimeout(async () => {
         const msEl = row.querySelector('.ds-multi-select');
         const btnRef = row.querySelector('.btn-refresh-ds');
         if(window.feather) window.feather.replace();
         
         const connId = document.getElementById(prefix === 'p1' ? 'f-source-connection' : 'f-dest-connection')?.value;
         let shouldAutoLoad = !!connId;
         if (shouldAutoLoad && field.dependsOn) {
            const parentEl = container.querySelector(`[data-schema-id="${field.dependsOn}"]`);
            const pVal = parentEl ? (parentEl.type === 'checkbox' ? parentEl.checked : parentEl.value) : (existingData[field.dependsOn] !== undefined ? String(existingData[field.dependsOn]) : '');
            if (field.visibilityRule) {
              shouldAutoLoad = field.visibilityRule.split(',').map(s => s.trim()).includes(String(pVal));
            } else {
              shouldAutoLoad = String(pVal).trim().length > 0;
            }
         }
         
          const loadData = async () => {
            if (!msEl || msEl.classList.contains('is-loading')) return;
            if (field.dataSource) {
              const connIdLocal = document.getElementById(prefix === 'p1' ? 'f-source-connection' : 'f-dest-connection')?.value;
              if (!connIdLocal) { msEl.className = 'ds-multi-select ms-empty'; msEl.innerHTML = '<div class="ms-placeholder">— Select a connection first —</div>'; return; }
              
              btnRef.style.display = 'none';
              msEl.className = 'ds-multi-select is-loading';
              msEl.textContent = `Fetching ${cleanLabel}...`;
              
              try {
                let parentVal = '';
                if (field.dependsOn) {
                  const parentEl = container.querySelector(`[data-schema-id="${field.dependsOn}"]`);
                  if (parentEl) parentVal = parentEl.type === 'checkbox' ? parentEl.checked : parentEl.value;
                }
                const items = await fetchPlatformEntities(field.dataSource, connIdLocal, parentVal);
                if (items.length === 0) {
                  msEl.className = 'ds-multi-select ms-empty';
                  msEl.innerHTML = '<div class="ms-placeholder">— No tags available —</div>';
                } else {
                  const savedVals = parseSavedMultiValue(val);
                  msEl.className = 'ds-multi-select has-options';
                  msEl.innerHTML = items.map(i => {
                    const checked = savedVals.includes(i.value) ? 'checked' : '';
                    return `<label class="ms-option">
                      <input type="checkbox" class="ms-cb" value="${escAttr(i.value)}" ${checked} />
                      <span>${escHtml(i.label)}</span>
                    </label>`;
                  }).join('');
                  msEl.querySelectorAll('.ms-cb').forEach(cb => cb.addEventListener('change', () => updateMsHidden(msEl)));
                  updateMsHidden(msEl);
                }
                
                btnRef.textContent = 'Refresh';
                btnRef.style.color = 'var(--primary)';
              } catch (e) {
                console.error("DataSource Error:", e);
                msEl.className = 'ds-multi-select ms-empty';
                msEl.innerHTML = '<div class="ms-error">Error loading</div>';
                btnRef.textContent = 'Fetch Failed — Retry';
                btnRef.style.color = '#ef4444';
              } finally {
                btnRef.style.display = 'inline-block';
              }
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
               
               let isVisible = true;
               if (childField.visibilityRule) {
                 const allowedVals = childField.visibilityRule.split(',').map(s => s.trim());
                 isVisible = allowedVals.includes(String(newVal));
               } else {
                 isVisible = String(newVal).trim().length > 0;
               }
               childRow.style.display = isVisible ? 'block' : 'none';
               
                 if ((childField.type === 'dynamic_select' || childField.type === 'dynamic_multi_select') && isVisible) {
                  const connId = document.getElementById(prefix === 'p1' ? 'f-source-connection' : 'f-dest-connection')?.value;
                  if (connId) {
                    const btnRef = childRow.querySelector('.btn-refresh-ds');
                    if (btnRef) btnRef.click();
                  }
                }
            }
          });
          if (field.type === 'dynamic_select' && !field.dependsOn) {
            setTimeout(() => loadDefaultMappingsPreset(), 0);
          }
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
          if (childRow) {
             let isVisible = true;
             if (field.visibilityRule) {
                const allowedVals = field.visibilityRule.split(',').map(s => s.trim());
                isVisible = allowedVals.includes(String(parentVal));
             } else {
                isVisible = String(parentVal).trim().length > 0;
             }
             childRow.style.display = isVisible ? 'block' : 'none';
          }
       }
    });
  }, 100);
};

window.parseSavedMultiValue = function(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  try { return JSON.parse(val); } catch { return val.split(',').map(s => s.trim()).filter(Boolean); }
};

window.updateMsHidden = function(container) {
  const hidden = container.closest('.ds-input-container')?.querySelector('input[type="hidden"][data-schema-id]');
  if (!hidden) return;
  const checked = Array.from(container.querySelectorAll('input[type="checkbox"]:checked')).map(cb => cb.value);
  hidden.value = JSON.stringify(checked);
  if (typeof window.triggerAutoSave === 'function') window.triggerAutoSave();
};

window.harvestDynamicFields = function(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return {};
  const data = {};
  container.querySelectorAll('[data-schema-id]').forEach(el => {
    const id = el.getAttribute('data-schema-id');
    if (el.type === 'hidden') {
      try { data[id] = JSON.parse(el.value); } catch { data[id] = el.value; }
    } else if (el.type === 'checkbox') {
      data[id] = el.checked;
    } else {
      data[id] = el.value;
    }
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

// Shows pending workspace invites for explicit accept/decline instead of
// silently auto-joining — a user should consciously choose to join a
// workspace someone else invited them to, not be added invisibly on login.
async function processPendingInvites(user) {
  try {
    const token = await user.getIdToken();
    const res = await fetch('/api/workspace/invites', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) return;
    const data = await res.json();
    if (!data.invites?.length) return;
    showPendingInvitesModal(data.invites, token);
  } catch (e) {
    console.warn('Could not process invites:', e);
  }
}

function showPendingInvitesModal(invites, token) {
  const existing = document.getElementById('pending-invites-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'pending-invites-overlay';
  overlay.className = 'conn-dialog-overlay';
  overlay.style.zIndex = '10000';
  overlay.innerHTML = `
    <div class="conn-dialog" style="max-width:440px;">
      <h3>Workspace Invitation${invites.length !== 1 ? 's' : ''}</h3>
      <p style="color:var(--text-3);font-size:0.9rem;margin:0 0 16px;">You've been invited to collaborate on the following workspace${invites.length !== 1 ? 's' : ''}:</p>
      <div id="pending-invites-list" style="display:flex;flex-direction:column;gap:12px;">
        ${invites.map(ws => `
          <div class="collaborator-item" data-invite-id="${escAttr(ws.id)}" style="justify-content:space-between;align-items:center;">
            <div class="collab-info"><div class="collab-name">${escHtml(ws.name || 'Untitled Workspace')}</div></div>
            <div style="display:flex;gap:8px;">
              <button class="btn btn-secondary btn-sm decline-invite-action" data-id="${escAttr(ws.id)}">Decline</button>
              <button class="btn btn-primary btn-sm accept-invite-action" data-id="${escAttr(ws.id)}">Accept</button>
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  function removeRow(id) {
    const row = overlay.querySelector(`[data-invite-id="${CSS.escape(id)}"]`);
    if (row) row.remove();
    if (!overlay.querySelector('[data-invite-id]')) overlay.remove();
  }

  overlay.querySelectorAll('.accept-invite-action').forEach(btn => {
    btn.addEventListener('click', async () => {
      setButtonLoading(btn, true, 'Accept', 'Joining...');
      try {
        const r = await fetch('/api/workspace/join', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({ workspaceId: btn.dataset.id })
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Failed to join');
        showToast('Joined workspace', 'success');
        removeRow(btn.dataset.id);
        // The workspace switcher dropdown is only ever populated once, right
        // after sign-in (setupWorkspaceSwitcher() in onAuthStateChanged) — a
        // workspace joined via this modal never appeared as an option until
        // the next full page reload. Refresh it now so the newly-joined
        // workspace is immediately selectable.
        if (typeof setupWorkspaceSwitcher === 'function' && auth.currentUser) {
          setupWorkspaceSwitcher(auth.currentUser).catch(err => console.error('Failed to refresh workspace switcher after join:', err));
        }
      } catch (err) {
        showToast('Failed to join: ' + err.message, 'error');
        setButtonLoading(btn, false, 'Accept');
      }
    });
  });

  overlay.querySelectorAll('.decline-invite-action').forEach(btn => {
    btn.addEventListener('click', async () => {
      setButtonLoading(btn, true, 'Decline', 'Declining...');
      try {
        const r = await fetch('/api/workspace/decline-invite', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({ workspaceId: btn.dataset.id })
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Failed to decline');
        removeRow(btn.dataset.id);
      } catch (err) {
        showToast('Failed to decline: ' + err.message, 'error');
        setButtonLoading(btn, false, 'Decline');
      }
    });
  });
}
// -----------------------------------


// Sourced from window.VELYNC_CONFIG.firebase, set in index.html by hostname
// (production vs staging) — see the environment-detection block there.
const firebaseConfig = (window.VELYNC_CONFIG && window.VELYNC_CONFIG.firebase) || {
  apiKey: "AIzaSyBSMJMrR2lCYJP5D6e7wZDp-PmR8MZ5pIE",
  authDomain: "velync.web.app",
  projectId: "velync",
  storageBucket: "velync.firebasestorage.app",
  messagingSenderId: "632548720073",
  appId: "1:632548720073:web:521085551e7c24da27bc18"
};

const app = initializeApp(firebaseConfig);
let appCheck;
// Site key is environment-driven (see index.html's VELYNC_CONFIG). It's null
// on any environment without its own reCAPTCHA v3 key registered for that
// exact domain (e.g. staging) — initializing App Check with a wrong-domain
// key otherwise floods appCheck/recaptcha-error and stalls Firestore client
// reads. When null, skip App Check entirely (enforcement is off there).
const recaptchaSiteKey = (window.VELYNC_CONFIG && window.VELYNC_CONFIG.recaptchaSiteKey) || null;
if (recaptchaSiteKey) {
  try {
    if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
      self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
    }
    appCheck = initializeAppCheck(app, {
      provider: new ReCaptchaV3Provider(recaptchaSiteKey),
      isTokenAutoRefreshEnabled: true
    });
  } catch (e) {
    console.warn("App Check initialization failed.", e);
  }
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

// ─── Global error reporting ────────────────────────────────────
// Reports uncaught errors/rejections to the backend so admins can see them
// (Admin Panel → Client Errors) instead of them only ever appearing in the
// reporting user's own devtools console. Best-effort and capped: never
// throws, never blocks the UI, and stops after a handful per page load so a
// tight error loop can't flood the endpoint or the user's network.
(function () {
  const MAX_REPORTS = 10;
  let reportCount = 0;
  const seen = new Set();

  // Strips embedded ISO-8601 timestamps before hashing for dedupe — some
  // sources (Firebase's own console.error calls, e.g. AppCheck's ReCAPTCHA
  // refresher) prepend a live timestamp to an otherwise-identical repeating
  // message, which without this would give every occurrence a unique key
  // and defeat dedupe entirely, burning through MAX_REPORTS on one error.
  const ISO_TIMESTAMP_RE = /\[?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\]?\s*/g;
  function normalizeForDedupe(s) {
    return (s || '').replace(ISO_TIMESTAMP_RE, '');
  }

  function report(payload) {
    if (reportCount >= MAX_REPORTS) return;
    const dedupeKey = normalizeForDedupe(payload.message) + '|' + normalizeForDedupe(payload.stack).slice(0, 300);
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    reportCount++;
    try {
      const body = JSON.stringify({
        ...payload,
        url: window.location.href,
        userAgent: navigator.userAgent,
        // Self-reported, not verified via a Bearer token — this endpoint is
        // unauthenticated (errors can happen before login) and this data is
        // diagnostic-only (admin-read-only), so an unverified uid is fine.
        uid: (auth.currentUser && auth.currentUser.uid) || null,
        workspaceId: window.currentWorkspaceId || null,
      });
      fetch(`${window.VELYNC_CONFIG.apiBase}/api/client-errors`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
      }).catch(() => {});
    } catch (_) { /* never let error reporting itself throw */ }
  }

  window.addEventListener('error', (e) => {
    report({
      type: 'error',
      message: e.message || 'Unknown error',
      stack: (e.error && e.error.stack) || '',
    });
  });

  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason;
    report({
      type: 'unhandledrejection',
      message: (reason && reason.message) || String(reason),
      stack: (reason && reason.stack) || '',
    });
  });

  // Some libraries (notably Firebase's own App Check SDK) catch their own
  // errors internally and only console.error() them — they never become an
  // uncaught exception or unhandled rejection, so the listeners above can't
  // see them. Hooking console.error catches these too. Shares the same
  // dedupe/cap as above, so an error that retries on a timer (e.g. App
  // Check's ReCAPTCHA refresher) only ever reports once per page load, not
  // on every retry.
  const originalConsoleError = console.error.bind(console);
  console.error = function (...args) {
    originalConsoleError(...args);
    try {
      const errArg = args.find((a) => a instanceof Error);
      const message = args.map((a) => {
        if (a instanceof Error) return a.message;
        if (typeof a === 'string') return a;
        try { return JSON.stringify(a); } catch (_) { return String(a); }
      }).join(' ');
      report({ type: 'console.error', message, stack: (errArg && errArg.stack) || '' });
    } catch (_) { /* never let the hook itself throw */ }
  };

  // Failed same-origin /api/** calls — scoped deliberately, not global.
  // Third-party SDK traffic (Firebase, reCAPTCHA, gstatic) fails/retries as
  // part of normal SDK behavior and isn't actionable app code, so reporting
  // on it would just be noise. Never reports on the error-reporting
  // endpoint itself. Response/rejection behavior is passed through
  // unchanged either way — this only observes, never intercepts.
  const originalFetch = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const isApiCall = url.includes('/api/') && !url.includes('/api/client-errors');
    if (!isApiCall) return originalFetch(input, init);

    const method = (init && init.method) || 'GET';
    try {
      const res = await originalFetch(input, init);
      if (!res.ok) {
        report({ type: 'fetch-error', message: `${method} ${url} -> HTTP ${res.status}` });
      }
      return res;
    } catch (err) {
      report({ type: 'fetch-error', message: `${method} ${url} -> ${err.message}`, stack: err.stack || '' });
      throw err;
    }
  };
})();

// ─── Global Settings Initialization ───────────────────────────
(async () => {
  try {
    const res = await fetch('/api/settings/global');
    if (res.ok) {
      const data = await res.json();
      if (data.whatsappNumber) {
        const waLink = document.getElementById('whatsapp-fab-link');
        if (waLink) waLink.href = `https://wa.me/${data.whatsappNumber}`;
        const adminWaInput = document.getElementById('admin-whatsapp-number');
        if (adminWaInput) adminWaInput.value = data.whatsappNumber;
      }
      const maintCheck = document.getElementById('admin-maintenance-mode');
      if (maintCheck && data.maintenanceMode) maintCheck.checked = data.maintenanceMode;
      const maintMsg = document.getElementById('admin-maintenance-message');
      if (maintMsg && data.maintenanceMessage) maintMsg.value = data.maintenanceMessage;
    }
  } catch (err) {
    console.error("Error fetching global settings:", err);
    showToast('Failed to load global settings', 'error');
  }
})();

// ─── Info-tip tooltips (global, event-delegated) ───────────────
// `.info-tip-bubble` is authored inline next to its icon for markup
// convenience, but CSS-only `position:absolute` bubbles get clipped by
// any scrollable/overflow ancestor (e.g. a side-panel's `.panel-body`)
// when the icon sits near that ancestor's edge. Instead of positioning
// in place, move the bubble to a single fixed-position portal on
// `document.body` and place it with getBoundingClientRect() — that
// escapes every ancestor's overflow/stacking context regardless of
// which page or panel the tooltip lives in.
(function initInfoTips() {
  let portal = null;
  let activeTip = null;

  function getPortal() {
    if (!portal) {
      portal = document.createElement('div');
      portal.className = 'info-tip-portal';
      document.body.appendChild(portal);
    }
    return portal;
  }

  function showTip(tip) {
    const bubbleSrc = tip.querySelector('.info-tip-bubble');
    if (!bubbleSrc) return;
    const p = getPortal();
    p.innerHTML = '';
    const bubble = document.createElement('div');
    bubble.className = 'info-tip-bubble info-tip-bubble--portal';
    bubble.innerHTML = bubbleSrc.innerHTML;
    p.appendChild(bubble);

    const r = tip.getBoundingClientRect();
    bubble.style.visibility = 'hidden';
    bubble.style.opacity = '1';
    const bw = bubble.offsetWidth;
    const bh = bubble.offsetHeight;
    let left = r.left + r.width / 2 - bw / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - bw - 8));
    let top = r.top - bh - 8;
    let arrowBelow = true;
    if (top < 8) {
      top = r.bottom + 8;
      arrowBelow = false;
    }
    bubble.style.left = `${left}px`;
    bubble.style.top = `${top}px`;
    bubble.classList.toggle('info-tip-bubble--flip', !arrowBelow);
    const arrowLeft = r.left + r.width / 2 - left;
    bubble.style.setProperty('--info-tip-arrow-left', `${arrowLeft}px`);
    bubble.style.visibility = 'visible';
    activeTip = tip;
  }

  function hideTip() {
    if (portal) portal.innerHTML = '';
    activeTip = null;
  }

  document.addEventListener('mouseover', (e) => {
    const tip = e.target.closest && e.target.closest('.info-tip');
    if (tip) showTip(tip);
  });
  document.addEventListener('mouseout', (e) => {
    const tip = e.target.closest && e.target.closest('.info-tip');
    if (tip && tip === activeTip) hideTip();
  });
  document.addEventListener('focusin', (e) => {
    const tip = e.target.closest && e.target.closest('.info-tip');
    if (tip) showTip(tip);
  });
  document.addEventListener('focusout', (e) => {
    const tip = e.target.closest && e.target.closest('.info-tip');
    if (tip && tip === activeTip) hideTip();
  });
  window.addEventListener('scroll', hideTip, true);
  window.addEventListener('resize', hideTip);
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
let isSuperadmin = false;
let currentWorkspaceId = null;
let workspaceSelectTom = null;

// Backward-compat: resolve status from new 'status' field or legacy 'enabled' field
function configIsActive(cfg) {
  return cfg.status === 'active' || (cfg.enabled === true && !cfg.status);
}
function configStatusLabel(cfg) {
  return cfg.status || (cfg.enabled ? 'active' : 'paused');
}


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
const fSourceConnection = document.getElementById('f-source-connection');
const fDestConnection = document.getElementById('f-dest-connection');
const lastRunRow   = document.getElementById('last-run-row');
const fLastRun     = document.getElementById('f-last-run');

// New configuration fields
const fSyncType      = document.getElementById('f-sync-type');
const fDeleteAfter   = document.getElementById('f-delete-after');

const deleteAfterRow = document.getElementById('delete-after-row');
const btnAddMapping  = document.getElementById('btn-add-mapping');
const mappingsContainer = document.getElementById('mappings-container');
const fSourceList        = document.getElementById('f-source-list');
const fTtTag         = document.getElementById('f-tt-tag');

const sectionStatusMapping = document.getElementById('section-status-mapping');
let currentStatusState = {
  options: [],
  incomplete: [],
  incompleteDefault: '',
  complete: [],
  completeDefault: ''
};

let notionDbProperties = {}; // name -> { type, ... } property metadata
let sourceSchema = {}; // fieldKey -> { type, label } from /api/schema
let _connectionsCache = [];
let currentSourcePlatform = '';
let currentDestPlatform = '';
document.addEventListener('DOMContentLoaded', () => {
  if (typeof initWorkspaceDropdownSkeleton === 'function') {
    initWorkspaceDropdownSkeleton();
  }
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

  // Removed TomSelect init for status fields (now handled by custom modal)
});

// Cloud Run API endpoint
const API_URL = window.VELYNC_CONFIG.apiBase.replace(/\/$/, '') + '/api';
let currentProjects = [];

// ─── Avatar Dropdown (module-level so handlers are ready immediately) ───
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

// Report a client-originated usage-intensity event (login / workspace creation)
// to the backend usage tracker. Fire-and-forget: tracking must never block or
// break the sign-in flow, but failures still get logged (and the server keeps
// its own admin-visible failure counter for anything that reaches it).
function reportUsageEvent(user, activityType) {
  user.getIdToken()
    .then(token => fetch(`${window.VELYNC_CONFIG.apiBase}/api/usage/event`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ activityType }),
    }))
    .then(res => {
      if (res && !res.ok) console.error(`Usage event "${activityType}" rejected: HTTP ${res.status}`);
    })
    .catch(err => console.error(`Failed to report usage event "${activityType}":`, err));
}

// ─── Auth Flow ────────────────────────────────────────────────
onAuthStateChanged(auth, async (user) => {
  const globalLoader = document.getElementById('global-loader');
  if (globalLoader) globalLoader.style.display = 'none';
  

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

    // Email verification reminder (non-blocking) — Google sign-ins are always
    // pre-verified by Google, so this only ever shows for email/password accounts.
    const verifyBanner = document.getElementById('verify-email-banner');
    if (verifyBanner) verifyBanner.style.display = user.emailVerified ? 'none' : 'flex';

    // Set Avatar Initials
    const initials = user.email ? user.email.substring(0, 2).toUpperCase() : 'U';
    const userAvatar = document.getElementById('user-avatar');
    if (userAvatar) userAvatar.textContent = initials;
    const dropAvatar = document.getElementById('dropdown-avatar');
    if (dropAvatar) dropAvatar.textContent = initials;
    const dropEmail = document.getElementById('dropdown-user-email');
    if (dropEmail) dropEmail.textContent = user.email;
    const settingsEmail = document.getElementById('settings-email');
    if (settingsEmail) settingsEmail.value = user.email;
    const collabDisplay = document.getElementById('collab-email-display');
    if (collabDisplay) collabDisplay.textContent = user.email;

    // Handle User Profile & RBAC
    currentWorkspaceId = localStorage.getItem('velync_last_workspace_' + user.uid) || user.uid;
    const userRef = doc(db, 'users', user.uid);
    let workspaceName = "Personal Workspace";
    if (user.displayName) workspaceName = user.displayName.split(' ')[0] + "'s Workspace";

    try {
      const ensureUserDoc = async () => {
        const userSnap = await Promise.race([getDoc(userRef), firestoreTimeout(10000)]);
        if (!userSnap.exists()) {
          await setDoc(userRef, {
            id: user.uid,
            email: user.email,
            workspaceName: workspaceName,
            name: user.displayName || '',
            workspaceId: user.uid,
            createdAt: serverTimestamp()
          });
          const settingsName = document.getElementById('settings-name');
          if (settingsName && user.displayName) settingsName.value = user.displayName;
        } else {
          const uData = userSnap.data();
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
      };

      const checkSuperadmin = async () => {
        // Determine superadmin status via backend (single source of truth)
        const adminToken = await user.getIdToken();
        const adminRes = await fetch('/api/admin/status', {
          headers: { 'Authorization': `Bearer ${adminToken}` }
        });
        if (adminRes.ok) {
          const adminData = await adminRes.json();
          isSuperadmin = adminData.isSuperadmin;
        }
      };

      const ensureWorkspaceDoc = async () => {
        const workspaceRef = doc(db, 'workspaces', user.uid);
        const workspaceSnap = await Promise.race([getDoc(workspaceRef), firestoreTimeout(10000)]);
        if (!workspaceSnap.exists()) {
          await setDoc(workspaceRef, {
            id: user.uid,
            name: workspaceName,
            ownerId: user.uid,
            members: [user.uid],
            invitedEmails: [],
            planId: 'free'
          });
          reportUsageEvent(user, 'workspace_created');
        }
      };

      // Usage-intensity tracking: onAuthStateChanged fires on every page load,
      // so dedupe to one 'user_login' per browser session via sessionStorage.
      const shouldLogLogin = !sessionStorage.getItem('velyncLoginLogged');
      if (shouldLogLogin) sessionStorage.setItem('velyncLoginLogged', '1');

      // ensureUserDoc() then ensureWorkspaceDoc() must complete, IN THAT
      // ORDER, before anything that depends on either doc existing:
      //  - POST /api/usage/event (user_login / workspace_created) reads
      //    users/{uid} server-side for workspaceId attribution.
      //  - GET /api/billing/plan (loadAndApplyPlanBadge below) 404s if
      //    workspaces/{id} doesn't exist yet.
      // On a brand-new signup neither doc exists until these two writes
      // land; running everything in one big Promise.all (as this used to)
      // let those reads race the writes and lose — same bug class as the
      // GET /workspace/invites fix (see workspace.js). Sequencing these two
      // first costs two extra round-trips on a first-ever sign-in (existing
      // users: two fast existence checks, not writes) but removes the race
      // outright.
      await ensureUserDoc();
      await ensureWorkspaceDoc();

      // These three are independent of each other and of the two calls
      // above that already completed — run them concurrently rather than
      // stacking round-trips serially, to cut time-to-usable-dashboard.
      await Promise.all([
        checkSuperadmin(),
        processPendingInvites(user), // hits the backend directly; bypasses Firestore rules
        loadAndApplyPlanBadge(auth), // shows the paid-plan crown badge on the avatar, if applicable
      ]);

      if (shouldLogLogin) reportUsageEvent(user, 'user_login');
    } catch (err) {
      console.error("Error fetching user profile:", err);
      if (navigator.onLine) showToast('Failed to load profile', 'error');
      isSuperadmin = false;
    }

    // Configure UI based on superadmin status
    const adminSection = document.getElementById('admin-sidebar-section');
    if (adminSection) {
      adminSection.style.display = isSuperadmin ? 'block' : 'none';
      if (isSuperadmin) {
        // Lazy-loaded: these 5 modules (~100KB+) are admin-only, so fetching
        // them eagerly for every visitor — including on the sign-in page,
        // before we even know if they're logged in — was pure waste for the
        // vast majority of users who are never superadmins.
        const [
          { initAdminIntegrations },
          { initAdminPlatforms },
          { initAdminPlans },
          { initAdminWorkspaces },
          { initAdminSyncHealth },
          { initAdminClientErrors },
          { initAdminData },
        ] = await Promise.all([
          import('./js/admin-integrations.js'),
          import('./js/admin-platforms.js'),
          import('./js/admin-plans.js'),
          import('./js/admin-workspaces.js'),
          import('./js/admin-sync-health.js'),
          import('./js/admin-client-errors.js'),
          import('./js/admin-data.js'),
        ]);
        initAdminIntegrations(db, auth);
        initAdminPlatforms(db, auth);
        initAdminPlans(db, auth);
        initAdminWorkspaces(auth);
        initAdminSyncHealth(auth);
        initAdminClientErrors(db, auth);
        initAdminData(auth);
      }
    }

    // Setup Admin Global Settings Save
    const btnSaveGlobalSettings = document.getElementById('btn-save-global-settings');
    if (btnSaveGlobalSettings && !btnSaveGlobalSettings.dataset.bound) {
      btnSaveGlobalSettings.dataset.bound = 'true';
      btnSaveGlobalSettings.addEventListener('click', async () => {
        const num = document.getElementById('admin-whatsapp-number').value.trim();
        const maintenanceMode = document.getElementById('admin-maintenance-mode')?.checked || false;
        const maintenanceMessage = document.getElementById('admin-maintenance-message')?.value.trim() || '';

        setButtonLoading(btnSaveGlobalSettings, true);
        try {
          const token = await auth.currentUser.getIdToken();
          const res = await fetch('/api/settings/global', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({
              whatsappNumber: num,
              maintenanceMode,
              maintenanceMessage
            })
          });
          if (!res.ok) {
            const errBody = await res.json().catch(() => ({}));
            throw new Error(errBody.error || `Failed to save settings (${res.status})`);
          }
          const waLink = document.getElementById('whatsapp-fab-link');
          if (waLink) waLink.href = `https://wa.me/${num}`;
          const msg = document.getElementById('admin-global-save-msg');
          if (msg) { msg.textContent = 'Settings saved successfully'; msg.style.display = 'block'; setTimeout(() => { msg.style.display = 'none'; }, 3000); }
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
    window.isSuperadmin = isSuperadmin;

    initLogs(db, currentWorkspaceId, auth);

    // Load configs in background — renders when done
    loadConfigs();
    
    // Wire hub nav to re-render on each visit
    const navHub = document.getElementById('nav-hub');
    if (navHub) {
      navHub.addEventListener('click', () => {
        renderHubView(db, (v) => navigateTo(v));
      });
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

            // If billing tab, load plan info
            if (tab.dataset.tab === 'billing') {
              initBilling(db, auth);
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
            const token = await user.getIdToken();
            const res = await fetch('/api/settings/profile', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
              body: JSON.stringify({ name: newName })
            });
            if (!res.ok) {
              const errData = await res.json().catch(() => ({}));
              throw new Error(errData.error || 'Failed to save');
            }
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

      // Change Password Logic
      const btnChangePassword = document.getElementById('btn-change-password');
      const currentPwInput = document.getElementById('settings-current-password');
      const newPwInput = document.getElementById('settings-new-password');
      const confirmPwInput = document.getElementById('settings-confirm-password');
      const pwMsg = document.getElementById('password-change-msg');
      if (btnChangePassword && currentPwInput && newPwInput && confirmPwInput) {
        btnChangePassword.addEventListener('click', async () => {
          if (pwMsg) { pwMsg.textContent = ''; pwMsg.style.color = ''; }

          const hasPasswordProvider = (auth.currentUser.providerData || []).some(p => p.providerId === 'password');
          if (!hasPasswordProvider) {
            if (pwMsg) { pwMsg.textContent = 'No password set on this account. Use "Forgot Password" on the sign-in page to set one.'; pwMsg.style.color = '#f43f5e'; }
            return;
          }

          // Determine the sign-in method used in the current session
          let signInProvider = 'password';
          try {
            const tokenResult = await auth.currentUser.getIdTokenResult();
            signInProvider = tokenResult.claims?.firebase?.sign_in_provider || 'password';
          } catch (_) {}

          const viaPassword = signInProvider === 'password';
          const currentPw = currentPwInput.value;
          const newPw = newPwInput.value;
          const confirmPw = confirmPwInput.value;

          if (viaPassword) {
            if (!currentPw) {
              if (pwMsg) { pwMsg.textContent = 'Current password is required.'; pwMsg.style.color = '#f43f5e'; }
              return;
            }
            if (currentPw === newPw) {
              if (pwMsg) { pwMsg.textContent = 'New password must be different from current password.'; pwMsg.style.color = '#f43f5e'; }
              return;
            }
          }
          if (!newPw || !confirmPw) {
            if (pwMsg) { pwMsg.textContent = 'New password and confirmation are required.'; pwMsg.style.color = '#f43f5e'; }
            return;
          }
          const missingPwReqs = getPasswordPolicyErrors(newPw);
          if (missingPwReqs.length) {
            if (pwMsg) { pwMsg.textContent = 'Password must contain ' + missingPwReqs.join(', ') + '.'; pwMsg.style.color = '#f43f5e'; }
            return;
          }
          if (newPw !== confirmPw) {
            if (pwMsg) { pwMsg.textContent = 'New passwords do not match.'; pwMsg.style.color = '#f43f5e'; }
            return;
          }
          if (isCommonPassword(newPw)) {
            if (pwMsg) { pwMsg.textContent = 'This password is too common and easily guessed. Please choose a stronger one.'; pwMsg.style.color = '#f43f5e'; }
            return;
          }

          setButtonLoading(btnChangePassword, true);
          try {
            if (viaPassword) {
              const credential = EmailAuthProvider.credential(auth.currentUser.email, currentPw);
              await reauthenticateWithCredential(auth.currentUser, credential);
            }
            await updatePassword(auth.currentUser, newPw);
            if (pwMsg) { pwMsg.textContent = 'Password updated successfully!'; pwMsg.style.color = '#34d399'; }
            currentPwInput.value = '';
            newPwInput.value = '';
            confirmPwInput.value = '';
            // Setting .value directly doesn't fire the 'input' event those
            // listeners depend on — without dispatching it, the strength
            // meter and "Passwords match" indicator kept showing their last
            // (now-stale) state after a successful change instead of
            // clearing back to empty.
            newPwInput.dispatchEvent(new Event('input'));
            confirmPwInput.dispatchEvent(new Event('input'));
            // Security notification — best-effort, doesn't block the already-successful change.
            auth.currentUser.getIdToken().then(token =>
              fetch('/api/settings/notify-password-changed', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}` }
              })
            ).catch(() => {});
          } catch (err) {
            if (pwMsg) {
              if (err.code === 'auth/wrong-password' || err.code === 'auth/invalid-credential') {
                pwMsg.textContent = 'Current password is incorrect.';
              } else if (err.code === 'auth/weak-password' || err.code === 'auth/password-does-not-meet-requirements') {
                pwMsg.textContent = 'Password must be at least 8 characters and include a lowercase letter, an uppercase letter, a number, and a special character.';
              } else if (err.code === 'auth/requires-recent-login') {
                pwMsg.textContent = 'Please sign out and sign in again before changing your password.';
              } else {
                pwMsg.textContent = 'Failed to update password: ' + err.message;
              }
              pwMsg.style.color = '#f43f5e';
            }
          } finally {
            setButtonLoading(btnChangePassword, false);
            setTimeout(() => {
              if (pwMsg && pwMsg.style.color === 'rgb(52, 211, 153)') {
                pwMsg.textContent = '';
              }
            }, 4000);
          }
        });
      }

      // ─── Settings password strength & match indicators ─────
      const settingsNewPw = document.getElementById('settings-new-password');
      const settingsStrengthFill = document.getElementById('settings-strength-fill');
      const settingsStrengthLabel = document.getElementById('settings-strength-label');
      const settingsReqs = document.getElementById('settings-password-reqs');
      if (settingsNewPw && settingsStrengthFill && settingsStrengthLabel && settingsReqs) {
        settingsNewPw.addEventListener('input', () => {
          updatePasswordStrengthUI(settingsStrengthFill, settingsStrengthLabel, settingsReqs, settingsNewPw.value);
        });
      }

      const settingsConfirmPw = document.getElementById('settings-confirm-password');
      const matchIcon = document.getElementById('settings-match-icon');
      const matchText = document.getElementById('settings-match-text');
      if (settingsNewPw && settingsConfirmPw && matchIcon && matchText) {
        const updateMatch = () => {
          if (!settingsConfirmPw.value) {
            matchIcon.innerHTML = '';
            matchText.textContent = '';
            matchText.className = 'match-text';
            return;
          }
          if (settingsNewPw.value === settingsConfirmPw.value) {
            matchIcon.innerHTML = feather.icons['check'].toSvg({ width:14, height:14, style:'color:#22c55e' });
            matchText.textContent = 'Passwords match';
            matchText.className = 'match-text match-success';
          } else {
            matchIcon.innerHTML = feather.icons['x'].toSvg({ width:14, height:14, style:'color:#f43f5e' });
            matchText.textContent = 'Passwords do not match';
            matchText.className = 'match-text match-error';
          }
        };
        settingsConfirmPw.addEventListener('input', updateMatch);
        settingsNewPw.addEventListener('input', updateMatch);
      }

      // Save Workspace Logic
      const btnSaveWorkspace = document.getElementById('btn-save-workspace');
      const workspaceNameInput = document.getElementById('settings-workspace-name');
      const workspaceDescInput = document.getElementById('settings-workspace-description');
      const workspaceMsg = document.getElementById('workspace-msg');

      if (btnSaveWorkspace && workspaceNameInput) {
        btnSaveWorkspace.addEventListener('click', async () => {
          const newName = workspaceNameInput.value.trim();
          const newDescription = workspaceDescInput ? workspaceDescInput.value.trim() : undefined;
          if (!newName || !currentWorkspaceId) return;
          setButtonLoading(btnSaveWorkspace, true);
          try {
            const token = await user.getIdToken();
            const res = await fetch('/api/workspace/name', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
              body: JSON.stringify({ name: newName, description: newDescription, workspaceId: currentWorkspaceId })
            });
            if (!res.ok) {
              const errData = await res.json();
              throw new Error(errData.error || 'Failed to save');
            }
            if (workspaceMsg) {
              workspaceMsg.textContent = 'Workspace name updated!';
              workspaceMsg.style.color = '#34d399';
            }
            if (workspaceSelectTom) {
                workspaceSelectTom.updateOption(currentWorkspaceId, { value: currentWorkspaceId, text: newName });
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

      // ─── Delete Workspace ──────────────────────────────────────
      const deleteWsModal = document.getElementById('delete-ws-modal');
      const btnDeleteWs = document.getElementById('btn-delete-workspace');
      const deleteWsConfirm = document.getElementById('delete-ws-confirm');
      const deleteWsCancel = document.getElementById('delete-ws-cancel');
      const deleteWsNameInput = document.getElementById('delete-ws-name-input');
      const deleteWsNameLabel = document.getElementById('delete-ws-name-label');
      const deleteWsErrorMsg = document.getElementById('delete-ws-error-msg');
      const deleteWsDone = document.getElementById('delete-ws-done');

      function resetDeleteWsModal() {
        document.getElementById('delete-ws-step-confirm').style.display = 'block';
        document.getElementById('delete-ws-step-progress').style.display = 'none';
        document.getElementById('delete-ws-step-result').style.display = 'none';
        deleteWsConfirm.disabled = true;
        deleteWsNameInput.value = '';
        if (deleteWsErrorMsg) deleteWsErrorMsg.textContent = '';
        document.getElementById('delete-ws-result-errors').style.display = 'none';
      }

      function openDeleteWsModal(workspaceName) {
        resetDeleteWsModal();
        if (deleteWsNameLabel) {
          deleteWsNameLabel.textContent = `"${workspaceName}"`;
        }
        if (deleteWsModal) deleteWsModal.classList.add('show');
      }

      function closeDeleteWsModal() {
        if (deleteWsModal) deleteWsModal.classList.remove('show');
      }

      if (deleteWsNameInput) {
        deleteWsNameInput.addEventListener('input', () => {
          const wsName = document.getElementById('settings-workspace-name')?.value || '';
          deleteWsConfirm.disabled = deleteWsNameInput.value !== wsName;
        });
      }

      if (btnDeleteWs) {
        btnDeleteWs.addEventListener('click', () => {
          const wsName = document.getElementById('settings-workspace-name')?.value || '';
          openDeleteWsModal(wsName);
        });
      }

      if (deleteWsConfirm) {
        deleteWsConfirm.addEventListener('click', async () => {
          deleteWsConfirm.disabled = true;
          document.getElementById('delete-ws-step-confirm').style.display = 'none';
          document.getElementById('delete-ws-step-progress').style.display = 'block';
          deleteWsErrorMsg.textContent = '';
          try {
            const token = await auth.currentUser.getIdToken();
            const res = await fetch(`/api/workspace/${currentWorkspaceId}`, {
              method: 'DELETE',
              headers: { 'Authorization': `Bearer ${token}` }
            });
            const data = await res.json();
            document.getElementById('delete-ws-step-progress').style.display = 'none';
            document.getElementById('delete-ws-step-result').style.display = 'block';
            const icon = document.getElementById('delete-ws-result-icon');
            const msg = document.getElementById('delete-ws-result-msg');
            if (data.success) {
              icon.textContent = '✓';
              icon.style.color = '#34d399';
              msg.textContent = 'Workspace and all associated data deleted. Signing out…';
              showToast('Workspace deleted. Redirecting…', 'info');
              setTimeout(() => {
                signOut(auth).then(() => location.reload());
              }, 2000);
            } else {
              icon.textContent = '✗';
              icon.style.color = '#f43f5e';
              msg.textContent = data.error || 'Workspace deletion failed.';
              if (data.errors && data.errors.length) {
                const errList = document.getElementById('delete-ws-result-errors-list');
                data.errors.forEach(e => {
                  const li = document.createElement('li');
                  li.textContent = e;
                  errList.appendChild(li);
                });
                document.getElementById('delete-ws-result-errors').style.display = 'block';
              }
              deleteWsConfirm.disabled = false;
            }
          } catch (err) {
            document.getElementById('delete-ws-step-progress').style.display = 'none';
            document.getElementById('delete-ws-step-result').style.display = 'block';
            document.getElementById('delete-ws-result-icon').textContent = '✗';
            document.getElementById('delete-ws-result-icon').style.color = '#f43f5e';
            document.getElementById('delete-ws-result-msg').textContent = err.message || 'An unexpected error occurred.';
            deleteWsConfirm.disabled = false;
          }
        });
      }

      if (deleteWsCancel) {
        deleteWsCancel.addEventListener('click', closeDeleteWsModal);
      }

      if (deleteWsDone) {
        deleteWsDone.addEventListener('click', closeDeleteWsModal);
      }

      // Close modal on overlay click or escape
      if (deleteWsModal) {
        deleteWsModal.addEventListener('click', (e) => {
          if (e.target === deleteWsModal) closeDeleteWsModal();
        });
        document.addEventListener('keydown', (e) => {
          if (e.key === 'Escape' && deleteWsModal.classList.contains('show')) closeDeleteWsModal();
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
          
          setButtonLoading(btnSendInvite, true, 'Send Invite', 'Sending...');
          try {
            const token = await user.getIdToken();
            const inviteRes = await fetch('/api/workspace/invite', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
              body: JSON.stringify({ email, workspaceId: currentWorkspaceId })
            });
            if (!inviteRes.ok) {
              const errData = await inviteRes.json();
              if (inviteRes.status === 409) {
                setButtonLoading(btnSendInvite, false, 'Send Invite');
                return showInviteMsg('User is already invited', true);
              }
              throw new Error(errData.error || 'Failed to send invite');
            }
            // Invite email is now sent server-side (POST /api/workspace/invite)
            // — the mail collection is locked to Admin-SDK-only writes, since a
            // client-writable mail collection with no relation to a real invite
            // was an open email-relay abuse vector.
            showInviteMsg(`Invite sent to ${email}`, false);
            inviteEmailInput.value = '';
            inviteForm.style.display = 'none';
            btnShowInvite.style.display = 'block';
            loadCollaborators(); // Refresh list
          } catch (err) {
            showInviteMsg('Failed to send invite: ' + err.message, true);
          } finally {
            setButtonLoading(btnSendInvite, false, 'Send Invite');
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

      async function loadWorkspaceQuota() {
        const badge = document.getElementById('workspace-quota-badge');
        const progress = document.getElementById('workspace-quota-progress');
        const text = document.getElementById('workspace-quota-text');
        if (!badge || !progress || !text) return;

        try {
          const token = await auth.currentUser.getIdToken();
          const res = await fetch('/api/billing/plan', {
            headers: { 'Authorization': `Bearer ${token}` }
          });
          const data = await res.json();
          if (!res.ok || !data.success) throw new Error(data.error || 'Failed to load plan');

          const { plan, usage } = data;
          // Cached globally so renderCards() (a synchronous render loop) can
          // read the workspace's webhookSyncEnabled flag without an await —
          // used to show honest "real-time" vs "checked every N min" text
          // per config (WEBHOOK_SYNC_PLAN.md §5 Stage 6). Re-render once the
          // plan is known in case cards already rendered with the default text.
          const plchanged = JSON.stringify(window._currentPlan) !== JSON.stringify(plan);
          window._currentPlan = plan;
          if (plchanged && typeof renderCards === 'function' && configs.length > 0) renderCards();
          const used = usage.activeConfigs;
          const max = plan.maxActiveConfigs;
          const unlimited = !max || max <= 0;
          const ratio = unlimited ? 0 : used / max;
          const atLimit = !unlimited && used >= max;

          badge.textContent = `${plan.name} Tier`;
          progress.style.width = unlimited ? '0%' : `${Math.min(ratio, 1) * 100}%`;
          progress.style.background = atLimit ? 'var(--rose)' : '';
          text.textContent = unlimited
            ? `${used} active flow${used !== 1 ? 's' : ''} used. Unlimited on your plan.`
            : `${used} of ${max} active flows used.${atLimit ? ' Upgrade to add more.' : ''}`;
        } catch (err) {
          badge.textContent = '—';
          text.textContent = 'Failed to load usage: ' + err.message;
        }
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
           const token = await auth.currentUser.getIdToken();
           const wsRes = await fetch(`/api/workspace/${currentWorkspaceId}`, {
             headers: { 'Authorization': `Bearer ${token}` }
           });
            if (!wsRes.ok) throw new Error('Failed to load workspace');
            const wsData = await wsRes.json();
            if (!wsData.workspace) return;
            const tenant = wsData.workspace;
            // Show delete section only for the workspace owner
            const deleteWsSection = document.getElementById('delete-workspace-section');
            if (deleteWsSection) {
              deleteWsSection.style.display = tenant.ownerId === auth.currentUser.uid ? 'block' : 'none';
            }
            let html = '';
           
           const wsInput = document.getElementById('settings-workspace-name');
           if (wsInput && tenant.name) {
             wsInput.value = tenant.name;
           }
           const wsDescInput = document.getElementById('settings-workspace-description');
           if (wsDescInput) {
             wsDescInput.value = tenant.description || '';
           }

           loadWorkspaceQuota();

           const isCurrentUserOwner = tenant.ownerId === auth.currentUser.uid;

           // List accepted members
           if (tenant.members) {
             for (const uid of tenant.members) {
               // A member's user doc can be unreadable under the current
               // Firestore rules if their own `workspaceId` field points at a
               // different workspace than the one being viewed (it drifts
               // from the `members` array on every workspace switch/join).
               // Degrade that one row to "Unknown User" instead of letting it
               // throw and wipe out the whole list.
               let uData = { email: 'Unknown' };
               try {
                 const uSnap = await getDoc(doc(db, 'users', uid));
                 if (uSnap.exists()) uData = uSnap.data();
               } catch (_) { /* not readable under current rules */ }
               const isOwner = tenant.ownerId === uid;
               const initials = uData.email ? uData.email.substring(0, 2).toUpperCase() : 'U';
               const makeOwnerBtn = (isCurrentUserOwner && !isOwner)
                 ? `<button class="btn btn-secondary btn-sm make-owner-btn" data-uid="${escAttr(uid)}" data-name="${escAttr(uData.name || uData.email || 'this member')}" style="margin-left:auto;">Make Owner</button>`
                 : '';
               html += `
                 <div class="collaborator-item">
                   <div class="collab-avatar">${initials}</div>
                   <div class="collab-info">
                     <div class="collab-name">${escHtml(uData.name || 'Unknown User')} ${isOwner ? '(Owner)' : ''}</div>
                     <div class="collab-email">${escHtml(uData.email || '')}</div>
                   </div>
                   ${makeOwnerBtn}
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
                     <div class="collab-email">${escHtml(email)}</div>
                   </div>
                   <button class="btn btn-icon delete-invite-btn" title="Remove Invite" data-email="${escAttr(email)}" style="color: #f43f5e; background: rgba(244, 63, 94, 0.1); padding: 6px; border: none; cursor: pointer; border-radius: 6px;">
                     <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                   </button>
                 </div>
               `;
             }
           }
           collabContainer.innerHTML = html;

           // Bind "Make Owner" events
           collabContainer.querySelectorAll('.make-owner-btn').forEach(btn => {
             btn.addEventListener('click', async () => {
               const targetUid = btn.dataset.uid;
               const targetName = btn.dataset.name;
               const confirmed = await confirmDialog({
                 title: 'Transfer Ownership?',
                 message: `Make "${targetName}" the owner of this workspace? You will remain a member, but will no longer be able to delete the workspace or manage billing.`,
                 confirmText: 'Transfer Ownership',
                 confirmClass: 'btn-danger'
               });
               if (!confirmed) return;
               setButtonLoading(btn, true, 'Make Owner', 'Transferring...');
               try {
                 const token = await auth.currentUser.getIdToken();
                 const res = await fetch('/api/workspace/transfer-ownership', {
                   method: 'POST',
                   headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                   body: JSON.stringify({ workspaceId: currentWorkspaceId, newOwnerId: targetUid })
                 });
                 const data = await res.json();
                 if (!res.ok) throw new Error(data.error || 'Failed to transfer ownership');
                 showToast('Ownership transferred', 'success');
                 loadCollaborators();
               } catch (err) {
                 showToast('Failed to transfer ownership: ' + err.message, 'error');
                 setButtonLoading(btn, false, 'Make Owner');
               }
             });
           });

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
                  const token = await auth.currentUser.getIdToken();
                  const revokeRes = await fetch('/api/workspace/invite', {
                    method: 'DELETE',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                    body: JSON.stringify({ email: targetEmail, workspaceId: currentWorkspaceId })
                  });
                  if (!revokeRes.ok) {
                    const errData = await revokeRes.json();
                    throw new Error(errData.error || 'Failed to remove invite');
                  }
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
      }

      // ─── Notifications Tab ────────────────────────────────────
      const notifToggles = [
        'notif-sync-success', 'notif-sync-failure',
        'notif-invite', 'notif-weekly'
      ];
      const notifMsg = document.getElementById('notif-msg');

      async function loadNotifPrefs() {
        try {
          const snap = await getDoc(doc(db, 'users', user.uid));
          const prefs = snap.exists() ? snap.data().notificationPrefs : null;
          // No saved preferences yet (new user) — keep the sensible ON-by-default
          // toggles already set in the HTML instead of forcing everything off.
          if (!prefs) return;
          notifToggles.forEach(id => {
            const el = document.getElementById(id);
            if (el) el.checked = prefs[id] === true;
          });
        } catch (_) {}
      }

      notifToggles.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
          el.addEventListener('change', async () => {
            try {
              const prefs = {};
              notifToggles.forEach(i => { const e = document.getElementById(i); if (e) prefs[i] = e.checked; });
              await updateDoc(doc(db, 'users', user.uid), { notificationPrefs: prefs });
              if (notifMsg) { notifMsg.textContent = 'Preferences saved'; notifMsg.style.color = '#34d399'; setTimeout(() => { notifMsg.textContent = ''; }, 2000); }
            } catch (err) {
              if (notifMsg) { notifMsg.textContent = 'Failed to save: ' + err.message; notifMsg.style.color = '#f43f5e'; }
            }
          });
        }
      });

      // ─── Sessions Tab ─────────────────────────────────────────
      const btnRevokeSessions = document.getElementById('btn-revoke-sessions');
      const sessionsMsg = document.getElementById('sessions-msg');
      const sessionDetails = document.getElementById('session-current-details');

      if (sessionDetails) {
        sessionDetails.textContent = `${navigator.userAgent || 'Unknown browser'} · ${new Date().toLocaleDateString()}`;
      }

      if (btnRevokeSessions) {
        btnRevokeSessions.addEventListener('click', async () => {
          setButtonLoading(btnRevokeSessions, true, 'Logout All Other Devices', 'Revoking...');
          try {
            const token = await auth.currentUser.getIdToken();
            const res = await fetch('/api/settings/revoke-sessions', {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${token}` }
            });
            if (!res.ok) throw new Error(await res.text());
            const data = await res.json();
            // Revoking sessions invalidates every refresh token for this user,
            // including the one this browser is holding — a plain token
            // refresh can't survive that (its refresh token is dead too), so
            // re-sign-in with the one-time custom token the backend just
            // minted for us. That's a brand-new session issued after the
            // revocation timestamp, so it survives while every other device
            // stays logged out.
            let staySignedIn = true;
            try {
              if (data.customToken) {
                await signInWithCustomToken(auth, data.customToken);
              } else {
                await auth.currentUser.getIdToken(true);
              }
            } catch (_) {
              staySignedIn = false;
            }
            if (sessionsMsg) {
              sessionsMsg.textContent = staySignedIn
                ? data.message
                : data.message + ' You may need to sign in again here too.';
              sessionsMsg.style.color = '#34d399';
            }
            showToast('All other sessions revoked', 'success');
          } catch (err) {
            if (sessionsMsg) { sessionsMsg.textContent = 'Failed: ' + err.message; sessionsMsg.style.color = '#f43f5e'; }
          } finally {
            setButtonLoading(btnRevokeSessions, false, 'Logout All Other Devices');
          }
        });
      }

      // ─── Account Tab ──────────────────────────────────────────
      const btnExportData = document.getElementById('btn-export-data');
      const exportMsg = document.getElementById('export-msg');
      const btnDeleteAccount = document.getElementById('btn-delete-account');
      const deleteAccountMsg = document.getElementById('delete-account-msg');

      if (btnExportData) {
        btnExportData.addEventListener('click', async () => {
          setButtonLoading(btnExportData, true, 'Export My Data', 'Exporting...');
          try {
            const token = await auth.currentUser.getIdToken();
            const res = await fetch('/api/settings/export-data', { headers: { 'Authorization': `Bearer ${token}` } });
            if (!res.ok) throw new Error(await res.text());
            const data = await res.json();
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `velync-export-${new Date().toISOString().slice(0, 10)}.json`;
            a.click();
            URL.revokeObjectURL(url);
            if (exportMsg) {
              exportMsg.textContent = data.executionLogsTruncated
                ? `Exported ${Object.keys(data).length} data sections. Note: ${data.executionLogsNote}`
                : `Exported ${Object.keys(data).length} data sections`;
              exportMsg.style.color = data.executionLogsTruncated ? '#f59e0b' : '#34d399';
            }
          } catch (err) {
            if (exportMsg) { exportMsg.textContent = 'Export failed: ' + err.message; exportMsg.style.color = '#f43f5e'; }
          } finally {
            setButtonLoading(btnExportData, false, 'Export My Data');
          }
        });
      }

      if (btnDeleteAccount) {
        btnDeleteAccount.addEventListener('click', async () => {
          const confirmed = await confirmDialog({
            title: 'Delete Account?',
            message: 'This will permanently delete your account, all workspaces, sync configs, connections, and execution logs. This action cannot be undone. Consider using "Export My Data" above first if you\'d like to keep a copy — there\'s no way to recover anything after deletion.',
            confirmText: 'Delete My Account',
            confirmClass: 'btn-danger'
          });
          if (!confirmed) return;

          const doubleConfirm = await confirmDialog({
            title: 'Are you absolutely sure?',
            message: 'Type "DELETE" to confirm permanent account deletion.',
            confirmText: 'DELETE'
          });
          if (!doubleConfirm) return;

          setButtonLoading(btnDeleteAccount, true, 'Delete My Account', 'Deleting...');
          try {
            const token = await auth.currentUser.getIdToken();
            const res = await fetch('/api/settings/delete-account', {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${token}` }
            });
            if (!res.ok) throw new Error(await res.text());
            const data = await res.json();
            showToast(data.fullyDeleted === false ? data.message : 'Account deleted. Redirecting...', data.fullyDeleted === false ? 'warning' : 'info');
            setTimeout(() => {
              signOut(auth).then(() => location.reload());
            }, data.fullyDeleted === false ? 4000 : 2000);
          } catch (err) {
            if (deleteAccountMsg) { deleteAccountMsg.textContent = 'Failed: ' + err.message; deleteAccountMsg.style.color = '#f43f5e'; }
            setButtonLoading(btnDeleteAccount, false, 'Delete My Account');
          }
        });
      }

      // ─── Tab-switch triggers for new panes ────────────────────
      tabs.forEach(tab => {
        tab.addEventListener('click', () => {
          const t = tab.dataset.tab;
          if (t === 'notifications' && user) loadNotifPrefs();
        });
      });
    }
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

    // Reset auth form to login mode
    isSignUpMode = false;
    isResetMode = false;
    if (authForm) authForm.reset();
    if (authBoxTitle) authBoxTitle.textContent = 'Welcome Back';
    if (authBoxSubtitle) authBoxSubtitle.textContent = 'Sign in to manage your workspace.';
    if (btnAuthSubmit) btnAuthSubmit.textContent = 'Sign In';
    if (authToggleText) authToggleText.textContent = "Don't have an account?";
    if (authToggleLink) authToggleLink.textContent = 'Sign Up';
    if (authPasswordGroup) authPasswordGroup.style.display = 'block';
    if (authPassword) authPassword.required = true;
    if (authDivider) authDivider.style.display = 'flex';
    if (btnLogin) btnLogin.style.display = 'flex';
    if (forgotPasswordLink) forgotPasswordLink.style.display = 'block';
    // These only get hidden again by the sign-up/sign-in toggle handler, which
    // never runs on sign-out — without this, signing up (which shows them)
    // then signing out leaves them visible on the "Welcome Back" sign-in form.
    const termsGroupOnLogout = document.getElementById('auth-terms-group');
    if (termsGroupOnLogout) termsGroupOnLogout.style.display = 'none';
    const authStrengthOnLogout = document.getElementById('auth-password-strength');
    if (authStrengthOnLogout) authStrengthOnLogout.style.display = 'none';
    authError.style.display = 'none';
    authError.style.backgroundColor = 'rgba(239, 68, 68, 0.1)';
    authError.style.color = '#EF4444';
    authError.style.borderColor = 'rgba(239, 68, 68, 0.2)';

    // Clear all user-specific DOM to prevent stale data flash on next login
    const verifyBannerClear = document.getElementById('verify-email-banner');
    if (verifyBannerClear) verifyBannerClear.style.display = 'none';
    const userAvatar = document.getElementById('user-avatar');
    if (userAvatar) userAvatar.textContent = '';
    const dropAvatarClear = document.getElementById('dropdown-avatar');
    if (dropAvatarClear) dropAvatarClear.textContent = '';
    const wsNameInput = document.getElementById('settings-workspace-name');
    if (wsNameInput) wsNameInput.value = '';
    const sidebarName = document.getElementById('sidebar-workspace-name');
    if (sidebarName) sidebarName.textContent = '';
    const dropdownName = document.getElementById('dropdown-user-name');
    if (dropdownName) dropdownName.textContent = '';
    const dropdownEmail = document.getElementById('dropdown-user-email');
    if (dropdownEmail) dropdownEmail.textContent = '';
    const settingsName = document.getElementById('settings-name');
    if (settingsName) settingsName.value = '';
    const settingsEmail = document.getElementById('settings-email');
    if (settingsEmail) settingsEmail.value = '';
    if (userEmailSpan) userEmailSpan.textContent = '';

    // Reset auth form password strength meter
    const authPwInput = document.getElementById('auth-password');
    if (authPwInput) authPwInput.value = '';
    const authStrength = document.getElementById('auth-password-strength');
    if (authStrength) authStrength.style.display = 'none';
    const authFill = document.getElementById('auth-strength-fill');
    if (authFill) authFill.style.width = '0%';
    const authLabel = document.getElementById('auth-strength-label');
    if (authLabel) { authLabel.textContent = ''; authLabel.style.color = ''; }
    const authReqs = document.getElementById('auth-password-reqs');
    if (authReqs) authReqs.querySelectorAll('li').forEach(li => li.classList.remove('valid'));

    currentWorkspaceId = null;
    isSuperadmin = false;
    if (workspaceSelectTom) {
      workspaceSelectTom.clear(true);
      workspaceSelectTom.clearOptions();
      workspaceSelectTom.addOption({value: 'loading', text: 'Fetching Workspaces...'});
      workspaceSelectTom.setValue('loading', true);
      workspaceSelectTom.wrapper.classList.add('is-loading');
      workspaceSelectTom.lock();
    }
  }
});

// Wire additional view renderers to nav clicks
function wireViewRenderers() {
  const navConnections = document.getElementById('nav-connections');
  if (navConnections) {
    navConnections.addEventListener('click', async () => {
      const cached = window.__getViewCache ? window.__getViewCache('connections') : null;
      if (cached) {
        connections = cached;
        await renderConnectionsView();
        return;
      }
      renderConnectionsSkeleton();
      await loadConnections(true);
      await renderConnectionsView();
      if (window.__setViewCache) window.__setViewCache('connections', connections);
    });
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
    case 'auth/password-does-not-meet-requirements':
      return 'Password must be at least 8 characters and include a lowercase letter, an uppercase letter, a number, and a special character.';
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

// ─── Password Security Utilities ──────────────────────────────
const COMMON_PASSWORDS = new Set([
  'password','password1','password123','12345678','123456789',
  'qwerty123','qwerty1','abc123','letmein','welcome',
  'monkey','dragon','master','admin','admin123',
  'login','hello','passw0rd','shadow','sunshine',
  'trustno1','iloveyou','princess','football','baseball',
  'whatever','superman','batman','starwars','1234',
  '000000','111111','11111111','222222','333333',
  '444444','555555','666666','777777','888888',
  '999999','123123','1234567890','qwertyuiop','asdfghjkl',
]);

function evaluatePasswordStrength(password) {
  if (!password) return { score:0, checks:{}, label:'', color:'transparent', pct:0 };
  const checks = {
    length: password.length >= 8,
    lowercase: /[a-z]/.test(password),
    uppercase: /[A-Z]/.test(password),
    number: /\d/.test(password),
    special: /[^a-zA-Z0-9]/.test(password),
  };
  const score = Object.values(checks).filter(Boolean).length;
  const pct = (score / 5) * 100;
  const levels = [
    { label:'', color:'transparent' },
    { label:'Weak', color:'#f43f5e' },
    { label:'Fair', color:'#f97316' },
    { label:'Good', color:'#eab308' },
    { label:'Strong', color:'#22c55e' },
    { label:'Very Strong', color:'#16a34a' },
  ];
  return { score, checks, ...levels[score], pct };
}

/**
 * Human-readable list of policy requirements NOT met by `password`, derived from
 * the same checks the strength checklist UI uses. Matches the Firebase Auth
 * project password policy (min 8 chars, lower+upper+number+special) — keep this
 * in sync with that policy so the UI never accepts something Firebase rejects.
 * Empty array = compliant.
 */
function getPasswordPolicyErrors(password) {
  const { checks } = evaluatePasswordStrength(password || '');
  const messages = [];
  if (!checks.length) messages.push('at least 8 characters');
  if (!checks.lowercase) messages.push('a lowercase letter');
  if (!checks.uppercase) messages.push('an uppercase letter');
  if (!checks.number) messages.push('a number');
  if (!checks.special) messages.push('a special character');
  return messages;
}

function updatePasswordStrengthUI(fillEl, labelEl, reqsEl, password) {
  const r = evaluatePasswordStrength(password);
  if (fillEl) { fillEl.style.width = r.pct + '%'; fillEl.style.background = r.color; }
  if (labelEl) { labelEl.textContent = r.label; labelEl.style.color = r.color; }
  if (reqsEl) {
    reqsEl.querySelectorAll('li').forEach(li => {
      const req = li.dataset.req;
      // Always toggle (not just when the key is present) — when password is empty,
      // evaluatePasswordStrength() returns checks:{} and every req must clear back
      // to unmet, not keep whatever state it was left in.
      if (req) li.classList.toggle('valid', !!r.checks[req]);
    });
  }
  return r;
}

function togglePasswordVisibility(btn, input) {
  const hidden = input.type === 'password';
  input.type = hidden ? 'text' : 'password';
  btn.innerHTML = feather.icons[hidden ? 'eye-off' : 'eye'].toSvg({ width:18, height:18 });
  btn.setAttribute('aria-label', hidden ? 'Hide password' : 'Show password');
}

function isCommonPassword(password) {
  return COMMON_PASSWORDS.has(password.toLowerCase().trim());
}

// ─── Wire toggle buttons at page load ─────────────────────────
document.querySelectorAll('.password-toggle').forEach(btn => {
  const input = btn.closest('.password-input-wrapper').querySelector('input');
  if (!input) return;
  // The button ships empty in the HTML — togglePasswordVisibility() was the only
  // place that ever set its icon, so it stayed invisible until the first click.
  // Render the initial "eye" (password hidden) icon up front.
  btn.innerHTML = feather.icons[input.type === 'password' ? 'eye' : 'eye-off'].toSvg({ width: 18, height: 18 });
  btn.addEventListener('click', () => togglePasswordVisibility(btn, input));
});

// ─── Wire auth password strength meter ────────────────────────
(function initAuthPasswordStrength() {
  const pwInput = document.getElementById('auth-password');
  const fill = document.getElementById('auth-strength-fill');
  const label = document.getElementById('auth-strength-label');
  const reqs = document.getElementById('auth-password-reqs');
  if (!pwInput || !fill || !label || !reqs) return;
  pwInput.addEventListener('input', () => {
    if (document.getElementById('auth-password-strength').style.display === 'none') return;
    updatePasswordStrengthUI(fill, label, reqs, pwInput.value);
  });
})();

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

  const rememberGroup = document.getElementById('auth-remember-group');
  if (rememberGroup) rememberGroup.style.display = 'block';
  const termsGroup = document.getElementById('auth-terms-group');
  if (termsGroup) termsGroup.style.display = isSignUpMode ? 'block' : 'none';

  const authStrength = document.getElementById('auth-password-strength');
  if (authStrength) authStrength.style.display = isSignUpMode ? 'block' : 'none';
  if (!isSignUpMode && authPassword) {
    const fill = document.getElementById('auth-strength-fill');
    const label = document.getElementById('auth-strength-label');
    const reqs = document.getElementById('auth-password-reqs');
    if (fill) fill.style.width = '0%';
    if (label) { label.textContent = ''; label.style.color = ''; }
    if (reqs) reqs.querySelectorAll('li').forEach(li => li.classList.remove('valid'));
  }

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

    const rememberGroup = document.getElementById('auth-remember-group');
    if (rememberGroup) rememberGroup.style.display = 'none';
    const termsGroup = document.getElementById('auth-terms-group');
    if (termsGroup) termsGroup.style.display = 'none';

    authToggleText.textContent = "Remembered your password?";
    authToggleLink.textContent = "Sign In";
  });
}

function rememberMeChecked() {
  const cb = document.getElementById('auth-remember-me');
  return !cb || cb.checked; // default to "remember" if the checkbox isn't present
}

authForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = authEmail.value.trim();
  const password = authPassword.value;
  
  if (!email || (!isResetMode && !password)) return;

  if (isSignUpMode) {
    const termsCheckbox = document.getElementById('auth-terms-checkbox');
    if (termsCheckbox && !termsCheckbox.checked) {
      authError.textContent = 'Please agree to the Terms of Service and Privacy Policy to continue.';
      authError.style.display = 'block';
      return;
    }
  }

  authError.style.display = 'none';
  authError.style.backgroundColor = 'rgba(239, 68, 68, 0.1)'; // Reset to red
  authError.style.color = '#EF4444';
  authError.style.borderColor = 'rgba(239, 68, 68, 0.2)';
  
  const originalText = btnAuthSubmit.textContent;
  setButtonLoading(btnAuthSubmit, true, originalText, isResetMode ? 'Sending...' : (isSignUpMode ? 'Creating Account...' : 'Signing In...'));

  try {
    if (isResetMode) {
      try {
        await sendPasswordResetEmail(auth, email);
      } catch (resetErr) {
        // Don't reveal whether the account exists — showing a different message
        // for "no such account" vs success lets an attacker enumerate registered
        // emails. Any other error (bad format, network, rate limit) still
        // surfaces normally below.
        if (resetErr.code !== 'auth/user-not-found' && resetErr.code !== 'auth/invalid-credential') {
          throw resetErr;
        }
      }
      authError.textContent = "If an account exists for this email, a reset link has been sent. Check your inbox (and spam folder) for the link.";
      authError.style.display = 'block';
      authError.style.backgroundColor = 'rgba(16, 185, 129, 0.1)'; // Green success
      authError.style.color = '#10B981';
      authError.style.borderColor = 'rgba(16, 185, 129, 0.2)';
      setButtonLoading(btnAuthSubmit, false, "Send Reset Link");
      return; // Stop here, don't trigger the auth state changes
    } else if (isSignUpMode) {
      const missingReqs = getPasswordPolicyErrors(password);
      if (missingReqs.length) {
        throw new Error('Password must contain ' + missingReqs.join(', ') + '.');
      }
      if (isCommonPassword(password)) {
        throw new Error('This password is too common and easily guessed. Please choose a stronger password.');
      }
      await setPersistence(auth, rememberMeChecked() ? browserLocalPersistence : browserSessionPersistence);
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      if (analytics) logEvent(analytics, 'sign_up', { method: 'email' });
      // Best-effort — don't block account creation if sending the verification email fails.
      try { await sendEmailVerification(cred.user); } catch (verifyErr) { console.warn('Could not send verification email:', verifyErr); }
    } else {
      await setPersistence(auth, rememberMeChecked() ? browserLocalPersistence : browserSessionPersistence);
      await signInWithEmailAndPassword(auth, email, password);
      if (analytics) logEvent(analytics, 'login', { method: 'email' });
    }
  } catch (error) {
    authError.textContent = getAuthErrorMessage(error);
    authError.style.display = 'block';
  } finally {
    setButtonLoading(btnAuthSubmit, false, originalText);
  }
});

btnLogin.addEventListener('click', async () => {
  const provider = new GoogleAuthProvider();
  authError.style.display = 'none';
  const originalLoginLabel = btnLogin.innerHTML;
  setButtonLoading(btnLogin, true, originalLoginLabel, 'Connecting...');
  try {
    await setPersistence(auth, rememberMeChecked() ? browserLocalPersistence : browserSessionPersistence);
    await signInWithPopup(auth, provider);
    if (analytics) logEvent(analytics, 'login', { method: 'google' });
  } catch (error) {
    authError.textContent = getAuthErrorMessage(error);
    authError.style.display = 'block';
  } finally {
    // setButtonLoading restores via textContent, which would strip the
    // Google icon <img> — restore the captured innerHTML directly instead.
    btnLogin.disabled = false;
    delete btnLogin.dataset.originalText;
    btnLogin.innerHTML = originalLoginLabel;
  }
});

const btnResendVerification = document.getElementById('btn-resend-verification');
if (btnResendVerification) {
  btnResendVerification.addEventListener('click', async () => {
    if (!auth.currentUser) return;
    const originalLabel = btnResendVerification.textContent;
    setButtonLoading(btnResendVerification, true, originalLabel, 'Sending...');
    try {
      await sendEmailVerification(auth.currentUser);
      showToast('Verification email sent — check your inbox.', 'success');
    } catch (err) {
      showToast('Could not send verification email: ' + err.message, 'error');
    } finally {
      setButtonLoading(btnResendVerification, false, originalLabel);
    }
  });
}

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
  const enabled  = configs.filter(c => configIsActive(c)).length;
  const disabled = total - enabled;
  if (statTotal) statTotal.textContent   = total;
  if (statEnabled) statEnabled.textContent = enabled;
  if (statDisabled) statDisabled.textContent= disabled;
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
- status: "draft" | "active" | "paused"
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
    initOnboarding(db, auth, () => {
      window.currentOnboardingStep = null;
      loadConfigs();
    });
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

    // Parse the cron schedule into a readable text format. Webhook push
    // support is a per-connector capability (Connector.supportsWebhooks(),
    // surfaced via GET /api/platforms as `supportsWebhooks`) — looked up
    // generically here instead of hardcoding a platform name, so any future
    // webhook-capable connector shows this automatically with no app.js change.
    const p1SupportsWebhooks = (window.cachedPlatforms || []).find(p => p.id === p1Id)?.supportsWebhooks === true;
    let scheduleText = 'Every 5 Minutes';
    if (!configIsActive(cfg)) {
      scheduleText = '<span style="opacity: 0.5;">Disabled</span>';
    } else if (p1SupportsWebhooks && window._currentPlan?.webhookSyncEnabled) {
      scheduleText = '<span title="Changes in the source database sync within seconds via webhook. Falls back to the interval below if a webhook is ever missed.">⚡ Real-time</span>';
    } else if (cfg.cronSchedule) {
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
        <label class="toggle" title="${configIsActive(cfg) ? 'Pause' : 'Activate'} this config">
          <input type="checkbox" class="toggle-checkbox" data-id="${cfg.id}" ${configIsActive(cfg) ? 'checked' : ''} />
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
    await ensureCachedPlatforms();
    if (typeof loadConnections === 'function' && (!_connectionsCache || _connectionsCache.length === 0)) {
      _connectionsCache = await loadConnections(true);
    }

    const token = await auth.currentUser.getIdToken();
    const res = await Promise.race([
      fetch('/api/sync-configs', { headers: { 'Authorization': `Bearer ${token}` } }),
      firestoreTimeout(15000)
    ]);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    configs = data.items;
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


// ─── Toggle active/paused ─────────────────────────────────────
// Goes through the backend (not a direct client write) so activating a
// config actually re-runs plan enforcement (max active configs, connector
// tiers, min sync interval) instead of silently bypassing it.
async function toggleConfig(id, checkbox) {
  const prev = checkbox.checked;
  checkbox.disabled = true;
  try {
    const cfg = configs.find(c => c.id === id);
    const wasActive = cfg ? configIsActive(cfg) : false;
    const newStatus = wasActive ? 'paused' : 'active';
    await updateConfigViaApi(id, { status: newStatus });

    if (cfg) cfg.status = newStatus;
    renderCards();
    showToast(`Config ${newStatus === 'active' ? 'activated' : 'paused'}`, newStatus === 'active' ? 'success' : 'info');
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
      await ensureCachedPlatforms();
    } catch(err) {
      console.warn('Failed to load platforms in openPanel', err);
      if (navigator.onLine) showToast('Failed to load platforms', 'error');
    }
  }

  // 2. Load connections and populate the dropdowns
  _connectionsCache = await loadConnections(true);

  // Determine platform providers for filtering connection dropdowns
  let p1Provider = null;
  let p2Provider = null;

  if (id) {
    // Edit mode: derive providers from saved connections
    let cfg = configs.find(c => c.id === id);
    if (!cfg) {
      try {
        const fetched = await fetchSyncConfig(id);
        if (fetched) {
          cfg = fetched;
          configs.push(cfg);
        }
      } catch(err) {
        console.warn('[openPanel] Config fetch failed:', err);
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
      fillForm(cfg, { skipMappings: true });
      // Note: populateConnectionDropdowns was already called above with provider info.
      
      const p1Conn = _connectionsCache.find(c => c.id === cfg.platform1ConnectionId);
      if (p1Conn) {
        window.renderSchemaForPlatform(p1Conn.provider, 'source-dynamic-container', 'p1', cfg.p1Settings || {});
        const entity = cfg.p1Settings?.targetEntity || 'Tasks';
        await fetchSourceSchema(cfg.platform1ConnectionId, p1Conn.provider, entity);
      }
      
      const p2Conn = _connectionsCache.find(c => c.id === cfg.platform2ConnectionId);
      if (p2Conn) {
        window.renderSchemaForPlatform(p2Conn.provider, 'dest-dynamic-container', 'p2', cfg.p2Settings || {});
      }

      // Restore mappings only when both schemas are available (connections configured)
      if (p1Conn && p2Conn) {
        restoreFieldMappings(cfg);
      }
      // Clear dirty flag — fillForm/restoreFieldMappings may fire change events
      window.resetConfigDirty();
    }
  } else {
    panelTitle.innerHTML = feather.icons['plus'].toSvg({width: 18, height: 18, style: 'margin-right: 6px; vertical-align: text-bottom;'}) + ' New Config';
  }

  } finally {
    endLoad(loadKey);
  }

  goToStep(1);
  if (!id) {
    document.getElementById('f-source-connection')?.dispatchEvent(new Event('change'));
    document.getElementById('f-dest-connection')?.dispatchEvent(new Event('change'));
  }
  sidePanel.classList.add('open');
  panelOverlay.classList.add('open');
}
window.openPanel = openPanel; // Expose globally for external scripts

let _dropdownSourceProvider = null;
let _dropdownDestProvider = null;
let _dropdownSourceName = null;
let _dropdownDestName = null;

function getPlatformDisplayName(providerId) {
  if (!providerId) return null;
  const plat = window.cachedPlatforms?.find(p => p.id === providerId || p.key === providerId);
  return plat?.name || providerId;
}

function setConnectButtonProviders(p1Provider, p2Provider) {
  _dropdownSourceProvider = p1Provider;
  _dropdownDestProvider = p2Provider;
  _dropdownSourceName = getPlatformDisplayName(p1Provider);
  _dropdownDestName = getPlatformDisplayName(p2Provider);

  const p1Name = _dropdownSourceName || 'Source';
  const p2Name = _dropdownDestName || 'Destination';

  const btn1 = document.getElementById('btn-connect-source');
  const btn2 = document.getElementById('btn-connect-dest');
  const link1 = document.getElementById('source-connect-link');
  const link2 = document.getElementById('dest-connect-link');
  const hint1 = document.getElementById('source-connect-hint');
  const hint2 = document.getElementById('dest-connect-hint');
  if (btn1) btn1.dataset.provider = p1Provider || '';
  if (btn2) btn2.dataset.provider = p2Provider || '';
  if (link1) link1.dataset.provider = p1Provider || '';
  if (link2) link2.dataset.provider = p2Provider || '';
  if (hint1) hint1.dataset.provider = p1Provider || '';
  if (hint2) hint2.dataset.provider = p2Provider || '';

  // Update section titles
  const t1 = document.getElementById('source-settings-title');
  const t2 = document.getElementById('dest-settings-title');
  if (t1) t1.textContent = p1Name + ' Settings';
  if (t2) t2.textContent = p2Name + ' Settings';

  // Update node labels and logos in the workflow canvas
  const n1 = document.getElementById('node-source-name');
  const n2 = document.getElementById('node-dest-name');
  if (n1) n1.textContent = p1Name;
  if (n2) n2.textContent = p2Name;

  const n1Logo = document.getElementById('node-source-logo');
  const n2Logo = document.getElementById('node-dest-logo');
  if (n1Logo) n1Logo.innerHTML = getPlatformLogoSvg(p1Provider);
  if (n2Logo) n2Logo.innerHTML = getPlatformLogoSvg(p2Provider);

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
  _dropdownSourceProvider = p1Provider;
  _dropdownDestProvider = p2Provider;

  window._connectingProvider = null;

  // Remove any connecting indicators
  document.querySelectorAll('#section-source .loader1, #section-dest .loader2').forEach(el => el.remove());

  const p1Conns = p1Provider ? connections.filter(c => c.provider === p1Provider) : connections;
  const p2Conns = p2Provider ? connections.filter(c => c.provider === p2Provider) : connections;

  const p1Result = buildSelectHtml(p1Conns);
  const p2Result = buildSelectHtml(p2Conns);

  fSourceConnection.innerHTML = p1Result.html;
  fDestConnection.innerHTML = p2Result.html;
  fSourceConnection.disabled = false;
  fDestConnection.disabled = false;
  fSourceConnection.classList.remove('is-loading');
  fDestConnection.classList.remove('is-loading');

  const hint1 = document.getElementById('source-connect-hint');
  const hint2 = document.getElementById('dest-connect-hint');
  const btn1 = document.getElementById('btn-connect-source');
  const btn2 = document.getElementById('btn-connect-dest');

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
      if (cfg.platform1ConnectionId) fSourceConnection.value = cfg.platform1ConnectionId;
      if (cfg.platform2ConnectionId) fDestConnection.value = cfg.platform2ConnectionId;
    }
  } else {
    // New config: if a platform's connection list is unambiguous (exactly
    // one saved account for that provider — e.g. the user just connected it
    // from the Marketplace setup preview), auto-select it so they don't have
    // to re-pick a platform they just connected. Left unselected whenever
    // there's more than one account for that provider — genuinely ambiguous,
    // not something to guess at. Dispatches 'change' so schema-loading
    // (handleConnectionChange) runs exactly as it would for a manual pick —
    // setting .value alone doesn't fire that listener.
    if (p1Conns.length === 1) {
      fSourceConnection.value = p1Conns[0].id;
      fSourceConnection.dispatchEvent(new Event('change'));
    }
    if (p2Conns.length === 1) {
      fDestConnection.value = p2Conns[0].id;
      fDestConnection.dispatchEvent(new Event('change'));
    }
  }
}

function handleConnectionChange(prefix) {
  const connId = document.getElementById(prefix === 'p1' ? 'f-source-connection' : 'f-dest-connection')?.value;
  const containerId = prefix === 'p1' ? 'source-dynamic-container' : 'dest-dynamic-container';
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
}

async function closePanel() {
  window._connectingProvider = null;
  document.querySelectorAll('#section-source .loader1, #section-dest .loader2').forEach(el => el.remove());
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

function formatPropertyType(typeStr) {
  if (!typeStr) return '';
  const formatted = typeStr.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  return ` [Type: ${formatted}]`;
}

function buildSourceFieldOptions(entity, selectedField) {
  const fields = Object.entries(sourceSchema).map(([key, f]) => ({
    value: key, label: `${f.label || key}${formatPropertyType(f.type)}`
  }));
  if (!fields.length) {
    return `<option value="">— No schema loaded —</option>`;
  }
  return fields.map(f => `<option value="${f.value}" ${f.value === selectedField ? 'selected' : ''}>${f.label}</option>`).join('');
}

function addMappingRow(sourceField = '', destField = '', confidence = null, reasoning = '', sourceFieldList = null, destFieldList = null) {
  const row = document.createElement('div');
  row.className = 'mapping-row';
  row.style = 'display: flex; gap: 1rem; align-items: center; background: rgba(255, 255, 255, 0.02); padding: 0.75rem 1rem; border-radius: 12px; border: 1px solid var(--border); transition: all 0.2s ease;';

  const entity = (window.harvestDynamicFields && window.harvestDynamicFields('source-dynamic-container')['targetEntity']) || 'Tasks';

  if (!sourceFieldList) {
    sourceFieldList = Object.entries(sourceSchema).map(([key, f]) => ({
      value: key, label: `${f.label || key}${formatPropertyType(f.type)}`
    }));
    if (!sourceFieldList.length) {
      sourceFieldList = [{ value: '', label: '— No schema loaded —' }];
    }
  }

  if (!destFieldList) {
    if (notionDbProperties && notionDbProperties.__error) {
      destFieldList = [{ value: '__error', label: `Couldn't load properties: ${notionDbProperties.__error.label}` }];
    } else if (notionDbProperties) {
      destFieldList = Object.entries(notionDbProperties).map(([key, f]) => ({
        value: key, label: `${f.label || key}${formatPropertyType(f.type)}`
      }));
      destFieldList.unshift({ value: '__content__', label: '[Page Content / Body]' });
    } else {
      destFieldList = [{ value: '__content__', label: '[Page Content / Body]' }];
    }
  }

  let sOptions = sourceFieldList.map(f =>
    `<option value="${f.value}" ${f.value === sourceField ? 'selected' : ''}>${f.label}</option>`
  ).join('');

  let dOptions = destFieldList.map(f =>
    `<option value="${f.value}" ${f.value === destField ? 'selected' : ''}>${f.label}</option>`
  ).join('');

  row.innerHTML = `
    <select class="map-source" style="flex: 1; padding: 10px 12px; border-radius: 8px; background: transparent; color: var(--text-1); border: 1px solid transparent; font-size: 0.9rem; font-weight: 500; outline: none; cursor: pointer; transition: all 0.2s ease;" onmouseover="this.style.background='rgba(255,255,255,0.04)'; this.style.borderColor='var(--border)';" onmouseout="this.style.background='transparent'; this.style.borderColor='transparent';">${sOptions}</select>
    
    <div style="display: flex; align-items: center; justify-content: center; width: 32px; height: 32px; border-radius: 50%; background: var(--glass); color: var(--text-3);">
      ${feather.icons['arrow-right'].toSvg({width: 16, height: 16})}
    </div>
    
    <select class="map-dest" style="flex: 1; padding: 10px 12px; border-radius: 8px; background: transparent; color: var(--text-1); border: 1px solid transparent; font-size: 0.9rem; font-weight: 500; outline: none; cursor: pointer; transition: all 0.2s ease;" onmouseover="this.style.background='rgba(255,255,255,0.04)'; this.style.borderColor='var(--border)';" onmouseout="this.style.background='transparent'; this.style.borderColor='transparent';">${dOptions}</select>
    
    ${confidence !== null ? (() => {
      // Color-code by confidence so a weak AI suggestion is visually
      // distinct, not just a percentage a user has to read carefully.
      const pct = Math.round(confidence * 100);
      const isLow = confidence < 0.5;
      const isMedium = confidence >= 0.5 && confidence < 0.8;
      const bg = isLow ? 'rgba(251,113,133,0.15)' : isMedium ? 'rgba(245,158,11,0.15)' : 'rgba(129,140,248,0.15)';
      const color = isLow ? 'var(--rose)' : isMedium ? '#f59e0b' : 'var(--primary)';
      const label = isLow ? `⚠ ${pct}% — please verify` : `${pct}%`;
      return `<div class="mapping-reasoning-badge" style="background: ${bg}; color: ${color}; padding: 4px 10px; border-radius: 12px; font-size: 0.8rem; font-weight: 600;" title="${reasoning.replace(/"/g, '&quot;')}">${label}</div>`;
    })() : ''}
    
    <button type="button" class="btn-remove-mapping" style="background: rgba(251, 113, 133, 0.1); border: 1px solid transparent; color: var(--rose); cursor: pointer; padding: 6px; border-radius: 8px; display: flex; align-items: center; justify-content: center; transition: all 0.2s ease;" onmouseover="this.style.background='rgba(251, 113, 133, 0.2)'" onmouseout="this.style.background='rgba(251, 113, 133, 0.1)'">
      ${feather.icons['x'].toSvg({width: 16, height: 16})}
    </button>
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

let currentModalTarget = null;
let currentModalTempSelection = [];

function updateStatusMappingUI(savedStatusMappings = null) {
  if (!sectionStatusMapping) return;

  const syncType = document.getElementById('f-sync-type')?.value;
  const showStatusMapping = syncType === 'Dest_to_Source' || syncType === 'Bidirectional';

  if (!showStatusMapping) {
    sectionStatusMapping.style.display = 'none';
    return;
  }

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

  const options = propSchema.options || (propSchema.type === 'status' ? propSchema.status?.options : propSchema.select?.options) || [];
  currentStatusState.options = options.map(o => o.name);

  if (savedStatusMappings) {
    currentStatusState.incomplete = savedStatusMappings.incomplete || [];
    currentStatusState.incompleteDefault = savedStatusMappings.incompleteDefault || '';
    currentStatusState.complete = savedStatusMappings.complete || [];
    currentStatusState.completeDefault = savedStatusMappings.completeDefault || '';
  } else {
    const completedNames = options.filter(opt => ['completed', 'complete', 'done'].includes(opt.name.toLowerCase())).map(opt => opt.name);
    const incompleteNames = options.filter(opt => ['not started', 'to-do', 'todo', 'in progress'].includes(opt.name.toLowerCase())).map(opt => opt.name);
    
    currentStatusState.complete = completedNames.length > 0 ? completedNames : (options.length > 0 ? [options[options.length - 1].name] : []);
    currentStatusState.completeDefault = completedNames.length > 0 ? completedNames[0] : (options.length > 0 ? options[options.length - 1].name : '');
    
    currentStatusState.incomplete = incompleteNames.length > 0 ? incompleteNames : (options.length > 0 ? [options[0].name] : []);
    currentStatusState.incompleteDefault = incompleteNames.length > 0 ? incompleteNames[0] : (options.length > 0 ? options[0].name : '');
  }

  renderStatusLabels();
}

function renderStatusLabels() {
  document.getElementById('lbl-status-incomplete').textContent = currentStatusState.incomplete.length ? currentStatusState.incomplete.join(', ') : 'None';
  document.getElementById('lbl-status-incomplete-default').textContent = currentStatusState.incompleteDefault || 'None';
  document.getElementById('lbl-status-complete').textContent = currentStatusState.complete.length ? currentStatusState.complete.join(', ') : 'None';
  document.getElementById('lbl-status-complete-default').textContent = currentStatusState.completeDefault || 'None';
}

window.openStatusModal = function(target, isReRender = false) {
  currentModalTarget = target;
  
  const title = document.getElementById('status-modal-title');
  const subtitle = document.getElementById('status-modal-subtitle');
  const list = document.getElementById('status-modal-list');
  
  list.innerHTML = '';
  
  let options = currentStatusState.options;
  let isMulti = false;
  
  if (target === 'incomplete') {
    title.innerHTML = 'Incomplete';
    subtitle.textContent = 'Which properties in Notion are displayed as incomplete in TickTick?';
    isMulti = true;
    if (!isReRender) currentModalTempSelection = [...currentStatusState.incomplete];
  } else if (target === 'incomplete-default') {
    title.innerHTML = 'Incomplete Default';
    subtitle.textContent = 'Which property will incomplete tasks in TickTick sync to in Notion?';
    isMulti = false;
    options = currentStatusState.incomplete;
    if (!isReRender) currentModalTempSelection = [currentStatusState.incompleteDefault];
  } else if (target === 'complete') {
    title.innerHTML = 'Complete';
    subtitle.textContent = 'Which properties in Notion are displayed as complete in TickTick?';
    isMulti = true;
    if (!isReRender) currentModalTempSelection = [...currentStatusState.complete];
  } else if (target === 'complete-default') {
    title.innerHTML = 'Complete Default';
    subtitle.textContent = 'Which property will complete tasks in TickTick sync to in Notion?';
    isMulti = false;
    options = currentStatusState.complete;
    if (!isReRender) currentModalTempSelection = [currentStatusState.completeDefault];
  }

  if (options.length === 0) {
    list.innerHTML = `<p style="padding: 16px; color: var(--text-3); text-align: center; font-size: 0.9rem;">Please select at least one status in the parent list first.</p>`;
  } else {
    options.forEach(opt => {
      const isSelected = currentModalTempSelection.includes(opt);
    const row = document.createElement('div');
    row.style = 'display: flex; align-items: center; gap: 12px; padding: 12px; border-radius: 8px; cursor: pointer; transition: all 0.2s ease;';
    row.onmouseover = () => row.style.background = 'rgba(255,255,255,0.05)';
    row.onmouseout = () => row.style.background = 'transparent';
    
    const checkboxChecked = `<svg width="22" height="22" viewBox="0 0 24 24"><circle cx="12" cy="12" r="12" fill="var(--primary)"/><path d="M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2z" fill="#fff"/></svg>`;
    const checkboxUnchecked = `<div style="width: 22px; height: 22px; border-radius: 50%; border: 2px solid rgba(255,255,255,0.2); box-sizing: border-box;"></div>`;
    
    const radioChecked = `<svg width="22" height="22" viewBox="0 0 24 24"><circle cx="12" cy="12" r="12" fill="transparent" stroke="rgba(255,255,255,0.2)" stroke-width="2"/><circle cx="12" cy="12" r="8" fill="var(--primary)"/></svg>`;
    const radioUnchecked = `<div style="width: 22px; height: 22px; border-radius: 50%; border: 2px solid rgba(255,255,255,0.2); box-sizing: border-box;"></div>`;
    
    let iconSvg = isMulti ? (isSelected ? checkboxChecked : checkboxUnchecked) : (isSelected ? radioChecked : radioUnchecked);
    
    row.innerHTML = `<div class="opt-icon" style="display: flex; align-items: center; justify-content: center;">${iconSvg}</div><span style="font-size: 1rem; color: var(--text-1);">${opt}</span>`;
    
    row.onclick = () => {
      if (isMulti) {
        if (currentModalTempSelection.includes(opt)) {
           currentModalTempSelection = currentModalTempSelection.filter(x => x !== opt);
        } else {
           currentModalTempSelection.push(opt);
        }
      } else {
        currentModalTempSelection = [opt];
      }
      openStatusModal(target, true); // re-render to show correct selection state without resetting
    };
    list.appendChild(row);
  });
  }
  
  document.getElementById('status-mapping-modal').classList.add('open');
};

window.closeStatusModal = function() {
  document.getElementById('status-mapping-modal').classList.remove('open');
};

window.saveStatusModal = function() {
  if (currentModalTarget === 'incomplete') {
    currentStatusState.incomplete = [...currentModalTempSelection];
  } else if (currentModalTarget === 'incomplete-default') {
    currentStatusState.incompleteDefault = currentModalTempSelection[0] || '';
  } else if (currentModalTarget === 'complete') {
    currentStatusState.complete = [...currentModalTempSelection];
  } else if (currentModalTarget === 'complete-default') {
    currentStatusState.completeDefault = currentModalTempSelection[0] || '';
  }
  renderStatusLabels();
  closeStatusModal();
}

async function loadDefaultMappingsPreset() {
  const entity = (window.harvestDynamicFields && window.harvestDynamicFields('source-dynamic-container')['targetEntity']) || 'Tasks';
  const sourceConnId = document.getElementById('f-source-connection')?.value || document.querySelector('[data-source-connection]')?.value;
  const destConnId = document.getElementById('f-dest-connection')?.value || document.querySelector('[data-dest-connection]')?.value;

  if (!sourceConnId || !destConnId) return;

  const destContext = window.harvestDynamicFields ? window.harvestDynamicFields('dest-dynamic-container') : {};
  const sourceContext = window.harvestDynamicFields ? window.harvestDynamicFields('source-dynamic-container') : {};
  const destContextStr = JSON.stringify(destContext);
  const sourceContextStr = JSON.stringify(sourceContext);

  if (window._lastMappedSourceId === sourceConnId && window._lastMappedDestId === destConnId && 
      window._lastMappedSourceContext === sourceContextStr && window._lastMappedDestContext === destContextStr && 
      mappingsContainer.children.length > 0) {
    return; // Preserve existing state if connections and specific dynamic contexts haven't changed
  }

  mappingsContainer.innerHTML = '<div style="padding: 16px; text-align: center; color: var(--text-3); font-size: 0.9rem; animation: pulse-loading 1.5s infinite;"><i data-feather="loader" class="spin" style="width:16px; height:16px; margin-right:8px; vertical-align:middle;"></i> Generating intelligent mapping suggestions...</div>';
  if (window.feather) window.feather.replace();

  try {
    const user = auth.currentUser;
    const idToken = await user.getIdToken();
    const sourceConn = typeof _connectionsCache !== 'undefined' ? _connectionsCache.find(c => c.id === sourceConnId) : null;
    const destConn = typeof _connectionsCache !== 'undefined' ? _connectionsCache.find(c => c.id === destConnId) : null;

    const p1Provider = sourceConn?.provider || _dropdownSourceProvider || null;
    const p2Provider = destConn?.provider || _dropdownDestProvider || null;

    if (!p1Provider || !p2Provider) {
      mappingsContainer.innerHTML = `<div style="padding: 16px; text-align: center; color: #ef4444; font-size: 0.9rem;">
        Cannot determine platform for one or both connections.</div>`;
      return;
    }

    const res = await fetch(`${API_URL}/suggest-mappings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
      body: JSON.stringify({
        sourceConnectionId: sourceConnId,
        destConnectionId: destConnId,
        sourcePlatform: p1Provider,
        destPlatform: p2Provider,
        sourceEntityType: entity,
        context: { source: sourceContext, dest: destContext }
      })
    });

    if (!res.ok) {
      mappingsContainer.innerHTML = `<div style="padding: 16px; text-align: center; color: #ef4444; font-size: 0.9rem;">
        Failed to load schemas (HTTP ${res.status}). Check that both connections are valid.</div>`;
      const errText = await res.text().catch(() => '');
      console.warn('[loadDefaultMappingsPreset] HTTP error:', res.status, errText);
      return;
    }

    const data = await res.json();
    mappingsContainer.innerHTML = ''; // clear loading state
    
    if (data.sourceSchema && Object.keys(data.sourceSchema).length > 0) sourceSchema = data.sourceSchema;
    if (data.destSchema && Object.keys(data.destSchema).length > 0) notionDbProperties = data.destSchema;
    
    if (!data.success) {
      mappingsContainer.innerHTML = `<div style="padding: 16px; text-align: center; color: #ef4444; font-size: 0.9rem;">
        ${data.error ? `Error: ${escHtml(data.error)}` : 'Failed to generate mapping suggestions.'}</div>`;
      console.warn('[loadDefaultMappingsPreset] API error:', data.error);
      return;
    }

    if (data.suggestions && data.suggestions.length > 0) {
      window._lastMappedSourceId = sourceConnId;
      window._lastMappedDestId = destConnId;
      window._lastMappedSourceContext = sourceContextStr;
      window._lastMappedDestContext = destContextStr;
      let applied = 0, lowConfidence = 0;
      data.suggestions.forEach(s => {
        if (s.destField) {
          addMappingRow(s.sourceField, s.destField, s.confidence, s.reasoning);
          applied++;
          if (typeof s.confidence === 'number' && s.confidence < 0.5) lowConfidence++;
        }
      });
      window.markConfigDirty();
      // These are suggestions, not a final config — nothing is saved until
      // Save/Submit is clicked, so surface a clear prompt to actually look
      // at them rather than assuming they're all correct.
      showToast(
        lowConfidence > 0
          ? `${applied} field mapping(s) suggested — ${lowConfidence} marked low-confidence. Please review before saving.`
          : `${applied} field mapping(s) suggested. Please review before saving.`,
        lowConfidence > 0 ? 'warning' : 'info'
      );
      return;
    }

    // API succeeded but no suggestions returned
    mappingsContainer.innerHTML = `<div style="padding: 16px; text-align: center; color: var(--text-3); font-size: 0.9rem;">
      No mapping suggestions available. Add mappings manually below.</div>`;
    window.markConfigDirty();
  } catch (e) {
    console.warn('[loadDefaultMappingsPreset] Network error:', e);
    mappingsContainer.innerHTML = `<div style="padding: 16px; text-align: center; color: #ef4444; font-size: 0.9rem;">
      Network error loading schemas. Check your connection and try again.</div>`;
  }
}

function filterAndPopulateTtLists() {
  const entity = (window.harvestDynamicFields && window.harvestDynamicFields('source-dynamic-container')['targetEntity']) || 'Tasks';
  const currentVal = fSourceList.value;

  fSourceList.innerHTML = '';

  if (entity === 'Habits') {
    return;
  }

  if (currentProjects.length === 0) {
    const opt = document.createElement('option');
    opt.value = "";
    opt.textContent = "-- Click Load Data --";
    fSourceList.appendChild(opt);
    return;
  }

  if (entity === 'Tasks') {
    const inboxOpt = document.createElement('option');
    inboxOpt.value = 'Inbox';
    inboxOpt.textContent = 'Inbox';
    fSourceList.appendChild(inboxOpt);
  }

  const expectedKind = entity === 'Notes' ? 'NOTE' : 'TASK';
  const filtered = currentProjects.filter(p => String(p.kind).toUpperCase() === expectedKind);

  filtered.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.name;
    opt.textContent = p.name;
    fSourceList.appendChild(opt);
  });

  if (currentVal && Array.from(fSourceList.options).some(o => o.value === currentVal)) {
    fSourceList.value = currentVal;
  } else if (fSourceList.options.length > 0) {
    fSourceList.value = fSourceList.options[0].value;
  }
}

async function fetchSourceSchema(connectionId, platform, entityType) {
  if (!connectionId || !platform) return;
  // Use the platform ID directly — backend route resolves connector via registry
  const resolvedPlatform = platform;
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

  fSourceConnection.value = '';
  fDestConnection.value = '';
  
  if (fSourceList) fSourceList.innerHTML = '<option value="">-- Select Connection --</option>';
  if (fTtTag) fTtTag.innerHTML = '';
  
  fCron.value        = '*/5 * * * *';
  if (fIntervalValue) fIntervalValue.value = 5;
  if (fIntervalUnit) {
    fIntervalUnit.value = 'minutes';
    fIntervalUnit.dispatchEvent(new Event('change'));
  }

  if (lastRunRow) lastRunRow.style.display = 'none';
  const templateRow = document.getElementById('notion-template-row');
  if (templateRow) templateRow.style.display = 'none';
  const templateSelect = document.getElementById('f-n-template');
  if (templateSelect) {
    templateSelect.innerHTML = '<option value="">No Template (Default Layout)</option>';
    templateSelect.value = '';
  }

  // Clear dynamic platform containers so legacy schema fields don't persist
  const p1Container = document.getElementById('source-dynamic-container');
  if (p1Container) p1Container.innerHTML = '';
  const p2Container = document.getElementById('dest-dynamic-container');
  if (p2Container) p2Container.innerHTML = '';

  notionDbProperties = {};
  mappingsContainer.innerHTML = '';
  
  currentStatusState = { options: [], incomplete: [], incompleteDefault: '', complete: [], completeDefault: '' };
  // cleared state instead of tomselect
  if (window.fStatusIncompleteDefault) fStatusIncompleteDefault.innerHTML = '';
  if (window.fStatusCompleteDefault) fStatusCompleteDefault.innerHTML = '';
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

async function fillForm(cfg, opts = {}) {
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


  if (cfg.platform1ConnectionId) fSourceConnection.value = cfg.platform1ConnectionId;
  if (cfg.platform2ConnectionId) fDestConnection.value = cfg.platform2ConnectionId;
  
  const listName = cfg.ticktick?.listName || '';
  if (listName && fSourceList) {
    const opt = document.createElement('option');
    opt.value = listName;
    opt.textContent = listName;
    fSourceList.appendChild(opt);
    fSourceList.value = listName;
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
  
  if (lastRunRow && fLastRun) {
    if (cfg.lastRunAt) {
      lastRunRow.style.display = 'flex';
      const d = new Date(cfg.lastRunAt);
      fLastRun.textContent = isNaN(d.getTime()) ? cfg.lastRunAt : d.toLocaleString();
    } else {
      lastRunRow.style.display = 'none';
    }
  }
  
  // Set field visibility
  triggerFormFieldVisibility();

  // Load field mappings (skip when schemas will be loaded separately)
  if (opts.skipMappings) {
    window._pendingFieldMappings = cfg.fieldMappings || [];
    window._pendingStatusMappings = cfg.statusMappings || null;
  } else {
    mappingsContainer.innerHTML = '';
    const mappings = cfg.fieldMappings || [];
    if (mappings.length > 0) {
      mappings.forEach(m => addMappingRow(m.sourceField || m.ticktickField, m.destField || m.notionProperty));
      window._lastMappedSourceId = cfg.platform1ConnectionId || document.getElementById('f-source-connection')?.value;
      window._lastMappedDestId = cfg.platform2ConnectionId || document.getElementById('f-dest-connection')?.value;
    } else {
      loadDefaultMappingsPreset();
    }
    updateStatusMappingUI(cfg.statusMappings);
  }

  // Update visual node builder UI to match form data
  if (typeof updateNodeStatuses === 'function') {
    updateNodeStatuses();
  }
}

function restoreFieldMappings(cfg) {
  if (!cfg) {
    if (window._pendingFieldMappings) {
      const mappings = window._pendingFieldMappings;
      mappings.forEach(m => addMappingRow(m.sourceField || m.ticktickField, m.destField || m.notionProperty));
      updateStatusMappingUI(window._pendingStatusMappings);
    }
    return;
  }
  mappingsContainer.innerHTML = '';
  const mappings = cfg.fieldMappings || [];
  if (mappings.length > 0) {
    mappings.forEach(m => addMappingRow(m.sourceField || m.ticktickField, m.destField || m.notionProperty));
    window._lastMappedSourceId = cfg.platform1ConnectionId || document.getElementById('f-source-connection')?.value;
    window._lastMappedDestId = cfg.platform2ConnectionId || document.getElementById('f-dest-connection')?.value;
  } else {
    loadDefaultMappingsPreset();
  }
  updateStatusMappingUI(cfg.statusMappings);
}

function buildFormPayload(payloadStatus) {
  
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

  let p1ConnId = fSourceConnection.value || existingCfg?.platform1ConnectionId || '';
  let p2ConnId = fDestConnection.value || existingCfg?.platform2ConnectionId || '';

  // If this config came from the marketplace flow, the connections are locked in step 1.
  // Ignore the form dropdowns and strictly preserve what was saved in the draft.
  if (creationSource === 'marketplace' && existingCfg) {
    p1ConnId = existingCfg.platform1ConnectionId || p1ConnId;
    p2ConnId = existingCfg.platform2ConnectionId || p2ConnId;
  }

  const finalStatus = payloadStatus;

  return {
    description: fDescription.value.trim() || 'New Sync Configuration',
    integrationId: document.getElementById('f-integration-id')?.value || null,
    status: finalStatus,
    creationSource: creationSource,
    syncType:    fSyncType.value,
    deleteAfterSync: fDeleteAfter.checked,
    cronSchedule: buildCron(fIntervalValue?.value, fIntervalUnit?.value, fCron?.value),
    platform1: (typeof _connectionsCache !== 'undefined' && _connectionsCache.find(c => c.id === p1ConnId)?.provider) || _dropdownSourceProvider || null,
    platform2: (typeof _connectionsCache !== 'undefined' && _connectionsCache.find(c => c.id === p2ConnId)?.provider) || _dropdownDestProvider || null,
    platform1ConnectionId: p1ConnId,
    platform2ConnectionId: p2ConnId,
    p1Settings: window.harvestDynamicFields ? window.harvestDynamicFields('source-dynamic-container') : {},
    p2Settings: window.harvestDynamicFields ? window.harvestDynamicFields('dest-dynamic-container') : {},
    fieldMappings,
    statusMappings: (Array.from(mappingsContainer.querySelectorAll('.mapping-row'))
      .some(row => (row.querySelector('.map-source') || row.querySelector('.map-ticktick')).value === 'status')) ? {
        incomplete: currentStatusState.incomplete,
        incompleteDefault: currentStatusState.incompleteDefault,
        complete: currentStatusState.complete,
        completeDefault: currentStatusState.completeDefault
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

  // Skip write if editing existing config with no changes (draft only)
  if (editingId && !isSubmit && !isConfigDirty) {
    showToast('No changes to save', 'info');
    return;
  }

  isSavingConfig = true;

  const status = isSubmit ? 'active' : 'draft';
  const payload = buildFormPayload(status);

  if (!payload.platform1ConnectionId) {
    showToast('Please complete the setup for Platform 1.', 'error');
    isSavingConfig = false;
    return;
  }
  if (!payload.platform2ConnectionId) {
    showToast('Please complete the setup for Platform 2.', 'error');
    isSavingConfig = false;
    return;
  }
  if (payload.platform1ConnectionId === payload.platform2ConnectionId) {
    showToast("Validation Error: The 'From' and 'To' connections cannot be the exact same account.", 'error');
    isSavingConfig = false;
    return;
  }

  // Warn (don't block) if another config already syncs this exact same
  // connection pair — easy to end up with confusing/conflicting duplicates.
  const duplicateConfig = configs.find(c =>
    c.id !== editingId &&
    c.platform1ConnectionId === payload.platform1ConnectionId &&
    c.platform2ConnectionId === payload.platform2ConnectionId
  );
  if (duplicateConfig) {
    const proceedAnyway = await confirmDialog({
      title: 'Similar sync already exists',
      message: `"${duplicateConfig.description || duplicateConfig.id}" already syncs this exact same pair of connections. Creating another one can cause duplicate or conflicting syncs. Continue anyway?`,
      confirmText: 'Create Anyway',
    });
    if (!proceedAnyway) {
      isSavingConfig = false;
      return;
    }
  }

  // Validate duplicate destination fields
  const mappedDestFields = new Set();
  for (const m of payload.fieldMappings) {
    if (mappedDestFields.has(m.destField)) {
      showToast(`Validation Error: Destination field '${m.destField}' is mapped multiple times.`, 'error');
      isSavingConfig = false;
      if (btnSave) btnSave.disabled = false;
      if (btnSubmit) btnSubmit.disabled = false;
      return;
    }
    mappedDestFields.add(m.destField);
  }

  // Validate required destination fields
  if (typeof notionDbProperties !== 'undefined') {
    for (const [key, prop] of Object.entries(notionDbProperties)) {
      if (prop.required && !mappedDestFields.has(key)) {
        showToast(`Validation Error: Required destination field '${prop.label || key}' must be mapped.`, 'error');
        isSavingConfig = false;
        if (btnSave) btnSave.disabled = false;
        if (btnSubmit) btnSubmit.disabled = false;
        return;
      }
    }
  }
  
  const targetBtn = isSubmit ? btnSubmit : btnSave;
  if (btnSave) btnSave.disabled = true;
  if (btnSubmit) btnSubmit.disabled = true;
  
  const originalText = targetBtn ? targetBtn.innerHTML : '';
  if (targetBtn) targetBtn.innerHTML = '<span class="btn-spinner"></span><span style="vertical-align: middle;">' + (isSubmit ? 'Submitting...' : 'Saving...') + '</span>';

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
        // Query for an existing draft for this integration
        const matches = await fetchSyncConfigsByIntegrationId(integrationId);
        if (matches.length > 0) {
          const sortedDocs = matches.sort((a, b) => {
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

      // Enforce marketplace protection immediately before saving
      const existingData = await fetchSyncConfig(resolvedId);
      if (existingData) {
        if (existingData.creationSource === 'marketplace') {
           payload.platform1ConnectionId = existingData.platform1ConnectionId || payload.platform1ConnectionId;
           payload.platform2ConnectionId = existingData.platform2ConnectionId || payload.platform2ConnectionId;
           payload.creationSource = 'marketplace';
        }
      }

      // Route through server endpoint so plan limits are enforced
      try {
        const token = await auth.currentUser.getIdToken();
        const resp = await fetch('/api/sync-configs/' + resolvedId, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify(payload),
        });
        const result = await resp.json();
        if (!resp.ok) {
          throw new Error(result.error || 'Failed to update config');
        }
        showToast(isSubmit ? 'Config activated' : 'Config updated', 'success');
      } catch (apiErr) {
        showPlanError(apiErr.message);
        isSavingConfig = false;
        if (btnSave) btnSave.disabled = false;
        if (btnSubmit) btnSubmit.disabled = false;
        if (targetBtn) targetBtn.innerHTML = originalText;
        return;
      }
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
      // Use server-side endpoint so plan limits are enforced
      try {
        const token = await auth.currentUser.getIdToken();
        const resp = await fetch('/api/sync-configs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify(payload),
        });
        const result = await resp.json();
        if (!resp.ok) {
          throw new Error(result.error || 'Failed to create config');
        }
        editingId = result.id;
        window.currentConfigId = result.id;
        document.getElementById('form-id').value = result.id;
        showToast(isSubmit ? 'Config activated' : 'Config created', 'success');
      } catch (apiErr) {
        showPlanError(apiErr.message);
        isSavingConfig = false;
        if (btnSave) btnSave.disabled = false;
        if (btnSubmit) btnSubmit.disabled = false;
        if (targetBtn) targetBtn.innerHTML = originalText;
        return;
      }
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
      btnSave.innerHTML = `Save`;
    }
    if (btnSubmit) {
      btnSubmit.disabled = false;
      btnSubmit.innerHTML = `Submit`;
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

// Delete a config through the server, which cascades to its sync_mappings + lock.
// (Deleting client-side would orphan the sync_mappings subcollection — Firestore
// does not cascade subcollection deletes.)
async function deleteConfigViaApi(configId) {
  const token = await auth.currentUser.getIdToken();
  const API_BASE = window.VELYNC_CONFIG.apiBase;
  const res = await fetch(`${API_BASE}/api/sync-configs/${encodeURIComponent(configId)}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Delete failed (${res.status})`);
  }
  return res.json();
}

// Restore a just-deleted config through the server (used by the "Undo" toast
// action) — keeps the same enforced-fields guarantee as create/update instead
// of writing the client SDK directly back into sync_configs.
async function restoreConfigViaApi(configId, data) {
  const token = await auth.currentUser.getIdToken();
  const API_BASE = window.VELYNC_CONFIG.apiBase;
  const res = await fetch(`${API_BASE}/api/sync-configs/${encodeURIComponent(configId)}/restore`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Restore failed (${res.status})`);
  }
  return res.json();
}

// Update a config's status (active/paused) through the server, so plan
// enforcement (max active configs, connector tiers, min sync interval)
// actually runs — a direct client-side write here would bypass it entirely.
async function updateConfigViaApi(configId, data) {
  const token = await auth.currentUser.getIdToken();
  const API_BASE = window.VELYNC_CONFIG.apiBase;
  const res = await fetch(`${API_BASE}/api/sync-configs/${encodeURIComponent(configId)}`, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Update failed (${res.status})`);
  }
  return res.json();
}

async function deleteConfig() {
  if (!pendingDeleteId) return;
  modalConfirm.disabled = true;
  try {
    const deletedCfg = configs.find(c => c.id === pendingDeleteId);
    await deleteConfigViaApi(pendingDeleteId);
    selectedConfigIds.delete(pendingDeleteId);
    closeModal();
    await loadConfigs(true);
    showToast('Config deleted', 'info', {
      actionLabel: 'Undo',
      onAction: async () => {
        if (deletedCfg) {
          const { id, ...data } = deletedCfg;
          await restoreConfigViaApi(id, data);
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
configForm.addEventListener('submit', (e) => e.preventDefault());
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
}

document.getElementById('btn-step1-next')?.addEventListener('click', () => {
  const p1 = document.getElementById('f-source-connection')?.value;
  const p2 = document.getElementById('f-dest-connection')?.value;
  if (!p1) { showToast('Please complete the setup for Platform 1.', 'error'); return; }
  if (!p2) { showToast('Please complete the setup for Platform 2.', 'error'); return; }
  if (p1 === p2) { showToast('The source and destination accounts cannot be the same.', 'error'); return; }
  
  loadDefaultMappingsPreset();
  goToStep(2);
});

document.getElementById('btn-step2-back')?.addEventListener('click', () => goToStep(1));
document.getElementById('btn-step2-next')?.addEventListener('click', () => {
  const mappings = document.querySelectorAll('.mapping-row');
  if (mappings.length === 0) { showToast('Please add at least one field mapping.', 'error'); return; }
  goToStep(3);
});
document.getElementById('btn-step3-back')?.addEventListener('click', () => goToStep(2));

document.getElementById('btn-step1-save')?.addEventListener('click', (e) => {
  const p1 = document.getElementById('f-source-connection')?.value;
  const p2 = document.getElementById('f-dest-connection')?.value;
  if (!p1) { showToast('Please complete the setup for Platform 1.', 'error'); return; }
  if (!p2) { showToast('Please complete the setup for Platform 2.', 'error'); return; }
  saveConfig(e, false);
});
document.getElementById('btn-step2-save')?.addEventListener('click', (e) => {
  const p1 = document.getElementById('f-source-connection')?.value;
  const p2 = document.getElementById('f-dest-connection')?.value;
  if (!p1) { showToast('Please complete the setup for Platform 1.', 'error'); return; }
  if (!p2) { showToast('Please complete the setup for Platform 2.', 'error'); return; }
  const mappings = document.querySelectorAll('.mapping-row');
  if (mappings.length === 0) { showToast('Please add at least one field mapping.', 'error'); return; }
  saveConfig(e, false);
});

// Update node status indicators and load schema when connection changes
document.getElementById('f-source-connection')?.addEventListener('change', () => {
  updateNodeStatuses();
  handleConnectionChange('p1');
  if (document.getElementById('f-source-connection')?.value && document.getElementById('f-dest-connection')?.value) {
    autoPopulateSyncName();
  }
});
document.getElementById('f-dest-connection')?.addEventListener('change', () => {
  updateNodeStatuses();
  handleConnectionChange('p2');
  if (document.getElementById('f-source-connection')?.value && document.getElementById('f-dest-connection')?.value) {
    autoPopulateSyncName();
  }
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

      // Show inline loading state in the dropdown
      const isP1 = provider === _dropdownSourceProvider;
      const select = isP1 ? fSourceConnection : fDestConnection;
      const btn = isP1 ? document.getElementById('btn-connect-source') : document.getElementById('btn-connect-dest');
      const hint = isP1 ? document.getElementById('source-connect-hint') : document.getElementById('dest-connect-hint');
      
      let originalSelectHtml = '';
      if (select) {
        originalSelectHtml = select.innerHTML;
        select.disabled = true;
        select.classList.add('is-loading');
        select.innerHTML = `<option value="">Fetching ${escHtml(plat.name || 'provider')}...</option>`;
      }
      if (btn) btn.style.display = 'none';
      if (hint) hint.style.display = 'none';

      const opened = await initiateDirectOAuthFlow(plat, label);
      if (opened) return; // Popup opened — skip the dialog
      
      window._connectingProvider = null;
      // Revert loading state
      if (select) {
        select.innerHTML = originalSelectHtml;
        select.classList.remove('is-loading');
        select.disabled = false;
      }
      if (btn) btn.style.display = '';
      if (hint) hint.style.display = '';
    }
  }
  
  // Fallback to dialog
  window.dispatchEvent(new CustomEvent('open-add-connection', { detail: { provider } }));
}
document.getElementById('btn-connect-source')?.addEventListener('click', () => {
  fireOpenAddConnection(document.getElementById('btn-connect-source')?.dataset.provider || null);
});
document.getElementById('btn-connect-dest')?.addEventListener('click', () => {
  fireOpenAddConnection(document.getElementById('btn-connect-dest')?.dataset.provider || null);
});
document.getElementById('source-connect-link')?.addEventListener('click', (e) => {
  e.preventDefault();
  fireOpenAddConnection(document.getElementById('source-connect-link')?.dataset.provider || null);
});
document.getElementById('dest-connect-link')?.addEventListener('click', (e) => {
  e.preventDefault();
  fireOpenAddConnection(document.getElementById('dest-connect-link')?.dataset.provider || null);
});

// Refresh dropdowns when connections are saved/deleted elsewhere
window.addEventListener('connections-refreshed', async (e) => {
  const currentP1 = fSourceConnection.value;
  const currentP2 = fDestConnection.value;

  _connectionsCache = await loadConnections(true);
  const cfgId = document.getElementById('form-id')?.value?.trim() || null;
  populateConnectionDropdowns(_connectionsCache, cfgId, _dropdownSourceProvider, _dropdownDestProvider);

  if (currentP1) fSourceConnection.value = currentP1;
  if (currentP2) fDestConnection.value = currentP2;

  const { newConnectionId, platformId } = e.detail || {};
  if (newConnectionId && platformId) {
    if (platformId === _dropdownSourceProvider) {
      fSourceConnection.value = newConnectionId;
      fSourceConnection.dispatchEvent(new Event('change'));
    } else if (platformId === _dropdownDestProvider) {
      fDestConnection.value = newConnectionId;
      fDestConnection.dispatchEvent(new Event('change'));
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
        await deleteConfigViaApi(id);
        if (deletedCfg) {
          showToast(`"${deletedCfg.description || id}" deleted`, 'info', {
            actionLabel: 'Undo',
            onAction: async () => {
              const { id: did, ...data } = deletedCfg;
              await restoreConfigViaApi(did, data);
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
    await loadConfigs(true);
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

fSyncType.addEventListener('change', () => {
  triggerFormFieldVisibility();
  updateStatusMappingUI();
});

btnAddMapping.addEventListener('click', () => addMappingRow('', ''));



if (fSourceList) {
  fSourceList.addEventListener('change', async () => {
    const token = fTtToken.value.trim();
    const listName = fSourceList.value;
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
  window.cachedPlatforms = null;
  currentNodeId = nodeId;
  const p1Name = window._p1DisplayName || 'Source';
  const p2Name = window._p2DisplayName || 'Destination';
  if (nodeId === 'p1') {
    if (nodeModalTitle) nodeModalTitle.innerHTML = 'Setup Trigger <span style="color:var(--text-3); font-weight:normal;">(' + escHtml(p1Name) + ')</span>';
    const sectionP1 = document.getElementById('section-source');
    if (sectionP1 && nodeModalBody) {
      sectionP1.style.display = 'block';
      nodeModalBody.appendChild(sectionP1);
    }
  } else if (nodeId === 'p2') {
    if (nodeModalTitle) nodeModalTitle.innerHTML = 'Setup Action <span style="color:var(--text-3); font-weight:normal;">(' + escHtml(p2Name) + ')</span>';
    const sectionP2 = document.getElementById('section-dest');
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
  const sectionP1 = document.getElementById('section-source');
  const sectionP2 = document.getElementById('section-dest');
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
  const nodeP1Status = document.getElementById('node-source-status');
  if (nodeP1Status) {
    if (isSectionValid('section-source')) {
      nodeP1Status.innerHTML = '<i data-feather="check-circle" style="width: 16px; height: 16px;"></i>';
      nodeP1Status.className = 'node-status-icon success';
    } else {
      nodeP1Status.innerHTML = '<i data-feather="alert-triangle" style="width: 16px; height: 16px;"></i>';
      nodeP1Status.className = 'node-status-icon warning';
    }
  }

  const nodeP2Status = document.getElementById('node-dest-status');
  if (nodeP2Status) {
    if (isSectionValid('section-dest')) {
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

  // Auto-populate sync name (new configs only, p1 node)
  if (!editingId && currentNodeId === 'p1') {
    autoPopulateSyncName();
  }
}

function autoPopulateSyncName() {
  const fDesc = document.getElementById('f-description');
  if (!fDesc || fDesc.value.trim()) return;

  const p1Name = _dropdownSourceName || 'Source';
  const p2Name = _dropdownDestName || 'Destination';

  let name = p1Name + ' → ' + p2Name;
  let counter = 1;
  while (configs.some(c => c.description === name)) {
    counter++;
    name = p1Name + ' → ' + p2Name + ' ' + counter;
  }
  fDesc.value = name;
}

// Bind Node Modal clicks
document.getElementById('node-source')?.addEventListener('click', () => openNodeModal('p1'));
document.getElementById('node-dest')?.addEventListener('click', () => openNodeModal('p2'));
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
    if (iso && typeof iso === 'object' && iso.toDate) return iso.toDate().toLocaleString(undefined, { dateStyle:'medium', timeStyle:'short' });
    if (iso && typeof iso === 'object' && iso.toMillis) return new Date(iso.toMillis()).toLocaleString(undefined, { dateStyle:'medium', timeStyle:'short' });
    return new Date(iso).toLocaleString(undefined, { dateStyle:'medium', timeStyle:'short' });
  } catch { return iso; }
}

// ─── God Mode Workspace Switcher ──────────────────────────────
function initWorkspaceDropdownSkeleton() {
  const selectEl = document.getElementById('workspace-selector');
  if (!selectEl || typeof TomSelect === 'undefined' || workspaceSelectTom) return;
  
  workspaceSelectTom = new TomSelect("#workspace-selector", {
    create: false,
    sortField: { field: "text", direction: "asc" },
    maxOptions: null,
    onInitialize: function() {
      if (this.control_input) {
        this.control_input.readOnly = true;
      }
      this.addOption({value: 'loading', text: 'Fetching Workspaces...'});
      this.setValue('loading', true);
      if (this.wrapper) {
        this.wrapper.offsetHeight;
        this.wrapper.classList.add('is-loading');
      }
      this.lock();
    }
  });

  workspaceSelectTom.on('change', async (value) => {
    if (value && value !== currentWorkspaceId && value !== 'loading') {
      currentWorkspaceId = value;
      window.currentWorkspaceId = currentWorkspaceId;
      if (auth.currentUser) localStorage.setItem('velync_last_workspace_' + auth.currentUser.uid, value);
      
      const tsWrapper = workspaceSelectTom.wrapper;
      tsWrapper.classList.add('is-loading');
      workspaceSelectTom.lock();
      
      showToast(`Switched workspace`, 'info');
      await loadConfigs();
      
      if (typeof loadConnections === 'function') {
        renderConnectionsSkeleton();
        await loadConnections();
        renderConnectionsView();
      }
      
      tsWrapper.classList.remove('is-loading');
      workspaceSelectTom.unlock();
    }
  });
}

async function setupWorkspaceSwitcher(user) {
  initWorkspaceDropdownSkeleton();
  const selectEl = document.getElementById('workspace-selector');
  if (!selectEl) return;

  const tsWrapper = workspaceSelectTom.wrapper;
  tsWrapper.classList.add('is-loading');
  workspaceSelectTom.lock();
  workspaceSelectTom.addOption({value: 'loading', text: 'Fetching Workspaces...'});
  if (!workspaceSelectTom.getValue()) {
    workspaceSelectTom.setValue('loading', true);
  }

  try {
    let options = [];
    const token = await user.getIdToken();
    const res = await fetch('/api/workspace/memberships', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (res.ok) {
      const data = await res.json();
      if (data.workspaces) {
        data.workspaces.forEach(t => {
          options.push({value: t.id, text: t.name || 'Organization'});
        });
      }
    }

    workspaceSelectTom.clear(true);
    workspaceSelectTom.clearOptions();
    workspaceSelectTom.removeOption('loading');
    options.forEach(opt => workspaceSelectTom.addOption(opt));

  } catch (err) {
    console.error("Error setting up workspace switcher:", err);
    showToast('Failed to load workspaces', 'error');
    workspaceSelectTom.clear(true);
    workspaceSelectTom.clearOptions();
    workspaceSelectTom.removeOption('loading');
    workspaceSelectTom.addOption({value: user.uid, text: `Personal Workspace`});
  }

  const wsIds = Object.keys(workspaceSelectTom.options);
  if (currentWorkspaceId && wsIds.includes(currentWorkspaceId)) {
    workspaceSelectTom.setValue(currentWorkspaceId, true);
  } else if (wsIds.length > 0) {
    currentWorkspaceId = wsIds[0];
    window.currentWorkspaceId = currentWorkspaceId;
    if (auth.currentUser) localStorage.setItem('velync_last_workspace_' + auth.currentUser.uid, currentWorkspaceId);
    workspaceSelectTom.setValue(currentWorkspaceId, true);
  }
  
  tsWrapper.classList.remove('is-loading');
  workspaceSelectTom.unlock();
}

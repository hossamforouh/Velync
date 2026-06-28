/* =============================================================
   connections.js — Connected OAuth Accounts Hub
   Manages the `connected_accounts` Firestore collection and
   renders the Connections view panel.
   NOTE: All Firebase instances are obtained lazily (inside
   functions) to avoid "no-app" errors when this module is
   imported before initializeApp() runs in app.js.
   ============================================================= */

import { getFirestore, collection, getDocs, addDoc, deleteDoc, updateDoc, doc, setDoc, query, where }
  from 'https://www.gstatic.com/firebasejs/10.9.0/firebase-firestore.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/10.9.0/firebase-auth.js';
import { getApp } from 'https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js';

import { getSkeletonTableHTML } from './loading-components.js';
import { confirmDialog } from './confirm.js';
import { showToast } from './toast.js';

/** In-memory cache of connections loaded from Firestore */
export let connections = [];

/** Cached platform details (id → { name, color, bg }) for badge rendering */
let platformDetails = {};

/** Shared cache for full platform documents — avoids redundant Firestore reads */
let _platformsCache = null;

const FALLBACK_COLORS = [
  { color: '#5B6AEB', bg: 'rgba(91,106,235,0.1)' },
  { color: '#EAB308', bg: 'rgba(234,179,8,0.1)' },
  { color: '#059669', bg: 'rgba(5,150,105,0.1)' },
  { color: '#D97706', bg: 'rgba(217,119,6,0.1)' },
  { color: '#DC2626', bg: 'rgba(220,38,38,0.1)' },
  { color: '#7C3AED', bg: 'rgba(124,58,237,0.1)' },
  { color: '#0891B2', bg: 'rgba(8,145,178,0.1)' },
];

// ─── Lazy Firebase accessors ─────────────────────────────────
function getDb() { return getFirestore(getApp()); }
function getAuthInstance() { return getAuth(getApp()); }

// ─── Load connections from Firestore ──────────────────────────
export async function loadConnections() {
  try {
    const [connSnap, platSnap] = await Promise.all([
      getDocs(query(collection(getDb(), 'connected_accounts'), where('workspaceId', '==', window.currentWorkspaceId))),
      _platformsCache || getDocs(collection(getDb(), 'platforms'))
    ]);

    // Cache the platforms snapshot for reuse by fetchPlatformSchemas
    if (!_platformsCache) _platformsCache = platSnap;
    
    platformDetails = {};
    let colorIdx = 0;
    platSnap.forEach(d => {
      const p = d.data();
      const fallback = FALLBACK_COLORS[colorIdx % FALLBACK_COLORS.length];
      colorIdx++;
      platformDetails[d.id] = {
        name: p.name || d.id,
        color: p.badgeColor || fallback.color,
        bg: p.badgeBg || fallback.bg,
      };
    });

    connections = connSnap.docs.map(d => {
      const data = d.data();
      return {
        id: d.id,
        ...data,
        providerName: platformDetails[data.provider]?.name || data.provider
      };
    });
    return connections;
  } catch (err) {
    console.error('[connections] Failed to load:', err);
    showToast('Failed to load connections: ' + err.message, 'error');
    return [];
  }
}

// ─── Save a new connection ─────────────────────────────────────
export async function saveConnection(payload) {
  const user = getAuthInstance().currentUser;
  if (!user) throw new Error('Not authenticated');

  const data = {
    userId: user.uid,
    workspaceId: window.currentWorkspaceId,
    provider: payload.provider,
    label: payload.label || payload.provider,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  if (payload.attributes) {
    data.attributes = payload.attributes;
  } else {
    // Fallback for old explicit fields
    if (payload.provider === 'ticktick') {
      data.accessToken = payload.accessToken || '';
      data.clientId = payload.clientId || '';
      data.clientSecret = payload.clientSecret || '';
    }
    if (payload.provider === 'notion') {
      data.integrationToken = payload.integrationToken || '';
    }
  }

  const docRef = await addDoc(collection(getDb(), 'connected_accounts'), data);
  return { id: docRef.id, ...data };
}

// ─── Delete a connection ───────────────────────────────────────
export async function deleteConnection(id) {
  await deleteDoc(doc(getDb(), 'connected_accounts', id));
}

// ─── Update a connection ───────────────────────────────────────
export async function updateConnection(id, data) {
  await updateDoc(doc(getDb(), 'connected_accounts', id), {
    ...data,
    updatedAt: new Date().toISOString()
  });
}

// ─── Render the Connections view ──────────────────────────────
export function renderConnectionsSkeleton() {
  const tbody = document.getElementById('connections-body');
  if (!tbody) return;
  tbody.innerHTML = `
      <tr>
        <td data-label="Label"><div class="skeleton-line long" style="height: 18px; width: 150px; border-radius: 6px;"></div></td>
        <td data-label="Provider"><div class="skeleton-line" style="width: 100px; height: 24px; border-radius: 12px;"></div></td>
        <td data-label="Created"><div class="skeleton-line" style="height: 16px; width: 80px; border-radius: 6px;"></div></td>
        <td class="col-actions"><div class="skeleton-line" style="width: 32px; height: 32px; border-radius: 6px;"></div></td>
      </tr>
      <tr>
        <td data-label="Label"><div class="skeleton-line long" style="height: 18px; width: 120px; border-radius: 6px;"></div></td>
        <td data-label="Provider"><div class="skeleton-line" style="width: 100px; height: 24px; border-radius: 12px;"></div></td>
        <td data-label="Created"><div class="skeleton-line" style="height: 16px; width: 80px; border-radius: 6px;"></div></td>
        <td class="col-actions"><div class="skeleton-line" style="width: 32px; height: 32px; border-radius: 6px;"></div></td>
      </tr>
      <tr>
        <td data-label="Label"><div class="skeleton-line long" style="height: 18px; width: 180px; border-radius: 6px;"></div></td>
        <td data-label="Provider"><div class="skeleton-line" style="width: 100px; height: 24px; border-radius: 12px;"></div></td>
        <td data-label="Created"><div class="skeleton-line" style="height: 16px; width: 80px; border-radius: 6px;"></div></td>
        <td class="col-actions"><div class="skeleton-line" style="width: 32px; height: 32px; border-radius: 6px;"></div></td>
      </tr>
      <tr>
        <td data-label="Label"><div class="skeleton-line long" style="height: 18px; width: 140px; border-radius: 6px;"></div></td>
        <td data-label="Provider"><div class="skeleton-line" style="width: 100px; height: 24px; border-radius: 12px;"></div></td>
        <td data-label="Created"><div class="skeleton-line" style="height: 16px; width: 80px; border-radius: 6px;"></div></td>
        <td class="col-actions"><div class="skeleton-line" style="width: 32px; height: 32px; border-radius: 6px;"></div></td>
      </tr>
  `;
}

export function renderConnectionsView() {
  const panel = document.getElementById('view-connections');
  if (!panel) return;

  const btnAdd = document.getElementById('btn-add-conn');
  if (btnAdd && !btnAdd.dataset.wired) {
    btnAdd.addEventListener('click', () => openAddConnectionDialog());
    btnAdd.dataset.wired = 'true';
  }

  const tbody = document.getElementById('connections-body');
  if (!tbody) return;

  if (connections.length === 0) {
    tbody.innerHTML = `
      <tr class="table-empty-row">
        <td colspan="4">
          <div style="padding: 32px 16px; text-align: center;">
            <div style="font-size: 2.5rem; margin-bottom: 12px; color: var(--violet);">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="color: var(--violet);"><path d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"></path></svg>
            </div>
            <h3 style="margin-bottom: 6px; color: var(--text-1);">No connections yet</h3>
            <p style="color: var(--text-3); font-size: 0.88rem; margin-bottom: 16px;">Add your API credentials here to reuse them across multiple sync configurations.</p>
          </div>
        </td>
      </tr>`;
    return;
  }

  tbody.innerHTML = '';
    connections.forEach(conn => {
      const tr = document.createElement('tr');

      const plat = platformDetails[conn.provider] || {};
      const badge = {
        label: conn.providerName || plat.name || conn.provider,
        color: plat.color || 'var(--violet)',
        bg: plat.bg || 'rgba(100,100,250,0.1)',
      };

      const createdDate = conn.createdAt ? new Date(conn.createdAt).toLocaleDateString() : '—';

      tr.innerHTML = `
        <td data-label="Connection Name" style="font-weight: 500;">
          <span class="conn-label-text">${escHtml(conn.label || conn.providerName)}</span>
        </td>
        <td data-label="Provider">
          <span class="conn-badge" style="background: ${badge.bg}; color: ${badge.color};">
            ${badge.label}
          </span>
        </td>
        <td data-label="Created At" style="font-size: 0.82rem; color: var(--text-3);">${createdDate}</td>
        <td data-label="Actions" class="col-actions">
          <div class="row-actions-group">
            <button class="row-action-btn conn-edit-btn" data-id="${conn.id}" type="button" title="Edit Label"><svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
            <button class="row-action-btn conn-delete-btn" data-id="${conn.id}" type="button" title="Delete Connection"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg></button>
          </div>
        </td>
      `;
      tbody.appendChild(tr);
    });

    // Wire edit buttons
    tbody.querySelectorAll('.conn-edit-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        const conn = connections.find(c => c.id === id);
        if (!conn) return;

        const td = btn.closest('tr').querySelector('td[data-label="Connection Name"]');
        const labelSpan = td.querySelector('.conn-label-text');
        const currentLabel = conn.label || conn.providerName;

        const input = document.createElement('input');
        input.type = 'text';
        input.value = currentLabel;
        input.style.cssText = 'background:rgba(255,255,255,0.08);border:1px solid var(--violet);padding:6px 8px;border-radius:6px;color:var(--text-1);width:100%;box-sizing:border-box;font-size:0.9rem;';

        const saveBtn = document.createElement('button');
        saveBtn.innerHTML = '<span class="spin" style="width:12px;height:12px;border-width:1.5px;"></span>';
        saveBtn.style.cssText = 'background:none;border:none;cursor:pointer;color:var(--violet);padding:4px;display:none;';

        td.innerHTML = '';
        td.style.display = 'flex';
        td.style.alignItems = 'center';
        td.style.gap = '6px';
        td.appendChild(input);
        td.appendChild(saveBtn);
        input.focus();
        input.select();

        let saving = false;
        const doSave = async () => {
          if (saving) return;
          const val = input.value.trim();
          if (!val || val === currentLabel) {
            td.innerHTML = `<span class="conn-label-text">${escHtml(currentLabel)}</span>`;
            td.style.display = '';
            return;
          }
          saving = true;
          saveBtn.style.display = '';
          try {
            await updateConnection(id, { label: val });
            await loadConnections();
            renderConnectionsView();
            window.dispatchEvent(new CustomEvent('connections-refreshed'));
            showToast('Label updated', 'success');
          } catch (err) {
            showToast('Failed to update label: ' + err.message, 'error');
            td.innerHTML = `<span class="conn-label-text">${escHtml(currentLabel)}</span>`;
            td.style.display = '';
          }
        };

        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') doSave();
          if (e.key === 'Escape') {
            td.innerHTML = `<span class="conn-label-text">${escHtml(currentLabel)}</span>`;
            td.style.display = '';
          }
        });
        input.addEventListener('blur', () => {
          setTimeout(() => {
            if (!td.contains(document.activeElement)) {
              td.innerHTML = `<span class="conn-label-text">${escHtml(currentLabel)}</span>`;
              td.style.display = '';
            }
          }, 150);
        });
      });
    });

    // Wire delete buttons
    tbody.querySelectorAll('.conn-delete-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const conn = connections.find(c => c.id === id);
        if (!await confirmDialog({
          title: 'Delete Connection?',
          message: `Delete connection "${conn?.label || id}"? This cannot be undone.`,
          confirmText: 'Delete',
          confirmClass: 'btn-danger'
        })) return;
        btn.disabled = true;
        btn.innerHTML = '<span class="spin">⟳</span>';
        try {
          const deletedConn = connections.find(c => c.id === id);
          await deleteConnection(id);
          await loadConnections();
          renderConnectionsView();
          window.dispatchEvent(new CustomEvent('connections-refreshed'));
          showToast('Connection deleted', 'info', {
            actionLabel: 'Undo',
            onAction: async () => {
              if (deletedConn) {
                const { id: delId, ...data } = deletedConn;
                const db = getFirestore(getApp());
                await setDoc(doc(db, 'connected_accounts', delId), data);
                await loadConnections();
                renderConnectionsView();
                window.dispatchEvent(new CustomEvent('connections-refreshed'));
                showToast('Connection restored', 'success');
              }
            }
          });
        } catch (err) {
          showToast('Delete failed: ' + err.message, 'error');
        } finally {
          btn.disabled = false;
          btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>';
        }
      });
    });
}

// Global listener for opening the modal from other views (e.g. Marketplace)
window.addEventListener('open-add-connection', (e) => {
  const provider = e.detail?.provider || null;
  openAddConnectionDialog(provider);
});

async function fetchPlatformSchemas() {
  const db = getDb();
  const snapshot = _platformsCache || await getDocs(collection(db, 'platforms'));
  if (!_platformsCache) _platformsCache = snapshot;
  const platforms = [];
  snapshot.forEach(docSnap => {
    const data = docSnap.data();
    data.id = docSnap.id;
    platforms.push(data);
  });
  return platforms;
}

// ─── Add Connection Dialog ────────────────────────────────────
async function openAddConnectionDialog(presetProvider = null) {
  const existing = document.getElementById('conn-dialog-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'conn-dialog-overlay';
  overlay.style.cssText = [
    'position:fixed;inset:0;z-index:2000;',
    'background:rgba(0,0,0,0.45);backdrop-filter:blur(4px);',
    'display:flex;align-items:center;justify-content:center;'
  ].join('');

  overlay.innerHTML = `<div style="background:var(--bg-2);padding:2rem;border-radius:12px;color:var(--text-1);">Loading providers...</div>`;
  document.body.appendChild(overlay);

  let platforms = [];
  try {
    platforms = await fetchPlatformSchemas();
  } catch(err) {
    overlay.remove();
    showToast('Failed to load platforms', 'error');
    return;
  }

  if (platforms.length === 0) {
    overlay.innerHTML = `<div style="background:var(--bg-2);padding:2rem;border-radius:12px;color:var(--text-1);display:flex;flex-direction:column;gap:16px;">
      <span>No platforms found. Please define platforms in the Admin Panel first.</span>
      <button class="btn btn-secondary" onclick="document.getElementById('conn-dialog-overlay').remove()">Close</button>
    </div>`;
    return;
  }

  const renderDialog = (selectedKey) => {
    const selectedPlatform = platforms.find(p => p.id === selectedKey) || platforms[0];

    overlay.innerHTML = `
      <div class="conn-dialog" style="
        background:var(--bg-2);border-radius:16px;padding:28px;
        width:460px;max-width:calc(100vw - 32px);
        box-shadow:0 20px 60px rgba(0,0,0,0.5);
        display:flex;flex-direction:column;gap:16px;color:var(--text-1);">
        <h3 style="font-size:1.1rem;font-weight:700;margin:0; display:flex; align-items:center; gap:8px;">${feather.icons['plus'].toSvg({width: 18, height: 18})} Add New Connection</h3>
        
        <div class="form-row">
          <label for="conn-provider" style="color:var(--text-2);font-weight:600;font-size:0.9rem;margin-bottom:6px;display:block;">Connection Type *</label>
          <select id="conn-provider" style="color:var(--text-1);color-scheme:dark;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);padding:10px;border-radius:6px;width:100%;">
            ${platforms.map(p => `<option value="${p.id}" ${p.id === selectedPlatform.id ? 'selected' : ''}>${p.name}</option>`).join('')}
          </select>
        </div>

        <div class="form-row" style="margin-top:12px;">
          <label for="conn-label" style="color:var(--text-2);font-weight:600;font-size:0.9rem;margin-bottom:6px;display:block;">Connection Label *</label>
          <input id="conn-label" type="text" placeholder="e.g. My ${selectedPlatform.name}" style="color:var(--text-1);background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);padding:10px;border-radius:6px;width:100%;box-sizing:border-box;" />
        </div>
        
        <div id="conn-dynamic-fields" style="display:flex;flex-direction:column;gap:16px;">
          ${(selectedPlatform.attributes || []).map(attr => {
            const attrId = attr.id || attr.key || attr;
            const attrLabel = attr.label || attr.name || attr;
            const isPassword = attr.type === 'password' || attrLabel.toLowerCase().includes('token') || attrLabel.toLowerCase().includes('secret');
            const requiredMark = attr.required !== false ? ' *' : '';
            return `
              <div class="form-row" style="margin-top:12px;">
                <label for="conn-attr-${attrId}" style="color:var(--text-2);font-weight:600;font-size:0.9rem;margin-bottom:6px;display:block;">${attrLabel}${requiredMark}</label>
                <input id="conn-attr-${attrId}" type="${isPassword ? 'password' : 'text'}" autocomplete="off" style="color:var(--text-1);background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);padding:10px;border-radius:6px;width:100%;box-sizing:border-box;" />
              </div>
            `;
          }).join('')}
          ${selectedPlatform.authType === 'oauth' 
            ? `<div style="padding: 16px; background: rgba(99, 102, 241, 0.1); border-radius: 8px; color: #818cf8; font-size: 0.95rem; text-align: center;">
                 You will be securely redirected to ${selectedPlatform.name} to authorize access.
               </div>`
            : ''}
        </div>

        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;">
          <button class="btn btn-secondary" id="conn-dialog-cancel">Cancel</button>
          <button class="btn btn-primary" id="conn-dialog-save">
            ${selectedPlatform.authType === 'oauth' ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 6px; vertical-align: text-bottom;"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg> Connect to Provider' : `<span>${feather.icons['save'].toSvg({width: 16, height: 16, style: 'vertical-align: middle;'})}</span> Save Connection` }
          </button>
        </div>
      </div>
    `;

    document.getElementById('conn-provider').addEventListener('change', (e) => {
      renderDialog(e.target.value);
    });

    document.getElementById('conn-dialog-cancel').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    document.getElementById('conn-dialog-save').addEventListener('click', async () => {
      const label = document.getElementById('conn-label').value.trim();
      if (!label) { showToast('Label is required', 'error'); return; }

      const payload = { provider: selectedPlatform.id, label, attributes: {} };

      if (selectedPlatform.authType === 'oauth') {
        const encodeBase64 = (str) => btoa(unescape(encodeURIComponent(str)));

        const attrValues = {};
        for (const attr of selectedPlatform.attributes || []) {
          const attrId = attr.id || attr.key || attr;
          const val = document.getElementById(`conn-attr-${attrId}`).value.trim();
          if (val) attrValues[attrId] = val;
        }
        payload.attributes = attrValues;

        const statePayload = encodeBase64(JSON.stringify({ platformId: selectedPlatform.id, label, workspaceId: window.currentWorkspaceId, attributes: attrValues }));
        const redirectUri = window.location.origin + '/auth-callback.html';
        
        const clientId = selectedPlatform.clientId || '';

        const width = 600;
        const height = 700;
        const left = window.screenX + (window.outerWidth - width) / 2;
        const top = window.screenY + (window.outerHeight - height) / 2;
        
        const popupName = 'oauth_popup_' + Date.now();
        const popup = window.open('', popupName, `width=${width},height=${height},left=${left},top=${top},status=no,menubar=no,toolbar=no`);

        const saveBtn = document.getElementById('conn-dialog-save');
        saveBtn.disabled = true;
        saveBtn.innerHTML = '<span class="spin">⟳</span> Waiting for Auth…';

        try {
          if (!selectedPlatform.authUrl) throw new Error("Missing Authorization URL");
          // Read scopes from the form input (user-entered) — treat OAuthScopes as a normal field
          let scopes = '';
          for (const attr of selectedPlatform.attributes || []) {
            const attrId = attr.id || attr.key || attr;
            if (attrId.toLowerCase().includes('scope')) {
              const input = document.getElementById(`conn-attr-${attrId}`);
              if (input) scopes = input.value.trim();
              break;
            }
          }
          const url = new URL(selectedPlatform.authUrl);
          url.searchParams.set('client_id', clientId);
          url.searchParams.set('redirect_uri', redirectUri);
          url.searchParams.set('response_type', 'code');
          if (scopes) url.searchParams.set('scope', scopes);
          url.searchParams.set('state', statePayload);
          url.searchParams.set('access_type', 'offline');

          if (popup) {
            popup.location.href = url.toString();
          }

          if (!popup) {
            showToast('Popup blocked! Please allow popups for this site.', 'error');
            saveBtn.disabled = false;
            saveBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 6px; vertical-align: text-bottom;"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg> Connect to Provider';
            return;
          }

          const messageHandler = async (event) => {
            if (event.origin !== window.location.origin) return;

            if (event.data.type === 'oauth-code') {
              clearInterval(popupCloseCheck);
              window.removeEventListener('message', messageHandler);
              saveBtn.innerHTML = '<span class="spin">⟳</span> Exchanging token…';
              try {
                await exchangeOAuthCode({
                  code: event.data.code,
                  platformId: event.data.platformId,
                  label: event.data.label,
                  workspaceId: event.data.workspaceId,
                  attributes: event.data.attributes
                });
                await loadConnections();
                renderConnectionsView();
                overlay.remove();
                showToast(`${selectedPlatform.name} connection saved`, 'success');
                const newConn = connections.find(
                  c => c.provider === event.data.platformId && c.label === event.data.label
                );
                window.dispatchEvent(new CustomEvent('connections-refreshed', {
                  detail: { newConnectionId: newConn?.id, platformId: event.data.platformId }
                }));
              } catch (err) {
                console.error('[conn-dialog] OAuth exchange failed:', err);
                showToast('Connection failed: ' + err.message, 'error');
                saveBtn.disabled = false;
                saveBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 6px; vertical-align: text-bottom;"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg> Connect to Provider';
              }
            } else if (event.data.type === 'oauth-error') {
              clearInterval(popupCloseCheck);
              window.removeEventListener('message', messageHandler);
              showToast('Connection failed: ' + event.data.error, 'error');
              saveBtn.disabled = false;
              saveBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 6px; vertical-align: text-bottom;"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg> Connect to Provider';
            }
          };

          window.addEventListener('message', messageHandler);

          // Watch for popup close without OAuth completing
          const popupCloseCheck = setInterval(() => {
            if (popup.closed) {
              clearInterval(popupCloseCheck);
              window.removeEventListener('message', messageHandler);
              saveBtn.disabled = false;
              saveBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 6px; vertical-align: text-bottom;"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg> Connect to Provider';
            }
          }, 1000);
        } catch (e) {
          console.error('[conn-dialog] OAuth config error:', e);
          showToast('Invalid OAuth configuration in Admin Panel: ' + e.message, 'error');
          const saveBtn = document.getElementById('conn-dialog-save');
          if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 6px; vertical-align: text-bottom;"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg> Connect to Provider';
          }
        }
        return;
      }

      let missing = false;
      for (const attr of selectedPlatform.attributes || []) {
        const attrId = attr.id || attr.key || attr;
        const isRequired = attr.required !== false;
        const val = document.getElementById(`conn-attr-${attrId}`).value.trim();
        if (isRequired && !val) { missing = true; break; }
        payload.attributes[attrId] = val;
      }

      if (missing) {
        showToast('All required connection attributes must be filled', 'error');
        return;
      }

      const saveBtn = document.getElementById('conn-dialog-save');
      saveBtn.disabled = true;
      saveBtn.innerHTML = '<span class="spin">⟳</span> Saving…';

      try {
        await saveConnection(payload);
        await loadConnections();
        renderConnectionsView();
        overlay.remove();
        showToast(`${selectedPlatform.name} connection saved`, 'success');
        window.dispatchEvent(new CustomEvent('connections-refreshed'));
      } catch (err) {
        showToast('Save failed: ' + err.message, 'error');
        saveBtn.disabled = false;
        saveBtn.innerHTML = `<span>${feather.icons['save'].toSvg({width: 16, height: 16, style: 'vertical-align: middle;'})}</span> Save Connection`;
      }
    });
  };

  const initialProvider = (presetProvider && platforms.some(p => p.id === presetProvider))
    ? presetProvider
    : platforms[0].id;
  renderDialog(initialProvider);
}

// ─── Exchange OAuth code via backend (uses main window's Firebase Auth) ──
async function exchangeOAuthCode({ code, platformId, label, workspaceId, attributes }) {
  const auth = getAuthInstance();
  await auth.authStateReady();
  const user = auth.currentUser;
  if (!user) throw new Error('Not authenticated');
  const idToken = await user.getIdToken();

  const BACKEND_URL = window.VELYNC_CONFIG.apiBase;
  const redirectUri = window.location.origin + '/auth-callback.html';

  const resp = await fetch(`${BACKEND_URL}/oauth/exchange`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${idToken}`
    },
    body: JSON.stringify({ code, platformId, label, workspaceId, redirectUri, attributes })
  });

  const data = await resp.json();
  if (!resp.ok || !data.success) {
    throw new Error(data.error || 'Token exchange failed');
  }
  return data;
}

// ─── Direct OAuth Connect (skip dialog) ───────────────────────
export async function initiateDirectOAuthFlow(platform, label) {
  console.log('[initiateDirectOAuthFlow] platform:', platform?.id, 'name:', platform?.name);

  const encodeBase64 = (str) => btoa(unescape(encodeURIComponent(str)));

  function isOAuthScope(attr) {
    const id = (attr.id || attr.key || '').replace(/\s+/g, '').toLowerCase();
    return id === 'oauthscopes' || id === 'scopes';
  }

  const attrValues = {};
  for (const attr of platform.attributes || []) {
    if (isOAuthScope(attr)) continue;
    const attrId = attr.id || attr.key || attr;
    if (attr.defaultValue) attrValues[attrId] = attr.defaultValue;
  }

  if (!platform.authUrl) {
    console.warn('[initiateDirectOAuthFlow] authUrl missing for', platform.name);
    return false;
  }

  const statePayload = encodeBase64(JSON.stringify({
    platformId: platform.id,
    label,
    workspaceId: window.currentWorkspaceId,
    attributes: attrValues
  }));
  const redirectUri = window.location.origin + '/auth-callback.html';

  const authUrl = platform.authUrl.startsWith('http') ? platform.authUrl : window.location.origin + platform.authUrl;
  const url = new URL(authUrl);
  url.searchParams.set('client_id', platform.clientId || '');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', statePayload);
  url.searchParams.set('access_type', 'offline');

  // Scopes are optional per the OAuth 2.0 spec — the provider uses defaults if omitted.
  const scopesAttr = (platform.attributes || []).find(isOAuthScope);
  if (scopesAttr) {
    const scopes = scopesAttr.label || scopesAttr.name || '';
    if (scopes) url.searchParams.set('scope', scopes);
  }

  const finalUrl = url.toString();

  const width = 600;
  const height = 700;
  const left = window.screenX + (window.outerWidth - width) / 2;
  const top = window.screenY + (window.outerHeight - height) / 2;
  const popupName = 'oauth_popup_' + Date.now();

  const features = `width=${width},height=${height},left=${left},top=${top},status=no,menubar=no,toolbar=no`;
  const popup = window.open(finalUrl, popupName, features);

  if (!popup || popup.closed) {
    showToast('Popup blocked! Please allow popups for this site.', 'error', 5000);
    return false;
  }

  showToast(`Opening ${platform.name} for authorization…`, 'info');

  let messageHandler = async (event) => {
    if (event.origin !== window.location.origin) return;

    if (event.data.type === 'oauth-code') {
      clearInterval(popupCloseCheck);
      window.removeEventListener('message', messageHandler);
      try {
        await exchangeOAuthCode({
          code: event.data.code,
          platformId: event.data.platformId,
          label: event.data.label,
          workspaceId: event.data.workspaceId,
          attributes: event.data.attributes
        });
        await loadConnections();
        renderConnectionsView();
        showToast(`${platform.name} connection saved`, 'success');
        const newConn = connections.find(
          c => c.provider === event.data.platformId && c.label === event.data.label
        );
        window.dispatchEvent(new CustomEvent('connections-refreshed', {
          detail: { newConnectionId: newConn?.id, platformId: event.data.platformId }
        }));
      } catch (err) {
        console.error('[direct-oauth] Exchange failed:', err);
        showToast('Connection failed: ' + err.message, 'error');
        window.dispatchEvent(new CustomEvent('connections-refreshed'));
      }
    } else if (event.data.type === 'oauth-error') {
      clearInterval(popupCloseCheck);
      window.removeEventListener('message', messageHandler);
      showToast('Connection failed: ' + event.data.error, 'error');
      window.dispatchEvent(new CustomEvent('connections-refreshed'));
    }
  };

  window.addEventListener('message', messageHandler);

  // Watch for popup close without OAuth completing
  const popupCloseCheck = setInterval(() => {
    if (popup.closed) {
      clearInterval(popupCloseCheck);
      window.removeEventListener('message', messageHandler);
      window.dispatchEvent(new CustomEvent('connections-refreshed'));
    }
  }, 1000);

  return true;
}

// ─── Utilities ─────────────────────────────────────────────────
function maskSecret(val) {
  if (!val) return '—';
  const s = String(val);
  if (s.length <= 8) return '••••••••';
  return s.slice(0, 4) + '••••' + s.slice(-4);
}

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* =============================================================
   connections.js — Connected OAuth Accounts Hub
   Manages the `connected_accounts` Firestore collection and
   renders the Connections view panel.
   ============================================================= */

import { getFirestore, collection, getDocs, addDoc, deleteDoc, updateDoc, doc, setDoc, query, where, orderBy, limit, startAfter, serverTimestamp }
  from 'https://www.gstatic.com/firebasejs/10.9.0/firebase-firestore.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/10.9.0/firebase-auth.js';
import { getApp } from 'https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js';

import { getSkeletonRowHTML } from './loading-components.js';
import { confirmDialog } from './confirm.js';
import { showToast } from './toast.js';

const PAGE_SIZE = 50;

/** In-memory cache of connections loaded from Firestore */
export let connections = [];

/** Cached platform details (id → { name, color, bg }) for badge rendering */
let platformDetails = {};

/** Shared cache for full platform documents — avoids redundant Firestore reads */
let _platformsCache = null;

/** Pagination state */
let lastVisible = null;
let hasMore = true;

/** Sort state */
let sortField = 'label';
let sortDir = 'asc';

/** Search term */
let searchTerm = '';

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
export async function loadConnections(reset = false) {
  try {
    if (reset) {
      lastVisible = null;
      hasMore = true;
      connections = [];
    }

    const [connSnap, platSnap] = await Promise.all([
      getDocs(query(
        collection(getDb(), 'connected_accounts'),
        where('workspaceId', '==', window.currentWorkspaceId),
        orderBy('createdAt', 'desc'),
        limit(PAGE_SIZE),
        ...(reset || !lastVisible ? [] : [startAfter(lastVisible)])
      )),
      _platformsCache || getDocs(collection(getDb(), 'platforms'))
    ]);

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

    const loaded = connSnap.docs.map(d => {
      const data = d.data();
      return {
        id: d.id,
        ...data,
        providerName: platformDetails[data.provider]?.name || data.provider
      };
    });

    if (reset) {
      connections = loaded;
    } else {
      connections = connections.concat(loaded);
    }

    lastVisible = connSnap.docs.length > 0 ? connSnap.docs[connSnap.docs.length - 1] : null;

    if (connSnap.docs.length < PAGE_SIZE) {
      hasMore = false;
    }

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
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  if (payload.attributes) {
    data.attributes = payload.attributes;
  } else {
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

// ─── Check if connection is in use by any active sync config ──
export async function isConnectionInUse(connId) {
  try {
    const snap = await getDocs(query(
      collection(getDb(), 'workspaces', window.currentWorkspaceId, 'sync_configs'),
      where('platform1ConnectionId', '==', connId)
    ));
    let names = [];
    snap.forEach(d => {
      const data = d.data();
      if (data.status !== 'draft') names.push(data.description || data.id);
    });

    const snap2 = await getDocs(query(
      collection(getDb(), 'workspaces', window.currentWorkspaceId, 'sync_configs'),
      where('platform2ConnectionId', '==', connId)
    ));
    snap2.forEach(d => {
      const data = d.data();
      if (data.status !== 'draft' && !names.includes(data.description || data.id)) {
        names.push(data.description || data.id);
      }
    });

    return names;
  } catch (err) {
    console.warn('[connections] Failed to check in-use:', err);
    return [];
  }
}

// ─── Update a connection ───────────────────────────────────────
export async function updateConnection(id, data) {
  await updateDoc(doc(getDb(), 'connected_accounts', id), {
    ...data,
    updatedAt: serverTimestamp()
  });
}

// ─── Render the Connections view ──────────────────────────────
export function renderConnectionsSkeleton() {
  const tbody = document.getElementById('connections-body');
  if (!tbody) return;
  tbody.innerHTML = '';
  for (let i = 0; i < 4; i++) {
    tbody.insertAdjacentHTML('beforeend', getSkeletonRowHTML(4));
  }
}

function renderErrorState(message, onRetry) {
  const tbody = document.getElementById('connections-body');
  if (!tbody) return;
  tbody.innerHTML = `
    <tr>
      <td colspan="4" style="text-align:center;padding:40px 16px;">
        <div style="color:var(--rose);font-size:0.9rem;margin-bottom:12px;">${escHtml(message)}</div>
        ${onRetry ? `<button class="btn btn-secondary btn-sm" id="conn-retry-btn" style="justify-content:center;gap:6px;">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
          Retry
        </button>` : ''}
      </td>
    </tr>`;
  const retryBtn = document.getElementById('conn-retry-btn');
  if (retryBtn) retryBtn.addEventListener('click', onRetry);
}

export async function renderConnectionsView() {
  const panel = document.getElementById('view-connections');
  if (!panel) return;
  const tbody = document.getElementById('connections-body');
  if (!tbody) return;

  wireToolbar();

  // Apply search filter
  let filtered = applyFilters();

  if (filtered.length === 0 && connections.length === 0 && !hasMore) {
    tbody.innerHTML = `
      <tr class="table-empty-row">
        <td colspan="4">
          <div style="padding: 32px 16px; text-align: center;">
            <div style="font-size: 2.5rem; margin-bottom: 12px; color: var(--violet);">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="color: var(--violet);"><path d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"></path></svg>
            </div>
            <h3 style="margin-bottom: 6px; color: var(--text-1);">${searchTerm ? 'No matching connections' : 'No connections yet'}</h3>
            <p style="color: var(--text-3); font-size: 0.88rem; margin-bottom: 16px;">
              ${searchTerm
                ? `No connections match "${escHtml(searchTerm)}". Try a different search term.`
                : 'Add your API credentials here to reuse them across multiple sync configurations.'}
            </p>
          </div>
        </td>
      </tr>`;
    updateLoadMoreVisibility();
    return;
  }

  if (filtered.length === 0 && connections.length > 0) {
    tbody.innerHTML = `
      <tr class="table-empty-row">
        <td colspan="4">
          <div style="padding: 32px 16px; text-align: center;">
            <p style="color: var(--text-3); font-size: 0.88rem;">No connections match "${escHtml(searchTerm)}". Try a different search term.</p>
          </div>
        </td>
      </tr>`;
    updateLoadMoreVisibility();
    return;
  }

  // Sort
  filtered = applySort(filtered);

  tbody.innerHTML = '';
  filtered.forEach(conn => {
    const tr = document.createElement('tr');

    const plat = platformDetails[conn.provider] || {};
    const badge = {
      label: conn.providerName || plat.name || conn.provider,
      color: plat.color || 'var(--violet)',
      bg: plat.bg || 'rgba(100,100,250,0.1)',
    };

    const createdDate = conn.createdAt
      ? (typeof conn.createdAt === 'object' && conn.createdAt.toDate
        ? conn.createdAt.toDate().toLocaleDateString()
        : new Date(conn.createdAt).toLocaleDateString())
      : '—';

    const moreBtnId = 'conn-more-' + conn.id;
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
        <div class="row-actions-dropdown">
          <button class="row-action-btn btn-row-more" id="${moreBtnId}" data-id="${conn.id}" type="button" title="More actions">⋮</button>
          <div class="row-actions-menu">
            <button class="row-action-menu-item conn-full-edit-btn" data-id="${conn.id}" type="button">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
              Edit Connection
            </button>
            <div class="row-actions-menu-divider"></div>
            <button class="row-action-menu-item conn-delete-btn" data-id="${conn.id}" type="button" style="color:var(--danger);">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
              Delete
            </button>
          </div>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });

  wireDropdownMenus();
  wireFullEditButtons();
  wireDeleteButtons();
  updateLoadMoreVisibility();
}

/* ── Filter & Sort ─────────────────────────────────────────── */

function applyFilters() {
  if (!searchTerm) return [...connections];
  const term = searchTerm.toLowerCase();
  return connections.filter(c =>
    (c.label || '').toLowerCase().includes(term) ||
    (c.providerName || '').toLowerCase().includes(term) ||
    (c.provider || '').toLowerCase().includes(term)
  );
}

function applySort(arr) {
  const sorted = [...arr];
  sorted.sort((a, b) => {
    let va, vb;
    if (sortField === 'label') {
      va = (a.label || a.providerName || '').toLowerCase();
      vb = (b.label || b.providerName || '').toLowerCase();
    } else if (sortField === 'provider') {
      va = (a.providerName || a.provider || '').toLowerCase();
      vb = (b.providerName || b.provider || '').toLowerCase();
    } else if (sortField === 'createdAt') {
      va = a.createdAt?.toDate?.()?.getTime() || new Date(a.createdAt || 0).getTime();
      vb = b.createdAt?.toDate?.()?.getTime() || new Date(b.createdAt || 0).getTime();
    } else {
      return 0;
    }
    if (va < vb) return sortDir === 'asc' ? -1 : 1;
    if (va > vb) return sortDir === 'asc' ? 1 : -1;
    return 0;
  });
  return sorted;
}

/* ── Toolbar ───────────────────────────────────────────────── */

let toolbarWired = false;

function wireToolbar() {
  if (toolbarWired) return;

  // Search
  const searchInput = document.getElementById('conn-search');
  const searchClear = document.getElementById('conn-search-clear');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      if (searchClear) {
        searchClear.style.display = searchInput.value ? 'flex' : 'none';
      }
      clearTimeout(searchInput._timer);
      searchInput._timer = setTimeout(() => {
        searchTerm = searchInput.value.trim();
        renderConnectionsView();
      }, 250);
    });
  }
  if (searchClear) {
    searchClear.addEventListener('click', () => {
      searchInput.value = '';
      searchClear.style.display = 'none';
      searchTerm = '';
      renderConnectionsView();
    });
  }

  // Refresh
  const refreshBtn = document.getElementById('conn-refresh-btn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
      refreshBtn.disabled = true;
      renderConnectionsSkeleton();
      await loadConnections(true);
      await renderConnectionsView();
      refreshBtn.disabled = false;
    });
  }

  // Load More
  const loadMoreBtn = document.getElementById('conn-load-more-btn');
  if (loadMoreBtn) {
    loadMoreBtn.addEventListener('click', async () => {
      if (!hasMore) return;
      loadMoreBtn.disabled = true;
      loadMoreBtn.textContent = 'Loading...';
      await loadConnections(false);
      await renderConnectionsView();
      loadMoreBtn.disabled = false;
      loadMoreBtn.textContent = 'Load More';
    });
  }

  // Sort headers
  document.querySelectorAll('#connections-table th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const field = th.dataset.sort;
      if (sortField === field) {
        sortDir = sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        sortField = field;
        sortDir = 'asc';
      }
      document.querySelectorAll('#connections-table th[data-sort]').forEach(h =>
        h.classList.remove('sort-asc', 'sort-desc')
      );
      th.classList.add(sortDir === 'asc' ? 'sort-asc' : 'sort-desc');
      renderConnectionsView();
    });
  });

  toolbarWired = true;
}

/* ── Wire Dropdown Menus ───────────────────────────────────── */

function wireDropdownMenus() {
  document.querySelectorAll('.btn-row-more').forEach(btn => {
    if (btn.dataset.connWired) return;
    btn.dataset.connWired = 'true';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const menu = btn.parentElement.querySelector('.row-actions-menu');
      if (!menu) return;
      const isOpen = menu.classList.contains('open');
      closeAllConnMenus();
      if (!isOpen) {
        menu.classList.add('open');
        btn.classList.add('open');
      }
    });
  });
}

function closeAllConnMenus() {
  document.querySelectorAll('.row-actions-menu.open').forEach(m => m.classList.remove('open'));
  document.querySelectorAll('.btn-row-more.open').forEach(b => b.classList.remove('open'));
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('.row-actions-dropdown')) {
    closeAllConnMenus();
  }
});

/* ── Wire Full Edit Buttons ────────────────────────────────── */

function wireFullEditButtons() {
  document.querySelectorAll('.conn-full-edit-btn').forEach(btn => {
    if (btn.dataset.fullEditWired) return;
    btn.dataset.fullEditWired = 'true';
    btn.addEventListener('click', () => {
      closeAllConnMenus();
      const id = btn.dataset.id;
      const conn = connections.find(c => c.id === id);
      if (conn) openEditConnectionDialog(conn);
    });
  });
}

/* ── Wire Delete Buttons ───────────────────────────────────── */

function wireDeleteButtons() {
  document.querySelectorAll('.conn-delete-btn').forEach(btn => {
    if (btn.dataset.wired) return;
    btn.dataset.wired = 'true';
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const conn = connections.find(c => c.id === id);

      // Check if in use before delete
      const inUseBy = await isConnectionInUse(id);
      let message = `Delete connection "${conn?.label || id}"? This cannot be undone.`;
      if (inUseBy.length > 0) {
        message = `This connection is used by ${inUseBy.length} active config(s):\n\n${inUseBy.map(n => '• ' + n).join('\n')}\n\nDeleting it will break these integrations. Are you sure?`;
      }

      if (!await confirmDialog({
        title: 'Delete Connection?',
        message,
        confirmText: inUseBy.length > 0 ? 'Delete Anyway' : 'Delete',
        confirmClass: 'btn-danger'
      })) return;

      btn.disabled = true;
      btn.innerHTML = '<div class="spinner" style="width: 16px; height: 16px; border-width: 2px;"></div>';
      try {
        const deletedConn = connections.find(c => c.id === id);
        await deleteConnection(id);
        await loadConnections(true);
        renderConnectionsView();
        window.dispatchEvent(new CustomEvent('connections-refreshed'));
        showToast('Connection deleted', 'info', {
          actionLabel: 'Undo',
          onAction: async () => {
            if (deletedConn) {
              const { id: delId, ...data } = deletedConn;
              const db = getFirestore(getApp());
              data.createdAt = data.createdAt || serverTimestamp();
              data.updatedAt = serverTimestamp();
              await setDoc(doc(db, 'connected_accounts', delId), data);
              await loadConnections(true);
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

/* ── Load More Visibility ──────────────────────────────────── */

function updateLoadMoreVisibility() {
  const loadMoreRow = document.getElementById('conn-load-more-row');
  if (!loadMoreRow) return;
  loadMoreRow.style.display = hasMore ? '' : 'none';
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

  // Filter by workspace plan's connector tiers
  if (window.currentWorkspaceId) {
    try {
      const wsSnap = await getDoc(doc(db, 'workspaces', window.currentWorkspaceId));
      if (wsSnap.exists()) {
        const wsData = wsSnap.data();
        const planId = wsData.planId || 'free';
        const planSnap = await getDoc(doc(db, 'plans', planId));
        if (planSnap.exists()) {
          const planData = planSnap.data();
          const allowedTiers = planData.connectorTiers || ['basic'];
          for (let i = platforms.length - 1; i >= 0; i--) {
            const pTier = platforms[i].tier || 'basic';
            if (!allowedTiers.includes(pTier)) {
              platforms.splice(i, 1);
            }
          }
        }
      }
    } catch (pfErr) {
      console.warn('Failed to filter platforms by plan tier', pfErr);
    }
  }

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

  overlay.innerHTML = `<div style="background:var(--bg-2);padding:2rem;border-radius:12px;color:var(--text-1);"><i data-feather="loader" class="spin" style="width:16px; height:16px; margin-right:8px; vertical-align:middle;"></i>Loading providers...</div>`;
  if (window.feather) feather.replace();
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

      const payload = { provider: selectedPlatform.key || selectedPlatform.id, label, attributes: {} };

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
                await loadConnections(true);
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
        await loadConnections(true);
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

// ─── Edit Connection Dialog ──────────────────────────────────
async function openEditConnectionDialog(conn) {
  const existing = document.getElementById('conn-dialog-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'conn-dialog-overlay';
  overlay.style.cssText = [
    'position:fixed;inset:0;z-index:2000;',
    'background:rgba(0,0,0,0.45);backdrop-filter:blur(4px);',
    'display:flex;align-items:center;justify-content:center;'
  ].join('');

  overlay.innerHTML = `<div style="background:var(--bg-2);padding:2rem;border-radius:12px;color:var(--text-1);"><i data-feather="loader" class="spin" style="width:16px; height:16px; margin-right:8px; vertical-align:middle;"></i>Loading...</div>`;
  if (window.feather) feather.replace();
  document.body.appendChild(overlay);

  let platforms = [];
  try {
    platforms = await fetchPlatformSchemas();
  } catch(err) {
    overlay.remove();
    showToast('Failed to load platforms', 'error');
    return;
  }

  const selectedPlatform = platforms.find(p => p.id === conn.provider || p.key === conn.provider);
  if (!selectedPlatform) {
    overlay.remove();
    showToast('Platform schema not found for this connection', 'error');
    return;
  }

  const hasAttributes = conn.attributes && typeof conn.attributes === 'object';
  const existingAttrs = hasAttributes ? conn.attributes : {};

  overlay.innerHTML = `
    <div class="conn-dialog" style="
      background:var(--bg-2);border-radius:16px;padding:28px;
      width:460px;max-width:calc(100vw - 32px);
      box-shadow:0 20px 60px rgba(0,0,0,0.5);
      display:flex;flex-direction:column;gap:16px;color:var(--text-1);">
      <h3 style="font-size:1.1rem;font-weight:700;margin:0; display:flex; align-items:center; gap:8px;">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        Edit Connection
      </h3>

      <div class="form-row">
        <label for="conn-edit-provider" style="color:var(--text-2);font-weight:600;font-size:0.9rem;margin-bottom:6px;display:block;">Connection Type</label>
        <input id="conn-edit-provider" type="text" value="${escHtml(selectedPlatform.name)}" disabled style="color:var(--text-3);background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);padding:10px;border-radius:6px;width:100%;box-sizing:border-box;opacity:0.7;cursor:not-allowed;" />
      </div>

      <div class="form-row" style="margin-top:12px;">
        <label for="conn-edit-label" style="color:var(--text-2);font-weight:600;font-size:0.9rem;margin-bottom:6px;display:block;">Connection Label *</label>
        <input id="conn-edit-label" type="text" value="${escHtml(conn.label || conn.providerName || '')}" style="color:var(--text-1);background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);padding:10px;border-radius:6px;width:100%;box-sizing:border-box;" />
      </div>

      <div id="conn-edit-dynamic-fields" style="display:flex;flex-direction:column;gap:16px;">
        ${(selectedPlatform.attributes || []).map(attr => {
          const attrId = attr.id || attr.key || attr;
          const attrLabel = attr.label || attr.name || attr;
          const isPassword = attr.type === 'password' || attrLabel.toLowerCase().includes('token') || attrLabel.toLowerCase().includes('secret');
          const currentVal = existingAttrs[attrId] || '';
          const requiredMark = attr.required !== false ? ' *' : '';
          return `
            <div class="form-row" style="margin-top:12px;">
              <label for="conn-edit-attr-${attrId}" style="color:var(--text-2);font-weight:600;font-size:0.9rem;margin-bottom:6px;display:block;">${attrLabel}${requiredMark}</label>
              <input id="conn-edit-attr-${attrId}" type="${isPassword ? 'password' : 'text'}" value="${escHtml(currentVal)}" autocomplete="off" style="color:var(--text-1);background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);padding:10px;border-radius:6px;width:100%;box-sizing:border-box;" />
              ${isPassword && currentVal ? '<div style="font-size:0.75rem;color:var(--text-3);margin-top:4px;">Leave blank to keep current value</div>' : ''}
            </div>
          `;
        }).join('')}
      </div>

      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;">
        <button class="btn btn-secondary" id="conn-edit-dialog-cancel">Cancel</button>
        ${selectedPlatform.authType === 'oauth'
          ? `<button class="btn btn-secondary" id="conn-edit-dialog-save">
               Save Changes
             </button>
             <button class="btn btn-primary" id="conn-edit-dialog-reauth" style="background:var(--violet);">
               <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle; margin-right: 6px;"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>
               Reauthorize with ${selectedPlatform.name}
             </button>`
          : `<button class="btn btn-primary" id="conn-edit-dialog-save" style="background:var(--violet);">
               <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle; margin-right: 6px;"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
               Save Changes
             </button>`
        }
      </div>
    </div>
  `;

  if (window.feather) feather.replace();

  document.getElementById('conn-edit-dialog-cancel').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  // Save handler — updates label + attributes directly
  const saveBtn = document.getElementById('conn-edit-dialog-save');
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      const label = document.getElementById('conn-edit-label').value.trim();
      if (!label) { showToast('Label is required', 'error'); return; }

      const newAttrs = {};
      let hasChanges = false;

      for (const attr of selectedPlatform.attributes || []) {
        const attrId = attr.id || attr.key || attr;
        const val = document.getElementById(`conn-edit-attr-${attrId}`).value.trim();
        if (val !== '') {
          newAttrs[attrId] = val;
          if (val !== (existingAttrs[attrId] || '')) hasChanges = true;
        } else if (existingAttrs[attrId]) {
          newAttrs[attrId] = existingAttrs[attrId];
        }
      }

      if (label === (conn.label || conn.providerName) && !hasChanges) {
        overlay.remove();
        return;
      }

      saveBtn.disabled = true;
      saveBtn.innerHTML = '<span class="spin">⟳</span> Saving…';

      try {
        const updateData = { label };
        if (Object.keys(newAttrs).length > 0) updateData.attributes = newAttrs;
        await updateConnection(conn.id, updateData);
        await loadConnections(true);
        renderConnectionsView();
        overlay.remove();
        showToast(`${selectedPlatform.name} connection updated`, 'success');
        window.dispatchEvent(new CustomEvent('connections-refreshed'));
      } catch (err) {
        showToast('Update failed: ' + err.message, 'error');
        saveBtn.disabled = false;
        saveBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle; margin-right: 6px;"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg> Save Changes';
      }
    });
  }

  // Reauthorize handler — OAuth popup then replace old connection
  const reauthBtn = document.getElementById('conn-edit-dialog-reauth');
  if (reauthBtn) {
    reauthBtn.addEventListener('click', async () => {
      const label = document.getElementById('conn-edit-label').value.trim();
      if (!label) { showToast('Label is required', 'error'); return; }

      const encodeBase64 = (str) => btoa(unescape(encodeURIComponent(str)));
      const attrValues = {};
      for (const attr of selectedPlatform.attributes || []) {
        const attrId = attr.id || attr.key || attr;
        const val = document.getElementById(`conn-edit-attr-${attrId}`).value.trim();
        if (val) attrValues[attrId] = val;
      }

      const statePayload = encodeBase64(JSON.stringify({
        platformId: selectedPlatform.id,
        label,
        workspaceId: window.currentWorkspaceId,
        attributes: attrValues
      }));
      const redirectUri = window.location.origin + '/auth-callback.html';
      const clientId = selectedPlatform.clientId || '';

      const width = 600, height = 700;
      const left = window.screenX + (window.outerWidth - width) / 2;
      const top = window.screenY + (window.outerHeight - height) / 2;
      const popupName = 'oauth_popup_' + Date.now();
      const popup = window.open('', popupName, `width=${width},height=${height},left=${left},top=${top},status=no,menubar=no,toolbar=no`);

      reauthBtn.disabled = true;
      reauthBtn.innerHTML = '<span class="spin">⟳</span> Reauthorizing…';

      try {
        if (!selectedPlatform.authUrl) throw new Error('Missing Authorization URL');
        const url = new URL(selectedPlatform.authUrl);
        url.searchParams.set('client_id', clientId);
        url.searchParams.set('redirect_uri', redirectUri);
        url.searchParams.set('response_type', 'code');
        url.searchParams.set('state', statePayload);
        url.searchParams.set('access_type', 'offline');

        if (popup) popup.location.href = url.toString();

        if (!popup) {
          showToast('Popup blocked! Please allow popups for this site.', 'error');
          reauthBtn.disabled = false;
          reauthBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle; margin-right: 6px;"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg> Reauthorize with ' + selectedPlatform.name;
          return;
        }

        const messageHandler = async (event) => {
          if (event.origin !== window.location.origin) return;

          if (event.data.type === 'oauth-code') {
            clearInterval(popupCloseCheck);
            window.removeEventListener('message', messageHandler);
            reauthBtn.innerHTML = '<span class="spin">⟳</span> Exchanging token…';
            try {
              await exchangeOAuthCode({
                code: event.data.code,
                platformId: event.data.platformId || selectedPlatform.id,
                label,
                workspaceId: window.currentWorkspaceId,
                attributes: attrValues
              });
              // Backend created a new connection — delete the old one
              await deleteConnection(conn.id);
              await loadConnections(true);
              renderConnectionsView();
              overlay.remove();
              showToast(`${selectedPlatform.name} connection reauthorized`, 'success');
              window.dispatchEvent(new CustomEvent('connections-refreshed'));
            } catch (err) {
              console.error('[conn-edit] Reauth failed:', err);
              showToast('Reauthorization failed: ' + err.message, 'error');
              reauthBtn.disabled = false;
              reauthBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle; margin-right: 6px;"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg> Reauthorize with ' + selectedPlatform.name;
            }
          } else if (event.data.type === 'oauth-error') {
            clearInterval(popupCloseCheck);
            window.removeEventListener('message', messageHandler);
            showToast('Reauthorization failed: ' + event.data.error, 'error');
            reauthBtn.disabled = false;
            reauthBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle; margin-right: 6px;"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg> Reauthorize with ' + selectedPlatform.name;
          }
        };

        window.addEventListener('message', messageHandler);

        const popupCloseCheck = setInterval(() => {
          if (popup.closed) {
            clearInterval(popupCloseCheck);
            window.removeEventListener('message', messageHandler);
            reauthBtn.disabled = false;
            reauthBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle; margin-right: 6px;"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg> Reauthorize with ' + selectedPlatform.name;
          }
        }, 1000);
      } catch (e) {
        console.error('[conn-edit] OAuth config error:', e);
        showToast('Invalid OAuth configuration: ' + e.message, 'error');
        reauthBtn.disabled = false;
        reauthBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle; margin-right: 6px;"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg> Reauthorize with ' + selectedPlatform.name;
      }
    });
  }
}

// ─── Exchange OAuth code via backend ──
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
        await loadConnections(true);
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
function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

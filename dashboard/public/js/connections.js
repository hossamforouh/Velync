/* =============================================================
   connections.js — Connected OAuth Accounts Hub
   Manages the `connected_accounts` Firestore collection and
   renders the Connections view panel.
   ============================================================= */

import { getFirestore, collection, getDocs, query, where, orderBy, limit, startAfter }
  from 'https://www.gstatic.com/firebasejs/10.9.0/firebase-firestore.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/10.9.0/firebase-auth.js';
import { getApp } from 'https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js';

import { getSkeletonRowHTML, setButtonLoading } from './loading-components.js';
import { confirmDialog } from './confirm.js';
import { showToast } from './toast.js';

const PAGE_SIZE = 50;

/** In-memory cache of connections loaded from Firestore */
export let connections = [];

/** Cached platform details (id → { name, color, bg }) for badge rendering */
let platformDetails = {};

/** Shared cache of platform docs (plain array of {id, ...data}) — avoids
 * redundant GET /api/platforms calls across the page's lifetime. */
let _platformsCache = null;
async function fetchPlatformsCached() {
  if (!_platformsCache) _platformsCache = await apiRequest('/api/platforms').then(d => d.platforms);
  return _platformsCache;
}

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

// ─── Backend API helper ────────────────────────────────────────
// Connection create/update/delete go through backend routes — secrets are
// encrypted server-side into `credentials`, never written in plaintext from
// the browser (the Firestore write rule for connected_accounts is `if false`).
async function apiRequest(path, options = {}) {
  const user = getAuthInstance().currentUser;
  const token = user ? await user.getIdToken() : null;
  const res = await fetch(`${window.VELYNC_CONFIG.apiBase}${path}`, {
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

// ─── Load connections from Firestore ──────────────────────────
export async function loadConnections(reset = false) {
  try {
    if (reset) {
      lastVisible = null;
      hasMore = true;
      connections = [];
    }

    const [connSnap, platforms] = await Promise.all([
      getDocs(query(
        collection(getDb(), 'connected_accounts'),
        where('workspaceId', '==', window.currentWorkspaceId),
        orderBy('createdAt', 'desc'),
        limit(PAGE_SIZE),
        ...(reset || !lastVisible ? [] : [startAfter(lastVisible)])
      )),
      fetchPlatformsCached(),
    ]);

    platformDetails = {};
    let colorIdx = 0;
    platforms.forEach(p => {
      const fallback = FALLBACK_COLORS[colorIdx % FALLBACK_COLORS.length];
      colorIdx++;
      platformDetails[p.id] = {
        name: p.name || p.id,
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
  return apiRequest('/api/connections', {
    method: 'POST',
    body: JSON.stringify({
      provider: payload.provider,
      label: payload.label || payload.provider,
      attributes: payload.attributes || {},
      workspaceId: window.currentWorkspaceId,
    }),
  });
}

// ─── Delete a connection ───────────────────────────────────────
export async function deleteConnection(id) {
  return apiRequest(`/api/connections/${id}`, { method: 'DELETE' });
}

// ─── Check if connection is in use by any active sync config ──
// Throws on failure rather than silently returning [] — a caller treating a
// failed check as "not in use" would let a delete proceed without ever
// having actually verified that, which is the wrong failure mode for a
// destructive action.
export async function isConnectionInUse(connId) {
  const { items } = await apiRequest(`/api/sync-configs?connectionId=${encodeURIComponent(connId)}`);
  let names = [];
  items.forEach(data => {
    if (data.status !== 'draft' && !names.includes(data.description || data.id)) {
      names.push(data.description || data.id);
    }
  });
  return names;
}

// ─── Update a connection ───────────────────────────────────────
export async function updateConnection(id, data) {
  return apiRequest(`/api/connections/${id}`, { method: 'PUT', body: JSON.stringify(data) });
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
    const needsReauthBadge = conn.needsReauth
      ? `<div class="conn-reauth-badge" title="${escHtml(conn.reauthReason || 'This connection needs to be reauthorized.')}" style="display:flex;align-items:center;gap:4px;margin-top:4px;color:var(--rose, #f87171);font-size:0.75rem;font-weight:500;cursor:pointer;">
           <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
           Needs Reconnection
         </div>`
      : '';
    tr.innerHTML = `
      <td data-label="Connection Name" style="font-weight: 500;">
        <span class="conn-label-text">${escHtml(conn.label || conn.providerName)}</span>
        ${needsReauthBadge}
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
    const reauthBadgeEl = tr.querySelector('.conn-reauth-badge');
    if (reauthBadgeEl) {
      reauthBadgeEl.addEventListener('click', (e) => {
        e.stopPropagation();
        openEditConnectionDialog(conn);
      });
    }
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

  // New Connection — opens the same Add Connection dialog used elsewhere
  // (e.g. from the sync-config wizard), never wired to this page's own button.
  const addBtn = document.getElementById('btn-add-conn');
  if (addBtn) {
    addBtn.addEventListener('click', () => openAddConnectionDialog(null));
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
      setButtonLoading(loadMoreBtn, true, 'Load More', 'Loading...');
      await loadConnections(false);
      await renderConnectionsView();
      setButtonLoading(loadMoreBtn, false, 'Load More');
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

// Menus are `position: absolute` by default (see .row-actions-menu in
// style.css), which gets clipped by the table's own scroll boundary for
// rows near the bottom — same root cause app.js's Flows table already
// fixed for its own row-actions menu (switch to `position: fixed`,
// computed from the button's rect, flipping upward when there's no room
// below). Mirrored here rather than left un-fixed on this page too.
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
        positionConnMenu(btn, menu);
        menu.classList.add('open');
        btn.classList.add('open');
      }
    });
  });
}

function positionConnMenu(btn, menu) {
  const btnRect = btn.getBoundingClientRect();
  const wrapper = document.getElementById('conn-grid-table-wrapper');
  const wrapperRect = wrapper ? wrapper.getBoundingClientRect() : { right: window.innerWidth };
  const menuWidth = menu.offsetWidth || 180;
  const menuHeight = menu.offsetHeight || 100;
  const left = Math.max(0, Math.min(btnRect.right - menuWidth, wrapperRect.right - menuWidth));
  const spaceBelow = window.innerHeight - btnRect.bottom - 4;

  menu.style.position = 'fixed';
  menu.style.left = left + 'px';
  if (spaceBelow >= menuHeight) {
    menu.style.top = btnRect.bottom + 4 + 'px';
    menu.style.bottom = 'auto';
  } else {
    menu.style.top = 'auto';
    menu.style.bottom = window.innerHeight - btnRect.top + 4 + 'px';
  }
}

function resetConnMenuPosition(menu) {
  menu.style.position = '';
  menu.style.left = '';
  menu.style.top = '';
  menu.style.bottom = '';
}

function closeAllConnMenus() {
  document.querySelectorAll('.row-actions-menu.open').forEach(m => { m.classList.remove('open'); resetConnMenuPosition(m); });
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

      // Check if in use before delete — if the check itself fails, block the
      // delete rather than silently proceeding as if it were unused.
      let inUseBy;
      try {
        inUseBy = await isConnectionInUse(id);
      } catch (err) {
        showToast('Could not verify whether this connection is in use — delete cancelled. Please try again.', 'error');
        return;
      }
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

      // Capture the full original markup (icon + "Delete" label) so it can be
      // restored exactly on failure — a previous version of this handler
      // hardcoded the restore to just the icon, silently dropping the
      // "Delete" text label from the menu item after any failed delete.
      const originalHtml = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '<span class="btn-spinner" style="margin-right: 6px;"></span> Deleting...';
      try {
        const { deletedData } = await deleteConnection(id);
        await loadConnections(true);
        renderConnectionsView();
        window.dispatchEvent(new CustomEvent('connections-refreshed'));
        showToast('Connection deleted', 'info', {
          actionLabel: 'Undo',
          onAction: async () => {
            if (deletedData) {
              await apiRequest(`/api/connections/${id}/restore`, {
                method: 'POST',
                body: JSON.stringify(deletedData),
              });
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
        btn.innerHTML = originalHtml;
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
  const platforms = (await fetchPlatformsCached()).map(p => ({ ...p }));

  // Filter by workspace plan's connector tiers. GET /workspace/:id/plan
  // (not GET /billing/plan) since window.currentWorkspaceId can be a
  // workspace other than the caller's own (the "God Mode" workspace
  // switcher for superadmins).
  if (window.currentWorkspaceId) {
    try {
      const planData = await apiRequest(`/api/workspace/${window.currentWorkspaceId}/plan`).then(d => d.plan);
      const allowedTiers = planData.connectorTiers || ['basic'];
      for (let i = platforms.length - 1; i >= 0; i--) {
        const pTier = platforms[i].tier || 'basic';
        if (!allowedTiers.includes(pTier)) {
          platforms.splice(i, 1);
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
  overlay.className = 'conn-dialog-overlay';

  overlay.innerHTML = `<div class="conn-dialog-loading"><i data-feather="loader" class="spin" style="width:16px; height:16px; margin-right:8px; vertical-align:middle;"></i>Loading providers...</div>`;
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
    overlay.innerHTML = `<div class="conn-dialog-empty">
      <span>No platforms found. Please define platforms in the Admin Panel first.</span>
      <button class="btn btn-secondary" onclick="document.getElementById('conn-dialog-overlay').remove()">Close</button>
    </div>`;
    return;
  }

  const renderDialog = (selectedKey) => {
    const selectedPlatform = platforms.find(p => p.id === selectedKey) || platforms[0];

    overlay.innerHTML = `
      <div class="conn-dialog">
        <h3>${feather.icons['plus'].toSvg({width: 18, height: 18})} Add New Connection</h3>

        <div class="form-row" style="margin-top:0;">
          <label for="conn-provider">Connection Type *</label>
          <select id="conn-provider">
            ${platforms.map(p => `<option value="${p.id}" ${p.id === selectedPlatform.id ? 'selected' : ''}>${p.name}</option>`).join('')}
          </select>
        </div>

        <div class="form-row">
          <label for="conn-label">Connection Label *</label>
          <input id="conn-label" type="text" placeholder="e.g. My ${selectedPlatform.name}" />
        </div>

        <div id="conn-dynamic-fields" style="display:flex;flex-direction:column;gap:16px;">
          ${(selectedPlatform.attributes || []).map(attr => {
            const attrId = attr.id || attr.key || attr;
            const attrLabel = attr.label || attr.name || attr;
            const isPassword = attr.type === 'password' || attrLabel.toLowerCase().includes('token') || attrLabel.toLowerCase().includes('secret');
            const requiredMark = attr.required !== false ? ' *' : '';
            return `
              <div class="form-row">
                <label for="conn-attr-${attrId}">${attrLabel}${requiredMark}</label>
                <input id="conn-attr-${attrId}" type="${isPassword ? 'password' : 'text'}" autocomplete="off" />
              </div>
            `;
          }).join('')}
          ${selectedPlatform.authType === 'oauth'
            ? `<div class="conn-dialog-oauth-note">
                 You will be securely redirected to ${selectedPlatform.name} to authorize access.
               </div>`
            : ''}
        </div>

        <div class="conn-dialog-actions">
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

      const providerId = selectedPlatform.key || selectedPlatform.id;
      const existingCount = connections.filter(c => c.provider === providerId).length;
      if (existingCount > 0) {
        const proceed = await confirmDialog({
          title: 'Duplicate Connection?',
          message: `You already have ${existingCount} connection(s) to ${selectedPlatform.name}. Adding another can be confusing to tell apart later — continue anyway?`,
          confirmText: 'Add Anyway',
        });
        if (!proceed) return;
      }

      const payload = { provider: providerId, label, attributes: {} };

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
  overlay.className = 'conn-dialog-overlay';

  overlay.innerHTML = `<div class="conn-dialog-loading"><i data-feather="loader" class="spin" style="width:16px; height:16px; margin-right:8px; vertical-align:middle;"></i>Loading...</div>`;
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
    <div class="conn-dialog">
      <h3>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        Edit Connection
      </h3>

      <div class="form-row" style="margin-top:0;">
        <label for="conn-edit-provider">Connection Type</label>
        <input id="conn-edit-provider" type="text" value="${escHtml(selectedPlatform.name)}" disabled />
      </div>

      <div class="form-row">
        <label for="conn-edit-label">Connection Label *</label>
        <input id="conn-edit-label" type="text" value="${escHtml(conn.label || conn.providerName || '')}" />
      </div>

      <div id="conn-edit-dynamic-fields" style="display:flex;flex-direction:column;gap:16px;">
        ${(selectedPlatform.attributes || []).map(attr => {
          const attrId = attr.id || attr.key || attr;
          const attrLabel = attr.label || attr.name || attr;
          const isPassword = attr.type === 'password' || attrLabel.toLowerCase().includes('token') || attrLabel.toLowerCase().includes('secret');
          const currentVal = existingAttrs[attrId] || '';
          const requiredMark = attr.required !== false ? ' *' : '';
          // Attribute values live encrypted server-side and are never sent
          // back to the client, so this always renders blank on edit — that's
          // expected, not a missing value.
          return `
            <div class="form-row">
              <label for="conn-edit-attr-${attrId}">${attrLabel}${requiredMark}</label>
              <input id="conn-edit-attr-${attrId}" type="${isPassword ? 'password' : 'text'}" value="${escHtml(currentVal)}" autocomplete="off" />
              ${isPassword ? '<div class="form-row-hint">Leave blank to keep current value</div>' : ''}
            </div>
          `;
        }).join('')}
      </div>

      <div class="conn-dialog-actions">
        <button class="btn btn-secondary" id="conn-edit-dialog-cancel">Cancel</button>
        ${selectedPlatform.authType === 'oauth'
          ? `<button class="btn btn-secondary" id="conn-edit-dialog-save">
               Save Changes
             </button>
             <button class="btn btn-primary" id="conn-edit-dialog-reauth">
               <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle; margin-right: 6px;"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>
               Reauthorize with ${selectedPlatform.name}
             </button>`
          : `<button class="btn btn-primary" id="conn-edit-dialog-save">
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
        // Tagged with platformId + failed so a listener waiting on THIS
        // specific attempt (see integration-setup.js's
        // waitForSetupConnectionRefresh) can tell this apart from the many
        // OTHER unrelated actions that dispatch this same generic event
        // (delete, edit, reauth, etc.) — a bare untagged dispatch here used
        // to get misread as "this attempt failed" by any such listener.
        window.dispatchEvent(new CustomEvent('connections-refreshed', { detail: { platformId: platform.id, failed: true } }));
      }
    } else if (event.data.type === 'oauth-error') {
      clearInterval(popupCloseCheck);
      window.removeEventListener('message', messageHandler);
      showToast('Connection failed: ' + event.data.error, 'error');
      window.dispatchEvent(new CustomEvent('connections-refreshed', { detail: { platformId: platform.id, failed: true } }));
    }
  };

  window.addEventListener('message', messageHandler);

  const popupCloseCheck = setInterval(() => {
    if (popup.closed) {
      clearInterval(popupCloseCheck);
      window.removeEventListener('message', messageHandler);
      window.dispatchEvent(new CustomEvent('connections-refreshed', { detail: { platformId: platform.id, failed: true } }));
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

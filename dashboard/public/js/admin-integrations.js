import { collection, collectionGroup, onSnapshot, query, orderBy, where, getDocs, limit, startAfter } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-firestore.js";
import { getSkeletonTableHTML, getEmptySpinnerHTML, getEmptyStateRowHTML, setButtonLoading } from './loading-components.js';
import { showToast } from './toast.js';
import { confirmDialog } from './confirm.js';

let firestoreDb = null;
let authInstance = null;

// Integration create/edit/delete goes through backend routes (not direct
// Firestore writes — the `integrations` collection's write rule is `if false`).
// The backend also handles audit logging server-side now.
async function apiRequest(path, options = {}) {
  const token = authInstance && authInstance.currentUser ? await authInstance.currentUser.getIdToken() : null;
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

let allIntegrationsCache = [];
let searchTerm = '';
let adminIntegrationsWired = false;

// Pagination state
const INT_PAGE_SIZE = 50;
let intLastVisible = null;
let intHasMore = false;
let intLoading = false;

// Sort state
let intSortColumn = 'name';
let intSortDirection = 'asc';

// Bulk state
let intSelectedIds = new Set();

// Admin view cache (per-tab, 60s TTL)
const _viewCache = {};
const _VIEW_CACHE_TTL = 60000;

function _getCached(viewName) {
  const entry = _viewCache[viewName];
  if (entry && Date.now() - entry.time < _VIEW_CACHE_TTL) return entry.data;
  delete _viewCache[viewName];
  return null;
}

function _setCached(viewName, data) {
  _viewCache[viewName] = { data, time: Date.now() };
}

function _invalidateCache(viewName) {
  delete _viewCache[viewName];
}

// Platform cache (for dropdowns — loaded separately)
let cachedPlatforms = [];

// Module-level references to closured functions (set by initAdminIntegrations)
let _openModal = null;
let _closeModal = null;

let _platformsUnsub = null;

export function initAdminIntegrations(db, auth) {
  firestoreDb = db;
  authInstance = auth;

  // Unsubscribe any previous listener (cleanup on re-init)
  if (_platformsUnsub) { _platformsUnsub(); _platformsUnsub = null; }

  // Platforms listener (for dropdowns — kept as onSnapshot since it's small)
  _platformsUnsub = onSnapshot(
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

      // Map pane ID to cache key
      const cacheKey = targetId === 'admin-pane-overview' ? 'overview'
        : targetId === 'admin-pane-marketplace' ? 'marketplace'
        : targetId === 'admin-pane-activity' ? 'activity'
        : null;

      const cached = cacheKey ? _getCached(cacheKey) : null;
      if (cached) {
        if (cacheKey === 'overview') {
          _overviewCache = cached;
          renderOverviewFromCache();
        } else if (cacheKey === 'marketplace') {
          allIntegrationsCache = cached;
          renderAdminTable();
        }
        return;
      }

      if (targetId === 'admin-pane-marketplace') {
        loadIntegrationsPage(true);
      } else if (targetId === 'admin-pane-overview') {
        loadAdminOverview();
      } else if (targetId === 'admin-pane-activity') {
        loadActivityLog(true);
      } else if (targetId === 'admin-pane-platforms') {
        // platforms are loaded by admin-platforms.js
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

  _openModal = function(integration = null) {
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
  };

  _closeModal = function() {
    sidePanel.classList.remove('open');
    modalOverlay.classList.remove('open');
    setTimeout(() => {
      form.reset();
      const fe = document.getElementById('form-error-message');
      if (fe) fe.style.display = 'none';
    }, 300);
  };

  btnAdd.addEventListener('click', () => _openModal(null));
  btnClose.addEventListener('click', _closeModal);
  btnCancel.addEventListener('click', _closeModal);
  modalOverlay.addEventListener('click', _closeModal);

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
        await apiRequest(`/api/admin/integrations/${docId}`, { method: 'PUT', body: JSON.stringify(integrationData) });
      } else {
        await apiRequest('/api/admin/integrations', { method: 'POST', body: JSON.stringify(integrationData) });
      }

      const fe = document.getElementById('form-error-message');
      if (fe) fe.style.display = 'none';
      _closeModal();
      loadIntegrationsPage(true);
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

  // Wire admin search, sorting, bulk, refresh, load more
  wireAdminControls();

  // Trigger load for the currently active tab
  const activeTab = document.querySelector('.admin-tab.active');
  if (activeTab) {
    activeTab.click();
  }
}

// ─── Overview Stats ──────────────────────────────────────────

let _overviewCache = null;
let _overviewCacheTime = 0;
const OVERVIEW_CACHE_TTL = 60000; // 1 minute

async function loadAdminOverview() {
  const root = document.getElementById('admin-overview-content');
  if (!root) return;

  // Use cache if fresh
  if (_overviewCache && Date.now() - _overviewCacheTime < OVERVIEW_CACHE_TTL) {
    renderOverviewFromCache();
    return;
  }

  // Show loading state
  setOverviewLoading(true);

  try {
    // Server-side aggregation (cached, shared across admins) — replaces the old
    // client-side reads of the whole users/connected_accounts/sync_configs collections.
    const token = await authInstance.currentUser.getIdToken();
    const res = await fetch('/api/admin/overview', {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(e.error || `Request failed (${res.status})`);
    }
    const data = await res.json();
    // Stale-config timestamps arrive as ISO strings — timeAgo() needs Date objects.
    data.staleConfigs = (data.staleConfigs || []).map(s => ({
      ...s, lastRun: s.lastRun ? new Date(s.lastRun) : null,
    }));

    _overviewCache = data;
    _overviewCacheTime = Date.now();
    _setCached('overview', _overviewCache);

    renderOverviewFromCache();
  } catch (err) {
    console.error("Failed to load overview stats:", err);
    setOverviewError(err.message);
  } finally {
    setOverviewLoading(false);
  }
}

const OVERVIEW_MINI_PANEL_IDS = [
  'admin-platform-popularity', 'admin-top-errors', 'admin-connections-dist',
  'admin-stale-configs', 'admin-daily-volume',
];

function setOverviewLoading(loading) {
  if (loading) {
    document.querySelectorAll('#admin-overview-content [data-stat]').forEach(el => {
      el.textContent = '…';
    });
    // These 5 mini-panels otherwise sit on index.html's static "Loading..."
    // text for however long the overview fetch takes, with no shimmer.
    OVERVIEW_MINI_PANEL_IDS.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = getEmptySpinnerHTML('Loading...');
    });
  }
}

function setOverviewError(msg) {
  const root = document.getElementById('admin-overview-content');
  if (!root) return;
  root.innerHTML = `<div style="text-align:center;padding:40px;color:var(--rose);">
    <p>Failed to load overview: ${escHtml(msg)}</p>
    <button class="btn btn-primary btn-sm" onclick="loadAdminOverview()" style="margin-top:12px;">Retry</button>
  </div>`;
}

function renderOverviewFromCache() {
  const c = _overviewCache;
  if (!c) return;

  setText('admin-stat-users', c.totalUsers);
  setText('admin-stat-configs', c.totalConfigs);
  setText('admin-stat-active', c.activeCount);
  setText('admin-stat-paused', c.pausedCount);
  setText('admin-stat-draft', c.draftCount);
  setText('admin-stat-24h-syncs', c.total24h);
  setText('admin-stat-success-rate', c.successRate === '—' ? '—' : c.successRate + '%');
  setText('admin-stat-24h-errors', c.failed24h);
  setText('admin-stat-7d-volume', c.total7dVolume.toLocaleString());
  setText('admin-stat-stale', c.staleConfigs.length);

  // Platform popularity
  renderPlatformPopularity(c.platEntries, c.maxPlatCount);

  // Top errors
  renderTopErrors(c.topErrors);

  // Connections distribution
  renderConnDist(c.connDist);

  // Stale configs
  renderStaleConfigs(c.staleConfigs);

  // Daily volume
  renderDailyVolume(c.dailyVolume);
}

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val ?? '—';
}

function renderPlatformPopularity(entries, maxCount) {
  const container = document.getElementById('admin-platform-popularity');
  if (!container) return;
  if (entries.length === 0) {
    container.innerHTML = '<span style="color:var(--text-3);font-size:0.9rem;">No platforms in use yet.</span>';
    return;
  }
  container.innerHTML = entries.map(p => `
    <div class="plat-bar-wrap">
      <span class="plat-bar-label">${escHtml(p.name)}</span>
      <div class="plat-bar-track">
        <div class="plat-bar-fill" style="width:${(p.count / maxCount * 100).toFixed(0)}%;"></div>
      </div>
      <span class="plat-bar-count">${p.count}</span>
    </div>
  `).join('');
}

function renderTopErrors(errors) {
  const container = document.getElementById('admin-top-errors');
  if (!container) return;
  if (errors.length === 0) {
    container.innerHTML = '<span style="color:var(--text-3);font-size:0.9rem;">No errors in the last 24h.</span>';
    return;
  }
  container.innerHTML = errors.map(([err, count], i) => `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;padding:6px 0;border-bottom:${i < errors.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none'};gap:12px;">
      <span style="font-size:0.82rem;color:var(--text-2);flex:1;word-break:break-word;">${escHtml(err)}</span>
      <span class="badge badge-danger" style="white-space:nowrap;flex-shrink:0;">${count}</span>
    </div>
  `).join('');
}

function renderConnDist(dist) {
  const container = document.getElementById('admin-connections-dist');
  if (!container) return;
  const keys = Object.keys(dist).sort((a, b) => {
    if (a === '10+') return 1;
    if (b === '10+') return -1;
    return parseInt(a) - parseInt(b);
  });
  if (keys.length === 0) {
    container.innerHTML = '<span style="color:var(--text-3);font-size:0.9rem;">No connections found.</span>';
    return;
  }
  const maxVal = Math.max(...keys.map(k => dist[k]), 1);
  container.innerHTML = keys.map(k => `
    <div class="plat-bar-wrap" style="margin-bottom:4px;">
      <span class="plat-bar-label" style="width:60px;">${k} conn</span>
      <div class="plat-bar-track" style="height:18px;">
        <div class="plat-bar-fill" style="width:${(dist[k] / maxVal * 100).toFixed(0)}%;background:linear-gradient(90deg,#f59e0b,#ef4444);"></div>
      </div>
      <span class="plat-bar-count">${dist[k]}</span>
    </div>
  `).join('');
}

function renderStaleConfigs(configs) {
  const container = document.getElementById('admin-stale-configs');
  if (!container) return;
  if (configs.length === 0) {
    container.innerHTML = '<span style="color:var(--text-3);font-size:0.9rem;">No stale configs. All active configs have synced within 7 days.</span>';
    return;
  }
  container.innerHTML = configs.slice(0, 20).map(c => `
    <div class="stale-item">
      <span><strong>${escHtml(c.name)}</strong> <span style="color:var(--text-3);font-size:0.82rem;">by ${escHtml(c.ownerName)}</span></span>
      <span style="color:var(--rose);font-size:0.82rem;">${c.lastRun ? 'Last: ' + timeAgo(c.lastRun) : 'Never run'}</span>
    </div>
  `).join('');
  if (configs.length > 20) {
    container.innerHTML += `<div style="padding:8px 0;text-align:center;color:var(--text-3);font-size:0.82rem;">… and ${configs.length - 20} more</div>`;
  }
}

function renderDailyVolume(volume) {
  const container = document.getElementById('admin-daily-volume');
  if (!container) return;
  const days = Object.keys(volume).sort().reverse();
  if (days.length === 0) {
    container.innerHTML = '<span style="color:var(--text-3);font-size:0.9rem;">No syncs in the last 7 days.</span>';
    return;
  }
  const maxVol = Math.max(...days.map(d => volume[d]), 1);
  container.innerHTML = days.map(d => `
    <div class="plat-bar-wrap" style="margin-bottom:4px;">
      <span class="plat-bar-label" style="width:100px;">${d}</span>
      <div class="plat-bar-track" style="height:18px;">
        <div class="plat-bar-fill" style="width:${(volume[d] / maxVol * 100).toFixed(0)}%;background:linear-gradient(90deg,#34d399,#06b6d4);"></div>
      </div>
      <span class="plat-bar-count">${volume[d].toLocaleString()}</span>
    </div>
  `).join('');
}

function timeAgo(date) {
  const diff = Date.now() - date.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// Expose for retry button
window.loadAdminOverview = loadAdminOverview;

// ─── Paginated Load ──────────────────────────────────────────

async function loadIntegrationsPage(reset = false) {
  if (intLoading) return;
  intLoading = true;

  const tbody = document.getElementById('admin-integrations-tbody');
  if (!tbody) { intLoading = false; return; }

  if (reset) {
    intLastVisible = null;
    intHasMore = false;
    allIntegrationsCache = [];
    intSelectedIds.clear();
    updateBulkDeleteBtn();
    tbody.innerHTML = getSkeletonTableHTML(4, 7);
  }

  try {
    let q = query(
      collection(firestoreDb, 'integrations'),
      orderBy('name'),
      limit(INT_PAGE_SIZE)
    );
    if (intLastVisible) {
      q = query(q, startAfter(intLastVisible));
    }

    const snap = await getDocs(q);
    snap.forEach(docSnap => {
      allIntegrationsCache.push({ ...docSnap.data(), _id: docSnap.id });
    });

    intLastVisible = snap.docs[snap.docs.length - 1] || null;
    intHasMore = snap.docs.length === INT_PAGE_SIZE;
    _setCached('marketplace', allIntegrationsCache);
    renderAdminTable();
  } catch (err) {
    console.warn('[admin-integrations] Load error:', err);
    if (!navigator.onLine) return;
    showToast('Failed to load integrations', 'error');
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:20px;color:var(--rose);">Failed to load. <a href="#" onclick="location.reload()" style="color:var(--violet);">Reload</a></td></tr>';
  } finally {
    intLoading = false;
  }
}

// ─── Admin Controls (search, sort, bulk, refresh, load more) ─

function wireAdminControls() {
  if (adminIntegrationsWired) return;
  adminIntegrationsWired = true;

  // Search
  const searchInput = document.getElementById('admin-int-search');
  const searchClear = document.getElementById('admin-int-search-clear');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      if (searchClear) searchClear.style.display = searchInput.value ? 'flex' : 'none';
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

  // Sortable headers
  document.querySelectorAll('#admin-int-table thead th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.sort;
      if (intSortColumn === col) {
        intSortDirection = intSortDirection === 'asc' ? 'desc' : 'asc';
      } else {
        intSortColumn = col;
        intSortDirection = 'asc';
      }
      renderAdminTable();
    });
  });

  // Select all
  const selectAll = document.getElementById('admin-int-select-all');
  if (selectAll) {
    selectAll.addEventListener('change', () => {
      const visible = getFilteredIntegrations();
      if (selectAll.checked) {
        visible.forEach(i => intSelectedIds.add(i._id));
      } else {
        visible.forEach(i => intSelectedIds.delete(i._id));
      }
      renderAdminTable();
      updateBulkDeleteBtn();
    });
  }

  // Bulk delete
  const bulkDeleteBtn = document.getElementById('admin-int-bulk-delete-btn');
  if (bulkDeleteBtn) {
    bulkDeleteBtn.addEventListener('click', async () => {
      const ids = Array.from(intSelectedIds);
      if (ids.length === 0) return;
      const ok = await confirmDialog({
        title: 'Delete integrations?',
        message: `Delete ${ids.length} integration(s)? This cannot be undone.`,
        confirmText: 'Delete',
      });
      if (!ok) return;

      setButtonLoading(bulkDeleteBtn, true, 'Delete Selected', 'Deleting…');
      let success = 0;
      for (const id of ids) {
        try {
          await apiRequest(`/api/admin/integrations/${id}`, { method: 'DELETE' });
          success++;
        } catch (err) {
          console.warn(`Failed to delete ${id}:`, err);
        }
      }
      setButtonLoading(bulkDeleteBtn, false);
      intSelectedIds.clear();
      updateBulkDeleteBtn();
      showToast(
        success === ids.length ? `Deleted ${success} integration(s)` : `Deleted ${success} of ${ids.length} — ${ids.length - success} failed`,
        success === ids.length ? 'success' : 'error'
      );
      loadIntegrationsPage(true);
    });
  }

  // Refresh
  const refreshBtn = document.getElementById('admin-int-refresh-btn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
      _invalidateCache('marketplace');
      _invalidateCache('overview');
      _invalidateCache('activity');
      refreshBtn.disabled = true;
      await loadIntegrationsPage(true);
      refreshBtn.disabled = false;
    });
  }

  // Load more
  const loadMoreBtn = document.getElementById('admin-int-load-more');
  if (loadMoreBtn) {
    loadMoreBtn.addEventListener('click', () => loadIntegrationsPage(false));
  }
}

function updateBulkDeleteBtn() {
  const btn = document.getElementById('admin-int-bulk-delete-btn');
  if (!btn) return;
  btn.style.display = intSelectedIds.size > 0 ? 'inline-block' : 'none';
  if (intSelectedIds.size > 0) {
    btn.textContent = `Delete Selected (${intSelectedIds.size})`;
  }
}

function getFilteredIntegrations() {
  if (!searchTerm) return [...allIntegrationsCache];
  const term = searchTerm.toLowerCase();
  return allIntegrationsCache.filter(int =>
    (int.name || '').toLowerCase().includes(term) ||
    (int._id || '').toLowerCase().includes(term) ||
    (int.status || '').toLowerCase().includes(term) ||
    (int.platform1?.name || '').toLowerCase().includes(term) ||
    (int.platform2?.name || '').toLowerCase().includes(term)
  );
}

// ─── Render Admin Table ─────────────────────────────────────

function renderAdminTable() {
  const tbody = document.getElementById('admin-integrations-tbody');
  if (!tbody) return;

  const filtered = getFilteredIntegrations();

  // Sort
  const sorted = sortIntegrations(filtered);

  tbody.innerHTML = '';

  if (sorted.length === 0) {
    tbody.innerHTML = `
      <tr class="table-empty-row">
        <td colspan="7">
          <div style="padding: 32px 16px; text-align: center;">
            <div style="margin-bottom: 12px;">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="color: var(--violet);"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="9" y1="9" x2="15" y2="15"></line><line x1="15" y1="9" x2="9" y2="15"></line></svg>
            </div>
            <h3 style="margin-bottom: 6px; color: var(--text-1);">${searchTerm ? 'No matching integrations' : 'No integrations yet'}</h3>
            <p style="color: var(--text-3); font-size: 0.88rem; margin-bottom: 0;">
              ${searchTerm
                ? `No integrations match "${escHtml(searchTerm)}". Try a different search term.`
                : 'Click "+ Add New" to create the first Marketplace integration.'}
            </p>
          </div>
        </td>
      </tr>`;
    // Selection state and its checkbox must reset here too — this branch used
    // to return before the select-all sync below ran, so deleting every
    // selected row left the header checkbox visually checked even though
    // nothing was selected anymore.
    const selectAllEmpty = document.getElementById('admin-int-select-all');
    if (selectAllEmpty) selectAllEmpty.checked = false;
    const loadMoreWrap = document.getElementById('admin-int-load-more-wrap');
    if (loadMoreWrap) loadMoreWrap.style.display = 'none';
    const countEl = document.getElementById('admin-int-count');
    if (countEl) countEl.textContent = '';
    return;
  }

  sorted.forEach(intg => {
    const tr = document.createElement('tr');
    const checked = intSelectedIds.has(intg._id) ? 'checked' : '';
    const p1Name = intg.platform1?.name || '—';
    const p2Name = intg.platform2?.name || '—';
    tr.innerHTML = `
      <td data-label="Select"><input type="checkbox" class="int-row-check" data-id="${intg._id}" ${checked} /></td>
      <td data-label="ID" style="font-family:monospace;font-size:0.85rem;color:var(--text-2);">${escHtml(intg._id)}</td>
      <td data-label="Name"><strong>${escHtml(intg.name)}</strong></td>
      <td data-label="Platform A">${escHtml(p1Name)}</td>
      <td data-label="Platform B">${escHtml(p2Name)}</td>
      <td data-label="Status">
        <span class="badge ${statusBadgeClass(intg.status)}">${escHtml(intg.status)}</span>
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
      if (found && _openModal) _openModal(found);
    });

    tr.querySelector('.del-int-btn').addEventListener('click', () => {
      showDeleteModal(intg._id, intg.name || intg._id);
    });

    tr.querySelector('.int-row-check').addEventListener('change', (e) => {
      if (e.target.checked) intSelectedIds.add(intg._id);
      else intSelectedIds.delete(intg._id);
      updateBulkDeleteBtn();
    });
  });

  // Update select-all state
  const selectAll = document.getElementById('admin-int-select-all');
  if (selectAll) {
    const visible = getFilteredIntegrations();
    const allVisibleChecked = visible.every(i => intSelectedIds.has(i._id));
    selectAll.checked = allVisibleChecked && visible.length > 0;
  }

  // Load more visibility
  const loadMoreWrap = document.getElementById('admin-int-load-more-wrap');
  if (loadMoreWrap) {
    const showingAll = !intHasMore || filtered.length <= allIntegrationsCache.length;
    loadMoreWrap.style.display = (searchTerm || showingAll) ? 'none' : 'block';
  }

  // Count
  const countEl = document.getElementById('admin-int-count');
  if (countEl) {
    countEl.textContent = `${filtered.length} integration(s)`;
  }
}

function sortIntegrations(arr) {
  const col = intSortColumn;
  const dir = intSortDirection === 'asc' ? 1 : -1;
  return [...arr].sort((a, b) => {
    let aVal, bVal;
    switch (col) {
      case 'id': aVal = a._id; bVal = b._id; break;
      case 'name': aVal = a.name; bVal = b.name; break;
      case 'platform1': aVal = a.platform1?.name || ''; bVal = b.platform1?.name || ''; break;
      case 'platform2': aVal = a.platform2?.name || ''; bVal = b.platform2?.name || ''; break;
      case 'status': aVal = a.status || ''; bVal = b.status || ''; break;
      default: aVal = a.name; bVal = b.name;
    }
    if (aVal < bVal) return -1 * dir;
    if (aVal > bVal) return 1 * dir;
    return 0;
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

    setButtonLoading(btnDelConfirm, true, 'Delete', 'Deleting…');

    try {
      const { deletedData } = await apiRequest(`/api/admin/integrations/${id}`, { method: 'DELETE' });
      hideDeleteModal();
      showToast('Integration deleted', 'info', {
        actionLabel: 'Undo',
        onAction: async () => {
          if (deletedData) {
            await apiRequest(`/api/admin/integrations/${id}/restore`, { method: 'POST', body: JSON.stringify(deletedData) });
            showToast('Integration restored', 'success');
            loadIntegrationsPage(true);
          }
        }
      });
      loadIntegrationsPage(true);
    } catch (err) {
      console.error("Delete failed", err);
      showToast("Failed to delete integration: " + err.message, 'error');
    } finally {
      setButtonLoading(btnDelConfirm, false);
    }
  });
}

// ─── Activity Log ───────────────────────────────────────────

let activityPageSize = 50;
let activityLastVisible = null;
let activityHasMore = false;
let activityLoading = false;
let activityFilters = { action: '', type: '', search: '', dateFrom: '', dateTo: '' };
let activitySearchTimer = null;

async function loadActivityLog(reset = false) {
  if (activityLoading) return;

  const tbody = document.getElementById('admin-activity-tbody');
  const emptyMsg = document.getElementById('admin-activity-empty');
  if (!tbody) return;

  // Read current filter values from DOM
  activityFilters.action = document.getElementById('admin-activity-filter-action')?.value || '';
  activityFilters.type = document.getElementById('admin-activity-filter-type')?.value || '';
  activityFilters.dateFrom = document.getElementById('admin-activity-filter-date-from')?.value || '';
  activityFilters.dateTo = document.getElementById('admin-activity-filter-date-to')?.value || '';
  activityFilters.search = document.getElementById('admin-activity-search')?.value?.trim() || '';

  activityLoading = true;

  if (reset) {
    activityLastVisible = null;
    activityHasMore = false;
    tbody.innerHTML = getSkeletonTableHTML(6, 4);
    if (emptyMsg) emptyMsg.style.display = 'none';
  }

  try {
    const constraints = [];

    // Action filter (equality)
    if (activityFilters.action) {
      constraints.push(where('action', '==', activityFilters.action));
    }

    // Date range filters (on timestamp)
    if (activityFilters.dateFrom) {
      const from = new Date(activityFilters.dateFrom);
      constraints.push(where('timestamp', '>=', from));
    }
    if (activityFilters.dateTo) {
      // Include the full "to" day by setting time to 23:59:59
      const to = new Date(activityFilters.dateTo + 'T23:59:59');
      constraints.push(where('timestamp', '<=', to));
    }

    // Always order by timestamp desc
    constraints.push(orderBy('timestamp', 'desc'));
    constraints.push(limit(activityPageSize));

    if (activityLastVisible) {
      constraints.push(startAfter(activityLastVisible));
    }

    let q = query(collection(firestoreDb, 'activity_logs'), ...constraints);
    const snap = await getDocs(q);
    if (reset) tbody.innerHTML = '';

    // Client-side search filter (userEmail or targetName match)
    const searchLower = activityFilters.search.toLowerCase();
    let rowCount = 0;

    snap.forEach(docSnap => {
      const d = docSnap.data();

      // Client-side type filter — matches the existing search filter's
      // pattern (client-side within the fetched page) rather than adding a
      // Firestore `where('targetType', ...)` constraint, which combined with
      // the existing action/date-range filters would need new composite
      // indexes for every combination.
      if (activityFilters.type && d.targetType !== activityFilters.type) return;

      // Client-side search match
      if (searchLower) {
        const haystack = ((d.userEmail || '') + ' ' + (d.userId || '') + ' ' + (d.targetName || '') + ' ' + (d.targetType || '') + ' ' + (d.details || '')).toLowerCase();
        if (!haystack.includes(searchLower)) return;
      }

      const ts = d.timestamp?.toDate?.() || new Date();
      const tr = document.createElement('tr');
      const actionBadge = d.action === 'delete' ? 'badge-danger'
        : d.action === 'create' ? 'badge-success'
        : d.action === 'restore' || d.action === 'activate' ? 'badge-warning'
        : d.action === 'deactivate' ? 'badge-danger'
        : 'badge-info';
      const changesSummary = d.changes
        ? Object.entries(d.changes).map(([field, { before, after }]) =>
            `<div><strong>${escHtml(field)}:</strong> ${escHtml(String(before ?? '—'))} → ${escHtml(String(after ?? '—'))}</div>`
          ).join('')
        : '<span style="color:var(--text-3);">—</span>';
      tr.innerHTML = `
        <td data-label="Timestamp" style="font-size:0.82rem;color:var(--text-2);white-space:nowrap;">${ts.toLocaleString()}</td>
        <td data-label="User" style="font-size:0.85rem;">${escHtml(d.userDisplayName || d.userEmail || d.userId || '—')}</td>
        <td data-label="Action"><span class="badge ${actionBadge}">${escHtml(d.action)}</span></td>
        <td data-label="Target" style="font-size:0.85rem;">${escHtml(d.targetType)}: ${escHtml(d.targetName || d.targetId || '')}</td>
        <td data-label="Changes" style="font-size:0.78rem;color:var(--text-2);max-width:280px;">${changesSummary}</td>
        <td data-label="Details" style="font-size:0.82rem;color:var(--text-3);">${escHtml(d.details || '')}</td>
      `;
      tbody.appendChild(tr);
      rowCount++;
    });

    activityLastVisible = snap.docs[snap.docs.length - 1] || null;
    activityHasMore = snap.docs.length === activityPageSize;

    const loadMoreWrap = document.getElementById('admin-activity-load-more-wrap');
    if (loadMoreWrap) loadMoreWrap.style.display = activityHasMore ? 'block' : 'none';

    if (rowCount === 0) {
      if (reset && !activityLastVisible) {
        tbody.innerHTML = getEmptyStateRowHTML({
          colspan: 6,
          iconSvg: '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="color: var(--violet);"><path d="M9 11l3 3L22 4"></path><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path></svg>',
          title: 'No audit entries recorded yet',
          message: 'Admin actions will show up here as they happen.',
        });
      } else if (emptyMsg) {
        emptyMsg.style.display = 'block';
      }
    } else if (emptyMsg) {
      emptyMsg.style.display = 'none';
    }
  } catch (err) {
    console.warn('[admin-integrations] Activity log error:', err);
  } finally {
    activityLoading = false;
  }
}

// Wire activity log controls
(function wireActivityControls() {
  const refreshBtn = document.getElementById('admin-activity-refresh');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => loadActivityLog(true));
  }
  const loadMoreBtn = document.getElementById('admin-activity-load-more');
  if (loadMoreBtn) {
    loadMoreBtn.addEventListener('click', () => loadActivityLog(false));
  }

  // Filter change → debounced reload
  const filterEls = ['admin-activity-filter-action', 'admin-activity-filter-type', 'admin-activity-filter-date-from', 'admin-activity-filter-date-to'];
  filterEls.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', () => loadActivityLog(true));
  });

  // Search input → debounced reload
  const searchEl = document.getElementById('admin-activity-search');
  if (searchEl) {
    searchEl.addEventListener('input', () => {
      clearTimeout(activitySearchTimer);
      activitySearchTimer = setTimeout(() => loadActivityLog(true), 300);
    });
  }
})();

// ─── Utilities ──────────────────────────────────────────────
function statusBadgeClass(status) {
  if (status === 'Active') return 'badge-success';
  if (status === 'Disabled') return 'badge-danger';
  return 'badge-warning'; // Coming Soon (and any legacy/unrecognized value)
}

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escAttr(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}



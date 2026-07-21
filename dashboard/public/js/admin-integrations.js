import { collection, collectionGroup, onSnapshot, query, orderBy, where, getDocs, limit, startAfter } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-firestore.js";
import { getSkeletonTableHTML, getEmptySpinnerHTML, getEmptyStateRowHTML, setButtonLoading } from './loading-components.js';
import { showToast } from './toast.js';
import { confirmDialog } from './confirm.js';
import { wireRowActionsMenus } from './row-actions-menu.js';

let firestoreDb = null;
let authInstance = null;

const SYNC_DIRECTIONS = ['Source_to_Dest', 'Dest_to_Source', 'Bidirectional'];

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
let excludeSamePlatform = null;

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

      excludeSamePlatform?.();
    },
    (err) => {
      console.warn('[admin-integrations] Platforms listener error:', err);
      if (!navigator.onLine) return;
      showToast('Failed to load platforms', 'error');
    });

  // All DOM event-listener wiring below (tabs, modal, form submit) must only
  // ever run ONCE per page load — initAdminIntegrations() can legitimately
  // run again (e.g. a second onAuthStateChanged firing), and re-running
  // addEventListener() on the same static elements without removing the
  // prior listener stacks a duplicate. For most of these that's just wasted
  // work, but for the form's 'submit' listener it meant every extra init
  // added another full save request — one click of "Save" fired N POSTs
  // and created N identical integration records (the reported cause of
  // "TickTick <-> Notion" showing up twice after adding a single one).
  if (!adminIntegrationsWired) {
    adminIntegrationsWired = true;

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

        const enabledDirs = integration.enabledSyncDirections || ['Source_to_Dest'];
        SYNC_DIRECTIONS.forEach(v => {
          const cb = document.getElementById('f-int-sync-dir-' + v);
          if (cb) cb.checked = enabledDirs.includes(v);
        });
      } else {
        document.getElementById('integration-panel-title').textContent = 'Add Integration';
        document.getElementById('f-int-doc-id').value = '';
        document.getElementById('f-int-name').value = '';
        document.getElementById('f-int-desc').value = '';
        document.getElementById('f-int-status').value = 'Active';
        document.getElementById('f-int-tags').value = '';

        document.getElementById('f-int-platform1').value = '';
        document.getElementById('f-int-platform2').value = '';

        SYNC_DIRECTIONS.forEach(v => {
          const cb = document.getElementById('f-int-sync-dir-' + v);
          if (cb) cb.checked = v === 'Source_to_Dest';
        });
      }

      modalOverlay.classList.add('open');
      sidePanel.classList.add('open');

      // Catch a legacy integration doc that already has platform1.id === platform2.id
      // (predates this validation, or came in via Import) right when the admin opens
      // it — not silently, at some later unrelated moment (see excludeSamePlatform).
      excludeSamePlatform();
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

    // A Marketplace integration pairing a platform with itself isn't a real
    // integration — block it at selection, not just on Save. Disables (not
    // removes) the matching option in the OTHER select so the list doesn't
    // jump around, and clears+warns if the other side's current pick just
    // became invalid.
    //
    // This also re-runs on every `platforms` collection change (see the
    // onSnapshot listener above) so the dropdown stays in sync if a platform
    // is renamed/added/removed while this form happens to be sitting open —
    // but that means it fires even when the Add/Edit Integration panel is
    // closed and the admin is doing something unrelated (e.g. just adding a
    // new platform). The toast must only surface while the panel is actually
    // visible, or it reads as a mysterious, unexplained error.
    excludeSamePlatform = function() {
      const p1Select = document.getElementById('f-int-platform1');
      const p2Select = document.getElementById('f-int-platform2');
      if (!p1Select || !p2Select) return;

      const disableMatching = (select, blockedId) => {
        let hadToClear = false;
        for (const opt of select.options) {
          if (!opt.value) continue;
          const matches = !!blockedId && opt.value === blockedId;
          opt.disabled = matches;
          opt.hidden = matches;
          if (matches && select.value === opt.value) hadToClear = true;
        }
        if (hadToClear) select.value = '';
        return hadToClear;
      };

      const clearedP2 = disableMatching(p2Select, p1Select.value);
      const clearedP1 = disableMatching(p1Select, p2Select.value);
      if ((clearedP2 || clearedP1) && sidePanel.classList.contains('open')) {
        showToast('Platform 1 and Platform 2 cannot be the same platform.', 'error');
      }
    };
    document.getElementById('f-int-platform1')?.addEventListener('change', excludeSamePlatform);
    document.getElementById('f-int-platform2')?.addEventListener('change', excludeSamePlatform);

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
          tags: tagsArray,
          enabledSyncDirections: SYNC_DIRECTIONS.filter(
            v => document.getElementById('f-int-sync-dir-' + v)?.checked
          ),
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

        if (integrationData.platform1?.id && integrationData.platform2?.id
            && integrationData.platform1.id === integrationData.platform2.id) {
          showToast('Platform 1 and Platform 2 cannot be the same platform.', 'error');
          setButtonLoading(btnSave, false);
          return;
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
  }

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
                : 'Click "+ New Integration" to create the first Marketplace integration.'}
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
        <div class="row-actions-dropdown">
          <button class="row-action-btn btn-row-more" type="button" title="More actions">⋮</button>
          <div class="row-actions-menu">
            <button class="row-action-menu-item edit-int-btn" data-id="${intg._id}" type="button">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg>
              Edit Integration
            </button>
            <div class="row-actions-menu-divider"></div>
            <button class="row-action-menu-item del-int-btn" data-id="${intg._id}" type="button" style="color:var(--danger);">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
              Delete Integration
            </button>
          </div>
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

  wireRowActionsMenus();

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
    tbody.innerHTML = getSkeletonTableHTML(4, 4);
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
      const actionBadge = auditActionBadgeClass(d.action);
      // Full details (changes diff, free-text summary, ids) live in the
      // side panel now, not the table — clicking any row opens it. Keeping
      // the row itself scannable (Timestamp/User/Action/Target only) is
      // what let the "Changes"/"Details" columns get dropped below.
      tr.style.cursor = 'pointer';
      tr.innerHTML = `
        <td data-label="Timestamp" style="font-size:0.82rem;color:var(--text-2);white-space:nowrap;">${ts.toLocaleString()}</td>
        <td data-label="User" style="font-size:0.85rem;">${escHtml(d.userDisplayName || d.userEmail || d.userId || '—')}</td>
        <td data-label="Action"><span class="badge ${actionBadge}">${escHtml(d.action)}</span></td>
        <td data-label="Target" style="font-size:0.85rem;">${escHtml(d.targetType)}: ${escHtml(d.targetName || d.targetId || '')}</td>
      `;
      tr.addEventListener('click', () => openAuditDetail({ ...d, timestamp: ts }));
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
          colspan: 4,
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

function auditActionBadgeClass(action) {
  return action === 'delete' ? 'badge-danger'
    : action === 'create' ? 'badge-success'
    : action === 'restore' || action === 'activate' ? 'badge-warning'
    : action === 'deactivate' ? 'badge-danger'
    : 'badge-info';
}

// "connectorTiers" -> "Connector Tiers" — field names come straight from
// each admin route's own field list (see e.g. INTEGRATION_FIELDS,
// PLATFORM_FIELDS), which are all camelCase, so a single generic splitter
// covers every targetType without needing a per-field label map.
function humanizeFieldName(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/^./, c => c.toUpperCase());
}

// Renders one scalar cell inside an audit-diff-table (never itself HTML —
// callers are responsible for escaping).
function renderCellText(v) {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (Array.isArray(v)) return v.map(renderCellText).join(', ') || '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// A single object's own keys as a compact 2-column Field/Value table —
// only the keys THAT object actually has (not a global union), so a field
// with fewer properties (e.g. a Toggle vs. a Dynamic Dropdown) doesn't show
// a row of "—" padding for options it was never going to have.
function renderKeyValueTable(obj) {
  const rows = Object.entries(obj).map(([k, val]) =>
    `<tr><td class="audit-kv-key">${escHtml(humanizeFieldName(k))}</td><td>${escHtml(renderCellText(val))}</td></tr>`
  ).join('');
  return `<div class="audit-table-wrap"><table class="audit-diff-table audit-diff-table-kv"><tbody>${rows}</tbody></table></div>`;
}

function isPlainObj(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

// A row of small before→after pills for each key that actually differs —
// the same visual language as a top-level scalar diff (Field: A → B), just
// reused for the changed properties inside a modified array item or a
// whole nested settings object. Deliberately does NOT re-list unchanged
// keys — the point of this whole view is showing only what moved.
function renderChangedFieldsHtml(changes) {
  const entries = Object.entries(changes);
  if (!entries.length) return `<div class="audit-diff-unchanged">No field-level changes.</div>`;
  return `<div class="audit-diff-subrows">${entries.map(([k, { before, after }]) => `
    <div class="audit-diff-subrow">
      <span class="audit-diff-subfield">${escHtml(humanizeFieldName(k))}</span>
      <span class="audit-diff-subvalues">
        <span class="audit-diff-before">${escHtml(renderCellText(before))}</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="audit-diff-arrow"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
        <span class="audit-diff-after">${escHtml(renderCellText(after))}</span>
      </span>
    </div>`).join('')}</div>`;
}

// Shallow field-level diff between two plain objects — same idea as
// computeChanges() in src/core/activityLog.js, done client-side so it can
// also run on the individual items INSIDE an array diff (see
// diffObjectArrays below), not just the top-level change value.
function diffPlainObjects(before, after) {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  const changes = {};
  for (const k of keys) {
    const bv = before ? before[k] : undefined;
    const av = after ? after[k] : undefined;
    const equal = bv === av || JSON.stringify(bv ?? null) === JSON.stringify(av ?? null);
    if (!equal) changes[k] = { before: bv, after: av };
  }
  return changes;
}

// A stable per-item identity key (id/key/name) IF every item on both sides
// has one — lets diffObjectArrays() recognize "this is the same field,
// just edited" instead of only ever seeing "array changed" as a whole.
// Falls back to positional index when nothing qualifies (still gives a
// correct, if less precise, added/removed/modified breakdown).
function findArrayItemIdentityKey(beforeArr, afterArr) {
  const all = [...beforeArr, ...afterArr];
  for (const key of ['id', 'key', 'name']) {
    if (all.every(item => item && item[key] !== undefined && item[key] !== null && item[key] !== '')) return key;
  }
  return null;
}

function arrayItemHeading(item) {
  return item.label || item.name || item.id || item.key || null;
}

// The core of "make this understandable": a real structural diff between
// two arrays of objects (e.g. a platform's configSchema before/after an
// edit), classifying each item as added / removed / modified — and
// SKIPPING items that didn't actually change, rather than the previous
// approach of dumping the entire before list and the entire after list for
// the admin to visually compare field-by-field themselves.
function diffObjectArrays(beforeArr, afterArr) {
  const identityKey = findArrayItemIdentityKey(beforeArr, afterArr);
  const keyOf = identityKey ? (item, i) => String(item[identityKey]) : (item, i) => String(i);
  const beforeMap = new Map(beforeArr.map((item, i) => [keyOf(item, i), item]));
  const afterMap = new Map(afterArr.map((item, i) => [keyOf(item, i), item]));

  const orderedIds = [];
  for (const item of beforeArr) { const id = keyOf(item, beforeArr.indexOf(item)); if (!orderedIds.includes(id)) orderedIds.push(id); }
  for (const item of afterArr) { const id = keyOf(item, afterArr.indexOf(item)); if (!orderedIds.includes(id)) orderedIds.push(id); }

  const results = [];
  for (const id of orderedIds) {
    const b = beforeMap.get(id);
    const a = afterMap.get(id);
    if (b && !a) results.push({ status: 'removed', item: b, heading: arrayItemHeading(b) });
    else if (!b && a) results.push({ status: 'added', item: a, heading: arrayItemHeading(a) });
    else {
      const fieldChanges = diffPlainObjects(b, a);
      if (Object.keys(fieldChanges).length === 0) continue; // unchanged — deliberately not shown
      results.push({ status: 'modified', changes: fieldChanges, heading: arrayItemHeading(a) });
    }
  }
  return results;
}

function renderArrayDiffResult(r) {
  if (r.status === 'added' || r.status === 'removed') {
    const statusClass = r.status === 'added' ? 'audit-diff-item-added' : 'audit-diff-item-removed';
    const badgeText = r.status === 'added' ? 'Added' : 'Removed';
    return `
      <div class="audit-diff-item-card ${statusClass}">
        <div class="audit-diff-item-heading">
          <span>${escHtml(r.heading || (r.status === 'added' ? 'New item' : 'Removed item'))}</span>
          <span class="audit-diff-item-badge">${badgeText}</span>
        </div>
        ${renderKeyValueTable(r.item)}
      </div>`;
  }
  return `
    <div class="audit-diff-item-card audit-diff-item-modified">
      <div class="audit-diff-item-heading">
        <span>${escHtml(r.heading || 'Item')}</span>
        <span class="audit-diff-item-badge">Modified</span>
      </div>
      ${renderChangedFieldsHtml(r.changes)}
    </div>`;
}

function renderArrayDiffHtml(beforeArr, afterArr) {
  const results = diffObjectArrays(beforeArr, afterArr);
  if (!results.length) return `<div class="audit-diff-unchanged">No items changed.</div>`;
  return `<div class="audit-diff-item-list">${results.map(renderArrayDiffResult).join('')}</div>`;
}

// Builds one full "Field: ..." row for the Changes section. Dispatches on
// shape: an array of objects on either side (e.g. configSchema) gets the
// full structural Added/Removed/Modified diff; a plain nested object gets
// a changed-fields-only diff; anything else (numbers, strings, booleans)
// is a simple before → after pill, same as always.
function renderChangeRow(field, before, after) {
  const beforeIsObjArr = Array.isArray(before) && before.length > 0 && before.every(isPlainObj);
  const afterIsObjArr = Array.isArray(after) && after.length > 0 && after.every(isPlainObj);

  if (beforeIsObjArr || afterIsObjArr) {
    return `
      <div class="audit-diff-row">
        <div class="audit-diff-field">${escHtml(humanizeFieldName(field))}</div>
        ${renderArrayDiffHtml(beforeIsObjArr ? before : [], afterIsObjArr ? after : [])}
      </div>`;
  }

  if (isPlainObj(before) || isPlainObj(after)) {
    const changes = diffPlainObjects(before || {}, after || {});
    return `
      <div class="audit-diff-row">
        <div class="audit-diff-field">${escHtml(humanizeFieldName(field))}</div>
        ${renderChangedFieldsHtml(changes)}
      </div>`;
  }

  return `
    <div class="audit-diff-row">
      <div class="audit-diff-field">${escHtml(humanizeFieldName(field))}</div>
      <div class="audit-diff-values">
        <span class="audit-diff-before">${escHtml(renderCellText(before))}</span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="audit-diff-arrow"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
        <span class="audit-diff-after">${escHtml(renderCellText(after))}</span>
      </div>
    </div>`;
}

// Opens the Audit Log entry's detail panel — same compact side-panel
// pattern already used for Execution Logs (log-detail-panel) and Client
// Errors, so this reads as the same component instead of a one-off. Shows
// the full field-level before/after diff (computeChanges() output) that the
// table row itself no longer has room for.
function openAuditDetail(entry) {
  const overlay = document.getElementById('audit-detail-overlay');
  const panel = document.getElementById('audit-detail-panel');
  if (!overlay || !panel) return;

  const ts = entry.timestamp instanceof Date ? entry.timestamp : new Date(entry.timestamp);
  const actionBadge = auditActionBadgeClass(entry.action);
  const changeEntries = entry.changes ? Object.entries(entry.changes) : [];

  const diffHtml = changeEntries.length
    ? changeEntries.map(([field, diff]) => renderChangeRow(field, diff?.before, diff?.after)).join('')
    : `<div style="padding:14px;text-align:center;color:var(--text-3);font-size:0.82rem;background:var(--bg-3);border-radius:var(--radius-xs);border:1px solid var(--border);">No field-level changes recorded for this action.</div>`;

  panel.innerHTML = `
    <div class="panel-header">
      <h2 id="audit-detail-title" style="font-size:1.1rem;font-weight:700;">Audit Log Entry</h2>
      <button class="panel-close" id="audit-detail-close" aria-label="Close"><i data-feather="x"></i></button>
    </div>
    <div class="panel-body">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:24px;padding:16px;background:var(--bg-3);border-radius:var(--radius-xs);border:1px solid var(--border);">
        <span class="badge ${actionBadge}" style="text-transform:capitalize;">${escHtml(entry.action)}</span>
        <span style="font-size:0.95rem;font-weight:600;color:var(--text-1);">${escHtml(entry.targetType)}: ${escHtml(entry.targetName || entry.targetId || '—')}</span>
      </div>

      <div class="log-detail-grid">
        <div class="log-detail-item">
          <span class="log-detail-label">Timestamp</span>
          <span class="log-detail-value">${ts.toLocaleString()}</span>
        </div>
        <div class="log-detail-item">
          <span class="log-detail-label">Performed By</span>
          <span class="log-detail-value">${escHtml(entry.userDisplayName || entry.userEmail || entry.userId || '—')}</span>
        </div>
        <div class="log-detail-item">
          <span class="log-detail-label">Target Type</span>
          <span class="log-detail-value">${escHtml(entry.targetType || '—')}</span>
        </div>
        <div class="log-detail-item">
          <span class="log-detail-label">Target ID</span>
          <span class="log-detail-value" style="font-family:monospace;font-size:0.8rem;color:var(--text-3);">${escHtml(entry.targetId || '—')}</span>
        </div>
      </div>

      ${entry.details ? `
      <div style="margin-top:20px;padding:16px;background:var(--bg-3);border-radius:var(--radius-xs);border:1px solid var(--border);">
        <h3 style="font-size:0.85rem;font-weight:600;color:var(--text-2);margin-bottom:8px;">Summary</h3>
        <p style="font-size:0.85rem;color:var(--text-2);margin:0;line-height:1.5;">${escHtml(entry.details)}</p>
      </div>` : ''}

      <div style="margin-top:20px;">
        <h3 style="font-size:0.85rem;font-weight:600;color:var(--text-2);margin-bottom:12px;">Changes${changeEntries.length ? ` (${changeEntries.length})` : ''}</h3>
        <div class="audit-diff-list">${diffHtml}</div>
      </div>
    </div>
  `;

  if (window.feather) window.feather.replace();

  const closeBtn = panel.querySelector('#audit-detail-close');
  if (closeBtn) closeBtn.addEventListener('click', closeAuditDetail);

  overlay.classList.add('open');
  panel.classList.add('open');
}

function closeAuditDetail() {
  const overlay = document.getElementById('audit-detail-overlay');
  const panel = document.getElementById('audit-detail-panel');
  if (overlay) overlay.classList.remove('open');
  if (panel) panel.classList.remove('open');
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

  const detailOverlay = document.getElementById('audit-detail-overlay');
  if (detailOverlay) detailOverlay.addEventListener('click', closeAuditDetail);
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



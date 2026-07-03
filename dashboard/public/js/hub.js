/* =============================================================
   hub.js — Integration Marketplace / Hub View
   Renders integration cards, supports search, pagination, tags,
   refresh, and re-render on navigation.
   ============================================================= */

import { collection, getDocs, query, orderBy, where } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-firestore.js";
import { getSkeletonCardGridHTML } from './loading-components.js';

// ─── State ──────────────────────────────────────────────────
let allIntegrations = [];
let platformsMap = {};
let connectedIds = new Set();
let searchTerm = '';
let displayCount = 0;
let dbRef = null;
let onNavigateRef = null;
const PAGE_SIZE = 12;

// ─── Main Render Entry Point ────────────────────────────────
export async function renderHubView(db, onNavigate) {
  dbRef = db;
  onNavigateRef = onNavigate;
  const grid = document.getElementById('marketplace-grid');
  if (!grid) return;

  // Show skeleton while loading
  grid.innerHTML = getSkeletonCardGridHTML(6);
  const toolbar = document.getElementById('hub-toolbar');
  if (toolbar) toolbar.style.display = 'none';
  document.getElementById('hub-load-more-wrap').style.display = 'none';

  const cached = window.__getViewCache ? window.__getViewCache('hub') : null;
  if (cached) {
    platformsMap = cached.platformsMap;
    allIntegrations = cached.allIntegrations;
    connectedIds = cached.connectedIds;
    searchTerm = '';
    displayCount = PAGE_SIZE;
    if (toolbar) toolbar.style.display = 'flex';
    wireHubToolbar();
    renderCards();
    return;
  }

  try {
    const [pSnap, iSnap] = await Promise.all([
      getDocs(query(collection(db, 'platforms'))),
      getDocs(query(collection(db, 'integrations'), orderBy('name')))
    ]);

    platformsMap = {};
    pSnap.forEach(doc => { platformsMap[doc.id] = doc.data(); });

    allIntegrations = [];
    iSnap.forEach(doc => {
      allIntegrations.push({ id: doc.id, ...doc.data() });
    });

    // Check which integrations have active configs in this workspace
    connectedIds = new Set();
    if (window.currentWorkspaceId) {
      const cSnap = await getDocs(query(
        collection(db, 'workspaces', window.currentWorkspaceId, 'sync_configs'),
        where('status', '==', 'active')
      ));
      cSnap.forEach(doc => {
        const data = doc.data();
        if (data.integrationId) {
          connectedIds.add(data.integrationId);
        }
      });
    }

    if (window.__setViewCache) {
      window.__setViewCache('hub', { platformsMap, allIntegrations, connectedIds });
    }
  } catch (err) {
    console.error("Error fetching integrations:", err);
    grid.innerHTML = `
      <div style="grid-column:1/-1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:80px 20px;text-align:center;gap:16px;">
        <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--rose)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"></circle>
          <line x1="12" y1="8" x2="12" y2="12"></line>
          <line x1="12" y1="16" x2="12.01" y2="16"></line>
        </svg>
        <h3 style="color:var(--text-1);font-size:1.1rem;margin:0;">Failed to load marketplace</h3>
        <p style="color:var(--text-2);font-size:0.95rem;margin:0;max-width:400px;">We couldn't connect to the database. Please check your internet connection or try refreshing the page.</p>
        <button class="btn btn-primary" id="hub-error-retry" style="margin-top:8px;">Retry</button>
      </div>`;
    const retryBtn = document.getElementById('hub-error-retry');
    if (retryBtn) retryBtn.addEventListener('click', () => renderHubView(db, onNavigate));
    return;
  }

  // Reset search and pagination
  searchTerm = '';
  displayCount = PAGE_SIZE;

  // Show toolbar and wire events
  if (toolbar) toolbar.style.display = 'flex';
  wireHubToolbar();

  renderCards();
}

// ─── Render Cards ───────────────────────────────────────────
function renderCards() {
  const grid = document.getElementById('marketplace-grid');
  if (!grid) return;

  const filtered = applyFilter();

  grid.innerHTML = '';

  if (filtered.length === 0) {
    const emptyMsg = searchTerm
      ? `No integrations match "<strong>${escHtml(searchTerm)}</strong>". Try a different search term.`
      : 'The marketplace is currently empty. Check back later for new platform connections!';
    grid.innerHTML = `
      <div style="grid-column:1/-1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:80px 20px;text-align:center;gap:16px;background:var(--card-bg);border:1px dashed var(--border);border-radius:12px;margin-top:24px;">
        <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--text-3)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="3" width="7" height="7"></rect>
          <rect x="14" y="3" width="7" height="7"></rect>
          <rect x="14" y="14" width="7" height="7"></rect>
          <rect x="3" y="14" width="7" height="7"></rect>
        </svg>
        <h3 style="color:var(--text-1);font-size:1.1rem;margin:0;">${searchTerm ? 'No matching integrations' : 'No integrations available'}</h3>
        <p style="color:var(--text-2);font-size:0.95rem;margin:0;max-width:400px;">${emptyMsg}</p>
      </div>`;
    updateLoadMoreVisibility(0);
    return;
  }

  const toShow = filtered.slice(0, displayCount);

  toShow.forEach(integ => {
    const card = createCard(integ);
    grid.appendChild(card);
  });

  updateLoadMoreVisibility(filtered.length);
}

// ─── Filter ─────────────────────────────────────────────────
function applyFilter() {
  if (!searchTerm) return [...allIntegrations];
  const term = searchTerm.toLowerCase();
  return allIntegrations.filter(c =>
    (c.name || '').toLowerCase().includes(term) ||
    (c.description || '').toLowerCase().includes(term) ||
    (c.tags || []).some(t => t.toLowerCase().includes(term))
  );
}

// ─── Create Card Element ────────────────────────────────────
function createCard(integ) {
  const card = document.createElement('div');
  const isActive = integ.status === 'Active';
  card.className = `hub-card ${isActive ? 'hub-card-active' : 'hub-card-coming-soon'}`;
  card.dataset.id = integ.id;

  const tagsHtml = (integ.tags || []).map(t =>
    `<span class="hub-tag" data-tag="${escHtml(t)}">${escHtml(t)}</span>`
  ).join('');

  const statusBadge = isActive
    ? `<span class="hub-status-badge hub-status-active">● Active</span>`
    : `<span class="hub-status-badge hub-status-soon">${escHtml(integ.status || 'Coming Soon')}</span>`;

  const p1Id = typeof integ.platform1 === 'string' ? integ.platform1 : (integ.platform1?.id || integ.platform1?.key);
  const p2Id = typeof integ.platform2 === 'string' ? integ.platform2 : (integ.platform2?.id || integ.platform2?.key);

  const p1Logo = (p1Id && platformsMap[p1Id]?.logo) || '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect></svg>';
  const p2Logo = (p2Id && platformsMap[p2Id]?.logo) || '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect></svg>';

  const hasActiveConfig = connectedIds.has(integ.id);

  card.innerHTML = `
    <div class="hub-card-header">
      <div class="hub-card-logos">
        <span class="hub-logo">${p1Logo}</span>
        <span class="hub-logo-connector">⇄</span>
        <span class="hub-logo">${p2Logo}</span>
      </div>
      ${statusBadge}
    </div>
    <div class="hub-card-body">
      <h3 class="hub-card-title">${escHtml(integ.name)}</h3>
      <p class="hub-card-desc">${escHtml(integ.description || '')}</p>
      <div class="hub-card-tags">${tagsHtml}</div>
    </div>
    <div class="hub-card-footer">
      <button
        class="btn ${hasActiveConfig ? 'btn-secondary' : (isActive ? 'btn-primary' : 'btn-secondary')} btn-sm hub-cta-btn"
        ${hasActiveConfig || !isActive ? 'disabled' : ''}
      >
        ${hasActiveConfig ? 'Already Connected' : (isActive ? 'Connect' : 'Coming Soon')}
      </button>
    </div>
  `;

  // Wire tag clicks
  card.querySelectorAll('.hub-tag').forEach(tagEl => {
    tagEl.addEventListener('click', (e) => {
      e.stopPropagation();
      const tag = tagEl.dataset.tag;
      const searchInput = document.getElementById('hub-search');
      if (searchInput) {
        searchInput.value = tag;
        searchTerm = tag;
        displayCount = PAGE_SIZE;
        renderCards();
        const clearBtn = document.getElementById('hub-search-clear');
        if (clearBtn) clearBtn.style.display = 'flex';
      }
    });
  });

  // Wire CTA button
  const btn = card.querySelector('.hub-cta-btn');
  if (btn) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (hasActiveConfig) {
        if (onNavigateRef) onNavigateRef('flows');
        return;
      }
      window.dispatchEvent(new CustomEvent('open-integration-setup', {
        detail: { integration: integ, platformsMap }
      }));
    });
  }

  // Wire card body click to open detail panel
  card.querySelector('.hub-card-body').addEventListener('click', (e) => {
    if (e.target.closest('.hub-tag')) return; // tag clicks handled separately
    openDetailPanel(integ);
  });

  return card;
}

// ─── Load More ──────────────────────────────────────────────
function updateLoadMoreVisibility(totalCount) {
  const wrap = document.getElementById('hub-load-more-wrap');
  if (!wrap) return;
  if (totalCount === undefined) totalCount = applyFilter().length;
  wrap.style.display = (displayCount < totalCount) ? 'block' : 'none';
}

// ─── Wire Toolbar ───────────────────────────────────────────
function wireHubToolbar() {
  // Search
  const searchInput = document.getElementById('hub-search');
  if (searchInput && !searchInput.dataset.hubWired) {
    searchInput.dataset.hubWired = 'true';
    const searchClear = document.getElementById('hub-search-clear');
    searchInput.addEventListener('input', () => {
      if (searchClear) {
        searchClear.style.display = searchInput.value ? 'flex' : 'none';
      }
      clearTimeout(searchInput._timer);
      searchInput._timer = setTimeout(() => {
        searchTerm = searchInput.value.trim();
        displayCount = PAGE_SIZE;
        renderCards();
      }, 250);
    });
    if (searchClear && !searchClear.dataset.hubWired) {
      searchClear.dataset.hubWired = 'true';
      searchClear.addEventListener('click', () => {
        searchInput.value = '';
        searchTerm = '';
        displayCount = PAGE_SIZE;
        renderCards();
        searchClear.style.display = 'none';
      });
    }
  }

  // Refresh
  const refreshBtn = document.getElementById('hub-refresh-btn');
  if (refreshBtn && !refreshBtn.dataset.hubWired) {
    refreshBtn.dataset.hubWired = 'true';
    refreshBtn.addEventListener('click', () => {
      renderHubView(dbRef, onNavigateRef);
    });
  }

  // Load More
  const loadMoreBtn = document.getElementById('hub-load-more');
  if (loadMoreBtn && !loadMoreBtn.dataset.hubWired) {
    loadMoreBtn.dataset.hubWired = 'true';
    loadMoreBtn.addEventListener('click', () => {
      displayCount += PAGE_SIZE;
      renderCards();
    });
  }
}

// ─── Detail Panel ────────────────────────────────────────────

function openDetailPanel(integ) {
  const overlay = document.getElementById('hub-detail-overlay');
  const panel = document.getElementById('hub-detail-panel');
  if (!overlay || !panel) return;

  const p1Id = typeof integ.platform1 === 'string' ? integ.platform1 : (integ.platform1?.id || integ.platform1?.key);
  const p2Id = typeof integ.platform2 === 'string' ? integ.platform2 : (integ.platform2?.id || integ.platform2?.key);
  const p1Name = (p1Id && platformsMap[p1Id]?.name) || p1Id || 'Platform 1';
  const p2Name = (p2Id && platformsMap[p2Id]?.name) || p2Id || 'Platform 2';
  const p1Logo = (p1Id && platformsMap[p1Id]?.logo) || '';
  const p2Logo = (p2Id && platformsMap[p2Id]?.logo) || '';

  const isActive = integ.status === 'Active';
  const hasActiveConfig = connectedIds.has(integ.id);
  const tagsHtml = (integ.tags || []).map(t =>
    `<span class="hub-tag" style="cursor:default;">${escHtml(t)}</span>`
  ).join('');

  const body = document.getElementById('hub-detail-body');
  body.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:20px;">
      <div style="display:flex;align-items:center;gap:16px;">
        <div style="display:flex;align-items:center;gap:8px;">
          ${p1Logo ? `<span class="hub-logo" style="width:40px;height:40px;">${p1Logo}</span>` : ''}
          <span style="font-weight:600;font-size:0.95rem;">${escHtml(p1Name)}</span>
        </div>
        <span style="color:var(--text-3);font-size:1.2rem;">⇄</span>
        <div style="display:flex;align-items:center;gap:8px;">
          ${p2Logo ? `<span class="hub-logo" style="width:40px;height:40px;">${p2Logo}</span>` : ''}
          <span style="font-weight:600;font-size:0.95rem;">${escHtml(p2Name)}</span>
        </div>
      </div>

      <div>
        <h2 style="margin:0 0 4px;font-size:1.3rem;">${escHtml(integ.name)}</h2>
        <span class="hub-status-badge ${isActive ? 'hub-status-active' : 'hub-status-soon'}">● ${escHtml(integ.status || 'Coming Soon')}</span>
      </div>

      <p style="color:var(--text-2);line-height:1.6;margin:0;">${escHtml(integ.description || 'No description available.')}</p>

      ${tagsHtml ? `<div style="display:flex;flex-wrap:wrap;gap:6px;">${tagsHtml}</div>` : ''}

      <div style="display:flex;flex-direction:column;gap:8px;background:rgba(255,255,255,0.03);border-radius:10px;padding:16px;">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <span style="color:var(--text-3);font-size:0.85rem;">Document ID</span>
          <span style="font-family:monospace;font-size:0.82rem;color:var(--text-2);">${escHtml(integ.id)}</span>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <span style="color:var(--text-3);font-size:0.85rem;">Status</span>
          <span class="badge ${isActive ? 'badge-success' : 'badge-warning'}">${escHtml(integ.status)}</span>
        </div>
        ${integ.createdAt ? `
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <span style="color:var(--text-3);font-size:0.85rem;">Created</span>
          <span style="font-size:0.85rem;color:var(--text-2);">
            ${typeof integ.createdAt === 'object' && integ.createdAt?.toDate
              ? integ.createdAt.toDate().toLocaleDateString()
              : new Date(integ.createdAt).toLocaleDateString()}
          </span>
        </div>` : ''}
      </div>

      <button class="btn ${hasActiveConfig ? 'btn-secondary' : (isActive ? 'btn-primary' : 'btn-secondary')} hub-cta-btn" ${hasActiveConfig || !isActive ? 'disabled' : ''} style="width:100%;margin-top:8px;">
        ${hasActiveConfig ? 'Already Connected' : (isActive ? 'Connect Now' : 'Coming Soon')}
      </button>
    </div>
  `;

  // Wire the Connect button
  const detailBtn = body.querySelector('.hub-cta-btn');
  if (detailBtn && !detailBtn.disabled) {
    detailBtn.addEventListener('click', () => {
      closeDetailPanel();
      window.dispatchEvent(new CustomEvent('open-integration-setup', {
        detail: { integration: integ, platformsMap }
      }));
    });
  }

  overlay.classList.add('open');
  panel.classList.add('open');
}

function closeDetailPanel() {
  const overlay = document.getElementById('hub-detail-overlay');
  const panel = document.getElementById('hub-detail-panel');
  if (overlay) overlay.classList.remove('open');
  if (panel) panel.classList.remove('open');
}

// Wire detail panel close once
(function wireDetailPanel() {
  const closeBtn = document.getElementById('hub-detail-close');
  const overlay = document.getElementById('hub-detail-overlay');
  if (closeBtn) closeBtn.addEventListener('click', closeDetailPanel);
  if (overlay) overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeDetailPanel();
  });
})();

// ─── Utilities ──────────────────────────────────────────────
function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* =============================================================
   hub.js — Integration Marketplace / Hub View
   Renders integration cards for the Hub view panel.
   ============================================================= */

import { collection, getDocs, query, orderBy } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-firestore.js";
import { getSkeletonCardGridHTML } from './loading-components.js';

/**
 * Render the Marketplace view with integration cards from Firestore.
 * @param {Object} db - Firestore database instance
 * @param {Function} onNavigate — callback to switch views, e.g. navigateTo
 */
export async function renderHubView(db, onNavigate) {
  const panel = document.getElementById('view-hub');
  if (!panel) return;

  const loaderContainer = document.getElementById('marketplace-grid');
  if (!loaderContainer) return;
  
  // Reset grid to skeleton state while loading
  loaderContainer.innerHTML = getSkeletonCardGridHTML(6);

  let integrations = [];
  let platformsMap = {};
  
  try {
    const pQ = query(collection(db, 'platforms'));
    const pSnap = await getDocs(pQ);
    pSnap.forEach(doc => {
      platformsMap[doc.id] = doc.data();
    });

    const q = query(collection(db, 'integrations'), orderBy('name'));
    const querySnapshot = await getDocs(q);
    querySnapshot.forEach(doc => {
      integrations.push({ id: doc.id, ...doc.data() });
    });
    
    // Fetch user's active configs to know which integrations are already connected
    if (window.currentWorkspaceId) {
      const cQ = query(collection(db, "workspaces", window.currentWorkspaceId, "sync_configs"));
      const cSnap = await getDocs(cQ);
      cSnap.forEach(doc => {
        const data = doc.data();
        if (data.status === 'active' && data.integrationId) {
          const integ = integrations.find(i => i.id === data.integrationId);
          if (integ) integ.hasActiveConfig = true;
        }
      });
    }
  } catch (err) {
    console.error("Error fetching integrations: ", err);
    loaderContainer.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--rose)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="margin-bottom: 8px;">
        <circle cx="12" cy="12" r="10"></circle>
        <line x1="12" y1="8" x2="12" y2="12"></line>
        <line x1="12" y1="16" x2="12.01" y2="16"></line>
      </svg>
      <h3 style="color: var(--text-1); font-size: 1.1rem; margin: 0;">Failed to load marketplace</h3>
      <p style="color: var(--text-2); font-size: 0.95rem; margin: 0; max-width: 400px;">We couldn't connect to the database. Please check your internet connection or try refreshing the page.</p>
    `;
    return;
  }

  loaderContainer.innerHTML = ''; // Clear skeleton loader before rendering results


  if (integrations.length === 0) {
    const emptyState = document.createElement('div');
    emptyState.style = 'display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 80px 20px; text-align: center; gap: 16px; background: var(--card-bg); border: 1px dashed var(--border); border-radius: 12px; margin-top: 24px;';
    emptyState.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--text-3)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="margin-bottom: 8px;">
        <rect x="3" y="3" width="7" height="7"></rect>
        <rect x="14" y="3" width="7" height="7"></rect>
        <rect x="14" y="14" width="7" height="7"></rect>
        <rect x="3" y="14" width="7" height="7"></rect>
      </svg>
      <h3 style="color: var(--text-1); font-size: 1.1rem; margin: 0;">No integrations available</h3>
      <p style="color: var(--text-2); font-size: 0.95rem; margin: 0; max-width: 400px;">The marketplace is currently empty. Check back later for new platform connections!</p>
    `;
    loaderContainer.appendChild(emptyState);
    return;
  }

  // Cards grid
  loaderContainer.innerHTML = ''; // clear before appending actual cards

  integrations.forEach(integ => {
    const card = document.createElement('div');
    card.className = `hub-card ${integ.status === 'Active' ? 'hub-card-active' : 'hub-card-coming-soon'}`;
    card.dataset.id = integ.id;

    const tagsHtml = (integ.tags || []).map(t =>
      `<span class="hub-tag">${t}</span>`
    ).join('');

    const statusBadge = integ.status === 'Active'
      ? `<span class="hub-status-badge hub-status-active">● Active</span>`
      : `<span class="hub-status-badge hub-status-soon">${escHtml(integ.status || 'Coming Soon')}</span>`;

    const p1Id = typeof integ.platform1 === 'string' ? integ.platform1 : (integ.platform1?.id || integ.platform1?.key);
    const p2Id = typeof integ.platform2 === 'string' ? integ.platform2 : (integ.platform2?.id || integ.platform2?.key);

    const p1Logo = (p1Id && platformsMap[p1Id]?.logo) || '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect></svg>';
    const p2Logo = (p2Id && platformsMap[p2Id]?.logo) || '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect></svg>';

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
        <h3 class="hub-card-title">${integ.name}</h3>
        <p class="hub-card-desc">${integ.description}</p>
        <div class="hub-card-tags">${tagsHtml}</div>
      </div>
      <div class="hub-card-footer">
        <button
          class="btn ${integ.hasActiveConfig ? 'btn-secondary' : (integ.status === 'Active' ? 'btn-primary' : 'btn-secondary')} btn-sm hub-cta-btn"
          data-view="connections"
          ${integ.hasActiveConfig || integ.status !== 'Active' ? 'disabled' : ''}
        >
          ${integ.hasActiveConfig ? 'Already Connected' : (integ.status === 'Active' ? 'Connect' : 'Coming Soon')}
        </button>
      </div>
    `;

    const btn = card.querySelector('.hub-cta-btn');
    if (btn) {
      btn.addEventListener('click', () => {
        if (integ.hasActiveConfig) {
          if (onNavigate) onNavigate('flows');
          return;
        }
        
        const view = btn.dataset.view;
        if (view === 'connections') {
          window.dispatchEvent(new CustomEvent('open-integration-setup', {
            detail: { integration: integ, platformsMap }
          }));
        } else {
          if (view && onNavigate) onNavigate(view);
        }
      });
    }

    loaderContainer.appendChild(card);
  });
}

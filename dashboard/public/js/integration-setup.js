import { getFirestore, collection, getDocs, addDoc, updateDoc, doc, query, where } from 'https://www.gstatic.com/firebasejs/10.9.0/firebase-firestore.js';
import { getApp } from 'https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js';
import { saveConnection, connections, loadConnections } from './connections.js';
import { navigateTo } from './navigation.js';
import { showToast } from './toast.js';

function getDb() { return getFirestore(getApp()); }

// State
let currentIntegration = null;
let currentStep = 1;
let platformsMap = {};
let sidePanelObserver = null;

// Setup Integration Flow
function closeSetupView() {
  const overlay = document.getElementById('setup-overlay');
  if (overlay) overlay.classList.remove('open');
  window.currentIntegration = null;
}

window.addEventListener('open-integration-setup', async (e) => {
  currentIntegration = e.detail.integration;
  window.currentIntegration = currentIntegration;
  platformsMap = e.detail.platformsMap;

  // Show loading overlay before async work
  const loadingOverlay = document.createElement('div');
  loadingOverlay.id = 'setup-loading-overlay';
  loadingOverlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.45);backdrop-filter:blur(4px);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;';
  loadingOverlay.innerHTML = '<div class="spinner"></div><p style="color:#fff;font-size:1rem;margin:0;">Preparing setup…</p>';
  document.body.appendChild(loadingOverlay);

  // Timeout guard: remove overlay after 15s if anything hangs
  let loadingTimedOut = false;
  const loadingTimeout = setTimeout(() => {
    loadingTimedOut = true;
    const el = document.getElementById('setup-loading-overlay');
    if (el) {
      el.remove();
      showToast(!navigator.onLine ? 'No internet available' : 'Setup timed out', 'error');
    }
  }, 15000);

  const p1Id = typeof currentIntegration.platform1 === 'string' ? currentIntegration.platform1 : (currentIntegration.platform1?.id || currentIntegration.platform1?.key);
  const p2Id = typeof currentIntegration.platform2 === 'string' ? currentIntegration.platform2 : (currentIntegration.platform2?.id || currentIntegration.platform2?.key);

  try {
    if (!navigator.onLine) {
      showToast('No internet available. Some features may be unavailable.', 'error');
      return;
    }

    await loadConnections();

    if (!loadingTimedOut) {
      populateSetupView(p1Id, p2Id);
    }
  } finally {
    clearTimeout(loadingTimeout);
    const overlayEl = document.getElementById('setup-loading-overlay');
    if (overlayEl) overlayEl.remove();
  }

  if (!loadingTimedOut) {
    navigateTo('integration-setup');

    const fSyncType = document.getElementById('f-sync-type');
    if (fSyncType) {
        const p1Name = platformsMap[p1Id]?.name || "Platform 1";
        const p2Name = platformsMap[p2Id]?.name || "Platform 2";
        fSyncType.innerHTML = `
          <option value="Source_to_Dest">One-way: ${p1Name} ➔ ${p2Name}</option>
          <option value="Dest_to_Source">One-way: ${p2Name} ➔ ${p1Name}</option>
          <option value="Bidirectional">Bidirectional: Two-way (Sync Updates)</option>
        `;
    }
  }
});

function populateSetupView(p1Id, p2Id) {
  const view = document.getElementById('view-integration-setup');
  if (!view || !currentIntegration) return;

  const p1Name = platformsMap[p1Id]?.name || 'Platform 1';
  const p2Name = platformsMap[p2Id]?.name || 'Platform 2';
  const p1Logo = platformsMap[p1Id]?.logo || '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect></svg>';
  const p2Logo = platformsMap[p2Id]?.logo || '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect></svg>';

  document.getElementById('setup-integration-name').textContent = currentIntegration.name || 'Integration Setup';
  document.getElementById('setup-integration-desc').textContent = currentIntegration.description || 'Configure your sync integration';

  const logo1 = document.getElementById('setup-platform1-logo');
  logo1.innerHTML = p1Logo;

  const logo2 = document.getElementById('setup-platform2-logo');
  logo2.innerHTML = p2Logo;

  document.getElementById('setup-platform1-name').textContent = p1Name;
  document.getElementById('setup-platform2-name').textContent = p2Name;

  // Update the workflow canvas nodes
  const n1Name = document.getElementById('node-p1-name');
  const n2Name = document.getElementById('node-p2-name');
  const n1Logo = document.getElementById('node-p1-logo');
  const n2Logo = document.getElementById('node-p2-logo');

  if (n1Name) n1Name.textContent = p1Name;
  if (n2Name) n2Name.textContent = p2Name;
  if (n1Logo) n1Logo.innerHTML = p1Logo;
  if (n2Logo) n2Logo.innerHTML = p2Logo;

  const isP1Connected = connections.some(c => c.provider === p1Id);
  const isP2Connected = connections.some(c => c.provider === p2Id);

  document.getElementById('setup-platform1-status').textContent = isP1Connected ? 'Connected' : 'Not Connected';
  document.getElementById('setup-platform1-status').className = `setup-platform-status ${isP1Connected ? 'connected' : 'disconnected'}`;
  document.getElementById('setup-platform2-status').textContent = isP2Connected ? 'Connected' : 'Not Connected';
  document.getElementById('setup-platform2-status').className = `setup-platform-status ${isP2Connected ? 'connected' : 'disconnected'}`;

  // Empty connection notice
  const connNotice = document.getElementById('setup-connection-notice');
  if (connections.length === 0) {
    if (!connNotice) {
      const notice = document.createElement('p');
      notice.id = 'setup-connection-notice';
      notice.style.cssText = 'font-size:0.8rem;color:var(--text-3);margin:12px 0 0;';
      notice.textContent = 'No saved accounts yet — connect a platform to start syncing.';
      document.getElementById('setup-tags-container').after(notice);
    }
  } else if (connNotice) {
    connNotice.remove();
  }

  // Tags
  const tagsContainer = document.getElementById('setup-tags-container');
  const tags = currentIntegration.tags || [];
  tagsContainer.innerHTML = tags.length
    ? tags.map(t => `<span class="hub-tag">${t}</span>`).join('')
    : '<span class="hub-tag" style="opacity:0.5;">No tags</span>';

  // Configure button opens the side panel in Create New Config mode
  const configureBtn = document.getElementById('setup-configure-btn');
  configureBtn.onclick = null;
  configureBtn.addEventListener('click', () => {
    if (window.openPanel) {
      window.currentConfigCreationSource = 'marketplace';
      window.openPanel();
    }
  });
}



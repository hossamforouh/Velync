import { getFirestore, collection, getDocs, addDoc, updateDoc, doc, query, where } from 'https://www.gstatic.com/firebasejs/10.9.0/firebase-firestore.js';
import { getApp } from 'https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js';
import { saveConnection, connections, loadConnections, initiateDirectOAuthFlow } from './connections.js';
import { navigateTo } from './navigation.js';
import { showToast } from './toast.js';

function getDb() { return getFirestore(getApp()); }

// State
let currentIntegration = null;
let currentStep = 1;
let platformsMap = {};
let sidePanelObserver = null;
let currentP1Id = null;
let currentP2Id = null;

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

  currentP1Id = p1Id;
  currentP2Id = p2Id;

  const p1Name = platformsMap[p1Id]?.name || 'Platform 1';
  const p2Name = platformsMap[p2Id]?.name || 'Platform 2';
  const p1Logo = platformsMap[p1Id]?.logo || '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect></svg>';
  const p2Logo = platformsMap[p2Id]?.logo || '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect></svg>';

  document.getElementById('setup-integration-name').textContent = currentIntegration.name || 'Integration Setup';
  document.getElementById('setup-integration-desc').textContent = currentIntegration.description || 'Configure your sync integration';

  const logo1 = document.getElementById('setup-source-logo');
  if (logo1) logo1.innerHTML = p1Logo;

  const logo2 = document.getElementById('setup-dest-logo');
  if (logo2) logo2.innerHTML = p2Logo;

  const name1 = document.getElementById('setup-source-name');
  if (name1) name1.textContent = p1Name;

  const name2 = document.getElementById('setup-dest-name');
  if (name2) name2.textContent = p2Name;

  // Update the workflow canvas nodes
  const n1Name = document.getElementById('node-source-name');
  const n2Name = document.getElementById('node-dest-name');
  const n1Logo = document.getElementById('node-source-logo');
  const n2Logo = document.getElementById('node-dest-logo');

  if (n1Name) n1Name.textContent = p1Name;
  if (n2Name) n2Name.textContent = p2Name;
  if (n1Logo) n1Logo.innerHTML = p1Logo;
  if (n2Logo) n2Logo.innerHTML = p2Logo;

  const isP1Connected = connections.some(c => c.provider === p1Id);
  const isP2Connected = connections.some(c => c.provider === p2Id);

  // [DIAG] temporary — captured to client_errors via the console.error hook.
  try {
    console.error('[DIAG populateSetupView] connCount=' + connections.length
      + ' providers=' + connections.map(c => c.provider).join('|')
      + ' p1Id=' + p1Id + ' p2Id=' + p2Id
      + ' isP1=' + isP1Connected + ' isP2=' + isP2Connected
      + ' wsId=' + window.currentWorkspaceId);
  } catch (_) {}

  const status1 = document.getElementById('setup-source-status');
  if (status1) { status1.textContent = isP1Connected ? 'Connected' : 'Not Connected'; status1.className = `setup-platform-status ${isP1Connected ? 'connected' : 'disconnected'}`; }
  const status2 = document.getElementById('setup-dest-status');
  if (status2) { status2.textContent = isP2Connected ? 'Connected' : 'Not Connected'; status2.className = `setup-platform-status ${isP2Connected ? 'connected' : 'disconnected'}`; }

  // Inline "Connect" button per platform — lets the user resolve a missing
  // connection right here instead of discovering it only after opening the
  // full config wizard.
  wireConnectButton('setup-source-connect', p1Id, isP1Connected);
  wireConnectButton('setup-dest-connect', p2Id, isP2Connected);

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

// Shows/hides the inline "Connect" button next to a platform card based on
// its current connection status, and wires it to run the same OAuth-popup
// flow the Connections page uses (initiateDirectOAuthFlow) — lets the user
// resolve a missing connection right here instead of only discovering it
// after opening the full config wizard.
function wireConnectButton(btnId, platformId, isConnected) {
  const btn = document.getElementById(btnId);
  if (!btn) return;

  if (isConnected) {
    btn.style.display = 'none';
    btn.onclick = null;
    return;
  }

  btn.style.display = 'inline-block';
  btn.disabled = false;
  btn.textContent = 'Connect';
  btn.onclick = () => connectSetupPlatform(platformId, btn);
}

async function connectSetupPlatform(platformId, btn) {
  const platform = platformsMap[platformId];
  if (!platform) return;

  // Manual/API-key platforms (no authUrl) have no popup flow to drive from
  // here — direct the user to the full Connections page rather than hang on
  // "Connecting…" indefinitely (mirrors onboarding.js#connectPlatform).
  if (!platform.authType || platform.authType !== 'oauth' || !platform.authUrl) {
    showToast(`${platform.name || 'This platform'} isn't an OAuth connection — add it from the Connections page.`, 'info');
    return;
  }

  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Connecting…';

  const baseLabel = 'My ' + (platform.name || platformId);
  const existingLabels = connections.map(c => c.label).filter(Boolean);
  let label = baseLabel;
  let idx = 1;
  while (existingLabels.includes(label)) {
    idx++;
    label = `${baseLabel} (${idx})`;
  }

  try {
    const opened = await initiateDirectOAuthFlow(platform, label);
    if (!opened) throw new Error('Could not open the connection popup — check your popup blocker and try again.');

    await waitForSetupConnectionRefresh(platformId);
    // Re-render so the status badge flips to "Connected" and this button hides.
    populateSetupView(currentP1Id, currentP2Id);
  } catch (err) {
    showToast('Connection failed: ' + err.message, 'error');
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

// initiateDirectOAuthFlow() (connections.js) dispatches a window
// 'connections-refreshed' CustomEvent once the popup's OAuth exchange
// finishes — { detail: { newConnectionId, platformId } } on success, or
// { detail: { platformId, failed: true } } on a failure/abandoned popup for
// THIS specific attempt.
//
// 'connections-refreshed' is also dispatched from ~10 other places in
// connections.js for entirely unrelated actions (delete, edit, save, reauth,
// etc.) — this used to be a real bug: the handler below removed itself and
// resolved/rejected on the very FIRST such event it ever saw, so an
// unrelated dispatch firing during the OAuth wait window would be misread
// as "this connect attempt failed," reject the promise, and skip the
// populateSetupView() re-render below even though the connection had
// genuinely just been saved — the status only ever caught up on a full page
// reload. Now only reacts to an event carrying THIS platformId (either a
// real success or an explicit failure) and ignores everything else.
async function waitForSetupConnectionRefresh(expectedPlatformId) {
  return new Promise((resolve, reject) => {
    const handler = (event) => {
      const detail = event.detail;
      if (!detail || detail.platformId !== expectedPlatformId) return; // not this attempt — ignore
      window.removeEventListener('connections-refreshed', handler);
      clearTimeout(timeoutId);
      if (detail.newConnectionId) {
        resolve(detail.newConnectionId);
      } else {
        reject(new Error('OAuth was not completed'));
      }
    };
    window.addEventListener('connections-refreshed', handler);

    const timeoutId = setTimeout(() => {
      window.removeEventListener('connections-refreshed', handler);
      reject(new Error('OAuth timed out'));
    }, 300000);
  });
}


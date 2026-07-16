/**
 * Onboarding wizard — guides new users through first config creation.
 * Replaces the simple "No Flows Found" empty state with a step-by-step flow.
 */
import { initiateDirectOAuthFlow, connections } from './connections.js';
import { showToast } from './toast.js';
import { setButtonLoading } from './loading-components.js';

let currentStep = 1;
let onboardState = { p1: null, p2: null, connection1: null, connection2: null };
let listenerCleanups = [];
// Populated once from Firestore (see loadPlatforms) — step 3 looks the full
// doc up by id here to pass into initiateDirectOAuthFlow, since onboardState
// only stores the plain id string (sync-configs expects a string platform key).
let cachedPlatforms = [];

export function initOnboarding(db, auth, onComplete) {
  cleanup();
  currentStep = 1;
  onboardState = { p1: null, p2: null, connection1: null, connection2: null };
  document.getElementById('table-body').innerHTML = renderWizard();
  bindStep1(db, auth, onComplete);
}

function cleanup() {
  listenerCleanups.forEach(fn => fn());
  listenerCleanups = [];
}

function renderWizard() {
  return `
    <tr class="table-empty-row">
      <td colspan="8">
        <div class="onboarding-wizard" style="max-width:600px;margin:0 auto;padding:40px 24px;">
          <div style="text-align:center;margin-bottom:32px;">
            <div style="font-size:2rem;margin-bottom:8px;">🚀</div>
            <h2 style="margin:0 0 4px;">Welcome to Velync</h2>
            <p style="color:var(--text-3);font-size:0.9rem;margin:0;">Let's set up your first sync in 3 quick steps</p>
          </div>
          <div class="onboarding-steps" style="display:flex;gap:8px;margin-bottom:32px;justify-content:center;">
            ${[1,2,3].map(i => `
              <div class="onboarding-step-indicator" data-step="${i}" style="
                width:32px;height:4px;border-radius:2px;
                background:${i === 1 ? 'var(--primary)' : 'var(--border)'};
                transition:background 0.3s;
              "></div>
            `).join('')}
          </div>
          <div id="onboarding-step-content">
            ${renderStep1()}
          </div>
        </div>
      </td>
    </tr>
    <style>
      .onboarding-card {
        background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:24px;
        margin-bottom:16px;transition:border-color 0.2s,box-shadow 0.2s;cursor:pointer;
      }
      .onboarding-card:hover { border-color:var(--primary);box-shadow:0 2px 12px rgba(110,86,207,0.08); }
      .onboarding-card.selected { border-color:var(--primary);box-shadow:0 0 0 2px var(--primary); }
      .onboarding-card h4 { margin:0 0 4px; }
      .onboarding-card p { margin:0;font-size:0.85rem;color:var(--text-3); }
      .onboarding-connector { display:flex;align-items:center;gap:12px;padding:12px 16px; }
      .onboarding-connector img { width:28px;height:28px;border-radius:6px; }
      .onboarding-connector .name { font-weight:500; }
      .onboarding-connector .status { font-size:0.8rem;color:var(--text-3);margin-left:auto; }
      .onboarding-btn {
        display:inline-flex;align-items:center;gap:6px;
        padding:10px 24px;border-radius:8px;font-size:0.9rem;font-weight:500;
        border:none;cursor:pointer;transition:opacity 0.2s;
      }
      .onboarding-btn:disabled { opacity:0.5;cursor:default; }
      .onboarding-btn-primary { background:var(--primary);color:#fff; }
      .onboarding-btn-secondary { background:var(--surface);color:var(--text);border:1px solid var(--border); }
      .onboarding-actions { display:flex;justify-content:space-between;margin-top:24px; }
    </style>
  `;
}

// ─────────────── Step 1: Connect your first account ───────────────

function renderStep1() {
  return `
    <h3 style="margin:0 0 4px;font-size:1.05rem;">1. Connect your first account</h3>
    <p style="margin:0 0 16px;color:var(--text-3);font-size:0.88rem;">Pick a platform to connect. You'll need at least one source and one destination.</p>
    <div id="step1-connection-list">
      <div style="text-align:center;padding:20px;color:var(--text-3);font-size:0.9rem;">Loading available platforms…</div>
    </div>
    <div class="onboarding-actions">
      <div></div>
      <button class="onboarding-btn onboarding-btn-primary" id="btn-step1-next" disabled>Next →</button>
    </div>
  `;
}

// GET /api/platforms — same server-mediated endpoint every other page's
// platform list now goes through, instead of a page-local Firestore read.
async function loadPlatforms(auth) {
  if (cachedPlatforms.length) return cachedPlatforms;
  const token = await auth.currentUser.getIdToken();
  const res = await fetch('/api/platforms', { headers: { 'Authorization': `Bearer ${token}` } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  cachedPlatforms = data.platforms;
  return cachedPlatforms;
}

async function bindStep1(db, auth, onComplete) {
  const list = document.getElementById('step1-connection-list');
  const nextBtn = document.getElementById('btn-step1-next');
  if (!list) return;

  try {
    const platforms = await loadPlatforms(auth);
    const active = platforms.filter(p => p.isActive !== false);

    list.innerHTML = active.map(p => `
      <div class="onboarding-card onboarding-platform" data-platform="${p.id || p.key}" data-name="${escHtml(p.name || p.id)}" style="display:flex;align-items:center;gap:12px;padding:14px 18px;">
        <div style="width:32px;height:32px;border-radius:8px;background:var(--bg);display:flex;align-items:center;justify-content:center;font-size:1.1rem;">${(p.name || '?')[0]}</div>
        <div style="flex:1;">
          <div style="font-weight:500;">${escHtml(p.name || p.id)}</div>
          <div style="font-size:0.8rem;color:var(--text-3);">${escHtml(p.description || '')}</div>
        </div>
        <input type="radio" name="onboard-p1" value="${p.id || p.key}" style="width:18px;height:18px;accent-color:var(--primary);">
      </div>
    `).join('');

    // Selection
    list.querySelectorAll('.onboarding-platform').forEach(card => {
      card.addEventListener('click', () => {
        list.querySelectorAll('.onboarding-platform').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        card.querySelector('input[type="radio"]').checked = true;
        onboardState.p1 = card.dataset.platform;
        nextBtn.disabled = false;
      });
    });
  } catch (err) {
    list.innerHTML = `<div style="text-align:center;padding:20px;color:var(--rose);">Failed to load platforms. <button class="btn btn-sm btn-secondary" onclick="location.reload()">Retry</button></div>`;
  }

  nextBtn.addEventListener('click', () => goStep2(db, auth, onComplete));
}

// ─────────────── Step 2: Connect second account ───────────────

function goStep2(db, auth, onComplete) {
  currentStep = 2;
  updateIndicators();
  const content = document.getElementById('onboarding-step-content');
  content.innerHTML = `
    <h3 style="margin:0 0 4px;font-size:1.05rem;">2. Connect a second account</h3>
    <p style="margin:0 0 16px;color:var(--text-3);font-size:0.88rem;">Choose another platform to sync with. Different from the first one.</p>
    <div id="step2-connection-list">
      <div style="text-align:center;padding:20px;color:var(--text-3);font-size:0.9rem;">Loading available platforms…</div>
    </div>
    <div class="onboarding-actions">
      <button class="onboarding-btn onboarding-btn-secondary" id="btn-step2-back">← Back</button>
      <button class="onboarding-btn onboarding-btn-primary" id="btn-step2-next" disabled>Next →</button>
    </div>
  `;
  bindStep2(db, auth, onComplete);
}

async function bindStep2(db, auth, onComplete) {
  const list = document.getElementById('step2-connection-list');
  const nextBtn = document.getElementById('btn-step2-next');
  const backBtn = document.getElementById('btn-step2-back');
  if (!list) return;

  try {
    const platforms = await loadPlatforms(auth);
    const filtered = platforms.filter(p => p.id !== onboardState.p1 && p.isActive !== false);

    list.innerHTML = filtered.map(p => `
      <div class="onboarding-card onboarding-platform" data-platform="${p.id || p.key}" data-name="${escHtml(p.name || p.id)}" style="display:flex;align-items:center;gap:12px;padding:14px 18px;">
        <div style="width:32px;height:32px;border-radius:8px;background:var(--bg);display:flex;align-items:center;justify-content:center;font-size:1.1rem;">${(p.name || '?')[0]}</div>
        <div style="flex:1;">
          <div style="font-weight:500;">${escHtml(p.name || p.id)}</div>
          <div style="font-size:0.8rem;color:var(--text-3);">${escHtml(p.description || '')}</div>
        </div>
        <input type="radio" name="onboard-p2" value="${p.id || p.key}" style="width:18px;height:18px;accent-color:var(--primary);">
      </div>
    `).join('') || '<div style="text-align:center;padding:20px;color:var(--text-3);">No other platforms available.</div>';

    list.querySelectorAll('.onboarding-platform').forEach(card => {
      card.addEventListener('click', () => {
        list.querySelectorAll('.onboarding-platform').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        card.querySelector('input[type="radio"]').checked = true;
        onboardState.p2 = card.dataset.platform;
        nextBtn.disabled = false;
      });
    });
  } catch (err) {
    list.innerHTML = `<div style="text-align:center;padding:20px;color:var(--rose);">Failed to load platforms. <button class="btn btn-sm btn-secondary" onclick="location.reload()">Retry</button></div>`;
  }

  nextBtn.addEventListener('click', () => goStep3(db, auth, onComplete));
  backBtn.addEventListener('click', () => backStep1(db, auth, onComplete));
}

function backStep1(db, auth, onComplete) {
  currentStep = 1;
  updateIndicators();
  const content = document.getElementById('onboarding-step-content');
  content.innerHTML = renderStep1();
  bindStep1(db, auth, onComplete);
}

// ─────────────── Step 3: Connect accounts & review ───────────────

function goStep3(db, auth, onComplete) {
  currentStep = 3;
  updateIndicators();
  const content = document.getElementById('onboarding-step-content');
  content.innerHTML = `
    <h3 style="margin:0 0 4px;font-size:1.05rem;">3. Connect and activate</h3>
    <p style="margin:0 0 16px;color:var(--text-3);font-size:0.88rem;">Connect your accounts and we'll create your first sync config.</p>
    <div id="step3-connections">
      <div class="onboarding-card" style="cursor:default;">
        <h4>Platform 1: ${escHtml(onboardState.p1)}</h4>
        <p id="step3-status-1" style="color:var(--text-3);">Not connected</p>
        <button class="btn btn-sm btn-primary" id="btn-connect-1" style="margin-top:8px;">Connect</button>
      </div>
      <div class="onboarding-card" style="cursor:default;">
        <h4>Platform 2: ${escHtml(onboardState.p2)}</h4>
        <p id="step3-status-2" style="color:var(--text-3);">Not connected</p>
        <button class="btn btn-sm btn-primary" id="btn-connect-2" style="margin-top:8px;">Connect</button>
      </div>
    </div>
    <div class="onboarding-actions">
      <button class="onboarding-btn onboarding-btn-secondary" id="btn-step3-back">← Back</button>
      <button class="onboarding-btn onboarding-btn-primary" id="btn-step3-finish" disabled>Create my first sync →</button>
    </div>
  `;
  bindStep3(db, auth, onComplete);
}

async function bindStep3(db, auth, onComplete) {
  const btn1 = document.getElementById('btn-connect-1');
  const btn2 = document.getElementById('btn-connect-2');
  const backBtn = document.getElementById('btn-step3-back');
  const finishBtn = document.getElementById('btn-step3-finish');

  if (btn1) {
    btn1.addEventListener('click', () => connectPlatform(1, btn1, finishBtn));
  }

  if (btn2) {
    btn2.addEventListener('click', () => connectPlatform(2, btn2, finishBtn));
  }

  if (backBtn) {
    backBtn.addEventListener('click', () => {
      currentStep = 2;
      updateIndicators();
      const content = document.getElementById('onboarding-step-content');
      // Reload platforms list for step 2
      content.innerHTML = `
        <h3 style="margin:0 0 4px;font-size:1.05rem;">2. Connect a second account</h3>
        <p style="margin:0 0 16px;color:var(--text-3);font-size:0.88rem;">Choose another platform to sync with. Different from the first one.</p>
        <div id="step2-connection-list">
          <div style="text-align:center;padding:20px;color:var(--text-3);font-size:0.9rem;">Loading available platforms…</div>
        </div>
        <div class="onboarding-actions">
          <button class="onboarding-btn onboarding-btn-secondary" id="btn-step2-back">← Back</button>
          <button class="onboarding-btn onboarding-btn-primary" id="btn-step2-next" disabled>Next →</button>
        </div>
      `;
      bindStep2(db, auth, onComplete);
    });
  }

  if (finishBtn) {
    finishBtn.addEventListener('click', async () => {
      setButtonLoading(finishBtn, true, 'Create my first sync →', 'Creating…');
      try {
        const token = await auth.currentUser.getIdToken();
        await createFirstConfig(token);
        cleanup();
        if (onComplete) onComplete();
      } catch (err) {
        showToast('Failed to create your first sync: ' + err.message, 'error');
        setButtonLoading(finishBtn, false, 'Create my first sync →');
      }
    });
  }
}

function checkStep3Ready(finishBtn) {
  if (onboardState.connection1 && onboardState.connection2) {
    finishBtn.disabled = false;
  }
}

// Reuses the exact OAuth popup flow the Connections page already relies on
// (connections.js#initiateDirectOAuthFlow) instead of the old direct
// `window.open('/api/auth/...')` call, which pointed at a route that has
// never existed in this backend — every real OAuth-initiation path in this
// app goes through the platform's own authUrl, built client-side.
async function connectPlatform(stepNum, btn, finishBtn) {
  const platformId = stepNum === 1 ? onboardState.p1 : onboardState.p2;
  const statusEl = document.getElementById(`step3-status-${stepNum}`);
  const platform = cachedPlatforms.find(p => p.id === platformId);
  if (!platform) {
    if (statusEl) statusEl.textContent = '✗ Platform not found — please go back and re-select it.';
    return;
  }

  // Manual/API-key platforms (no authUrl) have no popup flow to drive from
  // here — direct the user to the full Connections page rather than hang on
  // "Connecting…" indefinitely.
  if (!platform.authType || platform.authType !== 'oauth' || !platform.authUrl) {
    if (statusEl) statusEl.innerHTML = `${escHtml(platform.name)} isn't an OAuth connection — add it from the <strong>Connections</strong> page, then come back and finish this sync from the Flows tab.`;
    return;
  }

  setButtonLoading(btn, true, btn.textContent, 'Connecting…');

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

    const result = await waitForConnectionRefresh(platformId);
    if (stepNum === 1) onboardState.connection1 = result.connectionId;
    else onboardState.connection2 = result.connectionId;

    if (statusEl) {
      statusEl.textContent = `✓ Connected (${escHtml(result.label || label)})`;
      statusEl.style.color = 'var(--green)';
    }
    btn.style.display = 'none';
    checkStep3Ready(finishBtn);
  } catch (err) {
    if (statusEl) statusEl.textContent = '✗ Connection failed: ' + err.message;
    setButtonLoading(btn, false, 'Retry');
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
// etc.). This used to reject on the very FIRST such event seen regardless of
// relevance, so an unrelated dispatch during the wait window could falsely
// report "OAuth was not completed" even when the connection had genuinely
// just been saved. Now only reacts to an event carrying THIS platformId.
async function waitForConnectionRefresh(expectedPlatformId) {
  return new Promise((resolve, reject) => {
    const handler = (event) => {
      const detail = event.detail;
      if (!detail || detail.platformId !== expectedPlatformId) return; // not this attempt — ignore
      window.removeEventListener('connections-refreshed', handler);
      clearTimeout(timeoutId);
      if (detail.newConnectionId) {
        const conn = connections.find(c => c.id === detail.newConnectionId);
        resolve({ connectionId: detail.newConnectionId, label: conn?.label });
      } else {
        reject(new Error('OAuth was not completed'));
      }
    };
    window.addEventListener('connections-refreshed', handler);
    listenerCleanups.push(() => window.removeEventListener('connections-refreshed', handler));

    // Timeout after 5 minutes
    const timeoutId = setTimeout(() => {
      window.removeEventListener('connections-refreshed', handler);
      reject(new Error('OAuth timed out'));
    }, 300000);
  });
}

async function createFirstConfig(token) {
  const payload = {
    platform1: onboardState.p1,
    platform2: onboardState.p2,
    platform1ConnectionId: onboardState.connection1,
    platform2ConnectionId: onboardState.connection2,
    status: 'active',
    description: 'My first sync',
    fieldMappings: [],
  };

  const resp = await fetch('/api/sync-configs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  const result = await resp.json();
  if (!resp.ok) throw new Error(result.error || 'Failed to create config');
}

function updateIndicators() {
  document.querySelectorAll('.onboarding-step-indicator').forEach(el => {
    const step = parseInt(el.dataset.step);
    el.style.background = step <= currentStep ? 'var(--primary)' : 'var(--border)';
  });
}

function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

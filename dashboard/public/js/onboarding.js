/**
 * Onboarding wizard — guides new users through first config creation.
 * Replaces the simple "No Flows Found" empty state with a step-by-step flow.
 */

let currentStep = 1;
let onboardState = { p1: null, p2: null, connection1: null, connection2: null };
let listenerCleanups = [];

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

async function bindStep1(db, auth, onComplete) {
  const list = document.getElementById('step1-connection-list');
  const nextBtn = document.getElementById('btn-step1-next');
  if (!list) return;

  try {
    const token = await auth.currentUser.getIdToken();
    const res = await fetch('/api/platforms', {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const platforms = await res.json();
    const active = (Array.isArray(platforms) ? platforms : platforms.platforms || [])
      .filter(p => p.isActive !== false);

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
    const token = await auth.currentUser.getIdToken();
    const res = await fetch('/api/platforms', {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const platforms = await res.json();
    const filtered = (Array.isArray(platforms) ? platforms : platforms.platforms || [])
      .filter(p => (p.id || p.key) !== onboardState.p1 && p.isActive !== false);

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
    btn1.addEventListener('click', async () => {
      btn1.disabled = true;
      btn1.textContent = 'Connecting…';
      try {
        const token = await auth.currentUser.getIdToken();
        const win = window.open(`/api/auth/${onboardState.p1}?token=${token}&mode=popup`, 'oauth', 'width=600,height=700');
        const result = await waitForOAuth();
        onboardState.connection1 = result.connectionId;
        document.getElementById('step3-status-1').textContent = `✓ Connected (${escHtml(result.label || '')})`;
        document.getElementById('step3-status-1').style.color = 'var(--green)';
        btn1.style.display = 'none';
        checkStep3Ready(finishBtn);
      } catch (err) {
        document.getElementById('step3-status-1').textContent = '✗ Connection failed: ' + err.message;
        btn1.disabled = false;
        btn1.textContent = 'Retry';
      }
    });
  }

  if (btn2) {
    btn2.addEventListener('click', async () => {
      btn2.disabled = true;
      btn2.textContent = 'Connecting…';
      try {
        const token = await auth.currentUser.getIdToken();
        const win = window.open(`/api/auth/${onboardState.p2}?token=${token}&mode=popup`, 'oauth', 'width=600,height=700');
        const result = await waitForOAuth();
        onboardState.connection2 = result.connectionId;
        document.getElementById('step3-status-2').textContent = `✓ Connected (${escHtml(result.label || '')})`;
        document.getElementById('step3-status-2').style.color = 'var(--green)';
        btn2.style.display = 'none';
        checkStep3Ready(finishBtn);
      } catch (err) {
        document.getElementById('step3-status-2').textContent = '✗ Connection failed: ' + err.message;
        btn2.disabled = false;
        btn2.textContent = 'Retry';
      }
    });
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
      finishBtn.disabled = true;
      finishBtn.textContent = 'Creating…';
      try {
        const token = await auth.currentUser.getIdToken();
        await createFirstConfig(token);
        cleanup();
        if (onComplete) onComplete();
      } catch (err) {
        finishBtn.disabled = false;
        finishBtn.textContent = 'Create my first sync →';
      }
    });
  }
}

function checkStep3Ready(finishBtn) {
  if (onboardState.connection1 && onboardState.connection2) {
    finishBtn.disabled = false;
  }
}

async function waitForOAuth() {
  return new Promise((resolve, reject) => {
    const handler = (event) => {
      if (event.data?.type === 'oauth-success') {
        window.removeEventListener('message', handler);
        resolve(event.data);
      } else if (event.data?.type === 'oauth-error') {
        window.removeEventListener('message', handler);
        reject(new Error(event.data.error || 'OAuth failed'));
      }
    };
    window.addEventListener('message', handler);
    listenerCleanups.push(() => window.removeEventListener('message', handler));

    // Timeout after 5 minutes
    setTimeout(() => {
      window.removeEventListener('message', handler);
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

import { doc, getDoc, collection, getDocs, query, orderBy } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-firestore.js";
import { showToast } from './toast.js';

let firestoreDb = null;
let auth = null;

export async function initBilling(dbInstance, authInstance) {
  firestoreDb = dbInstance;
  auth = authInstance;

  const display = document.getElementById('billing-plan-display');
  const subArea = document.getElementById('billing-subscription-area');
  const checkoutArea = document.getElementById('billing-checkout-area');
  if (!display) return;

  try {
    const token = await auth.currentUser.getIdToken();
    const res = await fetch('/api/billing/plan', {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) {
      display.innerHTML = '<div style="color:var(--rose);font-size:0.9rem;">Failed to load plan info.</div>';
      return;
    }
    const data = await res.json();

    if (!data.success) {
      display.innerHTML = '<div style="color:var(--rose);font-size:0.9rem;">' + (data.error || 'Failed to load plan') + '</div>';
      return;
    }

    const { plan, subscription, usage } = data;

    // Current plan card
    display.innerHTML = `
      <div class="billing-card current-plan" style="padding: 20px; border: 1px solid var(--border); border-radius: 12px;">
        <div class="plan-header" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
          <h3 style="margin:0;">${escHtml(plan.name)} Tier</h3>
          <span class="plan-price" style="font-size:1.8rem;font-weight:700;">
            ${plan.priceMonthly === 0 ? 'Free' : '$' + plan.priceMonthly + '<span style="font-size:0.9rem;font-weight:400;">/mo</span>'}
          </span>
        </div>
        <ul class="plan-features" style="margin:0 0 16px;padding:0;list-style:none;">
          <li style="padding:4px 0;">✓ ${plan.maxActiveConfigs} active config${plan.maxActiveConfigs !== 1 ? 's' : ''} maximum</li>
          <li style="padding:4px 0;">✓ ${plan.minSyncIntervalMinutes}-minute minimum sync interval</li>
          <li style="padding:4px 0;">✓ ${plan.maxItemsPerRun} items max per run</li>
          <li style="padding:4px 0;">✓ ${plan.logRetentionDays}-day log retention</li>
          <li style="padding:4px 0;">✓ Connectors: ${(plan.connectorTiers || ['basic']).join(', ')}</li>
        </ul>
        ${renderUsageLine(usage.activeConfigs, plan.maxActiveConfigs)}
      </div>
    `;

    // Subscription info or upgrade prompt.
    // Show the "Manage Subscription" (portal) button whenever a Stripe
    // customer record exists — not just when status is 'active'. A past_due
    // subscription still has a customer/subscription on file (only a full
    // cancellation clears stripeSubscriptionId), and those are exactly the
    // users who most need to reach the portal to fix their payment method.
    if (subscription.stripeCustomerId) {
      let statusBanner = '';
      if (subscription.status === 'past_due') {
        statusBanner = `<p style="margin:0 0 12px;color:var(--rose);font-size:0.85rem;font-weight:600;">⚠️ Your payment is past due. Please update your billing info to avoid service interruption.</p>`;
      } else if (subscription.status === 'canceled') {
        statusBanner = `<p style="margin:0 0 12px;color:var(--text-2);font-size:0.85rem;">Your subscription was canceled. You're currently on the Free plan.</p>`;
      }
      subArea.innerHTML = `
        <div class="billing-card" style="padding: 20px; border: 1px solid var(--border); border-radius: 12px;">
          <h4 style="margin:0 0 8px;">Subscription</h4>
          <p style="margin:0 0 4px;color:var(--text-2);">Status: <strong>${escHtml(subscription.status)}</strong> · ${escHtml(subscription.billingInterval)}</p>
          <p style="margin:0 0 12px;color:var(--text-3);font-size:0.85rem;">
            ${subscription.currentPeriodEnd ? 'Current period ends: ' + new Date(subscription.currentPeriodEnd).toLocaleDateString() : ''}
          </p>
          ${statusBanner}
          <button class="btn btn-secondary btn-sm" id="btn-manage-billing">Manage Subscription →</button>
        </div>
      `;
      document.getElementById('btn-manage-billing')?.addEventListener('click', openPortal);
    }

    // Available plans for upgrade — cached (plans change rarely and this is
    // a full-collection read on every tab open otherwise).
    let allPlans = window.__getViewCache ? window.__getViewCache('billing-plans') : null;
    if (!allPlans) {
      const plansSnap = await getDocs(query(collection(firestoreDb, 'plans'), orderBy('sortOrder', 'asc')));
      allPlans = [];
      plansSnap.forEach(d => allPlans.push({ id: d.id, ...d.data() }));
      if (window.__setViewCache) window.__setViewCache('billing-plans', allPlans);
    }

    const upgradePlans = allPlans.filter(p => p.id !== plan.id && p.isActive && p.priceMonthly > 0);
    if (upgradePlans.length > 0) {
      checkoutArea.innerHTML = `
        <h4 style="margin:0 0 12px;">Available Upgrades</h4>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:16px;">
          ${upgradePlans.map(p => `
            <div class="billing-card upgrade-plan" style="padding:16px;border:1px solid var(--primary);border-radius:12px;background:rgba(110,86,207,0.05);">
              <h4 style="margin:0 0 4px;">${escHtml(p.name)}</h4>
              <div style="font-size:1.5rem;font-weight:700;margin-bottom:8px;">
                $${p.priceMonthly}<span style="font-size:0.85rem;font-weight:400;">/mo</span>
              </div>
              <ul style="margin:0 0 12px;padding:0 0 0 16px;font-size:0.85rem;color:var(--text-2);">
                <li>${p.maxActiveConfigs} configs</li>
                <li>${p.minSyncIntervalMinutes} min interval</li>
                <li>${p.maxItemsPerRun} items/run</li>
                <li>${(p.connectorTiers || []).join(', ')} connectors</li>
              </ul>
              <button class="btn btn-primary btn-sm checkout-btn" data-plan="${p.id}" data-interval="monthly" style="width:100%;">Upgrade</button>
              ${p.priceAnnual > 0 ? `<button class="btn btn-secondary btn-sm checkout-btn" data-plan="${p.id}" data-interval="annual" style="width:100%;margin-top:6px;">$${p.priceAnnual}/yr</button>` : ''}
            </div>
          `).join('')}
        </div>
      `;
      checkoutArea.querySelectorAll('.checkout-btn').forEach(btn => {
        btn.addEventListener('click', () => startCheckout(btn.dataset.plan, btn.dataset.interval));
      });
    }
  } catch (err) {
    display.innerHTML = '<div style="color:var(--rose);font-size:0.9rem;">Error: ' + err.message + '</div>';
  }
}

async function startCheckout(planId, interval) {
  try {
    const token = await auth.currentUser.getIdToken();
    const res = await fetch('/api/billing/create-checkout-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ planId, billingInterval: interval }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Checkout failed');
    if (data.url) window.location.href = data.url;
  } catch (err) {
    showToast('Failed to start checkout: ' + err.message, 'error');
  }
}

async function openPortal() {
  try {
    const token = await auth.currentUser.getIdToken();
    const res = await fetch('/api/billing/create-portal-session', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Portal session failed');
    if (data.url) window.location.href = data.url;
  } catch (err) {
    showToast('Failed to open billing portal: ' + err.message, 'error');
  }
}

function renderUsageLine(used, max) {
  const ratio = max > 0 ? used / max : 0;
  const atLimit = max > 0 && used >= max;
  const nearLimit = !atLimit && ratio >= 0.8;
  const color = atLimit ? 'var(--rose)' : nearLimit ? '#f59e0b' : 'var(--text-3)';
  const weight = (atLimit || nearLimit) ? '600' : '400';
  const suffix = atLimit
    ? ' — limit reached, upgrade to add more'
    : nearLimit
      ? ' — approaching your limit'
      : '';
  return `<div style="font-size:0.85rem;color:${color};font-weight:${weight};">${used} of ${max} configs in use${suffix}</div>`;
}

function escHtml(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

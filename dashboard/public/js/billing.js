import { doc, getDoc, collection, getDocs, query, orderBy } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-firestore.js";
import { showToast } from './toast.js';
import { confirmDialog } from './confirm.js';
import { updatePlanBadge } from './plan-badge.js';

let firestoreDb = null;
let auth = null;
// Guards every subscription-mutating action (checkout swap / downgrade / undo)
// so a second click while the first request is still in flight can't fire a
// duplicate call to Lemon Squeezy (which was producing repeated plan changes).
let billingActionInFlight = false;

function setBillingButtonsDisabled(disabled) {
  document
    .querySelectorAll('#billing-checkout-area button, #billing-subscription-area button')
    .forEach((b) => { b.disabled = disabled; });
}

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

    // Keep the avatar's paid-plan badge in sync with whatever this tab just
    // fetched — reuses this response instead of a second round trip.
    updatePlanBadge(plan);

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

    // Subscription info. Always render something here — previously this
    // whole block was skipped for anyone without a Lemon Squeezy customer
    // record (every Free-tier user who never checked out), leaving a silent
    // gap instead of an explicit "you have no active subscription" state.
    if (subscription.lsCustomerId) {
      let statusBanner = '';
      if (subscription.cancelAtPeriodEnd) {
        statusBanner = `<p style="margin:0 0 12px;color:var(--rose);font-size:0.85rem;font-weight:600;">
          Your plan will downgrade to Free on ${subscription.currentPeriodEnd ? new Date(subscription.currentPeriodEnd).toLocaleDateString() : 'the end of your current period'}.
          <a href="#" id="btn-undo-downgrade" style="color:var(--primary);">Keep my plan</a>
        </p>`;
      } else if (subscription.status === 'past_due') {
        statusBanner = `<p style="margin:0 0 12px;color:var(--rose);font-size:0.85rem;font-weight:600;">⚠️ Your payment is past due. Please update your billing info to avoid service interruption.</p>`;
      } else if (subscription.status === 'canceled') {
        statusBanner = `<p style="margin:0 0 12px;color:var(--text-2);font-size:0.85rem;">Your subscription was canceled. You're currently on the Free plan.</p>`;
      }
      subArea.innerHTML = `
        <div class="billing-card" style="padding: 20px; border: 1px solid var(--border); border-radius: 12px;">
          <h4 style="margin:0 0 8px;">Subscription</h4>
          <p style="margin:0 0 4px;color:var(--text-2);">Status: <strong>${escHtml(subscription.status)}</strong></p>
          <p style="margin:0 0 12px;color:var(--text-3);font-size:0.85rem;">
            ${subscription.currentPeriodEnd ? 'Current period ends: ' + new Date(subscription.currentPeriodEnd).toLocaleDateString() : ''}
          </p>
          ${statusBanner}
          <button class="btn btn-secondary btn-sm" id="btn-manage-billing">Manage Subscription →</button>
        </div>
      `;
      document.getElementById('btn-manage-billing')?.addEventListener('click', openPortal);
      document.getElementById('btn-undo-downgrade')?.addEventListener('click', (e) => {
        e.preventDefault();
        setDowngrade(true, e.currentTarget);
      });
    } else if (plan.priceMonthly === 0) {
      subArea.innerHTML = `
        <div class="billing-card" style="padding: 20px; border: 1px solid var(--border); border-radius: 12px;">
          <h4 style="margin:0 0 8px;">Subscription</h4>
          <p style="margin:0;color:var(--text-2);font-size:0.9rem;">You're on the Free plan — no active subscription.</p>
        </div>
      `;
    } else {
      // A paid planId with no Lemon Squeezy customer on file — the plan was
      // granted without ever going through checkout (e.g. set directly in
      // Firestore). Don't claim they're on Free when the plan card above
      // correctly shows otherwise; billing just isn't linked to a subscription.
      subArea.innerHTML = `
        <div class="billing-card" style="padding: 20px; border: 1px solid var(--border); border-radius: 12px;">
          <h4 style="margin:0 0 8px;">Subscription</h4>
          <p style="margin:0;color:var(--text-2);font-size:0.9rem;">
            You're on the ${escHtml(plan.name)} plan, but no billing subscription is on file — this plan was set up outside of checkout. Contact support if this seems wrong.
          </p>
        </div>
      `;
    }

    // Available plans — cached (plans change rarely and this is a
    // full-collection read on every tab open otherwise).
    let allPlans = window.__getViewCache ? window.__getViewCache('billing-plans') : null;
    if (!allPlans) {
      const plansSnap = await getDocs(query(collection(firestoreDb, 'plans'), orderBy('sortOrder', 'asc')));
      allPlans = [];
      plansSnap.forEach(d => allPlans.push({ id: d.id, ...d.data() }));
      if (window.__setViewCache) window.__setViewCache('billing-plans', allPlans);
    }

    // Split by actual price relative to the current plan — plans cheaper
    // than the current one were previously lumped into "Available Upgrades"
    // and labeled with an "Upgrade" button, which is backwards.
    const otherPlans = allPlans.filter(p => p.id !== plan.id && p.isActive);
    const upgradePlans = otherPlans.filter(p => p.priceMonthly > plan.priceMonthly);
    const downgradePlans = otherPlans.filter(p => p.priceMonthly > 0 && p.priceMonthly < plan.priceMonthly);
    // Only offer an actionable "Downgrade to Free" when there's a real
    // subscription to cancel. A paid planId with no lsSubscriptionId (plan
    // granted outside checkout) has nothing for the backend to downgrade —
    // that combination is flagged informationally instead, in the
    // Subscription card above.
    const canDowngradeToFree = plan.priceMonthly > 0 && !!subscription.lsSubscriptionId;

    const planCard = (p, buttonLabel) => `
      <div class="billing-card" style="padding:16px;border:1px solid var(--border);border-radius:12px;">
        <h4 style="margin:0 0 4px;">${escHtml(p.name)}</h4>
        <div style="font-size:1.5rem;font-weight:700;margin-bottom:8px;">
          ${p.priceMonthly === 0 ? 'Free' : `$${p.priceMonthly}<span style="font-size:0.85rem;font-weight:400;">/mo</span>`}
        </div>
        <ul style="margin:0 0 12px;padding:0 0 0 16px;font-size:0.85rem;color:var(--text-2);">
          <li>${p.maxActiveConfigs} configs</li>
          <li>${p.minSyncIntervalMinutes} min interval</li>
          <li>${p.maxItemsPerRun} items/run</li>
          <li>${(p.connectorTiers || []).join(', ')} connectors</li>
        </ul>
        ${p.lsVariantIdMonthly ? `<button class="btn btn-primary btn-sm checkout-btn" data-plan="${p.id}" style="width:100%;">${buttonLabel}</button>` : ''}
      </div>
    `;

    let checkoutHtml = '';
    if (upgradePlans.length > 0) {
      checkoutHtml += `
        <h4 style="margin:0 0 12px;">Available Upgrades</h4>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:16px;margin-bottom:24px;">
          ${upgradePlans.map(p => planCard(p, 'Upgrade')).join('')}
        </div>
      `;
    }
    if (downgradePlans.length > 0 || canDowngradeToFree) {
      checkoutHtml += `
        <h4 style="margin:0 0 12px;">Downgrade Options</h4>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:16px;">
          ${downgradePlans.map(p => planCard(p, 'Downgrade')).join('')}
          ${canDowngradeToFree ? `
            <div class="billing-card" style="padding:16px;border:1px solid var(--border);border-radius:12px;">
              <h4 style="margin:0 0 4px;">Free</h4>
              <div style="font-size:1.5rem;font-weight:700;margin-bottom:8px;">$0</div>
              <p style="margin:0 0 12px;font-size:0.85rem;color:var(--text-2);">
                You'll keep ${escHtml(plan.name)} access until ${subscription.currentPeriodEnd ? new Date(subscription.currentPeriodEnd).toLocaleDateString() : 'your current period ends'}, then switch to Free.
              </p>
              <button class="btn btn-secondary btn-sm" id="btn-downgrade-free" style="width:100%;">Downgrade to Free</button>
            </div>
          ` : ''}
        </div>
      `;
    }
    checkoutArea.innerHTML = checkoutHtml;
    checkoutArea.querySelectorAll('.checkout-btn').forEach(btn => {
      btn.addEventListener('click', () => startCheckout(btn.dataset.plan, btn));
    });
    document.getElementById('btn-downgrade-free')?.addEventListener('click', (e) => setDowngrade(false, e.currentTarget));
  } catch (err) {
    display.innerHTML = '<div style="color:var(--rose);font-size:0.9rem;">Error: ' + err.message + '</div>';
  }
}

async function startCheckout(planId, btn) {
  if (billingActionInFlight) return;
  billingActionInFlight = true;
  const originalText = btn ? btn.textContent : '';
  if (btn) btn.textContent = 'Processing…';
  setBillingButtonsDisabled(true);
  try {
    const token = await auth.currentUser.getIdToken();
    const res = await fetch('/api/billing/create-checkout-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ planId }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Checkout failed');
    if (data.url) {
      // Redirecting to Lemon Squeezy's hosted checkout — leave the buttons
      // disabled through navigation so they can't be re-clicked mid-redirect.
      window.location.href = data.url;
      return;
    } else if (data.updated) {
      // Existing subscription's price was swapped in place — no redirect. The
      // backend already optimistically updated planId, so this re-fetch shows
      // the new plan immediately.
      showToast('Plan updated', 'success');
      if (window.__setViewCache) window.__setViewCache('billing-plans', null);
      await initBilling(firestoreDb, auth); // rebuilds the buttons
    }
  } catch (err) {
    showToast('Failed to start checkout: ' + err.message, 'error');
    if (btn && document.body.contains(btn)) btn.textContent = originalText;
    setBillingButtonsDisabled(false);
  } finally {
    billingActionInFlight = false;
  }
}

async function setDowngrade(undo, btn) {
  if (billingActionInFlight) return;
  if (!undo) {
    const confirmed = await confirmDialog({
      title: 'Downgrade to Free?',
      message: "You'll keep your current plan's access until the end of the billing period you've already paid for, then automatically switch to Free.",
      confirmText: 'Downgrade to Free',
      confirmClass: 'btn-danger',
    });
    if (!confirmed) return;
  }
  billingActionInFlight = true;
  setBillingButtonsDisabled(true);
  try {
    const token = await auth.currentUser.getIdToken();
    const res = await fetch('/api/billing/downgrade-to-free', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ undo }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to update subscription');
    showToast(undo ? 'Downgrade canceled — you\'re keeping your plan' : 'Scheduled downgrade to Free', 'success');
    await initBilling(firestoreDb, auth); // rebuilds the buttons
  } catch (err) {
    showToast('Failed to update subscription: ' + err.message, 'error');
    setBillingButtonsDisabled(false);
  } finally {
    billingActionInFlight = false;
  }
}

async function openPortal() {
  if (billingActionInFlight) return;
  billingActionInFlight = true;
  setBillingButtonsDisabled(true);
  try {
    const token = await auth.currentUser.getIdToken();
    const res = await fetch('/api/billing/create-portal-session', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Portal session failed');
    if (data.url) {
      window.location.href = data.url; // leaving the page — keep buttons disabled
      return;
    }
    setBillingButtonsDisabled(false);
  } catch (err) {
    showToast('Failed to open billing portal: ' + err.message, 'error');
    setBillingButtonsDisabled(false);
  } finally {
    billingActionInFlight = false;
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

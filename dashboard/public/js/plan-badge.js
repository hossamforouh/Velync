// Small "paid plan" badge on the user avatar + a matching pill in the avatar
// dropdown. Shown for any plan with priceMonthly > 0 — not hardcoded to
// "Pro"/"Business" by name, since plans are admin-editable Firestore docs
// (see CLAUDE.md) and a superadmin can rename/add tiers at any time. The
// badge text always reflects the plan's actual configured name.

function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const CROWN_SVG = `<svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
  <path d="M2.5 19h19l-1.2-8.5-4.8 3.6L12 7l-3.5 7.1-4.8-3.6L2.5 19z"/>
</svg>`;

/** Apply plan data (as returned by GET /api/billing/plan's `plan` field) to the badge + pill. */
export function updatePlanBadge(plan) {
  const badge = document.getElementById('user-plan-badge');
  const pill = document.getElementById('dropdown-plan-pill');
  const isPaid = !!plan && Number(plan.priceMonthly) > 0;
  const name = isPaid ? String(plan.name || 'Paid') : '';

  if (badge) {
    badge.style.display = isPaid ? 'flex' : 'none';
    badge.title = isPaid ? `${name} plan` : '';
    if (isPaid && !badge.dataset.rendered) {
      badge.innerHTML = CROWN_SVG;
      badge.dataset.rendered = '1';
    }
  }
  if (pill) {
    pill.style.display = isPaid ? 'inline-flex' : 'none';
    pill.textContent = isPaid ? escHtml(name) : '';
  }
}

/** Fetch the current workspace's plan and apply it. Fails silently — a
 * missing badge is a cosmetic gap, never worth surfacing as an error toast. */
export async function loadAndApplyPlanBadge(auth) {
  try {
    const token = await auth.currentUser.getIdToken();
    const res = await fetch('/api/billing/plan', { headers: { 'Authorization': `Bearer ${token}` } });
    if (!res.ok) return;
    const data = await res.json();
    if (data.success) updatePlanBadge(data.plan);
  } catch (err) {
    console.error('Failed to load plan badge:', err);
  }
}

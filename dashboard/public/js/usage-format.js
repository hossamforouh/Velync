// Shared formatting/rendering helpers for usage/cost data — used by the
// Admin Workspaces tab's usage-stats modal. Dollar figures are estimates
// (count × configured rate, see app_settings/usage_rates) and are labeled
// as such everywhere they appear; never presented as invoice-grade.

export const TYPE_LABELS = {
  sync_execution: 'Sync Executions',
  compute_estimate: 'Compute (ms)',
  api_call: 'Platform API Calls',
  firestore_read: 'Firestore Reads',
  firestore_write: 'Firestore Writes',
  firestore_delete: 'Firestore Deletes',
  user_login: 'Logins',
  workspace_created: 'Workspaces Created',
  member_invited: 'Members Invited',
  flow_created: 'Flows Created',
  field_mapping_changed: 'Field Mapping Changes',
  platform_connected: 'Platforms Connected',
};

// One dot color per activity type, cycling through the app's existing brand
// palette (var(--violet)/--indigo/--cyan/--rose/--amber/--green — see :root
// in style.css) so this slots visually into the rest of the admin UI instead
// of inventing new colors.
const TYPE_COLOR_CYCLE = ['violet', 'indigo', 'cyan', 'rose', 'amber', 'green'];
const TYPE_COLORS = Object.fromEntries(
  Object.keys(TYPE_LABELS).map((type, i) => [type, TYPE_COLOR_CYCLE[i % TYPE_COLOR_CYCLE.length]])
);

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function fmtCost(v) {
  if (v === null || v === undefined) return '—';
  if (v === 0) return '$0.00';
  // Per-unit Firestore rates are tiny — show enough precision to be meaningful
  // (a single sync execution is ~$0.0000004 and must not render as $0.000000).
  if (v < 0.000001) return `$${v.toFixed(9)}`;
  return v < 0.01 ? `$${v.toFixed(6)}` : `$${v.toFixed(2)}`;
}

export function fmtCount(v) {
  return Number(v || 0).toLocaleString();
}

/**
 * Build a grid of stat cards for one entity's (workspace, in practice) usage
 * breakdown for a month — one card per activity type showing count and,
 * for cost-driving types, the estimated $ alongside it. Cards with zero
 * activity are visually de-emphasized rather than hidden, so the grid shape
 * stays stable and an admin can see at a glance what simply hasn't happened
 * yet vs. what's actively costing money.
 */
export function renderUsageStatCardsHtml(activityTypes, entity) {
  const cards = activityTypes.map(({ type, costDriving }) => {
    const cell = entity.totals[type] || { count: 0, costUsd: costDriving ? 0 : null };
    const isEmpty = !cell.count;
    const color = TYPE_COLORS[type] || 'violet';
    return `
      <div class="usage-stat-card${isEmpty ? ' usage-stat-card-empty' : ''}">
        <div class="usage-stat-card-label"><span class="dot ${color}"></span>${escapeHtml(TYPE_LABELS[type] || type)}</div>
        <div class="usage-stat-card-count">${fmtCount(cell.count)}</div>
        ${costDriving
          ? `<div class="usage-stat-card-cost">${fmtCost(cell.costUsd)} <span class="usage-stat-est-tag">est.</span></div>`
          : `<div class="usage-stat-card-cost usage-stat-card-nocost">no direct cost</div>`}
      </div>`;
  }).join('');

  return `
    <div class="usage-hero-total">
      <div class="usage-hero-total-label">Total Estimated Cost</div>
      <div class="usage-hero-total-value">${fmtCost(entity.grandTotalCostUsd)}</div>
      <div class="usage-hero-total-caption">Estimate only — count × configured rate, not invoice-grade</div>
    </div>
    <div class="usage-stat-grid">${cards}</div>`;
}

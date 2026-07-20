// Shared formatting/rendering helpers for usage/cost data — used by the
// Admin Workspaces tab's usage-stats modal. Dollar figures are estimates
// (count × configured rate, see app_settings/usage_rates) and are labeled
// as such everywhere they appear; never presented as invoice-grade.

export const TYPE_LABELS = {
  sync_execution: 'Sync Executions',
  compute_estimate: 'Compute (ms)',
  api_call: 'Platform API Calls',
  ai_mapping_suggestion: 'AI Mapping Suggestions',
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
 * Render one entity's (workspace, in practice) usage breakdown for a month,
 * organized for quick analysis rather than a flat wall of equal cards:
 *
 *   1. Hero — the one number that matters (total estimated cost) + scope note.
 *   2. Cost drivers — ONLY the things that actually cost money, ranked biggest
 *      first, each with a proportion bar + $ + share-% so "what's driving this
 *      workspace's cost" is answerable at a glance (e.g. "AI is 70% of it").
 *   3. Activity — the no-direct-cost counts (logins, flows, …) as compact
 *      chips, de-emphasized since they don't affect the bill.
 *
 * This replaces the old 12-equal-cards grid, which forced the reader to hunt
 * through cost and non-cost items at the same visual weight.
 */
export function renderUsageBreakdownHtml(activityTypes, entity) {
  const total = Number(entity.grandTotalCostUsd) || 0;

  // Cost drivers: cost-driving types that actually incurred cost, ranked desc.
  const drivers = activityTypes
    .filter(({ costDriving }) => costDriving)
    .map(({ type }) => {
      const cell = entity.totals[type] || { count: 0, costUsd: 0 };
      return { type, count: cell.count || 0, cost: Number(cell.costUsd) || 0 };
    })
    .filter(d => d.cost > 0 || d.count > 0)
    .sort((a, b) => b.cost - a.cost);

  const driversHtml = drivers.length
    ? drivers.map(d => {
        const pct = total > 0 ? Math.round((d.cost / total) * 100) : 0;
        const color = TYPE_COLORS[d.type] || 'violet';
        return `
          <div class="usage-driver-row">
            <div class="usage-driver-head">
              <span class="usage-driver-label"><span class="dot ${color}"></span>${escapeHtml(TYPE_LABELS[d.type] || d.type)}</span>
              <span class="usage-driver-cost">${fmtCost(d.cost)}<span class="usage-driver-pct">${pct}%</span></span>
            </div>
            <div class="usage-driver-bar"><span class="usage-driver-bar-fill ${color}" style="width:${Math.max(pct, 2)}%"></span></div>
            <div class="usage-driver-count">${fmtCount(d.count)} ${escapeHtml((TYPE_LABELS[d.type] || '').toLowerCase()) || 'events'}</div>
          </div>`;
      }).join('')
    : `<div class="usage-empty-note">No billable activity recorded this month.</div>`;

  // Activity: intensity metrics (no direct cost) as compact chips.
  const activity = activityTypes.filter(({ costDriving }) => !costDriving);
  const activityHtml = activity.map(({ type }) => {
    const cell = entity.totals[type] || { count: 0 };
    const isEmpty = !cell.count;
    return `
      <div class="usage-chip${isEmpty ? ' usage-chip-empty' : ''}">
        <span class="usage-chip-count">${fmtCount(cell.count)}</span>
        <span class="usage-chip-label">${escapeHtml(TYPE_LABELS[type] || type)}</span>
      </div>`;
  }).join('');

  return `
    <div class="usage-hero-total">
      <div class="usage-hero-total-label">Total Estimated Cost</div>
      <div class="usage-hero-total-value">${fmtCost(total)}</div>
      <div class="usage-hero-total-caption">Estimate only — tracked internal operations (syncs, AI, database). Excludes fixed infrastructure &amp; dashboard usage.</div>
    </div>

    <div class="usage-section-title">Cost drivers</div>
    <div class="usage-drivers">${driversHtml}</div>

    <div class="usage-section-title">Activity <span class="usage-section-sub">no direct cost</span></div>
    <div class="usage-chips">${activityHtml}</div>`;
}

// Back-compat alias — the previous flat-grid renderer's name. Kept so any
// caller not yet updated still works; new layout applies either way.
export const renderUsageStatCardsHtml = renderUsageBreakdownHtml;

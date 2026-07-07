const { CronExpressionParser } = require('cron-parser');
const db = require('./db');
const logger = require('./logger');

const planCache = { data: new Map(), time: 0 };
const PLAN_CACHE_TTL = 120_000;

// Flat cap on total sync_configs per workspace (draft + active + paused).
// enforcePlanLimits()'s maxActiveConfigs check only looks at active configs,
// so without this an unlimited number of drafts could still be created,
// growing the DB unboundedly. This is deliberately generous — it's a growth
// guard, not a monetization lever, so it isn't part of the per-plan schema.
const TOTAL_CONFIG_CAP = 200;

/**
 * Reject creating a new sync config once a workspace holds TOTAL_CONFIG_CAP
 * configs of any status. Only meant to be called on create (POST), not
 * update (PUT) — updating an existing config doesn't add to the total.
 * @param {string} workspaceId
 * @returns {Promise<void>}
 */
async function enforceTotalConfigCap(workspaceId) {
  const totalSnap = await db.collection('workspaces').doc(workspaceId)
    .collection('sync_configs').count().get();
  if (totalSnap.data().count >= TOTAL_CONFIG_CAP) {
    throw new Error(
      `This workspace has reached the maximum of ${TOTAL_CONFIG_CAP} sync configs (including drafts). Delete unused configs to add more.`
    );
  }
}

/**
 * Fetch a plan document with a short-lived in-memory cache.
 * Caches the entire plans collection on first miss so subsequent lookups are instant.
 * @param {string} planId
 * @returns {Promise<object|null>}
 */
async function getPlan(planId) {
  if (planCache.time > Date.now() - PLAN_CACHE_TTL) {
    const cached = planCache.data.get(planId);
    if (cached) return cached;
  }
  const doc = await db.collection('plans').doc(planId).get();
  if (!doc.exists) return null;
  // Refresh entire cache on miss
  const snap = await db.collection('plans').get();
  planCache.data.clear();
  snap.forEach(d => planCache.data.set(d.id, { id: d.id, ...d.data() }));
  planCache.time = Date.now();
  return planCache.data.get(planId) || { id: doc.id, ...doc.data() };
}

/**
 * Context object describing the config being created or updated.
 * @typedef {Object} ConfigContext
 * @property {string} [status] - 'active' or 'draft'
 * @property {string} [platform1]
 * @property {string} [platform2]
 * @property {string} [cronSchedule]
 */

/**
 * Enforce plan limits for a config create/update operation.
 *
 * Checks (only when status === 'active'):
 *   1. maxActiveConfigs  — active configs in the workspace must stay under the limit
 *   2. connector tier    — both platform1 and platform2 tiers must be in plan.connectorTiers
 *   3. minSyncInterval   — cronSchedule (if any) must not be tighter than plan.minSyncIntervalMinutes
 *
 * @param {string} workspaceId
 * @param {object} plan  — resolved plan document (from getPlan)
 * @param {ConfigContext} context
 * @param {object} [options]
 * @param {boolean} [options.excludeOwnId]  — if set, exclude this config ID from the active count
 * @returns {Promise<void>} — throws an Error on first violated limit, resolves silently if all pass
 */
async function enforcePlanLimits(workspaceId, plan, context, options = {}) {
  if (!plan) return;
  if (context.status !== 'active') return;

  const planName = plan.name || 'free';

  // 1. maxActiveConfigs
  if (plan.maxActiveConfigs) {
    let query = db.collection('workspaces').doc(workspaceId)
      .collection('sync_configs')
      .where('status', '==', 'active');

    // If we're updating an existing config, don't count it against itself
    if (options.excludeOwnId) {
      // Firestore doesn't support != in collection group filters without composite indexes,
      // so we fetch and subtract manually.
      const snap = await query.get();
      let count = snap.size;
      // The existing active config will be in the results; subtract it if found
      for (const d of snap.docs) {
        if (d.id === options.excludeOwnId) {
          count--;
          break;
        }
      }
      if (count >= plan.maxActiveConfigs) {
        throw new Error(
          `Your ${planName} plan allows ${plan.maxActiveConfigs} active config${plan.maxActiveConfigs !== 1 ? 's' : ''}. Upgrade to add more.`
        );
      }
    } else {
      const snap = await query.get();
      if (snap.size >= plan.maxActiveConfigs) {
        throw new Error(
          `Your ${planName} plan allows ${plan.maxActiveConfigs} active config${plan.maxActiveConfigs !== 1 ? 's' : ''}. Upgrade to add more.`
        );
      }
    }
  }

  // 2. Connector tier gating
  const connectorTiers = plan.connectorTiers || ['basic'];
  const platformsToCheck = [];
  if (context.platform1) platformsToCheck.push(context.platform1);
  if (context.platform2) platformsToCheck.push(context.platform2);

  if (platformsToCheck.length > 0) {
    const [p1Doc, p2Doc] = await Promise.all([
      context.platform1 ? db.collection('platforms').doc(context.platform1).get() : Promise.resolve(null),
      context.platform2 ? db.collection('platforms').doc(context.platform2).get() : Promise.resolve(null),
    ]);
    const p1Tier = p1Doc && p1Doc.exists ? (p1Doc.data().tier || 'basic') : null;
    const p2Tier = p2Doc && p2Doc.exists ? (p2Doc.data().tier || 'basic') : null;

    for (const tier of [p1Tier, p2Tier].filter(Boolean)) {
      if (!connectorTiers.includes(tier)) {
        throw new Error(
          `Your ${planName} plan does not support "${tier}" tier connectors. Upgrade to connect this platform.`
        );
      }
    }
  }

  // 3. Min sync interval — fail closed: anything we can't confidently parse
  // is rejected rather than silently let through (a raw cron string like
  // "* * * * *" must not bypass this check just because it doesn't match a
  // hand-rolled regex pattern).
  if (plan.minSyncIntervalMinutes && context.cronSchedule) {
    const intervalMinutes = cronToMinutes(context.cronSchedule);
    if (intervalMinutes === null) {
      throw new Error(`"${context.cronSchedule}" is not a valid cron schedule.`);
    }
    if (intervalMinutes < plan.minSyncIntervalMinutes) {
      throw new Error(
        `Your ${planName} plan requires a minimum sync interval of ${plan.minSyncIntervalMinutes} minutes. "${context.cronSchedule}" runs every ${intervalMinutes} minute(s).`
      );
    }
  }
}

/**
 * Compute a cron expression's minimum interval in minutes by sampling its
 * next several fire times and taking the smallest gap — handles any valid
 * cron syntax (not just star-slash-N shorthand), so it can't be bypassed by
 * writing an equivalent schedule the old regex-based check didn't recognize.
 * Returns null only for genuinely invalid cron syntax.
 */
function cronToMinutes(cronExpr) {
  if (!cronExpr || typeof cronExpr !== 'string') return null;
  try {
    const interval = CronExpressionParser.parse(cronExpr.trim());
    const SAMPLE_SIZE = 5;
    let prev = interval.next().getTime();
    let minGapMinutes = Infinity;
    for (let i = 0; i < SAMPLE_SIZE; i++) {
      const next = interval.next().getTime();
      const gapMinutes = (next - prev) / 60000;
      if (gapMinutes < minGapMinutes) minGapMinutes = gapMinutes;
      prev = next;
    }
    return Math.round(minGapMinutes);
  } catch (err) {
    return null;
  }
}

module.exports = { getPlan, enforcePlanLimits, enforceTotalConfigCap, cronToMinutes };

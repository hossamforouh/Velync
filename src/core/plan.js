const db = require('./db');
const logger = require('./logger');

const planCache = { data: new Map(), time: 0 };
const PLAN_CACHE_TTL = 120_000;

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

  // 3. Min sync interval
  if (plan.minSyncIntervalMinutes && context.cronSchedule) {
    const intervalMinutes = cronToMinutes(context.cronSchedule);
    if (intervalMinutes !== null && intervalMinutes < plan.minSyncIntervalMinutes) {
      throw new Error(
        `Your ${planName} plan requires a minimum sync interval of ${plan.minSyncIntervalMinutes} minutes. "${context.cronSchedule}" runs every ${intervalMinutes} minute(s).`
      );
    }
  }
}

/**
 * Convert a cron expression to its approximate interval in minutes.
 * Handles star-slash-N minute patterns and "0 star-slash-N" hour patterns.
 * Returns null for complex/unrecognised schedules (enforcement skipped).
 */
function cronToMinutes(cronExpr) {
  if (!cronExpr || typeof cronExpr !== 'string') return null;
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const minuteMatch = parts[0].match(/^\*\/(\d+)$/);
  if (minuteMatch) return parseInt(minuteMatch[1], 10);
  const hourMatch = parts[1].match(/^\*\/(\d+)$/);
  if (hourMatch && (parts[0] === '0' || parts[0] === '0,30')) return parseInt(hourMatch[1], 10) * 60;
  return null;
}

module.exports = { getPlan, enforcePlanLimits, cronToMinutes };

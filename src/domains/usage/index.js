/**
 * Per-user usage/cost tracking.
 *
 * Every tracked action writes an event doc to `usage_events` AND atomically
 * increments the per-user-per-month aggregate `usage_summaries/{userId}_{YYYY-MM}`
 * via FieldValue.increment — never read-then-write (a concurrent sync run and a
 * login for the same user must not lose updates; same race class as sync_locks).
 *
 * Cost-driving activity types get estimatedCostUsd = units × configured rate;
 * usage-intensity types (logins, invites, …) are counted with costUsd null.
 * Rates live in `app_settings/usage_rates` (admin-editable) with GCP-pricing-based
 * defaults below — nothing is hardcoded at the call sites.
 *
 * Failure policy: a usage write must never break the action being tracked, but
 * must also never vanish silently — on failure we logger.error AND increment an
 * admin-visible failure counter (`usage_meta/write_failures`, surfaced in the
 * admin Usage tab). Losing cost data invisibly is worse than losing other data.
 */
const { FieldValue } = require('firebase-admin/firestore');
const db = require('../../core/db');
const logger = require('../../core/logger');

// activityType → does it carry a real $ cost to us?
const ACTIVITY_TYPES = {
  // Cost-driving
  sync_execution: { costDriving: true, rateKey: 'costPerSyncExecution' },
  compute_estimate: { costDriving: true, rateKey: 'costPerComputeMs' }, // units = ms
  api_call: { costDriving: true, rateKey: 'costPerApiCall' },
  ai_mapping_suggestion: { costDriving: true, rateKey: 'costPerAiMappingSuggestion' },
  firestore_read: { costDriving: true, rateKey: 'costPerRead' },
  firestore_write: { costDriving: true, rateKey: 'costPerWrite' },
  firestore_delete: { costDriving: true, rateKey: 'costPerDelete' },
  // Usage-intensity (no direct cost — count only)
  user_login: { costDriving: false },
  workspace_created: { costDriving: false },
  member_invited: { costDriving: false },
  flow_created: { costDriving: false },
  field_mapping_changed: { costDriving: false },
  platform_connected: { costDriving: false },
};

// Starting defaults, per unit, from current GCP pricing (us-central1):
// Firestore: reads $0.06 / 100k, writes $0.18 / 100k, deletes $0.02 / 100k.
// Cloud Run: ~$0.0000253/sec at 1 vCPU + 512 MiB → ~2.5e-8 per ms of sync compute.
// Sync execution overhead: Cloud Run request pricing $0.40/million invocations.
// api_call: no direct per-call charge from GCP; default approximates egress
// (~10 KB/call at $0.12/GB ≈ $1 per million calls).
// ai_mapping_suggestion: one Gemini 2.5 Flash call (via Vertex) — a mapping
// request sends both schemas (~2k input tokens) and gets a structured list
// back (~600 output tokens). At Flash pricing (~$0.30/1M in, ~$2.50/1M out)
// that's ≈ $0.0006 + $0.0015 ≈ $0.002/call. This is BY FAR the most expensive
// single action in the app (~1000× a Firestore read), so tracking it is what
// makes the cost estimate meaningful rather than sync-only. Flat per-call
// default; admin-tunable in app_settings/usage_rates like every other rate.
const DEFAULT_RATES = {
  costPerRead: 0.0000006,
  costPerWrite: 0.0000018,
  costPerDelete: 0.0000002,
  costPerComputeMs: 0.000000025,
  costPerSyncExecution: 0.0000004,
  costPerApiCall: 0.000001,
  costPerAiMappingSuggestion: 0.002,
};

let ratesCache = null;
let ratesCacheAt = 0;
const RATES_CACHE_TTL_MS = 60_000;

/** Effective rates: app_settings/usage_rates overrides merged over defaults. Cached 60s. */
async function getUsageRates() {
  if (ratesCache && Date.now() - ratesCacheAt < RATES_CACHE_TTL_MS) return ratesCache;
  let overrides = {};
  try {
    const doc = await db.collection('app_settings').doc('usage_rates').get();
    if (doc.exists) overrides = doc.data();
  } catch (err) {
    // Fall back to defaults but don't hide it — misconfigured rates skew every estimate.
    logger.error('usage', 'Failed to load usage_rates, using defaults', { error: err.message });
  }
  const merged = { ...DEFAULT_RATES };
  for (const key of Object.keys(DEFAULT_RATES)) {
    const v = Number(overrides[key]);
    if (Number.isFinite(v) && v >= 0) merged[key] = v;
  }
  ratesCache = merged;
  ratesCacheAt = Date.now();
  return merged;
}

/** YYYY-MM (UTC) for a given date. */
function yearMonthOf(date = new Date()) {
  return date.toISOString().slice(0, 7);
}

/** Best-effort admin-visible failure counter. Last line of defense is the logger. */
async function recordWriteFailure(activityType, err) {
  logger.error('usage', `Failed to record usage event "${activityType}" — cost data lost`, { error: err.message });
  try {
    await db.collection('usage_meta').doc('write_failures').set({
      count: FieldValue.increment(1),
      lastError: err.message,
      lastActivityType: activityType,
      lastAt: new Date().toISOString(),
    }, { merge: true });
  } catch (metaErr) {
    logger.error('usage', 'Failed to record usage write-failure marker', { error: metaErr.message });
  }
}

/**
 * Record one usage event and atomically bump the user's monthly summary.
 *
 * @param {string} userId - the user the usage is attributed to
 * @param {string} workspaceId
 * @param {string} activityType - one of ACTIVITY_TYPES
 * @param {object} [meta]
 * @param {string} [meta.connectorType] - e.g. 'notion' for api_call events
 * @param {number} [meta.units=1] - e.g. 1 per API call, ms for compute_estimate
 * @param {string} [meta.actor='user'] - 'admin'/'service' actions are recorded as
 *   events (tagged) but NEVER added to the user's cost summary; pass 'admin' from
 *   any admin-panel-triggered code path.
 * @returns {Promise<void>} resolves always — failures are surfaced internally
 *   (logger + usage_meta/write_failures), never thrown into the tracked action.
 */
async function logUsageEvent(userId, workspaceId, activityType, meta = {}) {
  const def = ACTIVITY_TYPES[activityType];
  try {
    if (!def) throw new Error(`Unknown activityType "${activityType}"`);
    if (!userId) throw new Error('userId is required');

    const units = Number.isFinite(Number(meta.units)) && Number(meta.units) > 0 ? Number(meta.units) : 1;
    const actor = meta.actor || 'user';
    let estimatedCostUsd = null;
    if (def.costDriving) {
      const rates = await getUsageRates();
      estimatedCostUsd = units * rates[def.rateKey];
    }

    const now = new Date();
    const yearMonth = yearMonthOf(now);

    const batch = db.batch();
    batch.set(db.collection('usage_events').doc(), {
      userId,
      workspaceId: workspaceId || null,
      activityType,
      connectorType: meta.connectorType || null,
      units,
      estimatedCostUsd,
      actor,
      timestamp: now.toISOString(),
    });

    // Admin/service-triggered actions are auditable in usage_events but must not
    // count toward the user's own cost-per-month.
    if (actor === 'user') {
      const summaryUpdate = {
        userId,
        yearMonth,
        totals: { [activityType]: { count: FieldValue.increment(units) } },
        updatedAt: now.toISOString(),
      };
      if (estimatedCostUsd !== null) {
        summaryUpdate.totals[activityType].costUsd = FieldValue.increment(estimatedCostUsd);
        summaryUpdate.grandTotalCostUsd = FieldValue.increment(estimatedCostUsd);
      }
      batch.set(db.collection('usage_summaries').doc(`${userId}_${yearMonth}`), summaryUpdate, { merge: true });

      // Parallel per-workspace rollup — a workspace's cost is the sum of all
      // its members' activity, so this is incremented alongside (not instead
      // of) the per-user summary above, same atomic-increment pattern, keyed
      // by workspaceId instead of userId. Skipped when there's no workspace
      // (e.g. a standalone event with only a userId).
      if (workspaceId) {
        const wsSummaryUpdate = {
          workspaceId,
          yearMonth,
          totals: { [activityType]: { count: FieldValue.increment(units) } },
          updatedAt: now.toISOString(),
        };
        if (estimatedCostUsd !== null) {
          wsSummaryUpdate.totals[activityType].costUsd = FieldValue.increment(estimatedCostUsd);
          wsSummaryUpdate.grandTotalCostUsd = FieldValue.increment(estimatedCostUsd);
        }
        batch.set(db.collection('usage_workspace_summaries').doc(`${workspaceId}_${yearMonth}`), wsSummaryUpdate, { merge: true });
      }
    }

    await batch.commit();
  } catch (err) {
    await recordWriteFailure(activityType, err);
  }
}

/**
 * Per-sync-run collector: increments counters in memory during the run, then
 * flush() writes ONE usage_event per activity type (units = total) instead of
 * one doc per Firestore read — otherwise the tracking itself would double our
 * write bill.
 */
function createUsageCollector({ userId, workspaceId }) {
  const apiCalls = new Map(); // connectorType -> count
  let reads = 0, writes = 0, deletes = 0;

  return {
    apiCall(connectorType, n = 1) { apiCalls.set(connectorType, (apiCalls.get(connectorType) || 0) + n); },
    firestoreRead(n = 1) { reads += n; },
    firestoreWrite(n = 1) { writes += n; },
    firestoreDelete(n = 1) { deletes += n; },

    /** Write aggregate events for the run. Never throws. */
    async flush({ durationMs } = {}) {
      const jobs = [];
      jobs.push(logUsageEvent(userId, workspaceId, 'sync_execution', { units: 1 }));
      if (Number.isFinite(durationMs) && durationMs > 0) {
        jobs.push(logUsageEvent(userId, workspaceId, 'compute_estimate', { units: Math.round(durationMs) }));
      }
      for (const [connectorType, count] of apiCalls) {
        jobs.push(logUsageEvent(userId, workspaceId, 'api_call', { connectorType, units: count }));
      }
      if (reads > 0) jobs.push(logUsageEvent(userId, workspaceId, 'firestore_read', { units: reads }));
      if (writes > 0) jobs.push(logUsageEvent(userId, workspaceId, 'firestore_write', { units: writes }));
      if (deletes > 0) jobs.push(logUsageEvent(userId, workspaceId, 'firestore_delete', { units: deletes }));
      await Promise.all(jobs);
    },
  };
}

// Connector contract methods that hit the third-party platform's API. Counted
// once per contract-level invocation — a paginated fetch() may issue several
// HTTP requests under the hood, so this is a lower-bound estimate, but it keeps
// the instrumentation generic (no per-adapter code, per the connector-contract
// rule in CLAUDE.md).
const API_METHODS = new Set(['connect', 'fetch', 'fetchIds', 'create', 'update', 'delete', 'retrieve', 'getDataSource']);

/**
 * Wrap a connector instance so every contract-level API method call is counted
 * as an 'api_call' on the collector. Works for any registered connector —
 * platform-agnostic by design.
 */
function instrumentConnector(connector, collector, connectorType) {
  return new Proxy(connector, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === 'function' && API_METHODS.has(prop)) {
        return function (...args) {
          collector.apiCall(connectorType, 1);
          return value.apply(target, args);
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

module.exports = {
  ACTIVITY_TYPES,
  DEFAULT_RATES,
  getUsageRates,
  yearMonthOf,
  logUsageEvent,
  createUsageCollector,
  instrumentConnector,
};

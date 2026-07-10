const { CronExpressionParser } = require('cron-parser');
const db = require('../../core/db');
const logger = require('../../core/logger');
const { runSync } = require('./engine');

const DEFAULT_SCHEDULE = '*/5 * * * *';

/** Coerce a Firestore Timestamp | ISO string | Date into a Date, or null. */
function toDate(value) {
  if (!value) return null;
  if (typeof value.toDate === 'function') return value.toDate();
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Decide whether a config is due to run at `now`, based on its cron schedule and
 * lastRunAt. This replaces in-process node-cron for the external-scheduler mode:
 * a Cloud Scheduler tick asks "which configs are due?" instead of each instance
 * holding its own timers.
 *
 * A config is due if a scheduled fire time has elapsed since its last run
 * (or it has never run). Pure function — safe to unit test.
 *
 * @param {object} config      the sync_config document data
 * @param {Date}   [now]
 * @returns {boolean}
 */
function isConfigDue(config, now = new Date()) {
  let prevFire;
  try {
    prevFire = CronExpressionParser.parse(config.cronSchedule || DEFAULT_SCHEDULE, { currentDate: now }).prev().toDate();
  } catch {
    // Unparseable schedule → fall back to the default cadence rather than never running.
    prevFire = CronExpressionParser.parse(DEFAULT_SCHEDULE, { currentDate: now }).prev().toDate();
  }
  const lastRun = toDate(config.lastRunAt);
  if (!lastRun) return true;
  return prevFire.getTime() > lastRun.getTime();
}

/**
 * Query active configs and return those due to run now.
 * @param {Date} [now]
 * @returns {Promise<Array<{configId: string, config: object}>>}
 */
async function selectDueConfigs(now = new Date()) {
  const snap = await db.collectionGroup('sync_configs').where('status', '==', 'active').get();
  const due = [];
  snap.forEach(doc => {
    const config = doc.data();
    if (isConfigDue(config, now)) due.push({ configId: doc.id, config });
  });
  return due;
}

/** Max configs to execute in parallel within a single tick. */
const DEFAULT_CONCURRENCY = 10;

/**
 * Run `fn` over `items` with at most `concurrency` in flight at once. A fixed
 * pool of workers pulls from a shared cursor — bounded memory/connection use
 * regardless of how many items are due. Never rejects: `fn` is expected to
 * handle its own errors (see runDueConfigs). Pure/generic — unit-tested.
 * @template T
 * @param {T[]} items
 * @param {number} concurrency
 * @param {(item: T) => Promise<void>} fn
 */
async function mapConcurrent(items, concurrency, fn) {
  const limit = Math.max(1, Math.min(concurrency, items.length));
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const item = items[cursor++];
      await fn(item);
    }
  }
  await Promise.all(Array.from({ length: limit }, () => worker()));
}

/**
 * One scheduler tick: run every due config. runSync holds a distributed lease, so
 * overlapping ticks (or multiple instances) won't double-execute a config.
 * Runs configs with bounded parallelism so a tick with many due configs finishes
 * within a request window instead of serially (the previous behaviour would time
 * out once enough configs came due at the same minute).
 * @param {Date}   [now]
 * @param {number} [concurrency]
 * @returns {Promise<{due: number, ran: number, errors: number}>}
 */
async function runDueConfigs(now = new Date(), concurrency = DEFAULT_CONCURRENCY) {
  const due = await selectDueConfigs(now);
  let ran = 0;
  let errors = 0;
  await mapConcurrent(due, concurrency, async ({ configId, config }) => {
    try {
      await runSync(config, configId);
      ran++;
    } catch (err) {
      errors++;
      logger.error('dispatcher', `Sync failed for "${configId}"`, { error: err.message });
    }
  });
  logger.info('dispatcher', `Tick — ${due.length} due, ${ran} ran, ${errors} errored`);
  return { due: due.length, ran, errors };
}

module.exports = { isConfigDue, selectDueConfigs, runDueConfigs, mapConcurrent };

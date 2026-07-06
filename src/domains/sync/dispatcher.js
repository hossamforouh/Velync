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

/**
 * One scheduler tick: run every due config. runSync holds a distributed lease, so
 * overlapping ticks (or multiple instances) won't double-execute a config.
 * @param {Date} [now]
 * @returns {Promise<{due: number, ran: number, errors: number}>}
 */
async function runDueConfigs(now = new Date()) {
  const due = await selectDueConfigs(now);
  let ran = 0;
  let errors = 0;
  for (const { configId, config } of due) {
    try {
      await runSync(config, configId);
      ran++;
    } catch (err) {
      errors++;
      logger.error('dispatcher', `Sync failed for "${configId}"`, { error: err.message });
    }
  }
  logger.info('dispatcher', `Tick — ${due.length} due, ${ran} ran, ${errors} errored`);
  return { due: due.length, ran, errors };
}

module.exports = { isConfigDue, selectDueConfigs, runDueConfigs };

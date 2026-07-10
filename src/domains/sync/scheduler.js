const cron = require('node-cron');
const { runSync } = require('./engine');
const { cleanupLogs, cleanupActivityLogs, cleanupUsageEvents, reconcileStuckRuns } = require('./log-cleanup');
const { acquireLease, releaseLease } = require('../../core/lock');
const db = require('../../core/db');
const logger = require('../../core/logger');

const activeJobs = {};
let retryCount = 0;

// ─── Single-leader election ───────────────────────────────────
// Every Cloud Run instance boots this scheduler, but only ONE should hold the
// active-config listener + the per-config cron timers at a time. Without this,
// N instances each hold a timer per active config and all fire and race for the
// same per-config execution lease — correct (the lease in engine.js prevents
// double execution), but N× the timers, memory, and Firestore listener cost.
//
// A renewable Firestore lease elects a single leader. Non-leaders idle and take
// over only if the current leader stops renewing (crash / redeploy). During a
// brief handover both may believe they lead; that's safe because runSync's
// per-config lease still guarantees single execution — leader election is a
// cost optimization layered on top of that correctness guarantee, not a
// replacement for it.
const LEADER_LOCK_ID = 'scheduler-leader';
const LEADER_TTL_MS = 90_000;
const LEADER_POLL_MS = 30_000;

let isLeader = false;
let unsubscribeConfigs = null;
let maintenanceJobs = [];

// ─── Active-config listener (leader-only) ─────────────────────
function startConfigListener() {
  function listenToConfigs() {
    unsubscribeConfigs = db.collectionGroup('sync_configs')
      .where('status', '==', 'active')
      .onSnapshot((snapshot) => {
        retryCount = 0;
        const currentJobIds = new Set(Object.keys(activeJobs));
        const seenIds = new Set();

        snapshot.docChanges().forEach((change) => {
          const configId = change.doc.id;
          const config = change.doc.data();
          const configName = config.description || configId;
          seenIds.add(configId);

          if (change.type === 'removed') {
            if (activeJobs[configId]) {
              logger.info('scheduler', `Stopping job for "${configName}"`);
              activeJobs[configId].stop();
              delete activeJobs[configId];
            }
            return;
          }

          if (change.type !== 'added' && change.type !== 'modified') return;

          const schedule = config.cronSchedule || '*/5 * * * *';
          if (activeJobs[configId]) {
            activeJobs[configId].stop();
            delete activeJobs[configId];
            logger.info('scheduler', `Updating job for "${configName}" → "${schedule}"`);
          } else {
            logger.info('scheduler', `Starting job for "${configName}" → "${schedule}"`);
          }

          const safeSchedule = cron.validate(schedule) ? schedule : '*/5 * * * *';
          if (!cron.validate(schedule)) {
            logger.warn('scheduler', `Invalid cron "${schedule}" for "${configName}", fallback to */5`);
          }

          activeJobs[configId] = cron.schedule(safeSchedule, async () => {
            logger.info('scheduler', `Executing "${configName}"`);
            try {
              await runSync(config, configId);
            } catch (err) {
              logger.error('scheduler', `Failed "${configName}"`, { error: err.message });
            }
          });

          activeJobs[configId].start();
        });

        // Stop jobs for configs no longer in the active snapshot
        for (const jobId of currentJobIds) {
          if (!seenIds.has(jobId) && activeJobs[jobId]) {
            logger.info('scheduler', `Stopping orphaned job for "${jobId}"`);
            activeJobs[jobId].stop();
            delete activeJobs[jobId];
          }
        }
      }, (err) => {
        retryCount++;
        const delay = Math.min(30000 * Math.pow(2, retryCount - 1), 300000);
        logger.error('scheduler', `Firestore listener error (attempt ${retryCount}), retrying in ${delay}ms`, { error: err.message });
        // Only re-establish if we still hold leadership.
        setTimeout(() => { if (isLeader) listenToConfigs(); }, delay);
      });
  }

  listenToConfigs();
}

// ─── Maintenance crons (leader-only) ──────────────────────────
function startMaintenanceJobs() {
  // Daily log retention cleanup at 02:00
  const cleanupJob = cron.schedule('0 2 * * *', async () => {
    logger.info('scheduler', 'Starting daily log retention cleanup');
    try { await cleanupLogs(); } catch (err) { logger.error('scheduler', 'Log cleanup failed', { error: err.message }); }
    try { await cleanupActivityLogs(); } catch (err) { logger.error('scheduler', 'Activity log cleanup failed', { error: err.message }); }
    try { await cleanupUsageEvents(); } catch (err) { logger.error('scheduler', 'Usage-events cleanup failed', { error: err.message }); }
  });
  cleanupJob.start();
  maintenanceJobs.push(cleanupJob);

  // Stuck "running" execution_logs reconciliation, every 15 min
  const reconcileJob = cron.schedule('*/15 * * * *', async () => {
    try { await reconcileStuckRuns(); } catch (err) { logger.error('scheduler', 'Stuck-run reconciliation failed', { error: err.message }); }
  });
  reconcileJob.start();
  maintenanceJobs.push(reconcileJob);
}

// ─── Leadership transitions ───────────────────────────────────
function onBecomeLeader() {
  logger.info('scheduler', 'Acquired scheduler leadership — starting config listener + maintenance jobs');
  startConfigListener();
  startMaintenanceJobs();
}

function onLoseLeadership() {
  logger.warn('scheduler', 'Lost scheduler leadership — tearing down listener + all jobs');
  if (unsubscribeConfigs) {
    try { unsubscribeConfigs(); } catch (_) { /* noop */ }
    unsubscribeConfigs = null;
  }
  for (const jobId of Object.keys(activeJobs)) {
    try { activeJobs[jobId].stop(); } catch (_) { /* noop */ }
    delete activeJobs[jobId];
  }
  for (const job of maintenanceJobs) {
    try { job.stop(); } catch (_) { /* noop */ }
  }
  maintenanceJobs = [];
}

async function leaderTick() {
  try {
    // acquireLease sets/renews the lease when we already hold it or it's expired,
    // and returns false only when another instance holds it unexpired — so this
    // one call both acquires and renews.
    const got = await acquireLease(LEADER_LOCK_ID, LEADER_TTL_MS);
    if (got && !isLeader) {
      isLeader = true;
      onBecomeLeader();
    } else if (!got && isLeader) {
      isLeader = false;
      onLoseLeadership();
    }
  } catch (err) {
    logger.error('scheduler', 'Leader election tick failed', { error: err.message });
  }
}

function startScheduler() {
  // Heartbeat runs on every instance (harmless, aids debugging).
  cron.schedule('*/1 * * * *', () => {
    logger.debug('scheduler', `Heartbeat — leader:${isLeader}, active jobs: ${Object.keys(activeJobs).length}`);
  }).start();

  // Immediately contest leadership, then keep renewing/contesting on a poll.
  leaderTick();
  setInterval(leaderTick, LEADER_POLL_MS);

  // Release leadership promptly on shutdown so a redeploy's new instance can
  // take over without waiting out the full TTL.
  const relinquish = () => { if (isLeader) releaseLease(LEADER_LOCK_ID).catch(() => {}); };
  process.on('SIGTERM', relinquish);
  process.on('SIGINT', relinquish);

  logger.info('scheduler', 'Scheduler started (single-leader election active)');
}

module.exports = { startScheduler };

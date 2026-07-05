const cron = require('node-cron');
const { runSync } = require('./engine');
const { cleanupLogs } = require('./log-cleanup');
const db = require('../../core/db');
const logger = require('../../core/logger');

const activeJobs = {};
let retryCount = 0;

function startScheduler() {
  cron.schedule('*/1 * * * *', () => {
    logger.debug('scheduler', `Heartbeat — active jobs: ${Object.keys(activeJobs).length}`);
  }).start();

  // Daily log retention cleanup at 02:00
  cron.schedule('0 2 * * *', async () => {
    logger.info('scheduler', 'Starting daily log retention cleanup');
    try {
      await cleanupLogs();
    } catch (err) {
      logger.error('scheduler', 'Log cleanup failed', { error: err.message });
    }
  }).start();

  function listenToConfigs() {
    db.collectionGroup('sync_configs')
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
      setTimeout(listenToConfigs, delay);
    });
  }

  listenToConfigs();

  logger.info('scheduler', 'Scheduler started');
}

module.exports = { startScheduler };

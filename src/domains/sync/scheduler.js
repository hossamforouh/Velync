const cron = require('node-cron');
const { Firestore } = require('@google-cloud/firestore');
const { runSyncForConfig } = require('../../../workflows/syncInboxToNotion');
const { runSync } = require('./engine');
const logger = require('../../core/logger');

const db = new Firestore();
const activeJobs = {};

function startScheduler() {
  cron.schedule('*/1 * * * *', () => {
    logger.debug('scheduler', `Heartbeat — active jobs: ${Object.keys(activeJobs).length}`);
  }).start();

  function listenToConfigs() {
    db.collectionGroup('sync_configs')
      .onSnapshot((snapshot) => {
      logger.info('scheduler', `Firestore update: ${snapshot.docChanges().length} changes`);

      snapshot.docChanges().forEach((change) => {
        const configId = change.doc.id;
        const config = change.doc.data();
        const configName = config.description || configId;

        if (change.type === 'removed' || config.enabled !== true) {
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
            if (config.platform1) {
              await runSync(config, configId);
            } else {
              await runSyncForConfig(config, configId);
            }
          } catch (err) {
            logger.error('scheduler', `Failed "${configName}"`, { error: err.message });
          }
        });

        activeJobs[configId].start();
      });
    }, (err) => {
      logger.error('scheduler', 'Firestore listener error, retrying in 30s', { error: err.message });
      setTimeout(listenToConfigs, 30000);
    });
  }

  listenToConfigs();

  logger.info('scheduler', 'Scheduler started');
}

module.exports = { startScheduler };

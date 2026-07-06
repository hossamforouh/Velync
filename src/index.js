const admin = require('firebase-admin');
const { startServer } = require('./api/server');
const { startScheduler } = require('./domains/sync/scheduler');
const config = require('./core/config');
const logger = require('./core/logger');
const { testConfigConnections } = require('./cli/test');
const db = require('./core/db');

require('./domains/connector');

try {
  admin.initializeApp();
} catch (e) {}

// Graceful shutdown for CLI mode
async function shutdown(signal) {
  logger.info('cli', `${signal} received — exiting`);
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

if (process.argv.includes('--test-connections')) {
  (async () => {
    logger.info('cli', 'Starting connection tests');
    try {
      const allDocs = await db.collectionGroup('sync_configs').get();
      const activeDocs = allDocs.docs.filter(d => {
        const c = d.data();
        return c.status === 'active' || (c.enabled === true && !c.status);
      });
      if (activeDocs.length === 0) {
        console.log('No active configurations found.');
      } else {
        for (const doc of activeDocs) {
          await testConfigConnections(doc.data(), doc.id);
        }
      }
    } catch (err) {
      console.error('Failed to query configs:', err.message);
    }
    process.exit(0);
  })();
} else if (process.argv.includes('--run-sync')) {
  (async () => {
    const { runSync } = require('./domains/sync/engine');
    const allDocs = await db.collectionGroup('sync_configs')
      .where('status', '==', 'active')
      .get();
    let count = 0;
    for (const doc of allDocs.docs) {
      const config = doc.data();
      try {
        await runSync(config, doc.id);
        count++;
      } catch (err) {
        logger.error('cli', `Sync failed for "${config.description}": ${err.message}`);
      }
    }
    logger.info('cli', `Sync complete — ${count} configs processed`);
    process.exit(0);
  })();
} else {
  const server = startServer();
  // In 'external' mode, Cloud Scheduler drives syncs via POST /api/internal/scheduler/tick,
  // so the in-process cron/listener is disabled and the service can scale to zero.
  if (config.schedulerMode === 'external') {
    logger.info('scheduler', 'External scheduler mode — in-process cron disabled; expecting Cloud Scheduler ticks');
  } else {
    startScheduler();
  }
}

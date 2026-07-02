const admin = require('firebase-admin');
const { startServer } = require('./api/server');
const { startScheduler } = require('./domains/sync/scheduler');
const logger = require('./core/logger');
const { runSyncWorkflow } = require('../workflows/syncInboxToNotion');
const { testConfigConnections } = require('./cli/test');

require('./domains/connector');

try {
  admin.initializeApp();
} catch (e) {}

if (process.argv.includes('--test-connections')) {
  (async () => {
    logger.info('cli', 'Starting connection tests');
    try {
      const { Firestore } = require('@google-cloud/firestore');
      const db = new Firestore();
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
    const { Firestore } = require('@google-cloud/firestore');
    const { runSync } = require('./domains/sync/engine');
    const { getConnector } = require('./domains/connector/registry');
    const { resolveConnectionTokens } = require('./domains/connection/resolver');
    const db = new Firestore();
    const allDocs = await db.collectionGroup('sync_configs').get();
    const activeDocs = allDocs.docs.filter(d => {
      const c = d.data();
      return c.status === 'active' || (c.enabled === true && !c.status);
    });
    let legacyCount = 0, newCount = 0;
    for (const doc of activeDocs) {
      const config = doc.data();
      if (config.sourcePlatform) {
        try {
          await runSync(config, doc.id);
          newCount++;
        } catch (err) {
          logger.error('cli', `Sync failed for "${config.description}": ${err.message}`);
        }
      } else {
        legacyCount++;
      }
    }
    if (legacyCount > 0) {
      logger.info('cli', `Running legacy sync for ${legacyCount} configs`);
      await runSyncWorkflow(true);
    }
    logger.info('cli', `Sync complete — ${newCount} new engine, ${legacyCount} legacy`);
    process.exit(0);
  })();
} else {
  startServer();
  if (process.env.PORT) {
    startScheduler();
  } else {
    logger.info('server', 'No PORT set — scheduler disabled');
  }
}

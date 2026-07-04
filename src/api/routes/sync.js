const { Router } = require('express');
const { runSync } = require('../../domains/sync/engine');
const { verifyAuth } = require('../middleware/auth');
const db = require('../../core/db');
const logger = require('../../core/logger');

const router = Router();

router.post('/sync', verifyAuth, async (req, res) => {
  logger.info('sync', 'Manual sync triggered', { user: req.user?.uid });
  try {
    const snap = await db.collectionGroup('sync_configs')
      .where('status', '==', 'active')
      .get();
    const results = [];
    for (const doc of snap.docs) {
      const config = doc.data();
      const result = await runSync(config, doc.id);
      results.push({ configId: doc.id, description: config.description, ...result });
    }
    res.json({ success: true, results });
  } catch (err) {
    logger.error('sync', 'Sync failed', { error: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;

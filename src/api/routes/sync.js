const { Router } = require('express');
const { runSyncWorkflow } = require('../../../workflows/syncInboxToNotion');
const { verifyAuth } = require('../middleware/auth');
const logger = require('../../core/logger');

const router = Router();

router.post('/sync', verifyAuth, async (req, res) => {
  logger.info('sync', 'Manual sync triggered', { user: req.user?.uid });
  try {
    await runSyncWorkflow(true);
    res.json({ success: true, message: 'Sync workflow executed successfully.' });
  } catch (err) {
    logger.error('sync', 'Sync workflow failed', { error: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;

const { Router } = require('express');
const { body, validationResult } = require('express-validator');
const { verifyAuth } = require('../middleware/auth');
const db = require('../../core/db');
const logger = require('../../core/logger');
const { logUsageEvent } = require('../../domains/usage');

const router = Router();

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Validation failed', details: errors.array() });
  }
  next();
};

// Only events that genuinely originate on the client (Firebase Auth sign-in and
// the client-side default-workspace creation in app.js) may be self-reported.
// Everything else — especially anything cost-driving — is logged server-side at
// the point it actually happens and must never be accepted from a client.
const CLIENT_REPORTABLE = ['user_login', 'workspace_created'];

router.post('/usage/event', verifyAuth, [
  body('activityType').isIn(CLIENT_REPORTABLE),
], validate, async (req, res) => {
  try {
    const uid = req.user.uid;
    // Derive attribution from the verified token, never from the request body.
    const userDoc = await db.collection('users').doc(uid).get();
    const workspaceId = (userDoc.exists && userDoc.data().workspaceId) || uid;

    await logUsageEvent(uid, workspaceId, req.body.activityType);
    return res.status(204).end();
  } catch (err) {
    logger.error('usage', 'Failed to record client usage event', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;

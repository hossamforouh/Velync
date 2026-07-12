const { Router } = require('express');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const { verifyAuth } = require('../middleware/auth');
const { isSuperAdmin } = require('../../core/superadmin');
const db = require('../../core/db');
const logger = require('../../core/logger');

const router = Router();

const requireSuperAdmin = async (req, res, next) => {
  if (!req.user || !(await isSuperAdmin(req.user.uid))) {
    return res.status(403).json({ error: 'Forbidden: superadmin only' });
  }
  next();
};

// Deliberately IP-keyed (default), not uid-keyed — this endpoint has no
// verifyAuth, so req.user never exists. Errors can happen before login
// (landing page, auth form), so the endpoint must work unauthenticated.
const reportLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many error reports.' },
});

const MAX_LEN = 2000;
const truncate = (v) => (typeof v === 'string' ? v.slice(0, MAX_LEN) : '');

// Three-stage triage, not a boolean: 'open' (needs attention) -> 'resolved'
// (a fix has been shipped, awaiting verification) -> 'closed' (verified
// fixed). Any status can transition back to 'open' if verification finds
// the fix didn't actually work.
const STATUSES = ['open', 'resolved', 'closed'];

// Public, unauthenticated. uid/workspaceId are self-reported by the client
// (not verified via a Bearer token) — this collection is diagnostic-only,
// superadmin-read-only (see firestore.rules), so a spoofed uid has no
// security impact beyond mislabeling a debug entry.
router.post('/client-errors', reportLimiter, [
  // No isLength() cap here — oversized input is truncated below, not
  // rejected, so a legitimately long stack/message doesn't just get dropped.
  body('message').isString().trim().notEmpty(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Validation failed' });

  try {
    await db.collection('client_errors').add({
      message: truncate(req.body.message),
      stack: truncate(req.body.stack || ''),
      url: truncate(req.body.url || ''),
      userAgent: truncate(req.body.userAgent || ''),
      type: truncate(req.body.type || 'error'),
      uid: typeof req.body.uid === 'string' ? req.body.uid.slice(0, 128) : null,
      workspaceId: typeof req.body.workspaceId === 'string' ? req.body.workspaceId.slice(0, 128) : null,
      status: 'open',
      createdAt: new Date(),
    });
    return res.json({ success: true });
  } catch (err) {
    logger.error('client-errors', 'Failed to store client error report', { error: err.message });
    // Best-effort telemetry — never surface a failure to the reporting client.
    return res.json({ success: false });
  }
});

router.patch('/admin/client-errors/:id/status', verifyAuth, requireSuperAdmin, [
  body('status').isIn(STATUSES),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Validation failed' });

  try {
    const ref = db.collection('client_errors').doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'Not found' });
    await ref.update({ status: req.body.status });
    return res.json({ success: true });
  } catch (err) {
    logger.error('client-errors', 'Failed to update status', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

router.delete('/admin/client-errors/:id', verifyAuth, requireSuperAdmin, async (req, res) => {
  try {
    const ref = db.collection('client_errors').doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'Not found' });
    await ref.delete();
    return res.json({ success: true });
  } catch (err) {
    logger.error('client-errors', 'Failed to delete client error', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;

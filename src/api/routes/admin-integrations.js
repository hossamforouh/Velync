const { Router } = require('express');
const { body, validationResult } = require('express-validator');
const { verifyAuth } = require('../middleware/auth');
const { isSuperAdmin } = require('../../core/superadmin');
const { logAdminActivity, computeChanges } = require('../../core/activityLog');
const db = require('../../core/db');
const logger = require('../../core/logger');

const router = Router();

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Validation failed', details: errors.array() });
  }
  next();
};

const requireSuperAdmin = async (req, res, next) => {
  if (!req.user || !(await isSuperAdmin(req.user.uid))) {
    return res.status(403).json({ error: 'Forbidden: superadmin only' });
  }
  next();
};

const INTEGRATION_FIELDS = ['name', 'description', 'status', 'tags', 'platform1', 'platform2'];
// 'Disabled' is filtered out of the public Marketplace listing client-side
// (dashboard/public/js/hub.js) — it still exists here so admins can manage it.
const INTEGRATION_STATUSES = ['Active', 'Coming Soon', 'Disabled'];

function pickIntegrationFields(body) {
  const data = {};
  for (const key of INTEGRATION_FIELDS) {
    if (body[key] !== undefined) data[key] = body[key];
  }
  return data;
}

// Create a new integration
router.post('/admin/integrations', verifyAuth, requireSuperAdmin, [
  body('name').isString().trim().notEmpty(),
  body('status').optional().isIn(INTEGRATION_STATUSES),
], validate, async (req, res) => {
  try {
    const data = pickIntegrationFields(req.body);
    const docRef = await db.collection('integrations').add(data);
    await logAdminActivity({
      uid: req.user.uid, userEmail: req.user.email,
      action: 'create', targetType: 'integration', targetId: docRef.id, targetName: data.name,
    });
    return res.json({ success: true, id: docRef.id });
  } catch (err) {
    logger.error('admin-integrations', 'Failed to create integration', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// Update an existing integration
router.put('/admin/integrations/:integrationId', verifyAuth, requireSuperAdmin, [
  body('name').optional().isString().trim().isLength({ min: 1 }),
  body('status').optional().isIn(INTEGRATION_STATUSES),
], validate, async (req, res) => {
  try {
    const { integrationId } = req.params;
    const data = pickIntegrationFields(req.body);

    const existingSnap = await db.collection('integrations').doc(integrationId).get();
    const changes = computeChanges(existingSnap.data(), data, INTEGRATION_FIELDS);

    // Clicking Save without editing anything must not add a no-op 'update'
    // entry to the audit log — this used to happen unconditionally on every save.
    if (Object.keys(changes).length === 0) {
      return res.json({ success: true, changed: false });
    }

    await db.collection('integrations').doc(integrationId).set(data, { merge: true });
    await logAdminActivity({
      uid: req.user.uid, userEmail: req.user.email,
      action: 'update', targetType: 'integration', targetId: integrationId, targetName: data.name,
      changes,
    });
    return res.json({ success: true, changed: true });
  } catch (err) {
    logger.error('admin-integrations', 'Failed to update integration', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// Delete an integration. Returns the deleted data so the frontend's "Undo"
// toast can restore it via POST .../restore.
router.delete('/admin/integrations/:integrationId', verifyAuth, requireSuperAdmin, async (req, res) => {
  try {
    const { integrationId } = req.params;
    const ref = db.collection('integrations').doc(integrationId);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'Integration not found' });

    const deletedData = snap.data();
    await ref.delete();

    await logAdminActivity({
      uid: req.user.uid, userEmail: req.user.email,
      action: 'delete', targetType: 'integration', targetId: integrationId, targetName: deletedData.name,
    });
    return res.json({ success: true, deletedData });
  } catch (err) {
    logger.error('admin-integrations', 'Failed to delete integration', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// Restore a previously-deleted integration (used by the "Undo" toast action)
router.post('/admin/integrations/:integrationId/restore', verifyAuth, requireSuperAdmin, async (req, res) => {
  try {
    const { integrationId } = req.params;
    const data = pickIntegrationFields(req.body);
    await db.collection('integrations').doc(integrationId).set(data);
    await logAdminActivity({
      uid: req.user.uid, userEmail: req.user.email,
      action: 'restore', targetType: 'integration', targetId: integrationId, targetName: data.name,
    });
    return res.json({ success: true });
  } catch (err) {
    logger.error('admin-integrations', 'Failed to restore integration', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;

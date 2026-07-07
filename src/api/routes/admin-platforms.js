const { Router } = require('express');
const { body, validationResult } = require('express-validator');
const { verifyAuth } = require('../middleware/auth');
const { isSuperAdmin } = require('../../core/superadmin');
const { logAdminActivity } = require('../../core/activityLog');
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

// Fields allowed into the client-readable `platforms` doc. clientSecret is
// deliberately excluded — it lives in `platform_secrets` (Admin SDK only),
// since `platforms` is readable by any authenticated user for the connect-flow UI.
const PLATFORM_FIELDS = [
  'name', 'logo', 'authType', 'authUrl', 'tokenUrl', 'clientId',
  'guideUrl', 'attributes', 'configSchema',
];

function pickPlatformFields(body) {
  const data = {};
  for (const key of PLATFORM_FIELDS) {
    if (body[key] !== undefined) data[key] = body[key];
  }
  return data;
}

async function syncIntegrationNames(platformId, name) {
  const [snap1, snap2] = await Promise.all([
    db.collection('integrations').where('platform1.id', '==', platformId).get(),
    db.collection('integrations').where('platform2.id', '==', platformId).get(),
  ]);
  const batch = db.batch();
  snap1.forEach(doc => batch.update(doc.ref, { 'platform1.name': name }));
  snap2.forEach(doc => batch.update(doc.ref, { 'platform2.name': name }));
  if (!snap1.empty || !snap2.empty) await batch.commit();
}

// Create a new platform
router.post('/admin/platforms', verifyAuth, requireSuperAdmin, [
  body('name').isString().trim().notEmpty(),
], validate, async (req, res) => {
  try {
    const data = pickPlatformFields(req.body);
    const docRef = db.collection('platforms').doc();
    data.key = docRef.id;
    await docRef.set(data);

    if (req.body.clientSecret) {
      await db.collection('platform_secrets').doc(docRef.id).set({ clientSecret: req.body.clientSecret });
    }

    await logAdminActivity({
      uid: req.user.uid, userEmail: req.user.email,
      action: 'create', targetType: 'platform', targetId: docRef.id, targetName: data.name,
    });
    return res.json({ success: true, id: docRef.id });
  } catch (err) {
    logger.error('admin-platforms', 'Failed to create platform', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// Update an existing platform
router.put('/admin/platforms/:platformId', verifyAuth, requireSuperAdmin, [
  body('name').optional().isString().trim().isLength({ min: 1 }),
], validate, async (req, res) => {
  try {
    const { platformId } = req.params;
    const data = pickPlatformFields(req.body);
    data.key = platformId;
    await db.collection('platforms').doc(platformId).set(data);

    if (data.name) await syncIntegrationNames(platformId, data.name);

    if (req.body.clientSecret) {
      await db.collection('platform_secrets').doc(platformId).set({ clientSecret: req.body.clientSecret });
    }

    await logAdminActivity({
      uid: req.user.uid, userEmail: req.user.email,
      action: 'update', targetType: 'platform', targetId: platformId, targetName: data.name,
    });
    return res.json({ success: true });
  } catch (err) {
    logger.error('admin-platforms', 'Failed to update platform', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// Delete a platform. Returns the deleted data (including the secret) so the
// frontend's "Undo" toast can restore it via POST .../restore.
router.delete('/admin/platforms/:platformId', verifyAuth, requireSuperAdmin, async (req, res) => {
  try {
    const { platformId } = req.params;
    const platformRef = db.collection('platforms').doc(platformId);
    const secretRef = db.collection('platform_secrets').doc(platformId);

    const [platformSnap, secretSnap] = await Promise.all([platformRef.get(), secretRef.get()]);
    if (!platformSnap.exists) return res.status(404).json({ error: 'Platform not found' });

    const deletedData = { ...platformSnap.data() };
    if (secretSnap.exists) deletedData.clientSecret = secretSnap.data().clientSecret;

    await Promise.all([platformRef.delete(), secretSnap.exists ? secretRef.delete() : Promise.resolve()]);

    await logAdminActivity({
      uid: req.user.uid, userEmail: req.user.email,
      action: 'delete', targetType: 'platform', targetId: platformId, targetName: deletedData.name,
    });
    return res.json({ success: true, deletedData });
  } catch (err) {
    logger.error('admin-platforms', 'Failed to delete platform', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// Restore a previously-deleted platform (used by the "Undo" toast action)
router.post('/admin/platforms/:platformId/restore', verifyAuth, requireSuperAdmin, async (req, res) => {
  try {
    const { platformId } = req.params;
    const { clientSecret, ...rest } = req.body;
    const data = pickPlatformFields(rest);
    data.key = platformId;
    await db.collection('platforms').doc(platformId).set(data);
    if (clientSecret) {
      await db.collection('platform_secrets').doc(platformId).set({ clientSecret });
    }
    await logAdminActivity({
      uid: req.user.uid, userEmail: req.user.email,
      action: 'restore', targetType: 'platform', targetId: platformId, targetName: data.name,
    });
    return res.json({ success: true });
  } catch (err) {
    logger.error('admin-platforms', 'Failed to restore platform', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;

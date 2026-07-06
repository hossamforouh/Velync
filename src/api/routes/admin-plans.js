const { Router } = require('express');
const { body, validationResult } = require('express-validator');
const { verifyAuth } = require('../middleware/auth');
const { isSuperAdmin } = require('../../core/superadmin');
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

// List all plans
router.get('/admin/plans', verifyAuth, async (req, res) => {
  try {
    const snap = await db.collection('plans').orderBy('sortOrder', 'asc').get();
    const plans = [];
    snap.forEach(doc => plans.push({ id: doc.id, ...doc.data() }));
    return res.json(plans);
  } catch (err) {
    logger.error('admin-plans', 'Failed to list plans', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// Get a single plan
router.get('/admin/plans/:planId', verifyAuth, async (req, res) => {
  try {
    const doc = await db.collection('plans').doc(req.params.planId).get();
    if (!doc.exists) return res.status(404).json({ error: 'Plan not found' });
    return res.json({ id: doc.id, ...doc.data() });
  } catch (err) {
    logger.error('admin-plans', 'Failed to get plan', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// Create or update a plan
router.put('/admin/plans/:planId', verifyAuth, requireSuperAdmin, [
  body('name').optional().isString().trim().isLength({ min: 1 }),
  body('description').optional().isString(),
  body('priceMonthly').optional().isFloat({ min: 0 }),
  body('priceAnnual').optional().isFloat({ min: 0 }),
  body('maxActiveConfigs').optional().isInt({ min: 1 }),
  body('minSyncIntervalMinutes').optional().isInt({ min: 1 }),
  body('maxItemsPerRun').optional().isInt({ min: 1 }),
  body('connectorTiers').optional().isArray(),
  body('logRetentionDays').optional().isInt({ min: 1 }),
  body('sortOrder').optional().isInt({ min: 0 }),
  body('isActive').optional().isBoolean(),
  body('isDefault').optional().isBoolean(),
  body('stripePriceIdMonthly').optional().isString(),
  body('stripePriceIdAnnual').optional().isString(),
], validate, async (req, res) => {
  try {
    const { planId } = req.params;
    const allowed = [
      'name', 'description', 'priceMonthly', 'priceAnnual',
      'maxActiveConfigs', 'minSyncIntervalMinutes', 'maxItemsPerRun',
      'connectorTiers', 'logRetentionDays', 'sortOrder',
      'isActive', 'isDefault', 'stripePriceIdMonthly', 'stripePriceIdAnnual',
    ];
    const update = { updatedAt: new Date().toISOString() };
    for (const key of allowed) {
      if (req.body[key] !== undefined) update[key] = req.body[key];
    }

    await db.collection('plans').doc(planId).set(update, { merge: true });

    // If this plan is set as default, unset isDefault on all others
    if (update.isDefault === true) {
      const snap = await db.collection('plans').get();
      const batch = db.batch();
      snap.forEach(doc => {
        if (doc.id !== planId) {
          batch.update(doc.ref, { isDefault: false });
        }
      });
      await batch.commit();
    }

    logger.info('admin-plans', `Plan "${planId}" updated`, { user: req.user.uid });
    return res.json({ success: true });
  } catch (err) {
    logger.error('admin-plans', 'Failed to update plan', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// Create a new plan (new doc ID generated)
router.post('/admin/plans', verifyAuth, requireSuperAdmin, [
  body('id').isString().trim().notEmpty(),
  body('name').isString().trim().notEmpty(),
], validate, async (req, res) => {
  try {
    const { id, ...rest } = req.body;
    const existing = await db.collection('plans').doc(id).get();
    if (existing.exists) {
      return res.status(409).json({ error: `Plan "${id}" already exists. Use PUT to update.` });
    }
    const plan = {
      name: rest.name || id,
      description: rest.description || '',
      priceMonthly: rest.priceMonthly ?? 0,
      priceAnnual: rest.priceAnnual ?? 0,
      stripePriceIdMonthly: rest.stripePriceIdMonthly || '',
      stripePriceIdAnnual: rest.stripePriceIdAnnual || '',
      maxActiveConfigs: rest.maxActiveConfigs ?? 1,
      minSyncIntervalMinutes: rest.minSyncIntervalMinutes ?? 30,
      maxItemsPerRun: rest.maxItemsPerRun ?? 100,
      connectorTiers: rest.connectorTiers || ['basic'],
      logRetentionDays: rest.logRetentionDays ?? 7,
      sortOrder: rest.sortOrder ?? 99,
      isActive: rest.isActive !== undefined ? rest.isActive : true,
      isDefault: rest.isDefault === true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await db.collection('plans').doc(id).set(plan);
    logger.info('admin-plans', `Plan "${id}" created`, { user: req.user.uid });
    return res.json({ success: true, id });
  } catch (err) {
    logger.error('admin-plans', 'Failed to create plan', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// Toggle isActive on a plan
router.patch('/admin/plans/:planId/toggle', verifyAuth, requireSuperAdmin, async (req, res) => {
  try {
    const doc = await db.collection('plans').doc(req.params.planId).get();
    if (!doc.exists) return res.status(404).json({ error: 'Plan not found' });
    const current = doc.data();
    const newActive = !current.isActive;
    await doc.ref.update({ isActive: newActive, updatedAt: new Date().toISOString() });
    logger.info('admin-plans', `Plan "${req.params.planId}" isActive → ${newActive}`, { user: req.user.uid });
    return res.json({ success: true, isActive: newActive });
  } catch (err) {
    logger.error('admin-plans', 'Failed to toggle plan', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;

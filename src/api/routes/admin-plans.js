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
  body('maxActiveConfigs').optional().isInt({ min: 1 }),
  body('minSyncIntervalMinutes').optional().isInt({ min: 1 }),
  body('maxItemsPerRun').optional().isInt({ min: 1 }),
  body('connectorTiers').optional().isArray(),
  body('logRetentionDays').optional().isInt({ min: 1 }),
  body('sortOrder').optional().isInt({ min: 0 }),
  body('isActive').optional().isBoolean(),
  body('isDefault').optional().isBoolean(),
  body('lsVariantIdMonthly').optional().isString(),
], validate, async (req, res) => {
  try {
    const { planId } = req.params;
    const allowed = [
      'name', 'description', 'priceMonthly',
      'maxActiveConfigs', 'minSyncIntervalMinutes', 'maxItemsPerRun',
      'connectorTiers', 'logRetentionDays', 'sortOrder',
      'isActive', 'isDefault', 'lsVariantIdMonthly',
    ];
    const update = { updatedAt: new Date().toISOString() };
    for (const key of allowed) {
      if (req.body[key] !== undefined) update[key] = req.body[key];
    }

    await db.collection('plans').doc(planId).set(update, { merge: true });
    if (update.isDefault === true) await unsetOtherDefaults(planId);

    logger.info('admin-plans', `Plan "${planId}" updated`, { user: req.user.uid });
    await logAdminActivity({
      uid: req.user.uid, userEmail: req.user.email,
      action: 'update', targetType: 'plan', targetId: planId, targetName: update.name || planId,
    });
    return res.json({ success: true });
  } catch (err) {
    logger.error('admin-plans', 'Failed to update plan', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// Generate a stable, human-readable plan ID from its name (matches the
// convention already used by 'free'/'pro'/'business' — unlike the Platforms
// collection, plan IDs are referenced as literal string keys throughout the
// codebase, so they must stay readable rather than switching to opaque
// auto-generated Firestore IDs.
function slugify(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'plan';
}

// Unset isDefault on every plan except `keepPlanId` — enforces the
// invariant that at most one plan is ever marked default. Was previously
// only run from the PUT (update) handler; the POST (create) handler set
// isDefault: true on a brand-new plan without this, so creating a new
// default plan left the OLD default also still marked default — two plans
// simultaneously "Default" until the next unrelated update happened to
// trigger this cleanup.
async function unsetOtherDefaults(keepPlanId) {
  const snap = await db.collection('plans').where('isDefault', '==', true).get();
  const batch = db.batch();
  let any = false;
  snap.forEach(doc => {
    if (doc.id !== keepPlanId) {
      batch.update(doc.ref, { isDefault: false });
      any = true;
    }
  });
  if (any) await batch.commit();
}

async function generateUniquePlanId(name) {
  const base = slugify(name);
  let candidate = base;
  let suffix = 2;
  while ((await db.collection('plans').doc(candidate).get()).exists) {
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }
  return candidate;
}

async function nextSortOrder() {
  const snap = await db.collection('plans').get();
  let max = 0;
  snap.forEach(doc => {
    const sortOrder = doc.data().sortOrder;
    if (typeof sortOrder === 'number' && sortOrder > max) max = sortOrder;
  });
  return max + 10;
}

// Create a new plan (ID auto-generated as a slug of the name)
router.post('/admin/plans', verifyAuth, requireSuperAdmin, [
  body('name').isString().trim().notEmpty(),
], validate, async (req, res) => {
  try {
    const rest = req.body;
    const id = await generateUniquePlanId(rest.name);
    const plan = {
      name: rest.name,
      description: rest.description || '',
      priceMonthly: rest.priceMonthly ?? 0,
      lsVariantIdMonthly: rest.lsVariantIdMonthly || '',
      maxActiveConfigs: rest.maxActiveConfigs ?? 1,
      minSyncIntervalMinutes: rest.minSyncIntervalMinutes ?? 30,
      maxItemsPerRun: rest.maxItemsPerRun ?? 100,
      connectorTiers: rest.connectorTiers || ['basic'],
      logRetentionDays: rest.logRetentionDays ?? 7,
      sortOrder: await nextSortOrder(),
      isActive: rest.isActive !== undefined ? rest.isActive : true,
      isDefault: rest.isDefault === true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await db.collection('plans').doc(id).set(plan);
    if (plan.isDefault === true) await unsetOtherDefaults(id);

    logger.info('admin-plans', `Plan "${id}" created`, { user: req.user.uid });
    await logAdminActivity({
      uid: req.user.uid, userEmail: req.user.email,
      action: 'create', targetType: 'plan', targetId: id, targetName: plan.name,
    });
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
    await logAdminActivity({
      uid: req.user.uid, userEmail: req.user.email,
      action: newActive ? 'activate' : 'deactivate', targetType: 'plan', targetId: req.params.planId, targetName: current.name,
    });
    return res.json({ success: true, isActive: newActive });
  } catch (err) {
    logger.error('admin-plans', 'Failed to toggle plan', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;

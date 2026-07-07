const { Router } = require('express');
const { body, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');
const { defaultKeyGenerator } = rateLimit;
const { verifyAuth } = require('../middleware/auth');
const { resolveConnectionTokens } = require('../../domains/connection/resolver');
const { getConnector } = require('../../domains/connector/registry');
const { suggestMappings } = require('../../domains/sync/mapping-suggester');
const { getPlan, enforcePlanLimits, enforceTotalConfigCap } = require('../../core/plan');
const { deleteSyncConfig } = require('../../domains/sync/config-deletion');
const { runSync } = require('../../domains/sync/engine');
const db = require('../../core/db');
const logger = require('../../core/logger');

/** Per-user rate limiter for suggest-mappings (Gemini-backed, costly) */
const suggestLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: (req) => req.user?.uid ?? defaultKeyGenerator(req),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many mapping suggestions requested. Please wait before trying again.' },
});

const router = Router();

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Validation failed', details: errors.array() });
  }
  next();
};

/**
 * Resolve a platform ID to its connector key.
 */
async function resolvePlatform(platformId) {
  try {
    getConnector(platformId);
    return platformId;
  } catch (e) {
    const platDoc = await db.collection('platforms').doc(platformId).get();
    if (!platDoc.exists) return platformId;
    const platData = platDoc.data();
    return platData.connectorKey || platData.key || platformId;
  }
}

/**
 * Look up workspace and plan for the current user.
 * Shared by POST and PUT handlers.
 */
async function resolveWorkspacePlan(uid) {
  const userDoc = await db.collection('users').doc(uid).get();
  if (!userDoc.exists) return { error: 'User not found' };
  const workspaceId = userDoc.data().workspaceId;
  if (!workspaceId) return { error: 'No workspace found' };

  const wsDoc = await db.collection('workspaces').doc(workspaceId).get();
  const wsData = wsDoc.data() || {};
  const planId = wsData.planId || 'free';
  const plan = await getPlan(planId);

  return { workspaceId, wsData, planId, plan };
}

router.post('/suggest-mappings', verifyAuth, suggestLimiter, [
  body('sourceConnectionId').isString().trim().notEmpty(),
  body('destConnectionId').isString().trim().notEmpty(),
  body('sourcePlatform').isString().trim().notEmpty(),
  body('destPlatform').isString().trim().notEmpty(),
  body('sourceEntityType').optional().isString(),
  body('destEntityType').optional().isString(),
  body('context').optional().isObject(),
], validate, async (req, res) => {
  try {
    const {
      sourceConnectionId, destConnectionId,
      sourcePlatform, destPlatform,
      sourceEntityType, destEntityType,
      context = {}
    } = req.body;

    if (!sourceConnectionId || !destConnectionId || !sourcePlatform || !destPlatform) {
      return res.status(400).json({ success: false, error: 'Missing required connection or platform IDs' });
    }

    const [sourceCreds, destCreds] = await Promise.all([
      resolveConnectionTokens(req.user.uid, sourceConnectionId),
      resolveConnectionTokens(req.user.uid, destConnectionId)
    ]);

    const resolvedSourcePlatform = await resolvePlatform(sourcePlatform);
    const resolvedDestPlatform = await resolvePlatform(destPlatform);

    let SourceConnectorClass, DestConnectorClass;
    try {
      SourceConnectorClass = getConnector(resolvedSourcePlatform);
      DestConnectorClass = getConnector(resolvedDestPlatform);
    } catch (e) {
      return res.status(400).json({ success: false, error: e.message });
    }

    const sourceInstance = new SourceConnectorClass({ ...sourceCreds, ...context.source });
    const destInstance = new DestConnectorClass({ ...destCreds, ...context.dest });

    // Resolve entity types independently per connector
    const resolvedSourceEntityType = sourceEntityType || (sourceInstance.getEntityTypes?.() || ['default'])[0];
    const resolvedDestEntityType = destEntityType || (destInstance.getEntityTypes?.() || ['default'])[0];

    const [sourceSchema, destSchema] = await Promise.all([
      sourceInstance.getSchema(resolvedSourceEntityType, context.source || {}),
      destInstance.getSchema(resolvedDestEntityType, context.dest || {})
    ]);

    const data = await suggestMappings(sourceSchema, destSchema);

    res.json({
      success: true,
      suggestions: data.suggestions || [],
      sourceSchema,
      destSchema
    });
  } catch (err) {
    logger.error('sync-configs', 'Suggest mappings failed', { error: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Create a new sync config ─────────────────────────────────
router.post('/sync-configs', verifyAuth, [
  body('description').optional().isString().trim(),
  body('platform1').isString().trim().notEmpty(),
  body('platform2').isString().trim().notEmpty(),
  body('platform1ConnectionId').isString().trim().notEmpty(),
  body('platform2ConnectionId').isString().trim().notEmpty(),
  body('status').optional().isIn(['draft', 'active', 'paused']),
  body('cronSchedule').optional().isString(),
  body('fieldMappings').optional().isArray(),
  body('p1Settings').optional().isObject(),
  body('p2Settings').optional().isObject(),
  body('syncType').optional().isString(),
  body('filterConfig').optional().isObject(),
  body('creationSource').optional().isString(),
  body('integrationId').optional().isString(),
], validate, async (req, res) => {
  try {
    const uid = req.user.uid;
    const ctx = await resolveWorkspacePlan(uid);
    if (ctx.error) return res.status(404).json({ error: ctx.error });

    const status = req.body.status || 'active';

    // Plan enforcement (throws on violation)
    try {
      await enforceTotalConfigCap(ctx.workspaceId);
      await enforcePlanLimits(ctx.workspaceId, ctx.plan, {
        status,
        platform1: req.body.platform1,
        platform2: req.body.platform2,
        cronSchedule: req.body.cronSchedule,
      });
    } catch (planErr) {
      return res.status(403).json({ error: planErr.message });
    }

    // Build the config document
    const configData = {
      ...req.body,
      status,
      workspaceId: ctx.workspaceId,
      ownerId: uid,
      ownerName: req.user.name || req.user.email || uid,
      fieldMappings: req.body.fieldMappings || [],
      p1Settings: req.body.p1Settings || {},
      p2Settings: req.body.p2Settings || {},
      filterConfig: req.body.filterConfig || {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const ref = await db.collection('workspaces').doc(ctx.workspaceId)
      .collection('sync_configs').add(configData);

    logger.info('sync-configs', `Config created "${ref.id}" in workspace "${ctx.workspaceId}"`, { status });

    return res.status(201).json({ success: true, id: ref.id });
  } catch (err) {
    logger.error('sync-configs', 'Failed to create config', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// ─── Update an existing sync config ───────────────────────────
router.put('/sync-configs/:configId', verifyAuth, [
  body('description').optional().isString().trim(),
  body('platform1').optional().isString().trim(),
  body('platform2').optional().isString().trim(),
  body('platform1ConnectionId').optional().isString().trim(),
  body('platform2ConnectionId').optional().isString().trim(),
  body('status').optional().isIn(['draft', 'active', 'paused']),
  body('cronSchedule').optional().isString(),
  body('fieldMappings').optional().isArray(),
  body('p1Settings').optional().isObject(),
  body('p2Settings').optional().isObject(),
  body('syncType').optional().isString(),
  body('filterConfig').optional().isObject(),
  body('creationSource').optional().isString(),
  body('integrationId').optional().isString(),
], validate, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { configId } = req.params;

    const ctx = await resolveWorkspacePlan(uid);
    if (ctx.error) return res.status(404).json({ error: ctx.error });

    // Load existing config; check ownership
    const configRef = db.collection('workspaces').doc(ctx.workspaceId)
      .collection('sync_configs').doc(configId);
    const existingSnap = await configRef.get();
    if (!existingSnap.exists) {
      return res.status(404).json({ error: 'Config not found' });
    }
    const existingData = existingSnap.data();

    // Merge incoming fields over existing data
    const merged = { ...existingData, ...req.body };

    // Resolve the effective new status
    const newStatus = req.body.status !== undefined ? req.body.status : existingData.status;

    // Plan enforcement — only when relevant fields change or status transitions to active
    const needsPlanCheck =
      newStatus === 'active' || existingData.status !== 'active';
    const platformChanged =
      (req.body.platform1 && req.body.platform1 !== existingData.platform1) ||
      (req.body.platform2 && req.body.platform2 !== existingData.platform2);
    const cronChanged =
      req.body.cronSchedule !== undefined && req.body.cronSchedule !== existingData.cronSchedule;

    if (needsPlanCheck || platformChanged || cronChanged) {
      try {
        await enforcePlanLimits(ctx.workspaceId, ctx.plan, {
          status: newStatus,
          platform1: merged.platform1,
          platform2: merged.platform2,
          cronSchedule: merged.cronSchedule,
        }, { excludeOwnId: existingData.status === 'active' ? configId : undefined });
      } catch (planErr) {
        return res.status(403).json({ error: planErr.message });
      }
    }

    // Re-pin fields the client must never be able to override, same as POST.
    merged.workspaceId = ctx.workspaceId;
    merged.ownerId = existingData.ownerId;
    merged.updatedAt = new Date().toISOString();
    await configRef.set(merged, { merge: true });

    logger.info('sync-configs', `Config updated "${configId}" in workspace "${ctx.workspaceId}"`);

    return res.json({ success: true, id: configId });
  } catch (err) {
    logger.error('sync-configs', 'Failed to update config', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// Delete a config and cascade to its sync_mappings + lock (Firestore does not
// cascade subcollection deletes, so a client-side delete would orphan mappings).
router.delete('/sync-configs/:configId', verifyAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { configId } = req.params;

    const ctx = await resolveWorkspacePlan(uid);
    if (ctx.error) return res.status(404).json({ error: ctx.error });

    const configRef = db.collection('workspaces').doc(ctx.workspaceId)
      .collection('sync_configs').doc(configId);
    const existing = await configRef.get();
    if (!existing.exists) {
      return res.status(404).json({ error: 'Config not found' });
    }

    const result = await deleteSyncConfig(ctx.workspaceId, configId);
    logger.info('sync-configs', `Config deleted "${configId}" in workspace "${ctx.workspaceId}"`);
    return res.json({ success: true, id: configId, ...result });
  } catch (err) {
    logger.error('sync-configs', 'Failed to delete config', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// Restore a just-deleted config (used by the frontend's "Undo" toast action).
// Body is the full previously-deleted document, as returned to the client at
// delete time. workspaceId/ownerId are re-pinned server-side regardless of
// what the client sends, same as create/update.
router.post('/sync-configs/:configId/restore', verifyAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { configId } = req.params;

    const ctx = await resolveWorkspacePlan(uid);
    if (ctx.error) return res.status(404).json({ error: ctx.error });

    const configRef = db.collection('workspaces').doc(ctx.workspaceId)
      .collection('sync_configs').doc(configId);
    const existing = await configRef.get();
    if (existing.exists) {
      return res.status(409).json({ error: 'A config with this ID already exists.' });
    }

    const data = { ...req.body };
    delete data.id;
    data.workspaceId = ctx.workspaceId;
    data.ownerId = data.ownerId || uid;
    data.updatedAt = new Date().toISOString();

    await configRef.set(data);
    logger.info('sync-configs', `Config restored "${configId}" in workspace "${ctx.workspaceId}"`);
    return res.json({ success: true, id: configId });
  } catch (err) {
    logger.error('sync-configs', 'Failed to restore config', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// Manually trigger (or retry) a single config's sync. Scoped to the caller's
// own workspace via resolveWorkspacePlan + the sync_configs subcollection
// path — a user can never trigger another workspace's sync this way.
router.post('/sync-configs/:configId/run', verifyAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { configId } = req.params;

    const ctx = await resolveWorkspacePlan(uid);
    if (ctx.error) return res.status(404).json({ error: ctx.error });

    const configRef = db.collection('workspaces').doc(ctx.workspaceId)
      .collection('sync_configs').doc(configId);
    const existing = await configRef.get();
    if (!existing.exists) {
      return res.status(404).json({ error: 'Config not found' });
    }

    logger.info('sync-configs', `Manual run triggered for "${configId}" in workspace "${ctx.workspaceId}"`, { user: uid });
    const result = await runSync(existing.data(), configId);
    return res.json({ success: true, id: configId, ...(result || {}) });
  } catch (err) {
    logger.error('sync-configs', 'Manual sync run failed', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;

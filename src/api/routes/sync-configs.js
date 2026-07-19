const { Router } = require('express');
const { body, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');
const { defaultKeyGenerator } = rateLimit;
const { verifyAuth } = require('../middleware/auth');
const { resolveConnectionTokens } = require('../../domains/connection/resolver');
const { getConnector } = require('../../domains/connector/registry');
const { suggestMappings } = require('../../domains/sync/mapping-suggester');
const { getPlan, enforcePlanLimits, enforceTotalConfigCap } = require('../../core/plan');
const { resolveConnectorKey } = require('../../core/platform');
const { deleteSyncConfig } = require('../../domains/sync/config-deletion');
const { runSync } = require('../../domains/sync/engine');
const db = require('../../core/db');
const logger = require('../../core/logger');
const { logUsageEvent } = require('../../domains/usage');

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
    logger.error('sync-configs', `Validation failed on ${req.method} ${req.path}`, { details: errors.array(), body: req.body });
    return res.status(400).json({ error: 'Validation failed', details: errors.array() });
  }
  next();
};

/**
 * Resolve platform1/platform2 from the connection documents themselves
 * rather than trusting whatever the client sent. The client derives these
 * from a locally-cached connections array that has repeatedly gone stale
 * (a fresh OAuth connection not yet in cache, an async ordering race, a
 * workspace switch) — each time silently sending platform1/platform2 as
 * null, which express-validator's .notEmpty() correctly rejects with a
 * 400 that gives the user no indication anything is wrong with their
 * setup. The connectionId fields are already required and validated
 * against this workspace, so deriving the platform from them server-side
 * is strictly more reliable and closes this whole bug class at the root.
 */
async function resolvePlatformsFromConnections(workspaceId, conn1Id, conn2Id) {
  const [snap1, snap2] = await Promise.all([
    db.collection('connected_accounts').doc(conn1Id).get(),
    db.collection('connected_accounts').doc(conn2Id).get(),
  ]);
  if (!snap1.exists || snap1.data().workspaceId !== workspaceId) {
    throw new Error('Source connection not found');
  }
  if (!snap2.exists || snap2.data().workspaceId !== workspaceId) {
    throw new Error('Destination connection not found');
  }
  return { platform1: snap1.data().provider, platform2: snap2.data().provider };
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

    const resolvedSourcePlatform = await resolveConnectorKey(sourcePlatform);
    const resolvedDestPlatform = await resolveConnectorKey(destPlatform);

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

// ─── Preview mapped sample data (wizard "Preview" step) ────────
// Lets the wizard show what a handful of *real* source records look like
// once mapped, before the config is ever saved or activated — read-only,
// same as suggest-mappings: only ever calls the source connector's fetch(),
// never touches the destination in any way (no create/update calls), so
// there is nothing here that could write real data anywhere.
router.post('/preview-mapping', verifyAuth, suggestLimiter, [
  body('sourceConnectionId').isString().trim().notEmpty(),
  body('sourcePlatform').isString().trim().notEmpty(),
  body('sourceEntityType').optional().isString(),
  body('context').optional().isObject(),
  body('sourceFields').isArray({ min: 1 }),
  body('sourceFields.*').isString(),
], validate, async (req, res) => {
  try {
    const { sourceConnectionId, sourcePlatform, sourceEntityType, context = {}, sourceFields } = req.body;

    const sourceCreds = await resolveConnectionTokens(req.user.uid, sourceConnectionId);
    const resolvedSourcePlatform = await resolveConnectorKey(sourcePlatform);

    let SourceConnectorClass;
    try {
      SourceConnectorClass = getConnector(resolvedSourcePlatform);
    } catch (e) {
      return res.status(400).json({ success: false, error: e.message });
    }

    const sourceInstance = new SourceConnectorClass({ ...sourceCreds, ...context });
    const resolvedEntityType = sourceEntityType || (sourceInstance.getEntityTypes?.() || ['default'])[0];

    // fetch()'s 2nd arg is the *filter* (e.g. TickTick's { listName }), not
    // credentials context — passing {} here always queried the default
    // "Inbox" list regardless of what the user actually selected in the
    // wizard, which is why this returned nothing for anyone using a
    // non-default list/project. `context` (already spread into the
    // connector's credentials above for connectors that read it from
    // there) is exactly what a real Load-Data call for this same list uses
    // as its filter, so it belongs here too.
    const items = await sourceInstance.fetch(resolvedEntityType, context, {});
    const PREVIEW_LIMIT = 3;
    const samples = items.slice(0, PREVIEW_LIMIT).map(item => {
      const fields = {};
      for (const key of sourceFields) fields[key] = item[key] ?? null;
      return {
        title: sourceInstance.getDisplayTitle ? sourceInstance.getDisplayTitle(item) : (item.title || item.name || 'Untitled'),
        fields,
      };
    });

    res.json({ success: true, samples, totalAvailable: items.length });
  } catch (err) {
    logger.error('sync-configs', 'Preview mapping failed', { error: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── List sync configs for the caller's workspace ──────────────
// Was previously a raw client-side Firestore read from the Flows page
// (app.js's loadConfigs), the Marketplace view (hub.js), and saveConfig's
// marketplace-draft lookup — consolidated here so all three go through one
// server-mediated path instead of duplicating the same collection read (and
// so it can be tightened/paginated later without touching three separate
// frontend files). ?status= mirrors hub.js's existing filtered query (it
// only wants status=='active' for its "already connected" check).
// ?integrationId= mirrors saveConfig's marketplace-draft lookup.
router.get('/sync-configs', verifyAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const ctx = await resolveWorkspacePlan(uid);
    if (ctx.error) return res.status(404).json({ error: ctx.error });

    const configsRef = db.collection('workspaces').doc(ctx.workspaceId).collection('sync_configs');
    const { status, integrationId, connectionId } = req.query;
    if (status && !['draft', 'active', 'paused'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status filter' });
    }

    let base = configsRef;
    if (status) base = base.where('status', '==', status);
    if (integrationId) base = base.where('integrationId', '==', integrationId);

    let items;
    if (connectionId) {
      // A config references a connection via either of two fields —
      // Firestore can't OR across two different fields in one query, so this
      // mirrors what the frontend previously did client-side (two queries,
      // merged by doc id) rather than adding a composite/array-contains field.
      const [snap1, snap2] = await Promise.all([
        base.where('platform1ConnectionId', '==', connectionId).get(),
        base.where('platform2ConnectionId', '==', connectionId).get(),
      ]);
      const byId = new Map();
      for (const d of [...snap1.docs, ...snap2.docs]) byId.set(d.id, { id: d.id, ...d.data() });
      items = Array.from(byId.values());
    } else {
      const snap = await base.get();
      items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    }

    return res.json({ success: true, items });
  } catch (err) {
    logger.error('sync-configs', 'Failed to list configs', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// ─── Fetch a single sync config ─────────────────────────────────
router.get('/sync-configs/:configId', verifyAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { configId } = req.params;
    const ctx = await resolveWorkspacePlan(uid);
    if (ctx.error) return res.status(404).json({ error: ctx.error });

    const snap = await db.collection('workspaces').doc(ctx.workspaceId)
      .collection('sync_configs').doc(configId).get();
    if (!snap.exists) return res.status(404).json({ error: 'Config not found' });

    return res.json({ success: true, item: { id: snap.id, ...snap.data() } });
  } catch (err) {
    logger.error('sync-configs', 'Failed to fetch config', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// ─── Create a new sync config ─────────────────────────────────
router.post('/sync-configs', verifyAuth, [
  body('description').optional().isString().trim(),
  body('platform1').optional().isString().trim(),
  body('platform2').optional().isString().trim(),
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
  // { nullable: true } is required, not just optional() alone — the client
  // sends integrationId: null (not an omitted field) whenever a config
  // wasn't created from a marketplace integration, and express-validator's
  // optional() only skips validation for an actually-missing field by
  // default; a literal null still hits .isString() and fails it.
  body('integrationId').optional({ nullable: true }).isString(),
], validate, async (req, res) => {
  try {
    const uid = req.user.uid;
    const ctx = await resolveWorkspacePlan(uid);
    if (ctx.error) return res.status(404).json({ error: ctx.error });

    const status = req.body.status || 'active';

    let platform1, platform2;
    try {
      ({ platform1, platform2 } = await resolvePlatformsFromConnections(
        ctx.workspaceId, req.body.platform1ConnectionId, req.body.platform2ConnectionId
      ));
    } catch (resolveErr) {
      return res.status(400).json({ error: resolveErr.message });
    }

    // Plan enforcement (throws on violation)
    try {
      await enforceTotalConfigCap(ctx.workspaceId);
      await enforcePlanLimits(ctx.workspaceId, ctx.plan, {
        status,
        platform1,
        platform2,
        cronSchedule: req.body.cronSchedule,
      });
    } catch (planErr) {
      return res.status(403).json({ error: planErr.message });
    }

    // Build the config document
    const configData = {
      ...req.body,
      platform1,
      platform2,
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

    await logUsageEvent(uid, ctx.workspaceId, 'flow_created');

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
  // { nullable: true } is required, not just optional() alone — the client
  // sends integrationId: null (not an omitted field) whenever a config
  // wasn't created from a marketplace integration, and express-validator's
  // optional() only skips validation for an actually-missing field by
  // default; a literal null still hits .isString() and fails it.
  body('integrationId').optional({ nullable: true }).isString(),
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

    // When either connection is being changed, re-derive platform1/platform2
    // from the connection documents rather than trusting client-supplied
    // values — see resolvePlatformsFromConnections() above for why.
    if (req.body.platform1ConnectionId || req.body.platform2ConnectionId) {
      try {
        const resolved = await resolvePlatformsFromConnections(
          ctx.workspaceId,
          merged.platform1ConnectionId,
          merged.platform2ConnectionId
        );
        merged.platform1 = resolved.platform1;
        merged.platform2 = resolved.platform2;
      } catch (resolveErr) {
        return res.status(400).json({ error: resolveErr.message });
      }
    }

    // Resolve the effective new status
    const newStatus = req.body.status !== undefined ? req.body.status : existingData.status;

    // Plan enforcement — only when relevant fields change or status transitions to active
    const needsPlanCheck =
      newStatus === 'active' || existingData.status !== 'active';
    const platformChanged =
      merged.platform1 !== existingData.platform1 ||
      merged.platform2 !== existingData.platform2;
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
    merged.updatedById = uid;
    merged.updatedByName = req.user.name || req.user.email || uid;
    await configRef.set(merged, { merge: true });

    logger.info('sync-configs', `Config updated "${configId}" in workspace "${ctx.workspaceId}"`);

    if (req.body.fieldMappings !== undefined
        && JSON.stringify(req.body.fieldMappings) !== JSON.stringify(existingData.fieldMappings || [])) {
      await logUsageEvent(uid, ctx.workspaceId, 'field_mapping_changed');
    }

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

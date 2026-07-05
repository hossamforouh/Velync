const { Router } = require('express');
const { body, validationResult } = require('express-validator');
const { FieldValue } = require('@google-cloud/firestore');
const { verifyAuth } = require('../middleware/auth');
const { resolveConnectionTokens } = require('../../domains/connection/resolver');
const { getConnector } = require('../../domains/connector/registry');
const { suggestMappings } = require('../../domains/sync/mapping-suggester');
const { getPlan } = require('../../core/plan');
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

router.post('/suggest-mappings', verifyAuth, [
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

// Create a new sync config with plan-gating enforcement
router.post('/sync-configs', verifyAuth, [
  body('description').optional().isString().trim(),
  body('platform1').isString().trim().notEmpty(),
  body('platform2').isString().trim().notEmpty(),
  body('platform1ConnectionId').isString().trim().notEmpty(),
  body('platform2ConnectionId').isString().trim().notEmpty(),
  body('status').optional().isIn(['draft', 'active']),
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
    const userDoc = await db.collection('users').doc(uid).get();
    if (!userDoc.exists) return res.status(404).json({ error: 'User not found' });
    const workspaceId = userDoc.data().workspaceId;
    if (!workspaceId) return res.status(400).json({ error: 'No workspace found' });

    const wsDoc = await db.collection('workspaces').doc(workspaceId).get();
    const wsData = wsDoc.data() || {};
    const planId = wsData.planId || 'free';
    const plan = await getPlan(planId);

    const status = req.body.status || 'active';

    // Only enforce plan limits for active configs (drafts don't count)
    if (status === 'active' && plan) {
      // 2a: maxActiveConfigs
      if (plan.maxActiveConfigs) {
        const activeSnap = await db.collection('workspaces').doc(workspaceId)
          .collection('sync_configs')
          .where('status', '==', 'active')
          .get();
        if (activeSnap.size >= plan.maxActiveConfigs) {
          const msg = `Your ${plan.name || planId} plan allows ${plan.maxActiveConfigs} active config${plan.maxActiveConfigs !== 1 ? 's' : ''}. Upgrade to add more.`;
          return res.status(403).json({ error: msg });
        }
      }

      // 2b: connector tier gating
      const connectorTiers = plan.connectorTiers || ['basic'];
      const [p1Doc, p2Doc] = await Promise.all([
        db.collection('platforms').doc(req.body.platform1).get(),
        db.collection('platforms').doc(req.body.platform2).get(),
      ]);
      const p1Tier = p1Doc.exists ? (p1Doc.data().tier || 'basic') : 'basic';
      const p2Tier = p2Doc.exists ? (p2Doc.data().tier || 'basic') : 'basic';
      for (const tier of [p1Tier, p2Tier]) {
        if (!connectorTiers.includes(tier)) {
          const msg = `Your ${plan.name || planId} plan does not support "${tier}" tier connectors. Upgrade to connect this platform.`;
          return res.status(403).json({ error: msg });
        }
      }

      // 2c: min sync interval
      if (plan.minSyncIntervalMinutes && req.body.cronSchedule) {
        const intervalMinutes = cronToMinutes(req.body.cronSchedule);
        if (intervalMinutes !== null && intervalMinutes < plan.minSyncIntervalMinutes) {
          const msg = `Your ${plan.name || planId} plan requires a minimum sync interval of ${plan.minSyncIntervalMinutes} minutes. "${req.body.cronSchedule}" runs every ${intervalMinutes} minute(s).`;
          return res.status(403).json({ error: msg });
        }
      }
    }

    // Build the config document
    const configData = {
      ...req.body,
      status,
      workspaceId,
      ownerId: uid,
      ownerName: req.user.name || req.user.email || uid,
      fieldMappings: req.body.fieldMappings || [],
      p1Settings: req.body.p1Settings || {},
      p2Settings: req.body.p2Settings || {},
      filterConfig: req.body.filterConfig || {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const ref = await db.collection('workspaces').doc(workspaceId)
      .collection('sync_configs').add(configData);

    logger.info('sync-configs', `Config created "${ref.id}" in workspace "${workspaceId}"`, { status });

    return res.status(201).json({ success: true, id: ref.id });
  } catch (err) {
    logger.error('sync-configs', 'Failed to create config', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Convert a cron expression to its approximate interval in minutes.
 * Only handles simple "every N minutes" patterns; returns null for complex schedules.
 */
function cronToMinutes(cronExpr) {
  if (!cronExpr || typeof cronExpr !== 'string') return null;
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  // Match patterns like "*/5 * * * *" or "0 */2 * * *" 
  const minuteMatch = parts[0].match(/^\*\/(\d+)$/);
  if (minuteMatch) return parseInt(minuteMatch[1], 10);
  const hourMatch = parts[1].match(/^\*\/(\d+)$/);
  if (hourMatch && (parts[0] === '0' || parts[0] === '0,30')) return parseInt(hourMatch[1], 10) * 60;
  return null; // Non-standard schedule — skip enforcement
}

module.exports = router;

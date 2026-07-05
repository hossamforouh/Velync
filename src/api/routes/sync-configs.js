const { Router } = require('express');
const { body, validationResult } = require('express-validator');
const { verifyAuth } = require('../middleware/auth');
const { resolveConnectionTokens } = require('../../domains/connection/resolver');
const { getConnector } = require('../../domains/connector/registry');
const { suggestMappings } = require('../../domains/sync/mapping-suggester');
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

module.exports = router;

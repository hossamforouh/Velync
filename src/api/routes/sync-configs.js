const { Router } = require('express');
const { verifyAuth } = require('../middleware/auth');
const { resolveConnectionTokens } = require('../../domains/connection/resolver');
const { getConnector } = require('../../domains/connector/registry');
const { suggestMappings } = require('../../domains/sync/mapping-suggester');
const logger = require('../../core/logger');
const { Firestore } = require('@google-cloud/firestore');

const router = Router();
const db = new Firestore();

async function resolvePlatform(platformId) {
  try {
    getConnector(platformId);
    return platformId;
  } catch (e) {
    const platDoc = await db.collection('platforms').doc(platformId).get();
    if (!platDoc.exists) return platformId;
    const platData = platDoc.data();
    let resolved = platData.key || platData.name?.toLowerCase() || platData.title?.toLowerCase() || platformId;
    if (resolved === platformId) {
       if (platData.authUrl?.includes('ticktick')) resolved = 'ticktick';
       if (platData.authUrl?.includes('notion')) resolved = 'notion';
    }
    return resolved;
  }
}

router.post('/suggest-mappings', verifyAuth, async (req, res) => {
  try {
    const { 
      sourceConnectionId, destConnectionId, 
      sourcePlatform, destPlatform, 
      entityType, context = {} 
    } = req.body;
    
    console.log("[Suggest Mappings] Request body:", JSON.stringify(req.body));

    if (!sourceConnectionId || !destConnectionId || !sourcePlatform || !destPlatform) {
      return res.status(400).json({ success: false, error: 'Missing required connection or platform IDs' });
    }

    const [sourceCreds, destCreds] = await Promise.all([
      resolveConnectionTokens(req.user.uid, sourceConnectionId).catch(() => ({})),
      resolveConnectionTokens(req.user.uid, destConnectionId).catch(() => ({}))
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

    const [sourceSchema, destSchema] = await Promise.all([
      sourceInstance.getSchema(entityType || 'Tasks', context.source || {}),
      destInstance.getSchema(context.dest?.entityType || 'Database', context.dest || {})
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

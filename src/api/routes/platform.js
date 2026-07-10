const { Router } = require('express');
const { body, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');
const { verifyAuth } = require('../middleware/auth');
const { resolveConnectionTokens } = require('../../domains/connection/resolver');
const { getConnector } = require('../../domains/connector/registry');
const { resolveConnectorKey } = require('../../core/platform');
const db = require('../../core/db');
const logger = require('../../core/logger');

const router = Router();

// Was previously mounted at the top-level `app.use('/api', authLimiter, platformRoutes)`
// in server.js — but since Express's app.use(path, ...) prefix-matches, that made
// this limiter count EVERY /api/* request in the whole app (any request reaching
// this middleware, whether or not platformRoutes actually had a matching
// sub-route), not just the two routes below. Scoped directly to them here instead.
const platformLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Validation failed', details: errors.array() });
  }
  next();
};

router.get('/data-sources', verifyAuth, platformLimiter, async (req, res) => {
  try {
    const platformsSnap = await db.collection('platforms').get();
    const sources = [];
    for (const doc of platformsSnap.docs) {
      const plat = doc.data();
      if (plat.configSchema) {
        for (const field of plat.configSchema) {
          if (field.dataSource) {
            sources.push({ id: field.dataSource, name: `${plat.name}: ${field.label}` });
          }
        }
      }
    }
    res.json(sources);
  } catch (err) {
    logger.error('platform', 'Failed to fetch data-sources', { error: err.message });
    res.status(500).json([]);
  }
});

const DATA_SOURCE_ALIASES = {
  'fetchTickTickLists': 'lists',
  'ticktick.getProjects': 'lists',
  'fetchTickTickTags': 'tags',
  'fetchNotionDBs': 'databases',
  'fetchNotionTemplates': 'templates',
  'google_contacts_fetch_groups': 'contactGroups',
};

router.post('/platform-entities', verifyAuth, platformLimiter, [
  body('connectionId').isString().trim().notEmpty(),
  body('dataSourceId').optional().isString(),
  body('providerName').optional().isString(),
  body('parentValue').optional().isString(),
], validate, async (req, res) => {
  try {
    const { connectionId, dataSourceId, parentValue } = req.body;
    logger.info('platform', 'platform-entities called', { connectionId, dataSourceId, parentValue, uid: req.user?.uid });

    if (!dataSourceId) {
      return res.status(400).json({ success: false, error: 'dataSourceId is required' });
    }

    // Resolve connection provider from the document
    const connDoc = await db.collection('connected_accounts').doc(connectionId).get();
    if (!connDoc.exists) throw new Error('Connection not found');
    const provider = connDoc.data().provider;
    if (!provider) throw new Error('Connection has no provider');

    // Resolve credentials and instantiate the connector. `provider` is a
    // `platforms` Firestore doc ID, not necessarily the connector registry
    // key (platform docs get auto-generated IDs) — resolve it first.
    const creds = await resolveConnectionTokens(req.user.uid, connectionId);
    const connectorKey = await resolveConnectorKey(provider);
    const ConnectorClass = getConnector(connectorKey);
    const connector = new ConnectorClass(creds);

    // Map legacy dataSourceId names to canonical field IDs
    const fieldId = DATA_SOURCE_ALIASES[dataSourceId] || dataSourceId;

    // Pass parentValue as context so connectors can use it
    const items = await connector.getDataSource(fieldId, { parentValue });
    const entities = (items || []).map(i => ({ id: i.value, name: i.label }));

    logger.info('platform', 'returning entities', { count: entities.length, provider, fieldId });
    res.json({ success: true, entities });
  } catch (err) {
    logger.error('platform', 'Failed to fetch entities', { error: err.message, stack: err.stack?.split('\n').slice(0,5).join(' | ') });
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;

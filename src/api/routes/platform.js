const { Router } = require('express');
const { body, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');
const { verifyAuth } = require('../middleware/auth');
const { resolveConnectionTokens } = require('../../domains/connection/resolver');
const { getConnector, getRegisteredPlatforms } = require('../../domains/connector/registry');
const { resolveConnectorKey } = require('../../core/platform');
const db = require('../../core/db');
const logger = require('../../core/logger');

const router = Router();

// Was previously mounted at the top-level `app.use('/api', authLimiter, platformRoutes)`
// in server.js — but since Express's app.use(path, ...) prefix-matches, that made
// this limiter count EVERY /api/* request in the whole app (any request reaching
// this middleware, whether or not platformRoutes actually had a matching
// sub-route), not just the two routes below. Scoped directly to them here instead.
// 20/min was tight enough that normal wizard usage could trip it: a single
// "Setup Trigger"/"Setup Action" modal auto-loads List Name + Tags on open,
// re-fetches List Name every time Target Entity changes, and each manual
// "Refresh" click adds one more — a few minutes of legitimate back-and-forth
// (switching entity type, retrying) could plausibly reach 20 without any
// abuse involved. Raised to 60/min: still a real ceiling against scripted
// abuse, just with headroom for interactive use.
const platformLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
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

// Powers the admin Platform editor's "Data Source Function" picker (Sync
// Schema step, for Dynamic Dropdown fields). Previously this scanned
// existing platforms' configSchema for already-saved field.dataSource
// values — a chicken-and-egg bug: the only choosable options were ones a
// dynamic field had already been saved with somewhere, so the list was
// empty on any fresh platform/deployment and could never be bootstrapped.
// Reads the connector contract's declared getDataSources() instead — each
// registered connector states its own real capabilities (see
// Connector.getDataSources() in interface.js), so this is populated from
// what a connector can ACTUALLY fetch, not from prior admin data entry.
// Deduped by id since two connectors could in principle declare the same
// canonical fieldId.
router.get('/data-sources', verifyAuth, platformLimiter, async (req, res) => {
  try {
    const seen = new Map();
    for (const platformId of getRegisteredPlatforms()) {
      const ConnectorClass = getConnector(platformId);
      const declared = typeof ConnectorClass.getDataSources === 'function' ? ConnectorClass.getDataSources() : [];
      for (const ds of declared) {
        if (ds?.id && !seen.has(ds.id)) seen.set(ds.id, { id: ds.id, name: ds.name || ds.id });
      }
    }
    res.json(Array.from(seen.values()));
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

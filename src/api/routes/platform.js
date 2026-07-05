const { Router } = require('express');
const { body, query, validationResult } = require('express-validator');
const { verifyAuth } = require('../middleware/auth');
const { resolveConnectionTokens } = require('../../domains/connection/resolver');
const { getConnector } = require('../../domains/connector/registry');
const { NotionService } = require('../../../services/notion');
const { TickTickService } = require('../../../services/ticktick');
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

router.get('/data-sources', verifyAuth, async (req, res) => {
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

router.post('/platform-entities', verifyAuth, [
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

    // Resolve credentials and instantiate the connector
    const creds = await resolveConnectionTokens(req.user.uid, connectionId);
    const ConnectorClass = getConnector(provider);
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

router.get('/notion/databases', verifyAuth, [
  query('connectionId').isString().trim().notEmpty(),
], validate, async (req, res) => {
  try {
    const connectionId = req.query.connectionId;
    const creds = await resolveConnectionTokens(req.user.uid, connectionId);
    const notion = new NotionService(creds.accessToken);
    const databases = await notion.listDatabases();
    res.json({ success: true, databases });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/ticktick/lists', verifyAuth, [
  query('connectionId').isString().trim().notEmpty(),
], validate, async (req, res) => {
  try {
    const connectionId = req.query.connectionId;
    const creds = await resolveConnectionTokens(req.user.uid, connectionId);
    const ticktick = new TickTickService(creds);
    const lists = await ticktick.getProjects();
    res.json({ success: true, lists: lists || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/notion-databases', verifyAuth, [
  body('connectionId').optional().isString(),
  body('token').optional().isString(),
], validate, async (req, res) => {
  try {
    const { connectionId, token } = req.body;
    let actualToken = token;
    if (connectionId) {
      const creds = await resolveConnectionTokens(req.user.uid, connectionId);
      actualToken = creds.accessToken;
    }
    if (!actualToken) throw new Error('Token or Connection ID required');
    const notion = new NotionService(actualToken);
    const databases = await notion.listDatabases();
    res.json({ success: true, databases });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/notion-database-schema', verifyAuth, [
  body('databaseId').isString().trim().notEmpty(),
  body('connectionId').optional().isString(),
  body('token').optional().isString(),
], validate, async (req, res) => {
  try {
    const { connectionId, databaseId, token } = req.body;
    let actualToken = token;
    if (connectionId) {
      const creds = await resolveConnectionTokens(req.user.uid, connectionId);
      actualToken = creds.accessToken;
    }
    if (!actualToken) throw new Error('Token or Connection ID required');
    const notion = new NotionService(actualToken, databaseId);
    const properties = await notion.getDatabaseSchema();
    const schema = {};
    for (const [key, prop] of Object.entries(properties)) {
      schema[key] = { label: prop.name || key, type: prop.type };
      if (prop.type === 'status' && prop.status) schema[key].options = prop.status.options;
      if (prop.type === 'select' && prop.select) schema[key].options = prop.select.options;
    }
    res.json({ success: true, schema });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/notion-database-templates', verifyAuth, [
  body('databaseId').isString().trim().notEmpty(),
  body('connectionId').optional().isString(),
  body('token').optional().isString(),
], validate, async (req, res) => {
  try {
    const { connectionId, databaseId, token } = req.body;
    if (!databaseId) throw new Error('Notion database ID is required');
    let actualToken = token;
    if (connectionId) {
      const creds = await resolveConnectionTokens(req.user.uid, connectionId);
      actualToken = creds.accessToken;
    }
    if (!actualToken) throw new Error('Token or Connection ID required');
    const notion = new NotionService(actualToken, databaseId);
    const templates = await notion.listTemplates();
    res.json({ success: true, templates });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;

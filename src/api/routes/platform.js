const { Router } = require('express');
const { body, query, validationResult } = require('express-validator');
const { verifyAuth } = require('../middleware/auth');
const { resolveConnectionTokens } = require('../../domains/connection/resolver');
const { NotionService } = require('../../../services/notion');
const { TickTickService } = require('../../../services/ticktick');
const logger = require('../../core/logger');

const router = Router();

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Validation failed', details: errors.array() });
  }
  next();
};

router.get('/data-sources', verifyAuth, (req, res) => {
  res.json([
    { id: 'fetchTickTickLists', name: 'TickTick: Fetch Lists' },
    { id: 'fetchTickTickTags', name: 'TickTick: Fetch Tags' },
    { id: 'fetchNotionDBs', name: 'Notion: Fetch Databases' },
    { id: 'fetchNotionTemplates', name: 'Notion: Fetch Templates' },
    { id: 'google_contacts_fetch_groups', name: 'Google Contacts: Fetch Contact Groups' },
  ]);
});

router.post('/platform-entities', verifyAuth, [
  body('connectionId').isString().trim().notEmpty(),
  body('dataSourceId').optional().isString(),
  body('providerName').optional().isString(),
  body('parentValue').optional().isString(),
], validate, async (req, res) => {
  try {
    const { connectionId, providerName, dataSourceId, parentValue } = req.body;
    logger.info('platform', 'platform-entities called', { connectionId, dataSourceId, parentValue, uid: req.user?.uid });

    const creds = await resolveConnectionTokens(req.user.uid, connectionId);
    let entities = [];

    switch (dataSourceId) {
      case 'fetchTickTickLists':
      case 'ticktick.getProjects': {
        const ticktick = new TickTickService(creds);
        const lists = await ticktick.getProjectsFiltered(parentValue);
        entities = (lists || []).map(l => ({ id: l.id || l.name, name: l.name }));
        break;
      }
      case 'fetchTickTickTags': {
        const ticktick = new TickTickService(creds);
        const tags = await ticktick.getAllTags();
        entities = (tags || []).map(t => ({ id: t.id, name: t.name }));
        break;
      }
      case 'google_contacts_fetch_groups':
        entities = [
          { id: 'contactGroups/all', name: 'All Contacts' },
          { id: 'contactGroups/starred', name: 'Starred Contacts' },
        ];
        break;
      case 'fetchNotionDBs': {
        logger.info('platform', 'calling NotionService.listDatabases', { tokenPrefix: creds.accessToken?.substring(0, 10) });
        const notion = new NotionService(creds.accessToken);
        const databases = await notion.listDatabases();
        entities = (databases || []).map(db => ({ id: db.id, name: db.title || db.id }));
        break;
      }
      case 'fetchNotionTemplates': {
        if (!parentValue) throw new Error('Database ID (parentValue) is required to fetch templates');
        const notion = new NotionService(creds.accessToken, parentValue);
        const templates = await notion.listTemplates();
        entities = (templates || []).map(t => ({ id: t.id, name: t.name || t.id }));
        break;
      }
      default:
        throw new Error(`Unknown data source: ${dataSourceId}`);
    }

    logger.info('platform', 'returning entities', { count: entities.length });
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

const { Router } = require('express');
const { Firestore } = require('@google-cloud/firestore');
const { verifyAuth } = require('../middleware/auth');
const { resolveConnectionTokens } = require('../../domains/connection/resolver');
const { NotionService } = require('../../../services/notion');
const { TickTickService } = require('../../../services/ticktick');
const logger = require('../../core/logger');

const db = new Firestore();
const router = Router();

router.get('/data-sources', verifyAuth, (req, res) => {
  res.json([
    { id: 'fetchTickTickLists', name: 'TickTick: Fetch Lists' },
    { id: 'fetchTickTickTags', name: 'TickTick: Fetch Tags' },
    { id: 'fetchNotionDBs', name: 'Notion: Fetch Databases' },
    { id: 'fetchNotionTemplates', name: 'Notion: Fetch Templates' },
    { id: 'google_contacts_fetch_groups', name: 'Google Contacts: Fetch Contact Groups' },
  ]);
});

router.post('/platform-entities', verifyAuth, async (req, res) => {
  try {
    const { connectionId, providerName, dataSourceId, parentValue } = req.body;
    if (!connectionId) throw new Error('Connection ID required');

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
      default:
        throw new Error(`Unknown data source: ${dataSourceId}`);
    }

    res.json({ success: true, entities });
  } catch (err) {
    logger.error('platform', 'Failed to fetch entities', { error: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/notion/databases', verifyAuth, async (req, res) => {
  try {
    const connectionId = req.query.connectionId;
    if (!connectionId) throw new Error('Connection ID required');
    const creds = await resolveConnectionTokens(req.user.uid, connectionId);
    const notion = new NotionService(creds.accessToken);
    const databases = await notion.listDatabases();
    res.json({ success: true, databases });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/ticktick/lists', verifyAuth, async (req, res) => {
  try {
    const connectionId = req.query.connectionId;
    if (!connectionId) throw new Error('Connection ID required');
    const creds = await resolveConnectionTokens(req.user.uid, connectionId);
    const ticktick = new TickTickService(creds);
    const lists = await ticktick.getProjects();
    res.json({ success: true, lists: lists || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/notion-databases', verifyAuth, async (req, res) => {
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

router.post('/notion-database-schema', verifyAuth, async (req, res) => {
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
    const schema = await notion.getDatabaseSchema();
    res.json({ success: true, schema });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/notion-database-templates', verifyAuth, async (req, res) => {
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

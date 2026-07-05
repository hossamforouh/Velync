# Velync Architecture Export

## 1. Connector Base Class

**`src/domains/connector/interface.js`**

```js
class Connector {
  constructor(credentials) {
    this.credentials = credentials;
  }

  async connect() {
    throw new Error('connect() must be implemented');
  }

  async fetch(entityType, filter = {}) {
    throw new Error('fetch() must be implemented');
  }

  async create(entityType, data) {
    throw new Error('create() must be implemented');
  }

  async update(entityType, id, data) {
    throw new Error('update() must be implemented');
  }

  async delete(entityType, id) {
    throw new Error('delete() must be implemented');
  }

  getSchema(entityType, context = {}) {
    throw new Error('getSchema() must be implemented');
  }

  async getDataSource(fieldId, context = {}) {
    throw new Error('getDataSource() must be implemented');
  }
}

module.exports = { Connector };
```

---

## 2. Full Notion Connector Implementation

**`src/domains/connector/notion.js`**

```js
const { Connector } = require('./interface');
const { NotionService } = require('../../../services/notion');
const { register } = require('./registry');

class NotionConnector extends Connector {
  get databaseId() {
    return this.credentials.databaseId || this.credentials.database;
  }

  async connect() {
    const svc = new NotionService(this.credentials.accessToken, this.databaseId);
    try {
      await svc.testNotionConnection();
      return true;
    } catch {
      return false;
    }
  }

  async fetch(entityType, filter = {}) {
    const svc = new NotionService(this.credentials.accessToken, this.databaseId);
    const pages = await svc.getDatabasePages();
    return pages;
  }

  async create(entityType, data) {
    const { properties, content, children, templateId } = data;
    const svc = new NotionService(this.credentials.accessToken, this.databaseId);
    let dbSchema = {};
    try {
      dbSchema = await svc.getDatabaseSchema();
    } catch (err) {
      console.error(`[NotionConnector] Failed to fetch database schema:`, err.message);
    }
    const { createNotionPage } = require('./notion-page');
    return createNotionPage(svc, properties, content, dbSchema, data.title || 'Untitled', children || [], templateId);
  }

  async update(entityType, id, data) {
    const svc = new NotionService(this.credentials.accessToken, this.databaseId);
    return svc.updateDatabasePage(id, data.properties);
  }

  async delete(entityType, id) {
    const svc = new NotionService(this.credentials.accessToken, this.databaseId);
    return svc.archiveDatabasePage(id);
  }

  async getSchema(entityType, context = {}) {
    const databaseId = context.databaseId || context.database || this.credentials.databaseId;
    if (databaseId) {
      const svc = new NotionService(this.credentials.accessToken, databaseId);
      try {
        const properties = await svc.getDatabaseSchema();
        if (!properties) {
          throw new Error("Cannot retrieve properties for this database. It may be a linked view or an empty synced database.");
        }
        const schema = {};
        for (const [key, prop] of Object.entries(properties)) {
          schema[key] = {
            label: prop.name || key,
            type: prop.type
          };
          if (prop.type === 'status' && prop.status) schema[key].options = prop.status.options;
          if (prop.type === 'select' && prop.select) schema[key].options = prop.select.options;
        }
        return schema;
      } catch (err) {
        console.error(`[NotionConnector] Failed to fetch database schema for ${databaseId}:`, err.message);
        return { __error: { label: `Error: ${err.message}`, type: 'error' } };
      }
    }
    return { titleField: { type: 'title', label: 'Title' } };
  }

  async getDataSource(fieldId, context = {}) {
    const databaseId = context.databaseId || context.database || this.credentials.databaseId;
    const svc = new NotionService(this.credentials.accessToken, databaseId);
    if (fieldId === 'databases') {
      const dbs = await svc.listDatabases();
      return (dbs || []).map(d => ({ value: d.id, label: d.title }));
    }
    if (fieldId === 'templates') {
      const templates = await svc.listTemplates().catch(() => []);
      return (templates || []).map(t => ({ value: t.id, label: t.name }));
    }
    return [];
  }
}

register('notion', NotionConnector);
module.exports = NotionConnector;
```

**`src/domains/connector/notion-page.js`**

```js
const axios = require('axios');
const config = require('../../core/config');
const http = axios.create({ timeout: config.externalApiTimeout });

function buildSyncChildren(content, checklistItems = []) {
  const innerChildren = [];
  if (content && content.trim() !== '') {
    const lines = content.split('\n');
    const attachmentRegex = /!\[([^\]]*)\]\(([a-f0-9]+\/[^\)]+)\)/gi;
    for (const line of lines) {
      const cleanedLine = line.replace(attachmentRegex, '').trim();
      if (cleanedLine !== '') {
        innerChildren.push({
          object: 'block',
          type: 'paragraph',
          paragraph: {
            rich_text: [{ type: 'text', text: { content: cleanedLine.substring(0, 2000) } }],
          },
        });
      }
    }
  }
  if (Array.isArray(checklistItems) && checklistItems.length > 0) {
    for (const checklistItem of checklistItems) {
      const itemTitle = checklistItem.title || '';
      if (itemTitle.trim() !== '') {
        innerChildren.push({
          object: 'block', type: 'to_do',
          to_do: {
            rich_text: [{ type: 'text', text: { content: itemTitle.substring(0, 2000) } }],
            checked: checklistItem.status === 1 || checklistItem.status === 2,
          },
        });
      }
    }
  }
  if (innerChildren.length > 0) {
    return [{
      object: 'block', type: 'toggle',
      toggle: {
        rich_text: [{ type: 'text', text: { content: 'TickTick Sync Content' } }],
        children: innerChildren.slice(0, 99)
      }
    }];
  }
  return [];
}

async function createNotionPage(notionService, properties, content, dbSchema, fallbackTitle, checklistItems = [], templateId = null) {
  const children = buildSyncChildren(content, checklistItems);
  let hasTitle = false;
  for (const key of Object.keys(properties)) {
    if (dbSchema[key]?.type === 'title') { hasTitle = true; break; }
  }
  if (!hasTitle) {
    const titlePropName = Object.keys(dbSchema).find(k => dbSchema[k].type === 'title') || 'Name';
    properties[titlePropName] = {
      title: [{ type: 'text', text: { content: fallbackTitle.substring(0, 2000) } }]
    };
  }
  let page;
  let shouldDelay = false;
  if (templateId) {
    console.log(`[Notion Service] Creating page using template ID: ${templateId}...`);
    const { dataSourceId, isRealDataSource } = await notionService.getDataSourceId();
    const headers = {
      'Authorization': `Bearer ${notionService.notionToken}`,
      'Notion-Version': '2026-03-11',
      'Content-Type': 'application/json'
    };
    const buildPayload = (parentType) => ({
      parent: parentType === 'database_id'
        ? { type: 'database_id', database_id: dataSourceId }
        : { type: 'data_source_id', data_source_id: dataSourceId },
      template: { type: 'template_id', template_id: templateId },
      properties,
    });
    try {
      const res = await http.post('https://api.notion.com/v1/pages',
        isRealDataSource ? buildPayload('data_source_id') : buildPayload('database_id'), { headers });
      page = res.data;
      shouldDelay = true;
    } catch (firstErr) {
      if (!isRealDataSource && firstErr.response?.status === 404) {
        console.log(`[Notion Service] Retrying with data_source_id parent type...`);
        const res = await http.post('https://api.notion.com/v1/pages', buildPayload('data_source_id'), { headers });
        page = res.data;
        shouldDelay = true;
      } else { throw firstErr; }
    }
  } else {
    try {
      page = await notionService.client.pages.create({
        parent: { database_id: notionService.databaseId },
        properties: properties,
      });
    } catch (err) {
      if (err.code === 'object_not_found' || err.code === 'validation_error') {
        console.log(`[Notion Service] Falling back to data_source_id for page creation...`);
        page = await notionService.client.pages.create({
          parent: { type: 'data_source_id', data_source_id: notionService.databaseId },
          properties: properties,
        });
      } else { throw err; }
    }
  }
  if (shouldDelay) await new Promise(resolve => setTimeout(resolve, 250));
  return page;
}

module.exports = { createNotionPage, buildSyncChildren };
```

**`services/notion.js`**

```js
const { Client } = require('@notionhq/client');
const axios = require('axios');
const config = require('../src/core/config');
const http = axios.create({ timeout: config.externalApiTimeout });

class NotionService {
  constructor(notionToken, databaseId) {
    this.notionToken = notionToken;
    this.databaseId = databaseId;
    this.client = new Client({
      auth: this.notionToken,
      timeoutMs: config.externalApiTimeout,
    });
  }

  async _getDatabaseMetadata() {
    if (this.trueDatabaseId) {
      return this.client.databases.retrieve({ database_id: this.trueDatabaseId });
    }
    try {
      return await this.client.databases.retrieve({ database_id: this.databaseId });
    } catch (err) {
      if (err.code === 'object_not_found' || err.code === 'validation_error') {
        const ds = await this.client.dataSources.retrieve({ data_source_id: this.databaseId });
        if (ds.parent && ds.parent.type === 'database_id') {
          this.trueDatabaseId = ds.parent.database_id;
        }
        return ds;
      }
      throw err;
    }
  }

  async testNotionConnection() {
    if (!this.notionToken || this.notionToken.startsWith('secret_your')) {
      throw new Error('Notion token is missing or placeholder.');
    }
    if (!this.databaseId || this.databaseId.startsWith('your_notion')) {
      throw new Error('Notion Database ID is missing or placeholder.');
    }
    try {
      const response = await this._getDatabaseMetadata();
      const dbTitle = response.title && response.title[0] ? response.title[0].plain_text : 'Untitled';
      console.log(`[Notion Service] Successfully connected! Target Database Title: "${dbTitle}"`);
      return response;
    } catch (error) {
      console.error('[Notion Service] Connection test failed:', error.message);
      throw error;
    }
  }

  async listDatabases() {
    if (!this.notionToken || this.notionToken.startsWith('secret_your')) {
      throw new Error('Notion token is missing or placeholder.');
    }
    try {
      const allResults = [];
      let cursor = undefined;
      let hasMore = true;
      while (hasMore) {
        const response = await this.client.search({ start_cursor: cursor, page_size: 100 });
        allResults.push(...response.results);
        hasMore = response.has_more;
        cursor = response.next_cursor;
        if (!hasMore) break;
      }
      const databases = allResults
        .filter(obj => obj.object === 'database' || obj.object === 'data_source')
        .map(db => {
          let title = 'Untitled Database';
          if (db.title && Array.isArray(db.title) && db.title[0]) {
            title = db.title[0].plain_text || 'Untitled Database';
          } else if (db.properties?.title?.title?.[0]?.plain_text) {
            title = db.properties.title.title[0].plain_text;
          } else if (db.name) {
            title = db.name;
          }
          return { id: db.id, title };
        });
      const pages = allResults.filter(obj => obj.object === 'page');
      const uniqueDatabasesMap = new Map();
      const seenTitles = new Set();
      databases.forEach(db => {
        if (!db || (!db.id && !db.title)) return;
        const normId = String(db.id).replace(/-/g, '').toLowerCase();
        if (!uniqueDatabasesMap.has(normId) && !seenTitles.has(db.title)) {
          uniqueDatabasesMap.set(normId, db);
          if (db.title) seenTitles.add(db.title);
        }
      });
      const finalDatabases = Array.from(uniqueDatabasesMap.values());
      return finalDatabases;
    } catch (error) {
      console.error('[Notion Service] Failed to list databases:', error.message);
      throw error;
    }
  }

  async createDatabasePage({ title, status = 'Inbox', format = 'Note / Idea', topics = [], url, content }) {
    try {
      const dbMetadata = await this._getDatabaseMetadata();
      const availableOptions = dbMetadata.properties?.Topic?.multi_select?.options || [];
      const multiSelectValues = topics.map(topic => {
        const match = availableOptions.find(opt => opt.name.toLowerCase() === topic.toLowerCase());
        return { name: match ? match.name : topic };
      });
      const children = [];
      if (content && content.trim() !== '') {
        const lines = content.split('\n');
        const attachmentRegex = /!\[([^\]]*)\]\(([a-f0-9]+\/[^\)]+)\)/gi;
        for (const line of lines) {
          const cleanedLine = line.replace(attachmentRegex, '').trim();
          if (cleanedLine !== '') {
            children.push({
              object: 'block', type: 'paragraph',
              paragraph: { rich_text: [{ type: 'text', text: { content: cleanedLine.substring(0, 2000) } }] },
            });
          }
        }
      }
      const pageProperties = {
        Name: { title: [{ type: 'text', text: { content: title } }] },
        Status: { status: { name: status } },
        Format: { select: { name: format } },
        Topic: { multi_select: multiSelectValues },
      };
      if (url) pageProperties.URL = { url: url };
      let response;
      try {
        response = await this.client.pages.create({
          parent: { database_id: this.databaseId },
          properties: pageProperties,
          children: children.length > 0 ? children.slice(0, 100) : undefined,
        });
      } catch (err) {
        if (err.code === 'object_not_found' || err.code === 'validation_error') {
          response = await this.client.pages.create({
            parent: { type: 'data_source_id', data_source_id: this.databaseId },
            properties: pageProperties,
            children: children.length > 0 ? children.slice(0, 100) : undefined,
          });
        } else { throw err; }
      }
      return response;
    } catch (error) {
      console.error(`[Notion Service] Failed to create database page:`, error.message);
      throw error;
    }
  }

  async getDatabasePages() {
    try {
      let results = [];
      let cursor = undefined;
      let hasMore = true;
      let useDataSource = false;
      let queryId = this.databaseId;
      try {
        const meta = await this.client.databases.retrieve({ database_id: this.databaseId });
        if (meta.data_sources && meta.data_sources.length > 0) {
          queryId = meta.data_sources[0].id;
          useDataSource = true;
        }
      } catch (e) {
        if (e.code === 'object_not_found') {
          useDataSource = true;
        } else {
          console.warn(`[Notion Service] Failed to retrieve database metadata:`, e.message);
        }
      }
      while (hasMore) {
        let response;
        if (useDataSource) {
          response = await this.client.dataSources.query({
            data_source_id: queryId, start_cursor: cursor, page_size: 100,
          });
        } else {
          response = await this.client.databases.query({
            database_id: queryId, start_cursor: cursor, page_size: 100,
          });
        }
        results = results.concat(response.results);
        hasMore = response.has_more;
        cursor = response.next_cursor;
      }
      return results;
    } catch (error) {
      console.error(`[Notion Service] Failed to query database pages:`, error.message);
      throw error;
    }
  }

  async getDatabaseSchema() {
    try {
      const response = await this._getDatabaseMetadata();
      if (response.properties) return response.properties;
      return {};
    } catch (error) {
      console.error(`[Notion Service] Failed to retrieve metadata for ID resolution.`, error.message);
      throw error;
    }
  }

  async updateDatabasePage(pageId, properties) {
    try {
      const response = await this.client.pages.update({ page_id: pageId, properties: properties });
      return response;
    } catch (error) {
      console.error(`[Notion Service] Failed to update page ${pageId}:`, error.message);
      throw error;
    }
  }

  async archiveDatabasePage(pageId) {
    try {
      const response = await this.client.pages.update({ page_id: pageId, archived: true });
      return response;
    } catch (error) {
      console.error(`[Notion Service] Failed to archive page ${pageId}:`, error.message);
      throw error;
    }
  }

  async getPageContentBlocks(pageId) {
    try {
      const response = await this.client.blocks.children.list({ block_id: pageId });
      const textBlocks = response.results
        .filter(block => ['paragraph','heading_1','heading_2','heading_3','bulleted_list_item','numbered_list_item','quote','callout'].includes(block.type))
        .map(block => {
          const type = block.type;
          const richText = block[type]?.rich_text || [];
          return richText.map(t => t.plain_text).join('');
        });
      return textBlocks.join('\n');
    } catch (error) {
      console.error(`[Notion Service] Failed to retrieve page content for page ${pageId}:`, error.message);
      return '';
    }
  }

  async getDataSourceId() {
    if (this.dataSourceId !== undefined && this._dataSourceMeta) return this._dataSourceMeta;
    const headers = {
      'Authorization': `Bearer ${this.notionToken}`,
      'Notion-Version': '2026-03-11',
      'Content-Type': 'application/json'
    };
    try {
      const res = await http.get(`https://api.notion.com/v1/databases/${this.databaseId}`, { headers });
      const dataSources = res.data.data_sources || [];
      const isRealDataSource = dataSources.length > 0;
      this.dataSourceId = isRealDataSource ? dataSources[0].id : this.databaseId;
      this._dataSourceMeta = { dataSourceId: this.dataSourceId, isRealDataSource };
      return this._dataSourceMeta;
    } catch (err) {
      console.error('[Notion Service] Failed to retrieve data source ID:', err.message);
      this._dataSourceMeta = { dataSourceId: this.databaseId, isRealDataSource: false };
      return this._dataSourceMeta;
    }
  }

  async listTemplates() {
    const headers = {
      'Authorization': `Bearer ${this.notionToken}`,
      'Notion-Version': '2026-03-11',
      'Content-Type': 'application/json'
    };
    try {
      const { dataSourceId } = await this.getDataSourceId();
      const res = await http.get(`https://api.notion.com/v1/data_sources/${dataSourceId}/templates`, { headers });
      return res.data.templates || [];
    } catch (err) {
      console.error('[Notion Service] Failed to list database templates:', err.message);
      throw err;
    }
  }
}

module.exports = { NotionService };
```

---

## 3. Example `sync_configs` Document

This is a real-shaped document based on the code's field-mapping schema. Tokens and IDs are redacted; the structure is intact.

```json
{
  "workspaceId": "REDACTED_USER_UID",
  "platform1": "ticktick",
  "platform2": "notion",
  "platform1ConnectionId": "REDACTED_CONNECTION_ID",
  "platform2ConnectionId": "REDACTED_CONNECTION_ID",
  "sourceConnectionId": "REDACTED_CONNECTION_ID",
  "destConnectionId": "REDACTED_CONNECTION_ID",
  "sourcePlatform": "ticktick",
  "destPlatform": "notion",
  "status": "active",
  "syncType": "Source_to_Dest",
  "description": "TickTick Tasks → Notion Database",
  "targetEntity": "Tasks",
  "deleteAfterSync": false,
  "lastRunAt": "2026-07-05T12:00:00.000Z",
  "p1Settings": {
    "targetEntity": "Tasks",
    "listName": "Inbox"
  },
  "p2Settings": {
    "targetEntity": "Database",
    "database": "REDACTED_NOTION_DATABASE_ID",
    "templateId": ""
  },
  "fieldMappings": [
    {
      "sourceField": "title",
      "destField": "Name"
    },
    {
      "sourceField": "desc",
      "destField": "Description"
    },
    {
      "sourceField": "status",
      "destField": "Status"
    },
    {
      "sourceField": "priority",
      "destField": "Priority"
    },
    {
      "sourceField": "tags",
      "destField": "Tags"
    },
    {
      "sourceField": "dueDate",
      "destField": "Due Date"
    },
    {
      "sourceField": "content",
      "destField": "__content__"
    }
  ],
  "statusMappings": {
    "incompleteDefault": "Not started",
    "completeDefault": "Completed"
  },
  "filterConfig": {},
  "createdAt": "2026-06-01T10:00:00.000Z",
  "updatedAt": "2026-07-05T10:00:00.000Z"
}
```

Each `fieldMappings` entry is `{ sourceField: string, destField: string }`. The special destField `__content__` routes the source value into the page body content rather than a property.

---

## 4. Route Handler: `POST /api/sync-configs/suggest-mappings`

**`src/api/routes/sync-configs.js`**

```js
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
    let resolved = platData.key || platData.name?.toLowerCase() || platData.title?.toLowerCase() || platformId;
    if (resolved === platformId) {
       if (platData.authUrl?.includes('ticktick')) resolved = 'ticktick';
       if (platData.authUrl?.includes('notion')) resolved = 'notion';
    }
    return resolved;
  }
}

router.post('/suggest-mappings', verifyAuth, [
  body('sourceConnectionId').isString().trim().notEmpty(),
  body('destConnectionId').isString().trim().notEmpty(),
  body('sourcePlatform').isString().trim().notEmpty(),
  body('destPlatform').isString().trim().notEmpty(),
  body('entityType').optional().isString(),
  body('context').optional().isObject(),
], validate, async (req, res) => {
  try {
    const {
      sourceConnectionId, destConnectionId,
      sourcePlatform, destPlatform,
      entityType, context = {}
    } = req.body;

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
```

**`src/domains/sync/mapping-suggester.js`**

```js
const { GoogleGenAI, Type } = require('@google/genai');
const logger = require('../../core/logger');

const ai = new GoogleGenAI({ vertexai: true, project: 'velync', location: 'us-central1' });

async function suggestMappings(sourceSchema, destSchema) {
  try {
    const prompt = `You are an intelligent data mapping assistant for Velync, a SaaS integration platform.
Your task is to map fields from a source application to a destination application based on their semantic meaning, data types, and logical relationship.

Source Schema:
${JSON.stringify(sourceSchema, null, 2)}

Destination Schema:
${JSON.stringify(destSchema, null, 2)}

Instructions:
1. Analyze the fields and their types from both schemas.
2. Provide a list of mapping suggestions.
3. Each suggestion must include the source field key, destination field key, confidence score (0.0 to 1.0), and a short 1-sentence reasoning.
4. Only map fields if you have a reasonable confidence (>= 0.5) that they correspond logically.
5. Do NOT force a mapping. If a destination field lacks a logical source, leave it unmapped (do not include it in the array).
6. Pay close attention to field types. For example, a source "title" logically maps to a destination "title", "rich_text", or "text".`;

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            suggestions: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  sourceField: { type: Type.STRING, description: "The key of the field from the Source Schema." },
                  destField: { type: Type.STRING, description: "The key of the field from the Destination Schema." },
                  confidence: { type: Type.NUMBER, description: "A number between 0.0 and 1.0 representing your confidence in this mapping." },
                  reasoning: { type: Type.STRING, description: "A brief, 1 sentence explanation of why this mapping is logically sound." }
                },
                required: ["sourceField", "destField", "confidence", "reasoning"]
              }
            }
          },
          required: ["suggestions"]
        }
      }
    });

    const data = JSON.parse(response.text);
    return data;
  } catch (error) {
    logger.error('mapping-suggester', 'LLM mapping suggestion failed', { error: error.message });
    throw error;
  }
}

module.exports = { suggestMappings };
```

---

## 5. Generic Mapper (Runtime Transform Engine)

**`src/domains/sync/mapper.js`**

```js
function mapSourceToDest(sourceItem, fieldMappings, sourceSchema, destSchema, statusMappings = null) {
  const properties = {};
  let content = '';

  for (const m of fieldMappings) {
    const { sourceField, destField } = m;
    if (!sourceField || !destField) continue;

    let value = sourceItem[sourceField];
    if (sourceField === 'title' && !value && sourceItem.name) value = sourceItem.name;
    if ((sourceField === 'desc' || sourceField === 'content') && !value) value = sourceItem.desc || sourceItem.content || '';
    if (destField === '__content__') { content = value ? String(value) : ''; continue; }

    const destProp = destSchema[destField];
    if (!destProp) continue;
    if (value === undefined || value === null) continue;

    switch (destProp.type) {
      case 'title':
        properties[destField] = { title: [{ type: 'text', text: { content: String(value).substring(0, 2000) } }] };
        break;
      case 'rich_text':
        properties[destField] = { rich_text: [{ type: 'text', text: { content: String(value).substring(0, 2000) } }] };
        break;
      case 'number':
        properties[destField] = { number: Number(value) };
        break;
      case 'checkbox':
        properties[destField] = { checkbox: Boolean(value) };
        break;
      case 'url':
        properties[destField] = { url: String(value) };
        break;
      case 'select':
        properties[destField] = { select: { name: String(value).substring(0, 100) } };
        break;
      case 'status': {
        const statusOptions = destProp.status?.options || [];
        const numVal = Number(value);
        let mappedName;
        if (statusMappings) {
          if (numVal === 2 && statusMappings.completeDefault) {
            mappedName = statusMappings.completeDefault;
          } else if (numVal !== 2 && statusMappings.incompleteDefault) {
            mappedName = statusMappings.incompleteDefault;
          }
        }
        if (!mappedName) {
          if (numVal === 2) {
            const match = statusOptions.find(o => ['completed', 'complete', 'done'].includes(o.name.toLowerCase()));
            mappedName = match ? match.name : (statusOptions.find(o => o.color === 'green')?.name || statusOptions[0]?.name);
          } else {
            const match = statusOptions.find(o => ['not started', 'to-do', 'todo', 'in progress'].includes(o.name.toLowerCase()));
            mappedName = match ? match.name : statusOptions[0]?.name;
          }
        }
        if (mappedName) {
          properties[destField] = { status: { name: mappedName } };
        }
        break;
      }
      case 'multi_select': {
        let tags = Array.isArray(value) ? value : String(value).split(',').map(t => t.trim()).filter(Boolean);
        const options = destProp.multi_select?.options || [];
        properties[destField] = { multi_select: tags.map(tag => {
          const match = options.find(o => o.name.toLowerCase() === tag.toLowerCase());
          return { name: match ? match.name : tag };
        })};
        break;
      }
      case 'date':
        try { properties[destField] = { date: { start: new Date(value).toISOString() } }; } catch {}
        break;
    }
  }
  return { properties, content };
}

module.exports = { mapSourceToDest };
```

---

## 6. File Trees

```
src/domains/connector/
├── __template.js       # Connector subclass template
├── index.js            # Public API (re-exports from registry)
├── interface.js        # Connector base class
├── notion-page.js      # Notion page creation helpers (buildSyncChildren, createNotionPage)
├── notion.js           # NotionConnector extends Connector
├── registry.js         # Connector registry (Map, register, getConnector, getRegisteredPlatforms)
└── ticktick.js         # TickTickConnector extends Connector

src/domains/sync/
├── conflict.js         # Conflict resolution (resolveConflict)
├── engine.js           # Sync execution engine (runSync)
├── mapper.js           # mapSourceToDest — runtime field transform
├── mapping-suggester.js # suggestMappings — LLM-based mapping suggestions (Gemini)
└── scheduler.js        # Sync scheduler (Firestore-triggered)
```

const { Connector } = require('./interface');
const { NotionService } = require('../../../services/notion');
const { register } = require('./registry');

class NotionConnector extends Connector {
  async connect() {
    const svc = new NotionService(this.credentials.accessToken, this.credentials.databaseId);
    try {
      await svc.testNotionConnection();
      return true;
    } catch {
      return false;
    }
  }

  async fetch(entityType, filter = {}) {
    const svc = new NotionService(this.credentials.accessToken, this.credentials.databaseId);
    const pages = await svc.getDatabasePages();
    return pages;
  }

  async create(entityType, data) {
    const { properties, content, children, templateId } = data;
    const svc = new NotionService(this.credentials.accessToken, this.credentials.databaseId);
    const dbSchema = await svc.getDatabaseSchema();
    const { createNotionPage } = require('../../../workflows/syncInboxToNotion');
    return createNotionPage(svc, properties, content, dbSchema, data.title || 'Untitled', children || [], templateId);
  }

  async update(entityType, id, data) {
    const svc = new NotionService(this.credentials.accessToken, this.credentials.databaseId);
    return svc.updateDatabasePage(id, data.properties);
  }

  async delete(entityType, id) {
    const svc = new NotionService(this.credentials.accessToken, this.credentials.databaseId);
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

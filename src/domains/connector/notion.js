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

  getSchema(entityType, context = {}) {
    const databaseId = context.databaseId || this.credentials.databaseId;
    if (databaseId) {
      const svc = new NotionService(this.credentials.accessToken, databaseId);
      return svc.getDatabaseSchema().catch(() => ({}));
    }
    return { titleField: { type: 'title', label: 'Title' } };
  }

  async getDataSource(fieldId, context = {}) {
    const databaseId = context.databaseId || this.credentials.databaseId;
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

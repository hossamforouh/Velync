const crypto = require('crypto');
const { Connector } = require('./interface');
const { NotionService } = require('../../../services/notion');
const { register } = require('./registry');

// Event types this connector cares about — see WEBHOOK_SYNC_PLAN.md §0/§8
// build log for how this list was confirmed against Notion's official docs.
// `database.*` are pre-2025-09-03-API-version names, kept alongside their
// `data_source.*` replacements for compatibility with workspaces still on
// the older API version.
const WEBHOOK_EVENT_TYPES = [
  'page.created', 'page.content_updated', 'page.properties_updated',
  'page.moved', 'page.deleted', 'page.undeleted', 'page.locked', 'page.unlocked',
  'database.content_updated', 'database.schema_updated', 'database.created',
  'database.moved', 'database.deleted', 'database.undeleted',
  'data_source.content_updated', 'data_source.schema_updated', 'data_source.created',
  'data_source.moved', 'data_source.deleted', 'data_source.undeleted',
];

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

  async fetch(entityType, filter = {}, options = {}) {
    const svc = new NotionService(this.credentials.accessToken, this.databaseId);
    const pages = await svc.getDatabasePages({ modifiedSince: options.modifiedSince });
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

  getDisplayTitle(page) {
    if (!page.properties) return page.title || page.name || 'Untitled';
    for (const key of Object.keys(page.properties)) {
      const prop = page.properties[key];
      if (prop.type === 'title' && prop.title?.[0]?.plain_text) {
        return prop.title[0].plain_text;
      }
    }
    return page.title || page.name || 'Untitled';
  }

  async getDataSource(fieldId, context = {}) {
    const databaseId = context.databaseId || context.database || context.parentValue || this.credentials.databaseId;
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

  // ─── Webhook support (see WEBHOOK_SYNC_PLAN.md) ────────────────────

  static supportsWebhooks() {
    return true;
  }

  /**
   * Notion signs the raw request body with HMAC-SHA256, keyed by the
   * subscription's verification/signing secret, in the `X-Notion-Signature`
   * header as `sha256=<hex>`. Same pattern as lemonSqueezy.js's
   * verifyWebhookSignature — timing-safe compare, raw body must be the
   * unparsed bytes (see the server.js raw-body carve-out for this route).
   */
  static verifyWebhookSignature(rawBody, signatureHeader, secret) {
    if (!signatureHeader || !secret) return false;
    const prefix = 'sha256=';
    if (!signatureHeader.startsWith(prefix)) return false;
    const expected = prefix + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    const expectedBuf = Buffer.from(expected, 'utf8');
    const actualBuf = Buffer.from(signatureHeader, 'utf8');
    if (expectedBuf.length !== actualBuf.length) return false;
    return crypto.timingSafeEqual(expectedBuf, actualBuf);
  }

  /**
   * The one-time setup handshake: when a subscription is first created (or
   * ever recreated) in the Notion integration dashboard, Notion POSTs a
   * `verification_token` with no signature (there's no secret yet to sign
   * with). The route must detect this and surface the token for an admin to
   * paste back into the dashboard — see the runbook note in
   * WEBHOOK_SYNC_PLAN.md Stage 5.
   */
  static isVerificationHandshake(payload) {
    return !!(payload && typeof payload.verification_token === 'string' && !payload.type);
  }

  /**
   * Normalize a verified Notion webhook payload. Only `page`/`database`/
   * `data_source` entity events are meaningful for sync purposes —
   * `comment.*` events are deliberately out of scope (Velync doesn't sync
   * comments) and are rejected here rather than silently mis-parsed.
   */
  static parseWebhookEvent(payload) {
    const { type, entity, workspace_id: workspaceId } = payload || {};
    if (!type || !WEBHOOK_EVENT_TYPES.includes(type)) {
      throw new Error(`Unsupported or unrecognized Notion webhook event type: ${type}`);
    }
    if (!entity || !entity.id || !entity.type) {
      throw new Error('Notion webhook payload missing entity.{id,type}');
    }
    if (!workspaceId) {
      throw new Error('Notion webhook payload missing workspace_id');
    }
    return { workspaceId, entityId: entity.id, entityType: entity.type, eventType: type };
  }
}

register('notion', NotionConnector);
module.exports = NotionConnector;

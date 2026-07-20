class Connector {
  constructor(credentials) {
    this.credentials = credentials;
  }

  async connect() {
    throw new Error('connect() must be implemented');
  }

  /**
   * Fetch items from the platform.
   * @param {string} entityType - e.g. "Tasks", "Notes", "Contacts"
   * @param {object} filter - optional filters (listName, group, etc.)
   * @param {object} options
   * @param {string} [options.modifiedSince] - ISO timestamp; if set, only return items modified after this time
   * @returns {Promise<Array<{id: string, title?: string, modifiedTime?: string, ...}>>}
   */
  async fetch(entityType, filter = {}, options = {}) {
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

  /**
   * Declares which fieldIds this connector's getDataSource() actually
   * supports, so the admin Platform editor's "Data Source Function" picker
   * (Sync Schema step, for Dynamic Dropdown fields) can be populated from
   * the connector contract itself instead of needing at least one dynamic
   * field to already exist somewhere to bootstrap the list — see
   * GET /api/data-sources. Static (no credentials needed to enumerate what
   * a connector CAN fetch, only to actually fetch it).
   * @returns {Array<{id: string, name: string}>}
   */
  static getDataSources() {
    return [];
  }

  getEntityTypes() {
    return ['default'];
  }

  /**
   * Fetch only the IDs of current items for deletion-detection purposes.
   * The default calls fetch() without modifiedSince — override with a
   * cheaper API call when the platform supports it.
   * @param {string} entityType
   * @param {object} filter
   * @returns {Promise<Array<{id: string}>>}
   */
  async fetchIds(entityType, filter = {}) {
    const items = await this.fetch(entityType, filter);
    return items.map(i => ({ id: i.id }));
  }

  /**
   * Extract a human-readable display title from a native item object.
   * Each connector overrides this to read the appropriate field from its
   * own data shape (e.g. Notion reads properties.Name.title[0].plain_text,
   * TickTick reads item.title, Google Contacts reads names[0].displayName).
   */
  getDisplayTitle(item) {
    return item.title || item.name || 'Untitled';
  }

  // ─── Optional webhook capability (static — see WEBHOOK_SYNC_PLAN.md) ───
  // These are static, not instance methods: an inbound webhook arrives
  // before we know which user/connection it belongs to (that's the whole
  // point of parsing it), so there's no `credentials` to instantiate a
  // connector with yet. The registry already exposes the class itself
  // (getConnector(platformId)), so callers use these as
  // `getConnector('notion').verifyWebhookSignature(...)`.

  /** Does this connector support webhook-triggered sync? */
  static supportsWebhooks() {
    return false;
  }

  /**
   * Verify an inbound webhook's signature against the raw request body.
   * Returns `false` (not throw) when unsupported, so a caller that forgets
   * to check supportsWebhooks() first fails closed (rejects the request)
   * instead of crashing the handler.
   * @param {Buffer|string} rawBody - unparsed request body
   * @param {string} signatureHeader
   * @param {string} secret
   * @returns {boolean}
   */
  static verifyWebhookSignature(rawBody, signatureHeader, secret) {
    return false;
  }

  /**
   * Normalize a verified webhook payload into a platform-agnostic shape so
   * the reverse-lookup/dispatch code never touches platform-specific
   * fields.
   * @param {object} payload - parsed JSON body (only call after verifying)
   * @returns {{ workspaceId: string, entityId: string, entityType: string, eventType: string }}
   */
  static parseWebhookEvent(payload) {
    throw new Error('parseWebhookEvent() not supported by this connector');
  }
}

module.exports = { Connector };

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

  getEntityTypes() {
    return ['default'];
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
}

module.exports = { Connector };

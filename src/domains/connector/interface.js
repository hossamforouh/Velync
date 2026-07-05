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

  getEntityTypes() {
    return ['default'];
  }
}

module.exports = { Connector };

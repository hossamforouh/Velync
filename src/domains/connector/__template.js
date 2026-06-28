const { Connector } = require('./interface');
const { register } = require('./registry');

class MyPlatformConnector extends Connector {
  async connect() {
    // Test credentials: return true if valid, false otherwise
    return false;
  }

  async fetch(entityType, filter = {}) {
    // Fetch items of entityType (Tasks, Notes, Contacts, etc.)
    // Return array of items
    return [];
  }

  async create(entityType, data) {
    // Create item, return created object with .id
    return {};
  }

  async update(entityType, id, data) {
    // Update item by id, return updated object
    return {};
  }

  async delete(entityType, id) {
    // Delete item by id
  }

  getSchema(entityType) {
    // Return { fieldKey: { type, label } } for the given entityType
    return {};
  }

  async getDataSource(fieldId, context = {}) {
    // Return [{ value, label }] for dynamic selects
    return [];
  }
}

register('myplatform', MyPlatformConnector);
module.exports = MyPlatformConnector;

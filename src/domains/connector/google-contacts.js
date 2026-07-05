const { Connector } = require('./interface');
const { GooglePeopleService } = require('../../../services/google-contacts');
const { register } = require('./registry');

class GoogleContactsConnector extends Connector {
  async connect() {
    const svc = new GooglePeopleService(this.credentials.accessToken);
    try {
      await svc.testConnection();
      return true;
    } catch {
      return false;
    }
  }

  async fetch(entityType, filter = {}, options = {}) {
    const svc = new GooglePeopleService(this.credentials.accessToken);
    const group = filter.group || filter.resourceName || 'contactGroups/all';
    return svc.listContacts(group);
  }

  async fetchIds(entityType, filter = {}) {
    const svc = new GooglePeopleService(this.credentials.accessToken);
    const group = filter.group || filter.resourceName || 'contactGroups/all';
    const contacts = await svc.listContacts(group, 'names');
    return contacts.map(c => ({ id: c.id }));
  }

  async create(entityType, data) {
    const svc = new GooglePeopleService(this.credentials.accessToken);
    return svc.createContact(data);
  }

  async update(entityType, id, data) {
    const svc = new GooglePeopleService(this.credentials.accessToken);
    return svc.updateContact(id, data);
  }

  async delete(entityType, id) {
    const svc = new GooglePeopleService(this.credentials.accessToken);
    return svc.deleteContact(id);
  }

  getSchema(entityType, context = {}) {
    return {
      name: { type: 'title', label: 'Name' },
      givenName: { type: 'text', label: 'First Name' },
      familyName: { type: 'text', label: 'Last Name' },
      email: { type: 'email', label: 'Email' },
      phone: { type: 'phone', label: 'Phone' },
      organization: { type: 'text', label: 'Organization' },
      title: { type: 'text', label: 'Job Title' },
      address: { type: 'text', label: 'Address' },
    };
  }

  getDisplayTitle(contact) {
    const name = contact.names?.[0];
    return name?.displayName || name?.givenName || contact.title || contact.name || 'Untitled';
  }

  async getDataSource(fieldId, context = {}) {
    const svc = new GooglePeopleService(this.credentials.accessToken);
    if (fieldId === 'contactGroups') {
      const groups = await svc.listContactGroups();
      return [
        { value: 'contactGroups/all', label: 'All Contacts' },
        { value: 'contactGroups/starred', label: 'Starred Contacts' },
        ...groups.map(g => ({ value: g.id, label: g.name })),
      ];
    }
    return [];
  }
}

register('google_contacts', GoogleContactsConnector);
module.exports = GoogleContactsConnector;

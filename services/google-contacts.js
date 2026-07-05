const axios = require('axios');
const config = require('../src/core/config');
const http = axios.create({ timeout: config.externalApiTimeout });

class GooglePeopleService {
  constructor(accessToken) {
    this.accessToken = accessToken;
    this.baseUrl = 'https://people.googleapis.com/v1';
  }

  _headers() {
    return {
      Authorization: `Bearer ${this.accessToken}`,
      'Content-Type': 'application/json',
    };
  }

  async listContactGroups() {
    const res = await http.get(`${this.baseUrl}/contactGroups`, {
      headers: this._headers(),
      params: { pageSize: 200 },
    });
    const groups = res.data?.contactGroups || [];
    return groups.map(g => ({
      id: g.resourceName,
      name: g.name || g.resourceName,
    }));
  }

  async listContacts(resourceName = 'contactGroups/all') {
    const params = {
      personFields: 'names,emailAddresses,phoneNumbers,organizations,addresses',
      pageSize: 200,
    };
    if (resourceName && resourceName !== 'contactGroups/all') {
      params.resourceName = resourceName;
    }
    const res = await http.get(`${this.baseUrl}/people/me/connections`, {
      headers: this._headers(),
      params,
    });
    const connections = res.data?.connections || [];
    return connections.map(p => ({
      id: p.resourceName,
      ...p,
    }));
  }

  async getContact(resourceName) {
    const res = await http.get(`${this.baseUrl}/${resourceName}`, {
      headers: this._headers(),
      params: { personFields: 'names,emailAddresses,phoneNumbers,organizations,addresses' },
    });
    return res.data;
  }

  async createContact(data) {
    const res = await http.post(`${this.baseUrl}/people:createContact`, data, {
      headers: this._headers(),
    });
    return res.data;
  }

  async updateContact(resourceName, data, updatePersonFields) {
    const res = await http.patch(`${this.baseUrl}/${resourceName}:updateContact`, data, {
      headers: this._headers(),
      params: { updatePersonFields: updatePersonFields || 'names,emailAddresses,phoneNumbers' },
    });
    return res.data;
  }

  async deleteContact(resourceName) {
    await http.delete(`${this.baseUrl}/${resourceName}`, {
      headers: this._headers(),
    });
  }

  async testConnection() {
    const res = await http.get(`${this.baseUrl}/people/me`, {
      headers: this._headers(),
      params: { personFields: 'names' },
    });
    return res.data;
  }
}

module.exports = { GooglePeopleService };

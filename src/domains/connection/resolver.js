const { decrypt } = require('../../../utils/encryption');
const { ConnectionError } = require('../../core/errors');
const db = require('../../core/db');

async function resolveConnectionTokens(uid, connectionId) {
  const connDoc = await db.collection('connected_accounts').doc(connectionId).get();
  if (!connDoc.exists) throw new ConnectionError('Connection not found');
  const connData = connDoc.data();

  // Authorize: connection owner or workspace member
  if (connData.userId !== uid) {
    if (!connData.workspaceId) {
      throw new ConnectionError('Unauthorized access to connection');
    }
    const wsDoc = await db.collection('workspaces').doc(connData.workspaceId).get();
    if (!wsDoc.exists) throw new ConnectionError('Workspace not found');
    const ws = wsDoc.data();
    const members = ws.members || [];
    if (ws.ownerId !== uid && !members.includes(uid)) {
      throw new ConnectionError('Unauthorized access to connection');
    }
  }

  const provider = connData.provider;
  const credsOwnerId = connData.userId || connData.workspaceId || uid;
  const credsDoc = await db.collection('credentials').doc(credsOwnerId).get();
  if (credsDoc.exists) {
    const credsData = credsDoc.data();
    if (credsData[provider]) {
      const providerCreds = credsData[provider];
      return {
        accessToken: decrypt(providerCreds.accessToken),
        refreshToken: providerCreds.refreshToken ? decrypt(providerCreds.refreshToken) : null,
        clientId: providerCreds.clientId,
        clientSecret: providerCreds.clientSecret,
      };
    }
  }

  if (connData.accessToken || connData.clientId) {
    return {
      accessToken: connData.accessToken || '',
      refreshToken: null,
      clientId: connData.clientId || '',
      clientSecret: connData.clientSecret || '',
    };
  }

  if (connData.attributes && Array.isArray(connData.attributes)) {
    const accessAttr = connData.attributes.find(a => a.id === 'accessToken' || a.id === 'AccessToken');
    const clientIdAttr = connData.attributes.find(a => a.id === 'clientId' || a.id === 'ClientId');
    const clientSecretAttr = connData.attributes.find(a => a.id === 'clientSecret' || a.id === 'ClientSecret');
    if (accessAttr || clientIdAttr) {
      return {
        accessToken: accessAttr?.value || '',
        refreshToken: null,
        clientId: clientIdAttr?.value || '',
        clientSecret: clientSecretAttr?.value || '',
      };
    }
  }

  throw new ConnectionError(`Credentials not found for ${provider}`);
}

module.exports = { resolveConnectionTokens };

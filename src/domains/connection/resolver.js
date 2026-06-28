const { Firestore } = require('@google-cloud/firestore');
const { decrypt } = require('../../../utils/encryption');
const { ConnectionError } = require('../../core/errors');

const db = new Firestore();

async function resolveConnectionTokens(uid, connectionId) {
  const connDoc = await db.collection('connected_accounts').doc(connectionId).get();
  if (!connDoc.exists) throw new ConnectionError('Connection not found');
  const connData = connDoc.data();
  if (connData.userId !== uid && connData.workspaceId !== uid) {
    throw new ConnectionError('Unauthorized access to connection');
  }

  const provider = connData.provider;

  // Try reading from credentials collection first (OAuth path)
  const credsDoc = await db.collection('credentials').doc(connData.userId || uid).get();
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

  // Fallback: read credentials directly from the connection document (non-OAuth path)
  if (connData.accessToken || connData.clientId) {
    return {
      accessToken: connData.accessToken || '',
      refreshToken: null,
      clientId: connData.clientId || '',
      clientSecret: connData.clientSecret || '',
    };
  }

  // Last resort: extract tokens from the attributes array
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

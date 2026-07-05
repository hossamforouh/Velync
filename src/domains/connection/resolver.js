const axios = require('axios');
const { decrypt, encrypt } = require('../../../utils/encryption');
const { ConnectionError } = require('../../core/errors');
const db = require('../../core/db');
const logger = require('../../core/logger');

const EXPIRY_MARGIN_MS = 5 * 60 * 1000; // refresh if expiring within 5 min

/**
 * Refresh an expired or soon-to-expire access token using the stored refresh token.
 * If the refresh token itself is invalid (revoked/expired), marks the connection
 * as needing reauthorization.
 *
 * @param {string} uid - user id (used for credentials doc path)
 * @param {object} providerCreds - the stored credential entry { accessToken, refreshToken, clientId, clientSecret, expiresAt }
 * @param {string} provider - platform id (e.g. "google_contacts")
 * @param {string} connectionId - connection doc id (to mark needsReauth if refresh fails)
 * @returns {Promise<object>} updated credentials object
 */
async function refreshToken(uid, providerCreds, provider, connectionId) {
  if (!providerCreds.refreshToken) {
    logger.warn('auth', `No refresh token available for ${provider} — cannot refresh`);
    return { ...providerCreds, needsReauth: true };
  }

  const platformDoc = await db.collection('platforms').doc(provider).get();
  if (!platformDoc.exists) {
    logger.error('auth', `Platform doc not found for ${provider} — cannot refresh token`);
    return { ...providerCreds, needsReauth: true };
  }
  const platform = platformDoc.data();
  const tokenUrl = platform.tokenUrl;
  const clientId = providerCreds.clientId || platform.clientId;
  const clientSecret = providerCreds.clientSecret || platform.clientSecret;

  if (!tokenUrl || !clientId || !clientSecret) {
    logger.error('auth', `Missing tokenUrl/clientId/clientSecret for ${provider} — cannot refresh`);
    return { ...providerCreds, needsReauth: true };
  }

  try {
    const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const params = new URLSearchParams();
    params.append('grant_type', 'refresh_token');
    params.append('refresh_token', providerCreds.refreshToken);

    const response = await axios.post(tokenUrl, params.toString(), {
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      timeout: 15000,
    });

    const data = response.data;
    const newAccessToken = data.access_token;
    if (!newAccessToken) {
      throw new Error('Token refresh response missing access_token');
    }

    const expiresIn = data.expires_in || 3600;
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
    const newRefreshToken = data.refresh_token || providerCreds.refreshToken;

    const encryptedToken = encrypt(newAccessToken);
    const encryptedRefreshToken = newRefreshToken !== providerCreds.refreshToken ? encrypt(newRefreshToken) : undefined;

    // Persist new tokens and expiry
    const updateData = {
      accessToken: encryptedToken,
      expiresAt,
      updatedAt: new Date().toISOString(),
    };
    if (encryptedRefreshToken) {
      updateData.refreshToken = encryptedRefreshToken;
    }

    await db.collection('credentials').doc(uid).set(
      { [provider]: updateData },
      { merge: true }
    );

    logger.info('auth', `Token refreshed for ${provider}`, { expiresAt });

    return {
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
      clientId,
      clientSecret,
      expiresAt,
    };
  } catch (err) {
    logger.error('auth', `Token refresh failed for ${provider}`, {
      error: err.response?.data || err.message,
    });

    // Mark connection as needing reauthorization so the UI can show a prompt
    try {
      await db.collection('connected_accounts').doc(connectionId).update({
        needsReauth: true,
        reauthReason: `Token refresh failed: ${err.response?.data?.error || err.message}`,
        updatedAt: new Date().toISOString(),
      });
    } catch (updateErr) {
      logger.error('auth', 'Failed to mark connection as needing reauth', { error: updateErr.message });
    }

    return { ...providerCreds, needsReauth: true };
  }
}

/**
 * Check if an access token is expired or expiring within the margin,
 * and refresh it if needed.
 */
async function ensureFreshToken(uid, providerCreds, provider, connectionId) {
  if (!providerCreds) return providerCreds;

  const expiresAt = providerCreds.expiresAt ? new Date(providerCreds.expiresAt).getTime() : 0;
  const isExpired = Date.now() + EXPIRY_MARGIN_MS >= expiresAt;

  if (!isExpired) return providerCreds;

  logger.info('auth', `Token for ${provider} expired or expiring soon — refreshing`);
  return refreshToken(uid, providerCreds, provider, connectionId);
}

/**
 * Single source of truth for credential resolution.
 * Resolves credentials for a user's connection, handles auth checks,
 * and transparently refreshes expired tokens.
 *
 * @param {string} uid - requesting user's uid
 * @param {string} connectionId - connected_accounts doc id
 * @returns {Promise<{accessToken, refreshToken, clientId, clientSecret, expiresAt?, needsReauth?}>}
 */
async function resolveCredentials(uid, connectionId) {
  const connDoc = await db.collection('connected_accounts').doc(connectionId).get();
  if (!connDoc.exists) throw new ConnectionError('Connection not found');
  const connData = connDoc.data();

  // Authorize: connection owner or workspace member (skip auth check if uid is null, e.g. internal scheduler calls)
  if (uid) {
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
  }

  const provider = connData.provider;
  const credsOwnerId = uid || connData.userId || connData.workspaceId;
  const credsDoc = await db.collection('credentials').doc(credsOwnerId).get();

  let rawCreds = null;

  if (credsDoc.exists) {
    const credsData = credsDoc.data();
    if (credsData[provider]) {
      const providerCreds = credsData[provider];
      rawCreds = {
        accessToken: decrypt(providerCreds.accessToken),
        refreshToken: providerCreds.refreshToken ? decrypt(providerCreds.refreshToken) : null,
        clientId: providerCreds.clientId,
        clientSecret: providerCreds.clientSecret,
        expiresAt: providerCreds.expiresAt || null,
      };
    }
  }

  // Fallback: creds stored directly on the connection doc (legacy)
  if (!rawCreds) {
    if (connData.accessToken || connData.clientId) {
      rawCreds = {
        accessToken: connData.accessToken || '',
        refreshToken: null,
        clientId: connData.clientId || '',
        clientSecret: connData.clientSecret || '',
        expiresAt: null,
      };
    } else if (connData.attributes && Array.isArray(connData.attributes)) {
      const accessAttr = connData.attributes.find(a => a.id === 'accessToken' || a.id === 'AccessToken');
      const clientIdAttr = connData.attributes.find(a => a.id === 'clientId' || a.id === 'ClientId');
      const clientSecretAttr = connData.attributes.find(a => a.id === 'clientSecret' || a.id === 'ClientSecret');
      if (accessAttr || clientIdAttr) {
        rawCreds = {
          accessToken: accessAttr?.value || '',
          refreshToken: null,
          clientId: clientIdAttr?.value || '',
          clientSecret: clientSecretAttr?.value || '',
          expiresAt: null,
        };
      }
    }
  }

  if (!rawCreds) {
    throw new ConnectionError(`Credentials not found for ${provider}`);
  }

  // Auto-refresh expired tokens
  const freshCreds = await ensureFreshToken(credsOwnerId, rawCreds, provider, connectionId);

  if (freshCreds.needsReauth) {
    logger.warn('auth', `Connection ${connectionId} (${provider}) needs reauthorization`);
  }

  return {
    accessToken: freshCreds.accessToken,
    refreshToken: freshCreds.refreshToken,
    clientId: freshCreds.clientId,
    clientSecret: freshCreds.clientSecret,
    expiresAt: freshCreds.expiresAt,
    needsReauth: freshCreds.needsReauth || false,
  };
}

/**
 * Legacy wrapper — kept for backward compatibility with existing callers.
 * Calls resolveCredentials internally.
 */
async function resolveConnectionTokens(uid, connectionId) {
  const result = await resolveCredentials(uid, connectionId);
  return {
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    clientId: result.clientId,
    clientSecret: result.clientSecret,
  };
}

module.exports = { resolveCredentials, resolveConnectionTokens };

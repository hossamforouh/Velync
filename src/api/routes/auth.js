const { Router } = require('express');
const axios = require('axios');
const { body, validationResult } = require('express-validator');
const { verifyAuth } = require('../middleware/auth');
const { encrypt } = require('../../../utils/encryption');
const db = require('../../core/db');
const logger = require('../../core/logger');
const config = require('../../core/config');

const router = Router();

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Validation failed', details: errors.array() });
  }
  next();
};

router.post('/oauth/exchange', verifyAuth, [
  body('code').isString().trim().notEmpty(),
  body('platformId').isString().trim().notEmpty(),
  body('label').optional().isString().trim(),
  body('workspaceId').optional().isString().trim(),
  body('redirectUri').optional().isString(),
], validate, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { code, platformId, label, workspaceId, redirectUri } = req.body;

    const platformDoc = await db.collection('platforms').doc(platformId).get();
    if (!platformDoc.exists) return res.status(404).json({ error: 'Platform not found' });
    const platform = platformDoc.data();

    const clientId = platform.clientId;
    const clientSecret = platform.clientSecret;
    if (!clientId || !clientSecret) throw new Error('Platform is missing OAuth Client ID or Client Secret');

    const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const params = new URLSearchParams();
    params.append('client_id', clientId);
    params.append('client_secret', clientSecret);
    params.append('code', code);
    params.append('grant_type', 'authorization_code');
    params.append('redirect_uri', redirectUri);

    const response = await axios.post(platform.tokenUrl, params.toString(), {
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      timeout: config.externalApiTimeout,
    });

    const data = response.data;
    const accessToken = data.access_token;
    if (!accessToken) throw new Error('Failed to retrieve access token from provider');

    const encryptedToken = encrypt(accessToken);
    const encryptedRefreshToken = data.refresh_token ? encrypt(data.refresh_token) : null;

    // Calculate expiry from the OAuth response
    const expiresIn = data.expires_in || 3600;
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

    const credentialRef = db.collection('credentials').doc(uid);
    await credentialRef.set({
      [platformId]: {
        accessToken: encryptedToken,
        refreshToken: encryptedRefreshToken,
        expiresAt,
        providerWorkspaceId: data.workspace_id || null,
        providerWorkspaceName: data.workspace_name || null,
        botId: data.bot_id || null,
        updatedAt: new Date().toISOString(),
      },
    }, { merge: true });

    await db.collection('connected_accounts').add({
      provider: platformId,
      label: label || platform?.name || 'OAuth Connection',
      userId: uid,
      workspaceId: workspaceId || uid,
      authType: 'oauth',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      attributes: {},
    });

    res.json({ success: true, message: 'OAuth successful. Credentials securely stored.' });
  } catch (err) {
    logger.error('oauth', 'Exchange failed', { error: err.response?.data || err.message });
    res.status(500).json({ success: false, error: err.response?.data?.message || err.message });
  }
});

module.exports = router;

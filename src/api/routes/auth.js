const { Router } = require('express');
const axios = require('axios');
const { body, validationResult } = require('express-validator');
const { verifyAuth } = require('../middleware/auth');
const { encrypt } = require('../../../utils/encryption');
const { getPlan } = require('../../core/plan');
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

    // Connector tier gating: check workspace plan before allowing connection
    const resolvedWsId = workspaceId || uid;
    const wsDoc = await db.collection('workspaces').doc(resolvedWsId).get();
    const wsData = wsDoc.data() || {};
    const planId = wsData.planId || 'free';
    const plan = await getPlan(planId);
    const allowedTiers = (plan && plan.connectorTiers) || ['basic'];
    const platformTier = platform.tier || 'basic';
    if (!allowedTiers.includes(platformTier)) {
      const planName = (plan && plan.name) || planId;
      return res.status(403).json({ error: `Your ${planName} plan does not support "${platformTier}" tier connectors. Upgrade to connect ${platform.name || platformId}.` });
    }

    const clientId = platform.clientId;
    const secretDoc = await db.collection('platform_secrets').doc(platformId).get();
    const clientSecret = secretDoc.exists ? secretDoc.data().clientSecret : null;
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

    // Create connected_accounts doc FIRST so we have its ID to key credentials
    const connRef = await db.collection('connected_accounts').add({
      provider: platformId,
      label: label || platform?.name || 'OAuth Connection',
      userId: uid,
      workspaceId: workspaceId || uid,
      authType: 'oauth',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      attributes: {},
    });

    // Write credentials keyed by connectionId (not provider) — supports multi-account-per-platform
    const credentialRef = db.collection('credentials').doc(uid);
    await credentialRef.set({
      [connRef.id]: {
        accessToken: encryptedToken,
        refreshToken: encryptedRefreshToken,
        expiresAt,
        provider: platformId,
        providerWorkspaceId: data.workspace_id || null,
        providerWorkspaceName: data.workspace_name || null,
        botId: data.bot_id || null,
        updatedAt: new Date().toISOString(),
      },
    }, { merge: true });

    logger.info('oauth', `Connection "${connRef.id}" created for ${platformId}`, { workspaceId: workspaceId || uid });

    res.json({ success: true, message: 'OAuth successful. Credentials securely stored.', connectionId: connRef.id });
  } catch (err) {
    logger.error('oauth', 'Exchange failed', { error: err.response?.data || err.message });
    res.status(500).json({ success: false, error: err.response?.data?.message || err.message });
  }
});

module.exports = router;

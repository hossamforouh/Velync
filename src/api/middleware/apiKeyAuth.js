const crypto = require('crypto');
const db = require('../../core/db');
const logger = require('../../core/logger');
const config = require('../../core/config');

async function verifyApiKey(req, res, next) {
  if (!config.apiKeyAuthEnabled) return next();

  const authHeader = req.headers['x-api-key'] || req.headers['authorization'];
  if (!authHeader) return next();

  let apiKey = authHeader;
  if (authHeader.startsWith('Bearer ')) {
    apiKey = authHeader.slice(7);
  }

  if (!apiKey.startsWith('velync_')) return next();

  try {
    const hashedKey = crypto.createHash('sha256').update(apiKey).digest('hex');
    const snap = await db.collection('api_keys')
      .where('hashedKey', '==', hashedKey)
      .limit(1)
      .get();

    if (!snap.empty) {
      const keyDoc = snap.docs[0];
      const keyData = keyDoc.data();
      req.user = { uid: keyData.userId, apiKeyId: keyDoc.id, isApiKey: true };

      // Update lastUsedAt (fire-and-forget)
      keyDoc.ref.update({ lastUsedAt: new Date().toISOString() }).catch(() => {});

      logger.info('api-key', 'Request authenticated via API key', { user: keyData.userId, keyId: keyDoc.id });
      return next();
    }
  } catch (err) {
    logger.warn('api-key', 'API key verification failed', { error: err.message });
  }

  next();
}

module.exports = { verifyApiKey };

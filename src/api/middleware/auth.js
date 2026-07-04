const { getAuth } = require('firebase-admin/auth');
const logger = require('../../core/logger');
const db = require('../../core/db');

async function verifyAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Missing or invalid Authorization header' });
  }
  try {
    const decodedToken = await getAuth().verifyIdToken(authHeader.split('Bearer ')[1]);
    req.user = decodedToken;

    // authVersion check: if token was issued before last session revoke, reject
    try {
      const userDoc = await db.collection('users').doc(decodedToken.uid).get();
      if (userDoc.exists) {
        const userData = userDoc.data();
        const tokenIssuedAt = decodedToken.iat * 1000;
        const lastRevoked = userData.lastSessionRevokedAt
          ? new Date(userData.lastSessionRevokedAt).getTime()
          : 0;
        if (lastRevoked > tokenIssuedAt) {
          return res.status(401).json({ error: 'Session revoked. Please log in again.' });
        }
      }
    } catch (err) {
      logger.warn('auth', 'authVersion check failed, proceeding anyway', { error: err.message });
    }

    next();
  } catch (err) {
    logger.error('auth', 'Token verification failed', { error: err.message });
    return res.status(401).json({ error: 'Unauthorized: Token verification failed' });
  }
}

module.exports = { verifyAuth };

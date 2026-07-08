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

    // Session-revocation check: if the token was issued before the user's
    // last "revoke all sessions" action, reject it. Fails closed — if the
    // lookup itself errors, we can't confirm the session wasn't revoked, so
    // reject rather than silently letting a possibly-revoked token through.
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
      logger.error('auth', 'Session-revocation check failed — rejecting request (fail closed)', { error: err.message });
      return res.status(401).json({ error: 'Unable to verify session status. Please try again.' });
    }

    next();
  } catch (err) {
    logger.error('auth', 'Token verification failed', { error: err.message });
    return res.status(401).json({ error: 'Unauthorized: Token verification failed' });
  }
}

module.exports = { verifyAuth };

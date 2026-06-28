const { getAuth } = require('firebase-admin/auth');
const logger = require('../../core/logger');

async function verifyAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Missing or invalid Authorization header' });
  }
  try {
    const decodedToken = await getAuth().verifyIdToken(authHeader.split('Bearer ')[1]);
    req.user = decodedToken;
    next();
  } catch (err) {
    logger.error('auth', 'Token verification failed', { error: err.message });
    return res.status(401).json({ error: 'Unauthorized: Token verification failed' });
  }
}

module.exports = { verifyAuth };

const { getAuth } = require('firebase-admin/auth');
const logger = require('../../core/logger');
const db = require('../../core/db');

// ─── Session-revocation cache ─────────────────────────────────
// The revocation check runs on EVERY authenticated request, and previously
// read users/{uid} from Firestore each time — an extra read + round-trip on
// the entire API's hot path. Cache each user's lastSessionRevokedAt for a
// short TTL so active sessions hit Firestore at most once per window instead
// of once per request.
//
// Trade-off: after a "revoke all sessions" / password change, an already-
// issued token may still pass on a given instance for up to TTL. That is an
// acceptable narrowing of an already-hour-long Firebase ID token lifetime.
// Errors are NEVER cached — a failed lookup still fails closed (rejects).
const REVOCATION_CACHE_TTL_MS = 30_000;
const REVOCATION_CACHE_MAX = 10_000;
const revocationCache = new Map(); // uid -> { revokedAt: number, fetchedAt: number }

function getCachedRevocation(uid) {
  const entry = revocationCache.get(uid);
  if (!entry) return undefined;
  if (Date.now() - entry.fetchedAt > REVOCATION_CACHE_TTL_MS) {
    revocationCache.delete(uid);
    return undefined;
  }
  return entry.revokedAt;
}

function setCachedRevocation(uid, revokedAt) {
  // Bound memory: evict the oldest-inserted entry when at capacity (Map keeps
  // insertion order), so a long-running instance can't grow this unbounded.
  if (revocationCache.size >= REVOCATION_CACHE_MAX) {
    const oldestKey = revocationCache.keys().next().value;
    if (oldestKey !== undefined) revocationCache.delete(oldestKey);
  }
  revocationCache.set(uid, { revokedAt, fetchedAt: Date.now() });
}

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
      const uid = decodedToken.uid;
      const tokenIssuedAt = decodedToken.iat * 1000;

      let lastRevoked = getCachedRevocation(uid);
      if (lastRevoked === undefined) {
        const userDoc = await db.collection('users').doc(uid).get();
        lastRevoked = (userDoc.exists && userDoc.data().lastSessionRevokedAt)
          ? new Date(userDoc.data().lastSessionRevokedAt).getTime()
          : 0;
        setCachedRevocation(uid, lastRevoked);
      }

      if (lastRevoked > tokenIssuedAt) {
        return res.status(401).json({ error: 'Session revoked. Please log in again.' });
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

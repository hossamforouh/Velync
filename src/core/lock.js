const os = require('os');
const db = require('./db');
const logger = require('./logger');

/** Unique identifier for this process, used for lease ownership. */
const INSTANCE_ID = `${os.hostname()}-${process.pid}`;

/**
 * Acquire a distributed lease via a Firestore transaction, so only one instance
 * runs the guarded work at a time (safe when Cloud Run scales to many instances).
 *
 * @param {string} lockId          document id for the lease
 * @param {number} ttlMs           how long the lease is held before it may be taken over
 * @param {string} [collection]    collection holding lease docs (default 'sync_locks')
 * @returns {Promise<boolean>}     true if acquired, false if held by another instance (or on error — fail-safe skip)
 */
async function acquireLease(lockId, ttlMs, collection = 'sync_locks') {
  const lockRef = db.collection(collection).doc(lockId);
  try {
    return await db.runTransaction(async (transaction) => {
      const doc = await transaction.get(lockRef);
      const now = Date.now();

      if (doc.exists) {
        const data = doc.data();
        const expiresAt = data.expiresAt?.toMillis
          ? data.expiresAt.toMillis()
          : new Date(data.expiresAt || 0).getTime();
        // Held by someone else and not yet expired → don't take it.
        if (expiresAt > now && data.heldBy !== INSTANCE_ID) return false;
      }

      transaction.set(lockRef, {
        heldBy: INSTANCE_ID,
        acquiredAt: new Date().toISOString(),
        expiresAt: new Date(now + ttlMs),
      });
      return true;
    });
  } catch (err) {
    logger.error('lock', `Failed to acquire lease "${lockId}"`, { error: err.message });
    return false; // Fail-safe: skip this run rather than risk duplicate execution.
  }
}

/**
 * Release a lease, but only if this instance still holds it (never clear another
 * instance's lease).
 * @param {string} lockId
 * @param {string} [collection]
 */
async function releaseLease(lockId, collection = 'sync_locks') {
  try {
    const lockRef = db.collection(collection).doc(lockId);
    const doc = await lockRef.get();
    if (doc.exists && doc.data().heldBy === INSTANCE_ID) {
      await lockRef.delete();
    }
  } catch (err) {
    logger.warn('lock', `Failed to release lease "${lockId}"`, { error: err.message });
  }
}

module.exports = { acquireLease, releaseLease, INSTANCE_ID };

const db = require('./db');

/**
 * Superadmin check, backed by the `superadmins` Firestore collection — the same
 * source of truth Firestore security rules use (see isSuperAdmin() in
 * firestore.rules and scripts/seed-superadmin.js). Cached briefly since this
 * collection is small and rarely changes, mirroring core/plan.js / core/platform.js.
 */
const cache = { uids: new Set(), time: 0 };
const CACHE_TTL_MS = 60_000;

async function refreshCache() {
  const snap = await db.collection('superadmins').get();
  cache.uids = new Set(snap.docs.map(d => d.id));
  cache.time = Date.now();
}

/**
 * @param {string} uid
 * @returns {Promise<boolean>}
 */
async function isSuperAdmin(uid) {
  if (!uid) return false;
  if (cache.time <= Date.now() - CACHE_TTL_MS) {
    await refreshCache();
  }
  return cache.uids.has(uid);
}

module.exports = { isSuperAdmin };

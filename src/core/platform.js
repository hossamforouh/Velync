const db = require('./db');

const platformCache = { data: new Map(), time: 0 };
const PLATFORM_CACHE_TTL = 300_000; // 5 min — platform docs change very rarely

/**
 * Fetch a platform document with a short-lived in-memory cache.
 *
 * The sync engine resolves platform docs on every run (to map a platform id to
 * its connector name/tier). Those docs almost never change, so reading them from
 * Firestore each cycle is pure cost. This caches the whole `platforms` collection
 * on first miss so subsequent lookups are free until the TTL expires.
 *
 * Mirrors the caching approach in core/plan.js.
 *
 * @param {string} platformId
 * @returns {Promise<object|null>} the platform doc data (with `id`), or null if missing
 */
async function getPlatform(platformId) {
  if (!platformId) return null;

  if (platformCache.time > Date.now() - PLATFORM_CACHE_TTL) {
    if (platformCache.data.has(platformId)) return platformCache.data.get(platformId);
  }

  // Refresh the whole collection on a miss/expiry so repeated lookups are instant.
  const snap = await db.collection('platforms').get();
  platformCache.data.clear();
  snap.forEach(d => platformCache.data.set(d.id, { id: d.id, ...d.data() }));
  platformCache.time = Date.now();

  return platformCache.data.get(platformId) || null;
}

module.exports = { getPlatform };

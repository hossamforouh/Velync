const db = require('./db');
const { getConnector, getRegisteredPlatforms } = require('../domains/connector/registry');

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

/**
 * Resolve a platform identifier (a `platforms` Firestore doc ID, which is an
 * arbitrary auto-generated ID and not necessarily the connector registry key)
 * to the actual registered connector key (e.g. "ticktick", "google_contacts").
 *
 * Every platform doc is created with `db.collection('platforms').doc()` (an
 * auto-ID), so the doc ID essentially never equals the connector key except
 * by coincidence. Resolution order:
 *   1. platformId is already a registered connector key — use it as-is.
 *   2. The platform doc has an explicit `connectorKey` field — use it.
 *   3. Fall back to normalizing the platform's `name` (lowercase,
 *      non-alphanumeric runs collapsed to underscores) and matching that
 *      against the registry — covers legacy platform docs created before
 *      `connectorKey` existed.
 * Returns the original platformId unchanged if none of the above resolve,
 * so the caller's own getConnector() call still throws a clear error.
 *
 * @param {string} platformId
 * @returns {Promise<string>}
 */
async function resolveConnectorKey(platformId) {
  if (!platformId) return platformId;

  try {
    getConnector(platformId);
    return platformId;
  } catch (_) {
    // not a direct match — fall through to doc-based resolution
  }

  const platData = await getPlatform(platformId);
  if (!platData) return platformId;

  if (platData.connectorKey) {
    try {
      getConnector(platData.connectorKey);
      return platData.connectorKey;
    } catch (_) {
      // stored connectorKey doesn't match anything registered — keep trying
    }
  }

  const normalized = (platData.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (normalized && getRegisteredPlatforms().includes(normalized)) return normalized;

  return platformId;
}

module.exports = { getPlatform, resolveConnectorKey };

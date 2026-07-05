const db = require('./db');

const planCache = { data: new Map(), time: 0 };
const PLAN_CACHE_TTL = 120_000;

/**
 * Fetch a plan document with a short-lived in-memory cache.
 * Caches the entire plans collection on first miss so subsequent lookups are instant.
 * @param {string} planId
 * @returns {Promise<object|null>}
 */
async function getPlan(planId) {
  if (planCache.time > Date.now() - PLAN_CACHE_TTL) {
    const cached = planCache.data.get(planId);
    if (cached) return cached;
  }
  const doc = await db.collection('plans').doc(planId).get();
  if (!doc.exists) return null;
  // Refresh entire cache on miss
  const snap = await db.collection('plans').get();
  planCache.data.clear();
  snap.forEach(d => planCache.data.set(d.id, { id: d.id, ...d.data() }));
  planCache.time = Date.now();
  return planCache.data.get(planId) || { id: doc.id, ...doc.data() };
}

module.exports = { getPlan };

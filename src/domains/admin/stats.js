const { FieldPath } = require('@google-cloud/firestore');
const db = require('../../core/db');

/**
 * Admin statistics & management queries.
 *
 * Cost note: platform-wide totals use Firestore aggregation `count()` queries,
 * which are billed at a tiny fraction of reading every document — so these stay
 * cheap even as the collections grow. List/health queries are bounded by `limit`.
 */

const countOf = async (query) => (await query.count().get()).data().count;

/**
 * Platform-wide totals for the admin dashboard.
 * @returns {Promise<object>}
 */
async function getAdminStats() {
  const [totalWorkspaces, totalUsers, totalConnectedAccounts, totalActiveConfigs] = await Promise.all([
    countOf(db.collection('workspaces')),
    countOf(db.collection('users')),
    countOf(db.collection('connected_accounts')),
    countOf(db.collectionGroup('sync_configs').where('status', '==', 'active')),
  ]);

  // Per-plan workspace counts (one cheap count() per plan).
  const plansSnap = await db.collection('plans').get();
  const plans = plansSnap.docs.map(d => ({ id: d.id, name: d.data().name || d.id }));
  const byPlanEntries = await Promise.all(plans.map(async (p) => {
    const count = await countOf(db.collection('workspaces').where('planId', '==', p.id));
    return [p.id, { name: p.name, count }];
  }));
  const workspacesByPlan = Object.fromEntries(byPlanEntries);

  // Paid = every plan bucket except the free tier.
  const paidWorkspaces = byPlanEntries
    .filter(([id]) => id !== 'free')
    .reduce((sum, [, v]) => sum + v.count, 0);

  return {
    totalWorkspaces,
    totalUsers,
    totalConnectedAccounts,
    totalActiveConfigs,
    workspacesByPlan,
    paidWorkspaces,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Paginated workspace list for admin management. Ordered by document id so every
 * workspace is included (ordering by an optional field would silently drop docs
 * missing that field).
 * @param {{limit?: number, startAfter?: string|null}} opts
 */
async function listWorkspaces({ limit = 50, startAfter = null } = {}) {
  let query = db.collection('workspaces').orderBy(FieldPath.documentId()).limit(limit);
  if (startAfter) query = query.startAfter(startAfter);

  const snap = await query.get();
  const items = snap.docs.map(d => {
    const data = d.data();
    return {
      id: d.id,
      name: data.name || null,
      ownerId: data.ownerId || null,
      planId: data.planId || 'free',
      memberCount: Array.isArray(data.members) ? data.members.length : 0,
      createdAt: data.createdAt || null,
    };
  });
  const nextCursor = snap.size === limit ? snap.docs[snap.docs.length - 1].id : null;
  return { items, nextCursor };
}

/**
 * Recent execution logs across all workspaces, with a status breakdown, for the
 * admin sync-health view. Bounded by `limit`.
 * @param {{limit?: number}} opts
 */
async function getRecentSyncHealth({ limit = 50 } = {}) {
  const snap = await db.collection('execution_logs')
    .orderBy('startTime', 'desc')
    .limit(limit)
    .get();

  const recent = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  const summary = recent.reduce((acc, l) => {
    acc.total++;
    const status = l.status || 'unknown';
    acc.byStatus[status] = (acc.byStatus[status] || 0) + 1;
    return acc;
  }, { total: 0, byStatus: {} });

  return { summary, recent };
}

// Server-side cache so repeated admin opens (and multiple admins) share one
// computation instead of each browser re-reading whole collections.
const overviewCache = { data: null, time: 0 };
const OVERVIEW_TTL_MS = 60_000;

/**
 * Full admin Overview payload, computed server-side. Replaces the previous
 * client-side aggregation that read the users, connected_accounts and every
 * workspace's sync_configs on each page open. Shape matches what the Overview
 * renderer expects.
 * @returns {Promise<object>}
 */
async function getAdminOverview() {
  if (overviewCache.data && Date.now() - overviewCache.time < OVERVIEW_TTL_MS) {
    return overviewCache.data;
  }

  const now = Date.now();
  // startTime is stored as an ISO string, so compare against ISO cutoffs (the old
  // client compared against a Date object — a type mismatch that made the window a no-op).
  const cutoff24h = new Date(now - 86400000).toISOString();
  const cutoff7d = new Date(now - 604800000).toISOString();
  const staleThreshold = now - 7 * 86400000;

  const [totalUsers, configsSnap, connSnap, platformsSnap, logs24hSnap, logs7dSnap] = await Promise.all([
    countOf(db.collection('users')),
    db.collectionGroup('sync_configs').get(),
    db.collection('connected_accounts').get(),
    db.collection('platforms').get(),
    db.collection('execution_logs').where('startTime', '>=', cutoff24h).orderBy('startTime', 'desc').limit(200).get(),
    db.collection('execution_logs').where('startTime', '>=', cutoff7d).orderBy('startTime', 'desc').limit(1000).get(),
  ]);

  const platNames = {};
  platformsSnap.forEach(d => { platNames[d.id] = d.data().name || d.id; });

  // Configs: status breakdown, platform popularity, stale detection.
  let activeCount = 0, pausedCount = 0, draftCount = 0;
  const platCounts = {};
  const staleConfigs = [];
  configsSnap.forEach(doc => {
    const d = doc.data();
    const st = d.status || 'draft';
    if (st === 'active') activeCount++;
    else if (st === 'paused') pausedCount++;
    else draftCount++;

    [d.platform1, d.platform2].forEach(p => {
      if (!p) return;
      const key = typeof p === 'string' ? p : (p.id || p.key);
      if (key) platCounts[key] = (platCounts[key] || 0) + 1;
    });

    if (st === 'active') {
      const lr = d.lastRunAt ? (d.lastRunAt.toDate ? d.lastRunAt.toDate() : new Date(d.lastRunAt)) : null;
      if (!lr || lr.getTime() < staleThreshold) {
        staleConfigs.push({ id: doc.id, name: d.description || doc.id, lastRun: lr ? lr.toISOString() : null, ownerName: d.ownerName || '—' });
      }
    }
  });
  staleConfigs.sort((a, b) => {
    if (!a.lastRun) return -1;
    if (!b.lastRun) return 1;
    return new Date(a.lastRun) - new Date(b.lastRun);
  });
  const totalConfigs = configsSnap.size;

  // 24h sync results + top errors.
  let success24h = 0, failed24h = 0;
  const errorCounts = {};
  logs24hSnap.forEach(doc => {
    const d = doc.data();
    if (d.status === 'success') success24h++;
    else if (d.status === 'failed' || d.status === 'error') {
      failed24h++;
      const msg = (d.error || 'Unknown error').substring(0, 120);
      errorCounts[msg] = (errorCounts[msg] || 0) + 1;
    }
  });
  const total24h = success24h + failed24h;
  const successRate = total24h > 0 ? ((success24h / total24h) * 100).toFixed(1) : '—';
  const topErrors = Object.entries(errorCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);

  // 7d volume by day.
  let total7dVolume = 0;
  const dailyVolume = {};
  logs7dSnap.forEach(doc => {
    const d = doc.data();
    const vol = (d.syncedCount || 0) + (d.deletedCount || 0);
    total7dVolume += vol;
    const day = typeof d.startTime === 'string' ? d.startTime.slice(0, 10)
      : (d.startTime && d.startTime.toDate ? d.startTime.toDate().toISOString().slice(0, 10) : 'unknown');
    dailyVolume[day] = (dailyVolume[day] || 0) + vol;
  });

  // Connections-per-user distribution.
  const connPerUser = {};
  connSnap.forEach(doc => {
    const uid = doc.data().userId || 'unknown';
    connPerUser[uid] = (connPerUser[uid] || 0) + 1;
  });
  const connDist = Object.values(connPerUser).reduce((acc, c) => {
    const bucket = c >= 10 ? '10+' : String(c);
    acc[bucket] = (acc[bucket] || 0) + 1;
    return acc;
  }, {});

  const platEntries = Object.entries(platCounts)
    .map(([id, count]) => ({ id, name: platNames[id] || id, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
  const maxPlatCount = platEntries.length > 0 ? platEntries[0].count : 1;

  const overview = {
    totalUsers, totalConfigs, activeCount, pausedCount, draftCount,
    total24h, success24h, failed24h, successRate, total7dVolume,
    platEntries, maxPlatCount, topErrors, staleConfigs, dailyVolume, connDist,
    generatedAt: new Date().toISOString(),
  };
  overviewCache.data = overview;
  overviewCache.time = Date.now();
  return overview;
}

module.exports = { getAdminStats, listWorkspaces, getRecentSyncHealth, getAdminOverview };

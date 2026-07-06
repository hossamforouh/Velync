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

module.exports = { getAdminStats, listWorkspaces, getRecentSyncHealth };

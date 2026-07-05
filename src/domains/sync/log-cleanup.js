const db = require('../../core/db');
const logger = require('../../core/logger');
const { getPlan } = require('../../core/plan');

const BATCH_SIZE = 100;

/**
 * Delete execution_logs older than each workspace's plan's logRetentionDays.
 * Runs in batches to avoid unbounded Firestore deletes.
 * Logs summary of how many were cleaned up per run.
 */
async function cleanupLogs() {
  const workspacesSnap = await db.collection('workspaces').get();
  let totalDeleted = 0;

  for (const wsDoc of workspacesSnap.docs) {
    const ws = wsDoc.data();
    const planId = ws.planId || 'free';
    const plan = await getPlan(planId);
    const retentionDays = (plan && plan.logRetentionDays) || 7;

    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();

    // Query old logs for this workspace
    let hasMore = true;
    let deleted = 0;

    while (hasMore) {
      const oldSnap = await db.collection('execution_logs')
        .where('workspaceId', '==', wsDoc.id)
        .where('startTime', '<', cutoff)
        .limit(BATCH_SIZE)
        .get();

      if (oldSnap.empty) {
        hasMore = false;
        break;
      }

      const batch = db.batch();
      oldSnap.docs.forEach(d => batch.delete(d.ref));
      await batch.commit();
      deleted += oldSnap.size;

      if (oldSnap.size < BATCH_SIZE) {
        hasMore = false;
      }
    }

    if (deleted > 0) {
      logger.info('log-cleanup', `Workspace "${wsDoc.id}" — deleted ${deleted} log(s) older than ${retentionDays} days`);
    }
    totalDeleted += deleted;
  }

  logger.info('log-cleanup', `Cleanup complete — ${totalDeleted} log(s) deleted across all workspaces`);
  return totalDeleted;
}

module.exports = { cleanupLogs };

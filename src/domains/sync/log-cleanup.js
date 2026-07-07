const { Timestamp } = require('@google-cloud/firestore');
const db = require('../../core/db');
const logger = require('../../core/logger');
const { getPlan } = require('../../core/plan');
const { acquireLease, releaseLease } = require('../../core/lock');
const { notifySyncFailure } = require('../../core/notifications');

const BATCH_SIZE = 100;
const CLEANUP_LOCK_ID = 'daily-log-cleanup';
const CLEANUP_LEASE_MS = 10 * 60 * 1000; // 10 min — generous upper bound for a cleanup pass

// activity_logs is global (not per-workspace) admin audit trail, so it gets a
// flat cutoff rather than the per-plan logRetentionDays used for execution_logs.
const ACTIVITY_LOG_LOCK_ID = 'daily-activity-log-cleanup';
const ACTIVITY_LOG_RETENTION_DAYS = 180;

// If a Cloud Run instance dies mid-sync (deploy, OOM, crash), its execution_logs
// entry is left at status:'running' forever with no endTime — this reconciles
// those into a terminal 'error' state so the Execution Logs page doesn't show
// permanently "running" phantom entries.
const STUCK_RUN_LOCK_ID = 'stuck-run-reconciliation';
const STUCK_RUN_TIMEOUT_MS = 15 * 60 * 1000; // well above LEASE_DURATION_MS in engine.js

/**
 * Delete execution_logs older than each workspace's plan's logRetentionDays.
 * Runs in batches to avoid unbounded Firestore deletes.
 * Logs summary of how many were cleaned up per run.
 */
async function cleanupLogs() {
  // The scheduler fires on every instance; only one should actually do the work.
  const gotLease = await acquireLease(CLEANUP_LOCK_ID, CLEANUP_LEASE_MS);
  if (!gotLease) {
    logger.info('log-cleanup', 'Another instance holds the cleanup lease — skipping this run');
    return 0;
  }

  try {
    return await runCleanup();
  } finally {
    await releaseLease(CLEANUP_LOCK_ID);
  }
}

async function runCleanup() {
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

/**
 * Delete activity_logs (admin audit trail) older than ACTIVITY_LOG_RETENTION_DAYS.
 * Global collection (not per-workspace), so this is a flat cutoff.
 */
async function cleanupActivityLogs() {
  const gotLease = await acquireLease(ACTIVITY_LOG_LOCK_ID, CLEANUP_LEASE_MS);
  if (!gotLease) {
    logger.info('log-cleanup', 'Another instance holds the activity-log cleanup lease — skipping this run');
    return 0;
  }

  try {
    const cutoff = Timestamp.fromMillis(Date.now() - ACTIVITY_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    let hasMore = true;
    let deleted = 0;

    while (hasMore) {
      const oldSnap = await db.collection('activity_logs')
        .where('timestamp', '<', cutoff)
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

      if (oldSnap.size < BATCH_SIZE) hasMore = false;
    }

    if (deleted > 0) {
      logger.info('log-cleanup', `Activity log cleanup — deleted ${deleted} entr(ies) older than ${ACTIVITY_LOG_RETENTION_DAYS} days`);
    }
    return deleted;
  } finally {
    await releaseLease(ACTIVITY_LOG_LOCK_ID);
  }
}

/**
 * Mark execution_logs stuck at status:'running' beyond STUCK_RUN_TIMEOUT_MS
 * as status:'error' with an explanatory message, so they stop showing as
 * perpetually in-progress.
 */
async function reconcileStuckRuns() {
  const gotLease = await acquireLease(STUCK_RUN_LOCK_ID, CLEANUP_LEASE_MS);
  if (!gotLease) {
    logger.info('log-cleanup', 'Another instance holds the stuck-run reconciliation lease — skipping this run');
    return 0;
  }

  try {
    const cutoff = new Date(Date.now() - STUCK_RUN_TIMEOUT_MS).toISOString();
    const now = new Date().toISOString();
    let reconciled = 0;

    const stuckSnap = await db.collection('execution_logs')
      .where('status', '==', 'running')
      .where('startTime', '<', cutoff)
      .limit(BATCH_SIZE)
      .get();

    if (!stuckSnap.empty) {
      const timeoutMessage = 'Sync timed out or was interrupted before completion (no result recorded).';
      const batch = db.batch();
      stuckSnap.docs.forEach(d => batch.update(d.ref, {
        status: 'error',
        endTime: now,
        error: timeoutMessage,
      }));
      await batch.commit();
      reconciled = stuckSnap.size;
      logger.warn('log-cleanup', `Reconciled ${reconciled} stuck "running" execution log(s)`);

      await Promise.all(stuckSnap.docs.map(d => {
        const log = d.data();
        return notifySyncFailure({
          workspaceId: log.workspaceId,
          configId: log.configId,
          configName: log.configName,
          error: timeoutMessage,
          currentLogId: d.id,
        }).catch(() => {});
      }));
    }

    return reconciled;
  } finally {
    await releaseLease(STUCK_RUN_LOCK_ID);
  }
}

module.exports = { cleanupLogs, cleanupActivityLogs, reconcileStuckRuns };

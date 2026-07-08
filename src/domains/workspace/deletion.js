const { Firestore } = require('@google-cloud/firestore');
const db = require('../../core/db');
const logger = require('../../core/logger');

const BATCH_SIZE = 100;

/**
 * Delete all data associated with a workspace.
 *
 * Cascade order:
 *   1. sync_configs + sync_mappings subcollections (recursive delete)
 *   2. sync_locks for each deleted config
 *   3. connected_accounts where workspaceId == id (captures userIds first)
 *   4. credentials entries keyed by the deleted connectionIds
 *   5. execution_logs where workspaceId == id (batched, same pattern as log-cleanup)
 *   6. the workspace document itself
 *
 * Each step is wrapped in its own try/catch. Partial failures are logged
 * and surfaced so a retry or manual cleanup can pick up from an accurate state.
 *
 * @param {string} workspaceId
 * @param {object} [options]
 * @param {string} [options.initiatedBy] — uid who triggered deletion (for audit)
 * @returns {Promise<{success: boolean, summary: object, errors: string[]}>}
 */
async function deleteWorkspace(workspaceId, options = {}) {
  const summary = { syncConfigs: 0, locks: 0, connections: 0, credentials: 0, executionLogs: 0, membersReset: 0 };
  const errors = [];
  const initiatedBy = options.initiatedBy || 'system';

  logger.warn('workspace-deletion',
    `Starting deletion of workspace "${workspaceId}" initiated by "${initiatedBy}"`);

  // Capture owner/members BEFORE the workspace doc is deleted (step 6) — needed
  // for the workspaceId reset in step 7, since there's nothing left to read after.
  let memberUidsToReset = [];
  try {
    const wsDoc = await db.collection('workspaces').doc(workspaceId).get();
    if (wsDoc.exists) {
      const wsData = wsDoc.data();
      // `members` already includes the owner (set at workspace creation),
      // but dedupe defensively — a batch can't target the same doc twice.
      memberUidsToReset = [...new Set([wsData.ownerId, ...(wsData.members || [])])].filter(Boolean);
    }
  } catch (err) {
    logger.error('workspace-deletion', `Failed to read workspace doc before deletion: ${err.message}`);
  }

  // Collect config IDs early — needed for step 2 (locks) and step 1 doesn't return IDs after recursiveDelete
  let configIds = [];
  try {
    const cfgs = await db.collection('workspaces').doc(workspaceId)
      .collection('sync_configs')
      .select()
      .get();
    configIds = cfgs.docs.map(d => d.id);
    summary.syncConfigs = configIds.length;
  } catch (err) {
    const msg = `Failed to enumerate sync_configs for "${workspaceId}": ${err.message}`;
    logger.error('workspace-deletion', msg);
    errors.push(msg);
  }

  // ── Step 1: Recursively delete sync_configs subcollection ──────
  if (configIds.length > 0) {
    try {
      await db.recursiveDelete(
        db.collection('workspaces').doc(workspaceId).collection('sync_configs')
      );
      logger.info('workspace-deletion', `  Deleted ${configIds.length} sync_config(s) with subcollections`);
    } catch (err) {
      const msg = `Step 1 — recursiveDelete sync_configs failed: ${err.message}`;
      logger.error('workspace-deletion', msg);
      errors.push(msg);
    }
  }

  // ── Step 2: Delete sync_locks for each deleted config ──────────
  if (configIds.length > 0) {
    try {
      const lockBatch = db.batch();
      let lockCount = 0;
      for (const cid of configIds) {
        const lockRef = db.collection('sync_locks').doc(cid);
        const lockDoc = await lockRef.get();
        if (lockDoc.exists) {
          lockBatch.delete(lockRef);
          lockCount++;
        }
      }
      if (lockCount > 0) {
        await lockBatch.commit();
      }
      summary.locks = lockCount;
      if (lockCount > 0) {
        logger.info('workspace-deletion', `  Deleted ${lockCount} sync_lock(s)`);
      }
    } catch (err) {
      const msg = `Step 2 — sync_locks deletion failed: ${err.message}`;
      logger.error('workspace-deletion', msg);
      errors.push(msg);
    }
  }

  // ── Step 3: Delete connected_accounts (capture userIds first) ──
  const deletedConnIds = [];
  const affectedUserIds = new Set();
  try {
    const connSnap = await db.collection('connected_accounts')
      .where('workspaceId', '==', workspaceId)
      .get();

    // Capture userIds BEFORE deleting
    connSnap.forEach(d => {
      const data = d.data();
      deletedConnIds.push(d.id);
      if (data.userId) affectedUserIds.add(data.userId);
    });
    summary.connections = deletedConnIds.length;

    // Batch-delete connected_accounts
    if (deletedConnIds.length > 0) {
      const batch = db.batch();
      connSnap.docs.forEach(d => batch.delete(d.ref));
      await batch.commit();
      logger.info('workspace-deletion', `  Deleted ${deletedConnIds.length} connected_account(s)`);
    }
  } catch (err) {
    const msg = `Step 3 — connected_accounts deletion failed: ${err.message}`;
    logger.error('workspace-deletion', msg);
    errors.push(msg);
  }

  // ── Step 4: Clean up credentials entries ──────────────────────
  if (deletedConnIds.length > 0) {
    try {
      let credsDeletedCount = 0;

      for (const uid of affectedUserIds) {
        const credsRef = db.collection('credentials').doc(uid);
        const credsDoc = await credsRef.get();
        if (!credsDoc.exists) continue;

        const credsData = credsDoc.data();
        let needsUpdate = false;

        for (const connId of deletedConnIds) {
          if (credsData[connId]) {
            delete credsData[connId];
            needsUpdate = true;
            credsDeletedCount++;
          }
        }

        if (needsUpdate) {
          // Check if the user has any credentials left for OTHER workspaces
          const remainingKeys = Object.keys(credsData);
          if (remainingKeys.length === 0) {
            await credsRef.delete();
          } else {
            await credsRef.set(credsData, { merge: true });
          }
        }
      }

      summary.credentials = credsDeletedCount;
      if (credsDeletedCount > 0) {
        logger.info('workspace-deletion', `  Removed ${credsDeletedCount} credential entry(ies)`);
      }
    } catch (err) {
      const msg = `Step 4 — credentials cleanup failed: ${err.message}`;
      logger.error('workspace-deletion', msg);
      errors.push(msg);
    }
  }

  // ── Step 5: Delete execution_logs (batched) ───────────────────
  try {
    let deleted = 0;
    let hasMore = true;
    while (hasMore) {
      const oldSnap = await db.collection('execution_logs')
        .where('workspaceId', '==', workspaceId)
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

    summary.executionLogs = deleted;
    if (deleted > 0) {
      logger.info('workspace-deletion', `  Deleted ${deleted} execution_log(s)`);
    }
  } catch (err) {
    const msg = `Step 5 — execution_logs deletion failed: ${err.message}`;
    logger.error('workspace-deletion', msg);
    errors.push(msg);
  }

  // ── Step 6: Delete workspace document ─────────────────────────
  try {
    await db.collection('workspaces').doc(workspaceId).delete();
    logger.info('workspace-deletion', `  Deleted workspace document "${workspaceId}"`);
  } catch (err) {
    const msg = `Step 6 — workspace document deletion failed: ${err.message}`;
    logger.error('workspace-deletion', msg);
    errors.push(msg);
  }

  // ── Step 7: Reset departed members' workspaceId back to their own uid ──
  // Otherwise every member of a deleted shared workspace (including the
  // owner) is left with users/{uid}.workspaceId pointing at a doc that no
  // longer exists, with no recovery path — GET /workspace returns null
  // forever instead of falling back to their own solo workspace.
  if (memberUidsToReset.length > 0) {
    try {
      const batch = db.batch();
      memberUidsToReset.forEach(uid => {
        batch.update(db.collection('users').doc(uid), { workspaceId: uid });
      });
      await batch.commit();
      summary.membersReset = memberUidsToReset.length;
      logger.info('workspace-deletion', `  Reset workspaceId for ${memberUidsToReset.length} member(s) back to their own uid`);
    } catch (err) {
      const msg = `Step 7 — member workspaceId reset failed: ${err.message}`;
      logger.error('workspace-deletion', msg);
      errors.push(msg);
    }
  }

  // ── Summary ────────────────────────────────────────────────────
  const success = errors.length === 0;
  if (success) {
    logger.info('workspace-deletion',
      `Workspace "${workspaceId}" fully deleted: ${JSON.stringify(summary)}`);
  } else {
    logger.error('workspace-deletion',
      `Workspace "${workspaceId}" partially deleted. Summary: ${JSON.stringify(summary)}. Errors: ${errors.join('; ')}`);
  }

  return { success, summary, errors };
}

module.exports = { deleteWorkspace };

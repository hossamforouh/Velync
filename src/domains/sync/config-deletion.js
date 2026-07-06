const db = require('../../core/db');
const logger = require('../../core/logger');

const BATCH_SIZE = 300;

/**
 * Delete a sync config and everything tied to it.
 *
 * Firestore does NOT cascade subcollection deletes, so deleting the config doc
 * alone leaks its entire sync_mappings subcollection (one doc per synced item) —
 * the root cause of unbounded sync_mappings growth. This deletes, in order:
 *   1. all sync_mappings under the config (batched)
 *   2. the config document
 *   3. the distributed sync lock, if present
 *
 * @param {string} workspaceId
 * @param {string} configId
 * @returns {Promise<{deletedMappings: number}>}
 */
async function deleteSyncConfig(workspaceId, configId) {
  const configRef = db.collection('workspaces').doc(workspaceId)
    .collection('sync_configs').doc(configId);
  const mappingsRef = configRef.collection('sync_mappings');

  // 1. Delete all sync_mappings in bounded batches.
  let deletedMappings = 0;
  while (true) {
    const snap = await mappingsRef.limit(BATCH_SIZE).get();
    if (snap.empty) break;
    const batch = db.batch();
    snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
    deletedMappings += snap.size;
    if (snap.size < BATCH_SIZE) break;
  }

  // 2. Delete the config document.
  await configRef.delete();

  // 3. Delete the distributed lock (best-effort — it may not exist).
  await db.collection('sync_locks').doc(configId).delete().catch(() => {});

  logger.info('config-deletion',
    `Deleted sync_config "${configId}" (${deletedMappings} mapping(s)) in workspace "${workspaceId}"`);
  return { deletedMappings };
}

module.exports = { deleteSyncConfig };

const { resolveCredentials } = require('../connection/resolver');
const { getConnector } = require('../connector');
const db = require('../../core/db');
const logger = require('../../core/logger');
const { mapSourceToDest } = require('./mapper');
const { resolveConflict } = require('./conflict');
const os = require('os');

const runningConfigs = new Set();

/** Unique instance identifier for distributed lock ownership */
const INSTANCE_ID = `${os.hostname()}-${process.pid}`;

/** Duration of a sync lease in milliseconds (2 min — max expected execution time) */
const LEASE_DURATION_MS = 120_000;

/**
 * Try to acquire a distributed lease for a sync config.
 * Uses a Firestore transaction so only one instance succeeds.
 *
 * @param {string} configId
 * @returns {Promise<boolean>} true if lease was acquired, false if held by another instance
 */
async function acquireLease(configId) {
  const lockRef = db.collection('sync_locks').doc(configId);
  try {
    const result = await db.runTransaction(async (transaction) => {
      const doc = await transaction.get(lockRef);
      const now = Date.now();

      if (doc.exists) {
        const data = doc.data();
        const expiresAt = data.expiresAt?.toMillis ? data.expiresAt.toMillis() : new Date(data.expiresAt || 0).getTime();
        // If the lease hasn't expired and is held by another instance, fail
        if (expiresAt > now && data.heldBy !== INSTANCE_ID) {
          return false;
        }
      }

      // Acquire or extend the lease
      transaction.set(lockRef, {
        heldBy: INSTANCE_ID,
        acquiredAt: new Date().toISOString(),
        expiresAt: new Date(now + LEASE_DURATION_MS),
      });
      return true;
    });
    return result;
  } catch (err) {
    logger.error('sync', `Failed to acquire lease for "${configId}"`, { error: err.message });
    return false; // Fail open: skip this run rather than risk duplicate execution
  }
}

/**
 * Release the lease for a sync config.
 */
async function releaseLease(configId) {
  try {
    const lockRef = db.collection('sync_locks').doc(configId);
    // Only delete if we still hold the lease (don't clear another instance's lease)
    const doc = await lockRef.get();
    if (doc.exists && doc.data().heldBy === INSTANCE_ID) {
      await lockRef.delete();
    }
  } catch (err) {
    logger.warn('sync', `Failed to release lease for "${configId}"`, { error: err.message });
  }
}

/**
 * Retry an async operation with exponential backoff for transient errors.
 * Retries on 429 (rate-limit), 5xx (server errors), and network errors.
 * Does NOT retry on 4xx client errors (except 401/403 which may recover after token refresh).
 * Returns early on 404s so the caller can handle them specially.
 *
 * @param {Function} fn - async function to retry
 * @param {object} options
 * @param {number} options.maxAttempts - max retry attempts (default 3)
 * @param {number} options.baseDelayMs - base delay in ms (default 1000)
 * @returns {Promise<{result: any, recovered: boolean}>}
 */
async function retryWithBackoff(fn, options = {}) {
  const maxAttempts = options.maxAttempts || 3;
  const baseDelayMs = options.baseDelayMs || 1000;
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await fn();
      return { result, recovered: attempt > 1 };
    } catch (err) {
      lastError = err;
      const status = err.response?.status || err.statusCode || 0;

      // 404 — don't retry, signal caller
      if (status === 404) throw err;

      // 4xx other than 401/403/429 — don't retry (bad request, etc.)
      if (status >= 400 && status < 500 && status !== 401 && status !== 403 && status !== 429) throw err;

      // Last attempt — don't sleep, just throw
      if (attempt >= maxAttempts) throw err;

      const delay = baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 500;
      logger.warn('sync', `Retrying after error (attempt ${attempt}/${maxAttempts})`, {
        status, delay: Math.round(delay), error: err.message,
      });
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

async function runSync(config, configId) {
  if (runningConfigs.has(configId)) {
    logger.warn('sync', `Skipping "${configId}" — already running`);
    return;
  }
  runningConfigs.add(configId);

  try {
    const settingsDoc = await db.collection('app_settings').doc('general').get();
    const settings = settingsDoc.data() || {};
    const maxConfigs = settings.maxConfigsPerUser;
    if (maxConfigs && config.workspaceId) {
      const activeSnap = await db.collection('workspaces').doc(config.workspaceId)
        .collection('sync_configs')
        .where('status', '==', 'active')
        .get();
      if (activeSnap.size > maxConfigs) {
        logger.warn('sync', `Workspace "${config.workspaceId}" has ${activeSnap.size} active configs, limit is ${maxConfigs}. Skipping "${configId}".`);
        runningConfigs.delete(configId);
        return;
      }
    }
  } catch (err) {
    logger.warn('sync', 'Failed to check plan limits, proceeding anyway', { error: err.message });
  }

  // Acquire distributed lease so only one instance executes this config at a time
  const hasLease = await acquireLease(configId);
  if (!hasLease) {
    logger.info('sync', `Skipping "${configId}" — lease held by another instance`);
    runningConfigs.delete(configId);
    return;
  }

  const logRef = await db.collection('execution_logs').add({
    configId, configName: config.description || configId, workspaceId: config.workspaceId,
    startTime: new Date().toISOString(), status: 'running',
  }).catch(() => null);

  let synced = 0, deleted = 0, failed = 0;
  try {
    const workspaceId = config.workspaceId;
    const sourceConnId = config.platform1ConnectionId || config.sourceConnectionId;
    const destConnId = config.platform2ConnectionId || config.destConnectionId;
    const sourcePlatformId = config.platform1 || config.sourcePlatform;
    const destPlatformId = config.platform2 || config.destPlatform;
    const fieldMappings = config.fieldMappings || [];
    const syncType = config.syncType || 'Source_to_Dest';

    const p1Settings = config.p1Settings || {};
    const p2Settings = config.p2Settings || {};
    const entityType = p1Settings.targetEntity || p2Settings.targetEntity || config.targetEntity || 'Tasks';

    const filter = { ...p1Settings, ...(config.filterConfig || {}) };
    delete filter.targetEntity;

    config.templateId = p2Settings.templateId || p2Settings.template || config.templateId;

    // Incremental sync: only fetch items modified since the last successful run
    const lastSyncAt = config.lastSuccessfulSyncAt || config.lastRunAt;
    const fetchOptions = lastSyncAt ? { modifiedSince: lastSyncAt } : {};

    // Hard cap on items processed per run to avoid timeout
    const MAX_ITEMS_PER_RUN = config.maxItemsPerRun || 500;

    const sourceCreds = sourceConnId ? { ...await resolveCredentials(null, sourceConnId), ...p1Settings } : { ...p1Settings };
    const destCreds = destConnId ? { ...await resolveCredentials(null, destConnId), databaseId: p2Settings.database, ...p2Settings } : { databaseId: p2Settings.database, ...p2Settings };

    let resolvedSourcePlatform = sourcePlatformId;
    let resolvedDestPlatform = destPlatformId;

    const p1Doc = await db.collection('platforms').doc(sourcePlatformId).get();
    if (p1Doc.exists && p1Doc.data().name) resolvedSourcePlatform = p1Doc.data().name.toLowerCase();

    const p2Doc = await db.collection('platforms').doc(destPlatformId).get();
    if (p2Doc.exists && p2Doc.data().name) resolvedDestPlatform = p2Doc.data().name.toLowerCase();

    const SourceConn = getConnector(resolvedSourcePlatform);
    const DestConn = getConnector(resolvedDestPlatform);
    const source = new SourceConn(sourceCreds);
    const dest = new DestConn(destCreds);

    // ModifiedSince-filtered fetch for create/update processing
    const sourceItems = (await source.fetch(entityType, filter, fetchOptions)).slice(0, MAX_ITEMS_PER_RUN);
    const destItems = (await dest.fetch(entityType, filter, fetchOptions)).slice(0, MAX_ITEMS_PER_RUN);

    // Unfiltered ID-only fetch for deletion detection — must not use modifiedSince
    // or MAX_ITEMS_PER_RUN, since an incomplete ID set would cause false-positive deletions.
    const allSourceIds = (await source.fetchIds(entityType, filter)).map(i => i.id);
    const allDestIds = (await dest.fetchIds(entityType, filter)).map(i => i.id);

    const mappingsSnapshot = await db.collection('workspaces').doc(workspaceId)
      .collection('sync_configs').doc(configId).collection('sync_mappings').get();

    const sourceToMapping = new Map();
    const destToMapping = new Map();
    const mappedDestIds = new Set();
    mappingsSnapshot.forEach(doc => {
      const d = { mappingId: doc.id, ...doc.data() };
      sourceToMapping.set(d.sourceEntityId, d);
      destToMapping.set(d.destEntityId, d);
      mappedDestIds.add(d.destEntityId);
    });

    const activeSourceIds = new Set(sourceItems.map(i => i.id));
    const activeDestIds = new Set(destItems.map(i => i.id));

    const saveMappingBatch = async (operations) => {
      if (operations.length === 0) return;
      const batch = db.batch();
      const mappingsRef = db.collection('workspaces').doc(workspaceId)
        .collection('sync_configs').doc(configId).collection('sync_mappings');
      for (const op of operations) {
        if (op.type === 'set') {
          batch.set(mappingsRef.doc(op.id), op.data);
        } else if (op.type === 'update') {
          batch.update(mappingsRef.doc(op.id), op.data);
        } else if (op.type === 'delete') {
          batch.delete(mappingsRef.doc(op.id));
        }
      }
      await batch.commit();
    };

    const pendingOps = [];

    const queueSaveMapping = (sourceId, destId, srcMod, destMod) => {
      const data = {
        sourceEntityId: sourceId, destEntityId: destId,
        sourceEntityType: entityType, lastSyncedAt: new Date().toISOString(),
        sourceLastModified: srcMod, destLastEdited: destMod
      };
      const existing = sourceToMapping.get(sourceId);
      if (existing) {
        pendingOps.push({ type: 'update', id: existing.mappingId, data });
        Object.assign(existing, data);
      } else {
        const tempId = `batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        pendingOps.push({ type: 'set', id: tempId, data: { ...data, tempId } });
        data.mappingId = tempId;
        sourceToMapping.set(sourceId, data);
        destToMapping.set(destId, data);
      }
    };

    const queueRemoveMapping = (mapping) => {
      if (mapping?.mappingId) {
        pendingOps.push({ type: 'delete', id: mapping.mappingId });
        sourceToMapping.delete(mapping.sourceEntityId);
        destToMapping.delete(mapping.destEntityId);
      }
    };

    const destSchema = typeof dest.getSchema === 'function' ? await dest.getSchema(entityType) : {};

    for (const item of sourceItems) {
      try {
        let mapping = sourceToMapping.get(item.id);
        if (mapping && !activeDestIds.has(mapping.destEntityId)) mapping = null;

        const { properties, content } = mapSourceToDest(item, fieldMappings, {}, destSchema, config.statusMappings);

        if (!mapping) {
          const { result: created } = await retryWithBackoff(() =>
            dest.create(entityType, { properties, content, title: item.title || item.name || 'Untitled', children: item.items, templateId: config.templateId })
          );
          const modTime = created?.last_edited_time || created?.modifiedTime || new Date().toISOString();
          queueSaveMapping(item.id, created.id, item.modifiedTime, modTime);
          synced++;
          if (config.deleteAfterSync) {
            await retryWithBackoff(() => source.delete(entityType, item.id, item.projectId));
            queueRemoveMapping(mapping);
            deleted++;
          }
        } else {
          const conflict = resolveConflict(item.modifiedTime, item.destModifiedTime, mapping);
          if (conflict !== 'no_change') {
            try {
              const { result: updated } = await retryWithBackoff(() =>
                dest.update(entityType, mapping.destEntityId, { properties, content })
              );
              const retrieved = typeof dest.retrieve === 'function'
                ? await retryWithBackoff(() => dest.retrieve(entityType, mapping.destEntityId))
                : { result: {} };
              queueSaveMapping(item.id, mapping.destEntityId, item.modifiedTime, retrieved.result.last_edited_time || new Date().toISOString());
              synced++;
            } catch (updateErr) {
              // 404 on update means the dest item was deleted externally — remove stale mapping
              if (updateErr.response?.status === 404 || updateErr.statusCode === 404) {
                logger.warn('sync', `Destination item "${mapping.destEntityId}" not found (deleted externally) — removing stale mapping and recreating next cycle`, { error: updateErr.message });
                queueRemoveMapping(mapping);
              } else {
                throw updateErr;
              }
            }
          }
          if (config.deleteAfterSync) {
            await retryWithBackoff(() => source.delete(entityType, item.id, item.projectId));
            queueRemoveMapping(mapping);
            deleted++;
          }
        }
      } catch (err) {
        logger.error('sync', `Failed item "${item.title || item.name}"`, { error: err.message });
        failed++;
      }
    }

    // Flush batched mapping writes
    await saveMappingBatch(pendingOps.splice(0));

    if (syncType === 'Bidirectional') {
      for (const page of destItems) {
        try {
          if (destToMapping.has(page.id)) continue;
          const mapped = { title: dest.getDisplayTitle(page) };
          const { result: created } = await retryWithBackoff(() => source.create(entityType, mapped));
          queueSaveMapping(null, page.id, new Date().toISOString(), created.modifiedTime || new Date().toISOString());
          synced++;
        } catch (err) {
          logger.error('sync', `Failed bidirectional dest item`, { error: err.message });
          failed++;
        }
      }
      await saveMappingBatch(pendingOps.splice(0));
    }

    for (const [sourceId, mapping] of sourceToMapping.entries()) {
      if (!allSourceIds.includes(sourceId) && allDestIds.includes(mapping.destEntityId)) {
        try {
          await retryWithBackoff(() => dest.delete(entityType, mapping.destEntityId));
          queueRemoveMapping(mapping);
          deleted++;
        } catch (err) {
          logger.error('sync', `Failed deletion propagation`, { error: err.message });
          failed++;
        }
      }
    }
    await saveMappingBatch(pendingOps.splice(0));

  } catch (err) {
    logger.error('sync', `Config "${configId}" failed`, { error: err.message });
    if (logRef) await logRef.update({ status: 'error', endTime: new Date().toISOString(), error: err.message }).catch(() => {});
    throw err;
  } finally {
    runningConfigs.delete(configId);
    await releaseLease(configId);
  }

  const now = new Date().toISOString();
  if (logRef) await logRef.update({ status: 'success', endTime: now, syncedCount: synced, deletedCount: deleted, failedCount: failed }).catch(() => {});
  await db.collection('workspaces').doc(config.workspaceId).collection('sync_configs').doc(configId).update({ lastRunAt: now, lastSuccessfulSyncAt: now }).catch(() => {});
  logger.info('sync', `Completed "${configId}" — synced:${synced} deleted:${deleted} failed:${failed}`);
  return { synced, deleted, failed };
}

module.exports = { runSync, retryWithBackoff };

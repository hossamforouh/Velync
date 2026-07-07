const { resolveCredentials } = require('../connection/resolver');
const { getConnector } = require('../connector');
const db = require('../../core/db');
const logger = require('../../core/logger');
const { mapSourceToDest } = require('./mapper');
const { resolveConflict } = require('./conflict');
const { getPlan } = require('../../core/plan');
const { resolveConnectorKey } = require('../../core/platform');
const { acquireLease, releaseLease } = require('../../core/lock');
const { notifySyncFailure } = require('../../core/notifications');

const runningConfigs = new Set();

/** Duration of a sync lease in milliseconds (2 min — max expected execution time) */
const LEASE_DURATION_MS = 120_000;

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

/**
 * Load only the mapping docs relevant to the items touched this cycle, by querying
 * sourceEntityId / destEntityId in batches (Firestore 'in' supports up to 30 values).
 * Used on non-reconcile cycles to avoid reading the entire mapping set.
 * @returns {Promise<Array>} Firestore document snapshots (deduped by id)
 */
async function loadMappingsForItems(mappingsCol, sourceItems, destItems) {
  const byId = new Map();
  const queryIn = async (field, values) => {
    const clean = values.filter(Boolean);
    for (let i = 0; i < clean.length; i += 30) {
      const batch = clean.slice(i, i + 30);
      const snap = await mappingsCol.where(field, 'in', batch).get();
      snap.docs.forEach(d => byId.set(d.id, d));
    }
  };
  await queryIn('sourceEntityId', sourceItems.map(i => i.id));
  await queryIn('destEntityId', destItems.map(i => i.id));
  return Array.from(byId.values());
}

async function runSync(config, configId) {
  if (runningConfigs.has(configId)) {
    logger.warn('sync', `Skipping "${configId}" — already running`);
    return;
  }
  runningConfigs.add(configId);

  // Resolve workspace's plan limits
  let plan = null;
  try {
    if (config.workspaceId) {
      const wsDoc = await db.collection('workspaces').doc(config.workspaceId).get();
      const ws = wsDoc.data() || {};
      const planId = ws.planId || 'free';
      plan = await getPlan(planId);
      if (plan && plan.maxActiveConfigs) {
        // count() aggregation instead of reading every active config doc each run.
        const activeCount = (await db.collection('workspaces').doc(config.workspaceId)
          .collection('sync_configs')
          .where('status', '==', 'active')
          .count().get()).data().count;
        if (activeCount > plan.maxActiveConfigs) {
          logger.warn('sync', `Workspace "${config.workspaceId}" has ${activeCount} active configs, plan "${planId}" limit is ${plan.maxActiveConfigs}. Skipping "${configId}".`);
          runningConfigs.delete(configId);
          return;
        }
      }
    }
  } catch (err) {
    logger.warn('sync', 'Failed to check plan limits, proceeding anyway', { error: err.message });
  }

  // Acquire distributed lease so only one instance executes this config at a time
  const hasLease = await acquireLease(configId, LEASE_DURATION_MS);
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
  // Whether this run performs full deletion reconciliation (decided below). Declared
  // out here so the post-run config update can persist lastReconcileAt.
  let doReconcile = false;
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
    let MAX_ITEMS_PER_RUN = config.maxItemsPerRun || 500;
    if (plan && plan.maxItemsPerRun && MAX_ITEMS_PER_RUN > plan.maxItemsPerRun) {
      MAX_ITEMS_PER_RUN = plan.maxItemsPerRun;
    }

    const sourceCreds = sourceConnId ? { ...await resolveCredentials(null, sourceConnId), ...p1Settings } : { ...p1Settings };
    const destCreds = destConnId ? { ...await resolveCredentials(null, destConnId), databaseId: p2Settings.database, ...p2Settings } : { databaseId: p2Settings.database, ...p2Settings };

    // Platform docs get auto-generated Firestore IDs, not necessarily the
    // connector registry key — resolveConnectorKey() handles that mapping
    // (and uses the same cached platform lookup as getPlatform() elsewhere).
    const resolvedSourcePlatform = await resolveConnectorKey(sourcePlatformId);
    const resolvedDestPlatform = await resolveConnectorKey(destPlatformId);

    const SourceConn = getConnector(resolvedSourcePlatform);
    const DestConn = getConnector(resolvedDestPlatform);
    const source = new SourceConn(sourceCreds);
    const dest = new DestConn(destCreds);

    // ModifiedSince-filtered fetch for create/update processing
    const sourceItems = (await source.fetch(entityType, filter, fetchOptions)).slice(0, MAX_ITEMS_PER_RUN);
    const destItems = (await dest.fetch(entityType, filter, fetchOptions)).slice(0, MAX_ITEMS_PER_RUN);

    // Deletion reconciliation must read the FULL mapping set, which is the dominant
    // Firestore cost at scale. Run it only every `reconcileIntervalMinutes`; on other
    // cycles load just the mappings for items touched this run, so steady-state reads
    // scale with the number of CHANGES, not total data size. Deletions still propagate,
    // just within the reconcile interval rather than instantly.
    const RECONCILE_INTERVAL_MIN = config.reconcileIntervalMinutes || 60;
    const lastReconcileAt = config.lastReconcileAt || null;
    doReconcile = !lastReconcileAt
      || (Date.now() - new Date(lastReconcileAt).getTime()) >= RECONCILE_INTERVAL_MIN * 60_000;

    // Unfiltered ID-only fetch — must not use modifiedSince or MAX_ITEMS_PER_RUN, since
    // an incomplete ID set would cause false-positive deletions.
    // Dest IDs are always needed (staleness check in the create/update loop below).
    const allDestIdSet = new Set((await dest.fetchIds(entityType, filter)).map(i => i.id));
    // Source IDs are only needed for deletion reconciliation — skip the fetch otherwise.
    const allSourceIdSet = doReconcile
      ? new Set((await source.fetchIds(entityType, filter)).map(i => i.id))
      : null;

    const mappingsCol = db.collection('workspaces').doc(workspaceId)
      .collection('sync_configs').doc(configId).collection('sync_mappings');

    // Full load on reconcile cycles (needed to detect deletions); targeted load otherwise.
    const mappingDocs = doReconcile
      ? (await mappingsCol.get()).docs
      : await loadMappingsForItems(mappingsCol, sourceItems, destItems);

    const sourceToMapping = new Map();
    const destToMapping = new Map();
    const mappedDestIds = new Set();
    mappingDocs.forEach(doc => {
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
      const mappingsRef = mappingsCol;
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
        if (mapping && !allDestIdSet.has(mapping.destEntityId)) mapping = null;

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

    // Deletion reconciliation — only on reconcile cycles, where allSourceIdSet is the
    // complete set of live source IDs. On other cycles deletions are deferred to the
    // next reconcile, avoiding a full mapping scan every run.
    if (doReconcile) {
      for (const [sourceId, mapping] of sourceToMapping.entries()) {
        if (!allSourceIdSet.has(sourceId) && allDestIdSet.has(mapping.destEntityId)) {
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
    }

  } catch (err) {
    logger.error('sync', `Config "${configId}" failed`, { error: err.message });
    if (logRef) await logRef.update({ status: 'error', endTime: new Date().toISOString(), error: err.message }).catch(() => {});
    notifySyncFailure({
      workspaceId: config.workspaceId,
      configId,
      configName: config.description,
      error: err.message,
      currentLogId: logRef?.id,
    }).catch(() => {});
    throw err;
  } finally {
    runningConfigs.delete(configId);
    await releaseLease(configId);
  }

  const now = new Date().toISOString();
  if (logRef) await logRef.update({ status: 'success', endTime: now, syncedCount: synced, deletedCount: deleted, failedCount: failed }).catch(() => {});
  const configUpdate = { lastRunAt: now, lastSuccessfulSyncAt: now };
  if (doReconcile) configUpdate.lastReconcileAt = now;
  await db.collection('workspaces').doc(config.workspaceId).collection('sync_configs').doc(configId).update(configUpdate).catch(() => {});
  logger.info('sync', `Completed "${configId}" — synced:${synced} deleted:${deleted} failed:${failed}`);
  return { synced, deleted, failed };
}

module.exports = { runSync, retryWithBackoff };

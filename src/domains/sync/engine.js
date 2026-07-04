const { decrypt } = require('../../../utils/encryption');
const { getConnector } = require('../connector');
const db = require('../../core/db');
const logger = require('../../core/logger');
const { mapSourceToDest } = require('./mapper');
const { resolveConflict } = require('./conflict');

const runningConfigs = new Set();

async function resolveConnectorCreds(workspaceId, connectionId) {
  const connDoc = await db.collection('connected_accounts').doc(connectionId).get();
  if (!connDoc.exists) throw new Error('Connection not found: ' + connectionId);
  const conn = connDoc.data();
  const credsDoc = await db.collection('credentials').doc(workspaceId).get();
  if (!credsDoc.exists) throw new Error('Credentials not found for workspace');
  const platformCreds = credsDoc.data()[conn.provider];
  if (!platformCreds) throw new Error(`No credentials for ${conn.provider}`);
  return {
    accessToken: decrypt(platformCreds.accessToken),
    refreshToken: platformCreds.refreshToken ? decrypt(platformCreds.refreshToken) : null,
    clientId: platformCreds.clientId,
    clientSecret: platformCreds.clientSecret,
    ...conn.attributes,
  };
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

    const sourceCreds = sourceConnId ? { ...await resolveConnectorCreds(workspaceId, sourceConnId), ...p1Settings } : { ...p1Settings };
    const destCreds = destConnId ? { ...await resolveConnectorCreds(workspaceId, destConnId), databaseId: p2Settings.database, ...p2Settings } : { databaseId: p2Settings.database, ...p2Settings };

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

    const sourceItems = await source.fetch(entityType, filter);
    const destItems = await dest.fetch(entityType, filter);

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
          const created = await dest.create(entityType, { properties, content, title: item.title || item.name || 'Untitled', children: item.items, templateId: config.templateId });
          const modTime = created?.last_edited_time || created?.modifiedTime || new Date().toISOString();
          queueSaveMapping(item.id, created.id, item.modifiedTime, modTime);
          synced++;
          if (config.deleteAfterSync) {
            await source.delete(entityType, item.id, item.projectId);
            queueRemoveMapping(mapping);
            deleted++;
          }
        } else {
          const conflict = resolveConflict(item.modifiedTime, item.destModifiedTime, mapping);
          if (conflict !== 'no_change') {
            await dest.update(entityType, mapping.destEntityId, { properties, content });
            const updated = typeof dest.retrieve === 'function' ? await dest.retrieve(entityType, mapping.destEntityId) : {};
            queueSaveMapping(item.id, mapping.destEntityId, item.modifiedTime, updated.last_edited_time || new Date().toISOString());
            synced++;
          }
          if (config.deleteAfterSync) {
            await source.delete(entityType, item.id, item.projectId);
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
          const mapped = { title: page.properties?.Name?.title?.[0]?.plain_text || 'Untitled' };
          mapped.projectId = filter.listName?.toLowerCase() === 'inbox' ? 'inbox' : undefined;
          const created = await source.create(entityType, mapped);
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
      if (!activeSourceIds.has(sourceId) && activeDestIds.has(mapping.destEntityId)) {
        try {
          await dest.delete(entityType, mapping.destEntityId);
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
  }

  const now = new Date().toISOString();
  if (logRef) await logRef.update({ status: 'success', endTime: now, syncedCount: synced, deletedCount: deleted, failedCount: failed }).catch(() => {});
  await db.collection('workspaces').doc(config.workspaceId).collection('sync_configs').doc(configId).update({ lastRunAt: now }).catch(() => {});
  logger.info('sync', `Completed "${configId}" — synced:${synced} deleted:${deleted} failed:${failed}`);
  return { synced, deleted, failed };
}

module.exports = { runSync };

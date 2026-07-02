const { Firestore } = require('@google-cloud/firestore');
const { decrypt } = require('../../../utils/encryption');
const { getConnector } = require('../connector');
const logger = require('../../core/logger');
const { mapSourceToDest } = require('./mapper');
const { resolveConflict } = require('./conflict');

const db = new Firestore();
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
    
    config.templateId = p2Settings.templateId || config.templateId;

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

    const saveMapping = async (sourceId, destId, srcMod, destMod) => {
      const data = { sourceEntityId: sourceId, destEntityId: destId, sourceEntityType: entityType, lastSyncedAt: new Date().toISOString(), sourceLastModified: srcMod, destLastEdited: destMod };
      const existing = sourceToMapping.get(sourceId);
      if (existing) await db.collection('workspaces').doc(workspaceId).collection('sync_configs').doc(configId).collection('sync_mappings').doc(existing.mappingId).update(data);
      else {
        const ref = await db.collection('workspaces').doc(workspaceId).collection('sync_configs').doc(configId).collection('sync_mappings').add(data);
        data.mappingId = ref.id;
      }
      sourceToMapping.set(sourceId, data);
      destToMapping.set(destId, data);
    };

    const removeMapping = async (mapping) => {
      if (mapping?.mappingId) {
        await db.collection('workspaces').doc(workspaceId).collection('sync_configs').doc(configId).collection('sync_mappings').doc(mapping.mappingId).delete().catch(() => {});
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
          await saveMapping(item.id, created.id, item.modifiedTime, modTime);
          synced++;
          if (config.deleteAfterSync) {
            await source.delete(entityType, item.id, item.projectId);
            await removeMapping(mapping);
            deleted++;
          }
        } else {
          const conflict = resolveConflict(item.modifiedTime, item.destModifiedTime, mapping);
          if (conflict !== 'no_change') {
            await dest.update(entityType, mapping.destEntityId, { properties, content });
            const updated = typeof dest.retrieve === 'function' ? await dest.retrieve(entityType, mapping.destEntityId) : {};
            await saveMapping(item.id, mapping.destEntityId, item.modifiedTime, updated.last_edited_time || new Date().toISOString());
            synced++;
          }
          if (config.deleteAfterSync) {
            await source.delete(entityType, item.id, item.projectId);
            await removeMapping(mapping);
            deleted++;
          }
        }
      } catch (err) {
        logger.error('sync', `Failed item "${item.title || item.name}"`, { error: err.message });
        failed++;
      }
    }

    if (syncType === 'Bidirectional') {
      for (const page of destItems) {
        try {
          if (destToMapping.has(page.id)) continue;
          const mapped = { title: page.properties?.Name?.title?.[0]?.plain_text || 'Untitled' };
          mapped.projectId = filter.listName?.toLowerCase() === 'inbox' ? 'inbox' : undefined;
          const created = await source.create(entityType, mapped);
          await saveMapping(null, page.id, new Date().toISOString(), created.modifiedTime || new Date().toISOString());
          synced++;
        } catch (err) {
          logger.error('sync', `Failed bidirectional dest item`, { error: err.message });
          failed++;
        }
      }
    }

    for (const [sourceId, mapping] of sourceToMapping.entries()) {
      if (!activeSourceIds.has(sourceId) && activeDestIds.has(mapping.destEntityId)) {
        try {
          await dest.delete(entityType, mapping.destEntityId);
          await removeMapping(mapping);
          deleted++;
        } catch (err) {
          logger.error('sync', `Failed deletion propagation`, { error: err.message });
          failed++;
        }
      }
    }
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

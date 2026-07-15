const db = require('../../core/db');
const logger = require('../../core/logger');

/**
 * Two-hop reverse lookup from a verified webhook event to the sync_config(s)
 * it affects. See WEBHOOK_SYNC_PLAN.md §5 Stage 2 for the full design
 * rationale — summarized here:
 *
 *   1. providerWorkspaceId -> connectionId(s). The webhook only carries the
 *      third-party platform's own workspace id, not a Velync id, so this
 *      resolves it via connected_accounts (a real per-connection doc,
 *      denormalized with providerWorkspaceId at OAuth-connect time in
 *      auth.js — unlike `credentials`, which is doc-per-uid/map-keyed and
 *      not queryable this way).
 *   2. connectionId + entityId -> sync_config(s). A connection can be reused
 *      across multiple configs pointing at different databases, so matching
 *      on the connection alone would over-fire — this also checks that the
 *      matching side's p1Settings/p2Settings.database equals the changed
 *      entity's id.
 *
 * Platform-agnostic: takes the normalized `{provider, providerWorkspaceId,
 * entityId}` shape produced by a connector's parseWebhookEvent(), never
 * touches Notion-specific payload fields directly.
 *
 * @param {string} provider - connector registry key, e.g. 'notion'
 * @param {string} providerWorkspaceId - the platform's own workspace id
 * @param {string} entityId - the changed resource's id (e.g. a Notion database/data_source id)
 * @returns {Promise<Array<{configId: string, workspaceId: string, config: object}>>}
 */
async function resolveConfigsForWebhookEvent(provider, providerWorkspaceId, entityId) {
  if (!provider || !providerWorkspaceId || !entityId) return [];

  const accountsSnap = await db.collection('connected_accounts')
    .where('provider', '==', provider)
    .where('providerWorkspaceId', '==', providerWorkspaceId)
    .get();
  if (accountsSnap.empty) {
    logger.warn('webhook-lookup', `No connected_accounts found for ${provider} workspace "${providerWorkspaceId}"`);
    return [];
  }
  const connectionIds = accountsSnap.docs.map(d => d.id);

  // Firestore can't OR across two different fields in one query — same
  // constraint sync-configs.js's connectionId filter already works around
  // (two queries, merged by doc path).
  const configsRef = db.collectionGroup('sync_configs');
  const snaps = await Promise.all(connectionIds.flatMap(connectionId => [
    configsRef.where('platform1ConnectionId', '==', connectionId).get(),
    configsRef.where('platform2ConnectionId', '==', connectionId).get(),
  ]));

  const byPath = new Map();
  for (const snap of snaps) {
    for (const doc of snap.docs) byPath.set(doc.ref.path, doc);
  }

  const matches = [];
  for (const doc of byPath.values()) {
    const config = doc.data();
    const matchesEntity =
      (connectionIds.includes(config.platform1ConnectionId) && config.p1Settings?.database === entityId) ||
      (connectionIds.includes(config.platform2ConnectionId) && config.p2Settings?.database === entityId);
    if (!matchesEntity) continue;
    matches.push({ configId: doc.id, workspaceId: doc.ref.parent.parent?.id, config });
  }

  if (matches.length === 0) {
    logger.warn('webhook-lookup', `No sync_config references ${provider} entity "${entityId}" in workspace "${providerWorkspaceId}"`);
  }
  return matches;
}

module.exports = { resolveConfigsForWebhookEvent };

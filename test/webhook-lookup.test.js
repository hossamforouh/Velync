/**
 * Webhook reverse-lookup — Stage 2 (WEBHOOK_SYNC_PLAN.md §5).
 *
 * Verifies resolveConfigsForWebhookEvent() against the Firestore emulator:
 * providerWorkspaceId + entityId -> the sync_config(s) whose Notion-side
 * settings actually reference that database.
 *
 * Run:  npm run test:webhook-lookup
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert');

const db = require('../src/core/db');
const { resolveConfigsForWebhookEvent } = require('../src/domains/sync/webhookLookup');

function account(id, data) {
  return db.collection('connected_accounts').doc(id).set(data);
}

function cfg(workspaceId, configId, data) {
  return db.collection('workspaces').doc(workspaceId).collection('sync_configs').doc(configId).set(data);
}

before(async () => {
  // Two Notion connections in two different Velync workspaces, pointing at
  // the same real Notion workspace ("notion-ws-1") — plausible if two
  // separate Velync users both authorized the integration in that Notion
  // workspace.
  await account('conn-1', { provider: 'notion', providerWorkspaceId: 'notion-ws-1', userId: 'u1', workspaceId: 'wsA' });
  await account('conn-2', { provider: 'notion', providerWorkspaceId: 'notion-ws-1', userId: 'u2', workspaceId: 'wsB' });
  // A connection in an unrelated Notion workspace — must never match.
  await account('conn-3', { provider: 'notion', providerWorkspaceId: 'notion-ws-2', userId: 'u3', workspaceId: 'wsC' });
  // A non-Notion connection sharing conn-1's providerWorkspaceId string
  // coincidentally — must never match since provider differs.
  await account('conn-4', { provider: 'ticktick', providerWorkspaceId: 'notion-ws-1', userId: 'u4', workspaceId: 'wsD' });

  // wsA: conn-1 is the source (platform1), watching database "db-target".
  await cfg('wsA', 'config-match-p1', {
    platform1: 'notion', platform1ConnectionId: 'conn-1', p1Settings: { database: 'db-target' },
    platform2: 'ticktick', platform2ConnectionId: 'other-conn', p2Settings: {},
  });
  // wsA: a second config reusing conn-1 but watching a DIFFERENT database —
  // must NOT match an event for "db-target".
  await cfg('wsA', 'config-other-db', {
    platform1: 'notion', platform1ConnectionId: 'conn-1', p1Settings: { database: 'db-other' },
    platform2: 'ticktick', platform2ConnectionId: 'other-conn', p2Settings: {},
  });
  // wsB: conn-2 is the destination (platform2), watching the same "db-target"
  // id (coincidentally, in a different Velync workspace) — fan-out case.
  await cfg('wsB', 'config-match-p2', {
    platform1: 'ticktick', platform1ConnectionId: 'other-conn-2', p1Settings: {},
    platform2: 'notion', platform2ConnectionId: 'conn-2', p2Settings: { database: 'db-target' },
  });
  // wsC: unrelated Notion workspace's config — must never appear.
  await cfg('wsC', 'config-unrelated', {
    platform1: 'notion', platform1ConnectionId: 'conn-3', p1Settings: { database: 'db-target' },
    platform2: 'ticktick', platform2ConnectionId: 'other-conn-3', p2Settings: {},
  });
});

describe('resolveConfigsForWebhookEvent', () => {
  it('fans out to every matching config across workspaces (two-hop, connection reused for a different db excluded)', async () => {
    const matches = await resolveConfigsForWebhookEvent('notion', 'notion-ws-1', 'db-target');
    const ids = matches.map(m => m.configId).sort();
    assert.deepStrictEqual(ids, ['config-match-p1', 'config-match-p2']);
  });

  it('includes the correct workspaceId per match', async () => {
    const matches = await resolveConfigsForWebhookEvent('notion', 'notion-ws-1', 'db-target');
    const byId = Object.fromEntries(matches.map(m => [m.configId, m.workspaceId]));
    assert.strictEqual(byId['config-match-p1'], 'wsA');
    assert.strictEqual(byId['config-match-p2'], 'wsB');
  });

  it('excludes a config whose matching connection watches a different database', async () => {
    const matches = await resolveConfigsForWebhookEvent('notion', 'notion-ws-1', 'db-target');
    assert.ok(!matches.some(m => m.configId === 'config-other-db'));
  });

  it('excludes configs from an unrelated provider workspace', async () => {
    const matches = await resolveConfigsForWebhookEvent('notion', 'notion-ws-1', 'db-target');
    assert.ok(!matches.some(m => m.configId === 'config-unrelated'));
  });

  it('returns empty for an unknown providerWorkspaceId', async () => {
    const matches = await resolveConfigsForWebhookEvent('notion', 'notion-ws-nonexistent', 'db-target');
    assert.deepStrictEqual(matches, []);
  });

  it('returns empty for a known workspace but unmatched entityId', async () => {
    const matches = await resolveConfigsForWebhookEvent('notion', 'notion-ws-1', 'db-nonexistent');
    assert.deepStrictEqual(matches, []);
  });

  it('never matches a same-string providerWorkspaceId across a different provider', async () => {
    const matches = await resolveConfigsForWebhookEvent('ticktick', 'notion-ws-1', 'db-target');
    assert.deepStrictEqual(matches, []);
  });

  it('returns empty when any argument is missing', async () => {
    assert.deepStrictEqual(await resolveConfigsForWebhookEvent(null, 'notion-ws-1', 'db-target'), []);
    assert.deepStrictEqual(await resolveConfigsForWebhookEvent('notion', null, 'db-target'), []);
    assert.deepStrictEqual(await resolveConfigsForWebhookEvent('notion', 'notion-ws-1', null), []);
  });
});

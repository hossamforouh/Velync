/**
 * New/Edit Config (sync-configs) route fixes — regression tests.
 *
 * Covers the fixes from the "New/Edit Config" audit:
 *  1. Cron min-interval enforcement now fails closed (cron-parser based,
 *     rejects any schedule it can't parse, instead of silently skipping
 *     enforcement for anything that doesn't match a hand-rolled regex).
 *  2. PUT /sync-configs/:id accepts status:'paused' (used by the frontend's
 *     pause/resume toggle, which previously bypassed the backend entirely).
 *  3. PUT re-pins workspaceId/ownerId instead of trusting the merged body.
 *  4. POST /sync-configs/:id/restore (undo-delete) works and re-pins fields.
 *  5. enforceTotalConfigCap blocks creation once a workspace hits the cap.
 *
 * Run:  npm run test:sync-configs-fixes
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

const TEST_UID = 'sync-cfg-test-user';
const WORKSPACE_ID = 'sync-cfg-test-ws';

let currentUid = TEST_UID;

const authPath = require.resolve('../src/api/middleware/auth');
require.cache[authPath] = {
  id: authPath,
  filename: authPath,
  loaded: true,
  exports: {
    verifyAuth: (req, res, next) => {
      req.user = { uid: currentUid, email: `${currentUid}@synccfgtest.com` };
      next();
    },
  },
};

const db = require('../src/core/db');
const { createApp } = require('../src/api/server');
const { enforceTotalConfigCap, cronToMinutes } = require('../src/core/plan');

let server;
let baseUrl;

before(async () => {
  await db.collection('users').doc(TEST_UID).set({ workspaceId: WORKSPACE_ID });
  await db.collection('workspaces').doc(WORKSPACE_ID).set({ planId: 'pro', ownerId: TEST_UID, members: [] });
  await db.collection('plans').doc('pro').set({
    name: 'Pro', maxActiveConfigs: 10, minSyncIntervalMinutes: 5, connectorTiers: ['basic', 'standard'],
  });

  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function apiFetch(path, options = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer fake', ...(options.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

describe('cron min-interval enforcement (fail closed)', () => {
  it('parses standard shorthand cron patterns correctly', () => {
    assert.strictEqual(cronToMinutes('*/5 * * * *'), 5);
    assert.strictEqual(cronToMinutes('0 */2 * * *'), 120);
  });

  it('correctly computes an interval for a pattern the old regex-based check missed', () => {
    // "* * * * *" (every minute) didn't match either legacy regex and used
    // to return null, silently skipping enforcement entirely.
    assert.strictEqual(cronToMinutes('* * * * *'), 1);
  });

  it('rejects a config whose cron cannot be parsed at all, instead of skipping the check', async () => {
    const { status, body } = await apiFetch('/api/sync-configs', {
      method: 'POST',
      body: JSON.stringify({
        platform1: 'notion', platform2: 'ticktick',
        platform1ConnectionId: 'c1', platform2ConnectionId: 'c2',
        status: 'active', cronSchedule: 'not a real cron',
      }),
    });
    assert.strictEqual(status, 403);
    assert.match(body.error, /not a valid cron/);
  });

  it('rejects an every-minute schedule that violates the plan minimum, even though it is valid cron syntax', async () => {
    const { status, body } = await apiFetch('/api/sync-configs', {
      method: 'POST',
      body: JSON.stringify({
        platform1: 'notion', platform2: 'ticktick',
        platform1ConnectionId: 'c1', platform2ConnectionId: 'c2',
        status: 'active', cronSchedule: '* * * * *',
      }),
    });
    assert.strictEqual(status, 403);
    assert.match(body.error, /minimum sync interval/);
  });
});

describe('POST/PUT/DELETE/run/restore /api/sync-configs', () => {
  let configId;

  it('creates a config', async () => {
    const { status, body } = await apiFetch('/api/sync-configs', {
      method: 'POST',
      body: JSON.stringify({
        description: 'Test Config', platform1: 'notion', platform2: 'ticktick',
        platform1ConnectionId: 'c1', platform2ConnectionId: 'c2', status: 'draft',
      }),
    });
    assert.strictEqual(status, 201);
    configId = body.id;
  });

  it('accepts status:"paused" on PUT (used by the pause/resume toggle)', async () => {
    const { status } = await apiFetch(`/api/sync-configs/${configId}`, {
      method: 'PUT',
      body: JSON.stringify({ status: 'paused' }),
    });
    assert.strictEqual(status, 200);
    const doc = await db.collection('workspaces').doc(WORKSPACE_ID).collection('sync_configs').doc(configId).get();
    assert.strictEqual(doc.data().status, 'paused');
  });

  it('re-pins workspaceId/ownerId on PUT even if the client sends different values', async () => {
    const { status } = await apiFetch(`/api/sync-configs/${configId}`, {
      method: 'PUT',
      body: JSON.stringify({ description: 'Renamed', workspaceId: 'attacker-ws', ownerId: 'attacker-uid' }),
    });
    assert.strictEqual(status, 200);
    const doc = await db.collection('workspaces').doc(WORKSPACE_ID).collection('sync_configs').doc(configId).get();
    assert.strictEqual(doc.data().workspaceId, WORKSPACE_ID);
    assert.strictEqual(doc.data().ownerId, TEST_UID);
    assert.strictEqual(doc.data().description, 'Renamed');
  });

  it('deletes the config and returns it via the run of DELETE, then restores it via the new restore route', async () => {
    const beforeDelete = await db.collection('workspaces').doc(WORKSPACE_ID).collection('sync_configs').doc(configId).get();
    const deletedData = { id: configId, ...beforeDelete.data() };

    const del = await apiFetch(`/api/sync-configs/${configId}`, { method: 'DELETE' });
    assert.strictEqual(del.status, 200);
    const gone = await db.collection('workspaces').doc(WORKSPACE_ID).collection('sync_configs').doc(configId).get();
    assert.strictEqual(gone.exists, false);

    const { id, ...restoreData } = deletedData;
    const restore = await apiFetch(`/api/sync-configs/${configId}/restore`, {
      method: 'POST',
      body: JSON.stringify(restoreData),
    });
    assert.strictEqual(restore.status, 200);
    const restored = await db.collection('workspaces').doc(WORKSPACE_ID).collection('sync_configs').doc(configId).get();
    assert.strictEqual(restored.data().description, 'Renamed');
    assert.strictEqual(restored.data().workspaceId, WORKSPACE_ID);
  });

  it('/run 404s for a config in another workspace (scoped correctly)', async () => {
    await db.collection('workspaces').doc('other-ws').set({ ownerId: 'someone-else', members: [] });
    await db.collection('workspaces').doc('other-ws').collection('sync_configs').doc('other-cfg').set({
      workspaceId: 'other-ws', platform1: 'notion', platform2: 'ticktick',
    });
    const { status } = await apiFetch('/api/sync-configs/other-cfg/run', { method: 'POST' });
    assert.strictEqual(status, 404);
  });
});

describe('enforceTotalConfigCap', () => {
  it('blocks new config creation once the workspace hits the cap', async () => {
    const capWs = 'sync-cfg-cap-ws';
    await db.collection('users').doc('cap-user').set({ workspaceId: capWs });
    await db.collection('workspaces').doc(capWs).set({ planId: 'pro', ownerId: 'cap-user', members: [] });

    // Seed exactly the cap via Admin SDK directly (cheaper than 200 API round-trips).
    const batchSize = 20;
    for (let i = 0; i < 200; i += batchSize) {
      const batch = db.batch();
      for (let j = i; j < i + batchSize; j++) {
        batch.set(db.collection('workspaces').doc(capWs).collection('sync_configs').doc(`seed-${j}`), {
          workspaceId: capWs, status: 'draft', platform1: 'notion', platform2: 'ticktick',
        });
      }
      await batch.commit();
    }

    await assert.rejects(
      () => enforceTotalConfigCap(capWs),
      /maximum of 200 sync configs/
    );
  });
});

describe('GET /sync-configs (list) and GET /sync-configs/:id (single)', () => {
  const OTHER_UID = 'sync-cfg-other-user';
  const OTHER_WS = 'sync-cfg-other-ws';

  before(async () => {
    await db.collection('users').doc(OTHER_UID).set({ workspaceId: OTHER_WS });
    await db.collection('workspaces').doc(OTHER_WS).set({ planId: 'free', ownerId: OTHER_UID, members: [] });
    await db.collection('plans').doc('free').set({ name: 'Free', maxActiveConfigs: 1, minSyncIntervalMinutes: 60, connectorTiers: ['basic'] });
  });

  after(() => { currentUid = TEST_UID; });

  it('list returns an empty array for a workspace with no configs', async () => {
    currentUid = OTHER_UID;
    const { status, body } = await apiFetch('/api/sync-configs');
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body.items, []);
  });

  it('list returns configs belonging to the caller\'s own workspace only (cross-workspace isolation)', async () => {
    currentUid = TEST_UID;
    const created = await apiFetch('/api/sync-configs', {
      method: 'POST',
      body: JSON.stringify({ platform1: 'notion', platform2: 'ticktick', platform1ConnectionId: 'c1', platform2ConnectionId: 'c2', status: 'draft' }),
    });
    assert.strictEqual(created.status, 201);

    const mine = await apiFetch('/api/sync-configs');
    assert.strictEqual(mine.status, 200);
    assert.ok(mine.body.items.some(c => c.id === created.body.id));

    currentUid = OTHER_UID;
    const theirs = await apiFetch('/api/sync-configs');
    assert.strictEqual(theirs.status, 200);
    assert.ok(!theirs.body.items.some(c => c.id === created.body.id), "other workspace's list must not include this config");
  });

  it('list supports ?status= filtering (matches hub.js\'s existing active-only query)', async () => {
    currentUid = TEST_UID;
    const draft = await apiFetch('/api/sync-configs', {
      method: 'POST',
      body: JSON.stringify({ platform1: 'notion', platform2: 'ticktick', platform1ConnectionId: 'c1', platform2ConnectionId: 'c2', status: 'draft' }),
    });
    const { status, body } = await apiFetch('/api/sync-configs?status=draft');
    assert.strictEqual(status, 200);
    assert.ok(body.items.every(c => c.status === 'draft'));
    assert.ok(body.items.some(c => c.id === draft.body.id));
  });

  it('list rejects an invalid ?status= value', async () => {
    currentUid = TEST_UID;
    const { status, body } = await apiFetch('/api/sync-configs?status=bogus');
    assert.strictEqual(status, 400);
    assert.ok(body.error);
  });

  it('single fetch returns the config for its own workspace', async () => {
    currentUid = TEST_UID;
    const created = await apiFetch('/api/sync-configs', {
      method: 'POST',
      body: JSON.stringify({ platform1: 'notion', platform2: 'ticktick', platform1ConnectionId: 'c1', platform2ConnectionId: 'c2', status: 'draft' }),
    });
    const { status, body } = await apiFetch(`/api/sync-configs/${created.body.id}`);
    assert.strictEqual(status, 200);
    assert.strictEqual(body.item.id, created.body.id);
    assert.strictEqual(body.item.workspaceId, WORKSPACE_ID);
  });

  it('single fetch 404s for a config belonging to a different workspace', async () => {
    currentUid = TEST_UID;
    const created = await apiFetch('/api/sync-configs', {
      method: 'POST',
      body: JSON.stringify({ platform1: 'notion', platform2: 'ticktick', platform1ConnectionId: 'c1', platform2ConnectionId: 'c2', status: 'draft' }),
    });
    currentUid = OTHER_UID;
    const { status } = await apiFetch(`/api/sync-configs/${created.body.id}`);
    assert.strictEqual(status, 404);
  });

  it('single fetch 404s for a nonexistent config id', async () => {
    currentUid = TEST_UID;
    const { status } = await apiFetch('/api/sync-configs/does-not-exist');
    assert.strictEqual(status, 404);
  });
});

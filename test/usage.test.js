/**
 * Per-user usage/cost tracking — end-to-end tests against the Firestore emulator.
 *
 * Covers, with REAL Firestore documents (no mocked db):
 *  1. logUsageEvent writes a usage_events doc AND atomically increments the
 *     monthly usage_summaries doc; estimated $ math = count × configured rate.
 *  2. Concurrent writes (parallel events AND parallel real runSync executions)
 *     produce accurate summary totals — no lost updates.
 *  3. A real sync execution through runSync() (fake in-memory connectors, real
 *     engine + real Firestore) records sync_execution / compute_estimate /
 *     api_call / firestore_read / firestore_write with sane units.
 *  4. Every usage-intensity action fires through its real HTTP route:
 *     user_login + workspace_created (POST /api/usage/event), flow_created
 *     (POST /api/sync-configs), field_mapping_changed (PUT /api/sync-configs/:id),
 *     member_invited (POST /api/workspace/invite), platform_connected
 *     (POST /api/oauth/exchange against a local fake OAuth token server).
 *  5. Admin-triggered actions are recorded (tagged actor:'admin') but excluded
 *     from user summaries.
 *  6. Failed usage writes surface in usage_meta/write_failures (never silent).
 *  7. Admin endpoints return JSON matching the Firestore docs; CSV export rows
 *     match the summaries exactly.
 *
 * Run:  npm run test:usage
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const OWNER_UID = 'usage-owner-uid';
const ADMIN_UID = 'usage-admin-uid';
const WORKSPACE_ID = 'usage-owner-ws';

let currentUid = OWNER_UID;

// Stub only the auth middleware (before anything requires server.js).
const authPath = require.resolve('../src/api/middleware/auth');
require.cache[authPath] = {
  id: authPath,
  filename: authPath,
  loaded: true,
  exports: {
    verifyAuth: (req, res, next) => {
      req.user = { uid: currentUid, email: `${currentUid}@usagetest.com` };
      next();
    },
  },
};

const db = require('../src/core/db');
const { createApp } = require('../src/api/server');
const { logUsageEvent, getUsageRates, yearMonthOf, DEFAULT_RATES } = require('../src/domains/usage');
const { Connector } = require('../src/domains/connector/interface');
const { register } = require('../src/domains/connector/registry');
const { runSync } = require('../src/domains/sync/engine');
const { cleanupUsageEvents } = require('../src/domains/sync/log-cleanup');

const MONTH = yearMonthOf();

let server;
let baseUrl;
let tokenServer; // fake OAuth token endpoint for the /oauth/exchange test

// ── Fake connectors (same pattern as engine.test.js) ─────────────────────────
const stores = {};
function makeStore(key, items = []) {
  stores[key] = { items: items.map(i => ({ ...i })), created: [], updated: [], deleted: [] };
  return stores[key];
}
class FakeConnector extends Connector {
  constructor(creds) {
    super(creds);
    this.store = stores[creds.storeKey];
    if (!this.store) throw new Error(`No fake store for key "${creds.storeKey}"`);
  }
  async fetch() { return this.store.items.map(i => ({ ...i })); }
  async fetchIds() { return this.store.items.map(i => ({ id: i.id })); }
  getSchema() { return {}; }
  async create(entityType, data) {
    const id = `new_${this.store.created.length + 1}_${Math.random().toString(36).slice(2, 6)}`;
    const item = { id, title: data.title, modifiedTime: new Date().toISOString() };
    this.store.items.push(item);
    this.store.created.push({ id, data });
    return { id, last_edited_time: item.modifiedTime, modifiedTime: item.modifiedTime };
  }
  async update(entityType, id) { this.store.updated.push(id); return { id }; }
  async retrieve() { return { last_edited_time: new Date().toISOString() }; }
  async delete(entityType, id) {
    this.store.deleted.push(id);
    this.store.items = this.store.items.filter(i => i.id !== id);
    return true;
  }
}

async function summaryDoc(uid) {
  const d = await db.collection('usage_summaries').doc(`${uid}_${MONTH}`).get();
  return d.exists ? d.data() : null;
}
async function wsSummaryDoc(workspaceId) {
  const d = await db.collection('usage_workspace_summaries').doc(`${workspaceId}_${MONTH}`).get();
  return d.exists ? d.data() : null;
}
async function eventsFor(uid, activityType) {
  let q = db.collection('usage_events').where('userId', '==', uid);
  if (activityType) q = q.where('activityType', '==', activityType);
  return (await q.get()).docs.map(d => d.data());
}
async function apiFetch(path, options = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer fake', ...(options.headers || {}) },
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, headers: res.headers };
}

before(async () => {
  register('usagesrc', FakeConnector);
  register('usagedst', FakeConnector);

  await db.collection('users').doc(OWNER_UID).set({ workspaceId: WORKSPACE_ID, email: `${OWNER_UID}@usagetest.com`, name: 'Usage Owner' });
  await db.collection('users').doc(ADMIN_UID).set({ email: `${ADMIN_UID}@usagetest.com` });
  await db.collection('workspaces').doc(WORKSPACE_ID).set({
    ownerId: OWNER_UID, members: [OWNER_UID], invitedEmails: [], planId: 'free', name: 'Usage WS',
  });
  // Real workspace doc for the sync-execution test's workspaceId, so
  // GET /api/admin/workspaces (which lists actual `workspaces` docs) can
  // find it and attach its usage_workspace_summaries-derived cost.
  await db.collection('workspaces').doc('usage-sync-ws-1').set({
    ownerId: 'usage-sync-owner', members: ['usage-sync-owner'], invitedEmails: [], planId: 'free', name: 'Usage Sync WS 1',
  });
  await db.collection('plans').doc('free').set({
    name: 'Free', isActive: true, maxActiveConfigs: 10, connectorTiers: ['basic'],
  });
  await db.collection('superadmins').doc(ADMIN_UID).set({ addedAt: new Date().toISOString() });

  // Local fake OAuth token endpoint so /api/oauth/exchange runs end-to-end.
  tokenServer = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ access_token: 'fake-access-token', refresh_token: 'fake-refresh', expires_in: 3600 }));
  });
  await new Promise(resolve => tokenServer.listen(0, '127.0.0.1', resolve));
  const tokenUrl = `http://127.0.0.1:${tokenServer.address().port}/token`;
  await db.collection('platforms').doc('usageplat').set({
    name: 'Usage Platform', tier: 'basic', clientId: 'client-id', tokenUrl,
  });
  await db.collection('platform_secrets').doc('usageplat').set({ clientSecret: 'client-secret' });

  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef';

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
  await new Promise((resolve) => tokenServer.close(resolve));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('logUsageEvent — event doc + atomic summary increments', () => {
  const UID = 'usage-basic-uid';

  it('writes the event and increments count, costUsd, and grand total (count × rate)', async () => {
    await logUsageEvent(UID, 'ws-x', 'firestore_write', { units: 100 });
    await logUsageEvent(UID, 'ws-x', 'firestore_write', { units: 50 });

    const events = await eventsFor(UID, 'firestore_write');
    assert.strictEqual(events.length, 2);
    assert.strictEqual(events[0].workspaceId, 'ws-x');
    assert.ok(events.every(e => e.timestamp && e.actor === 'user'));

    const rates = await getUsageRates();
    assert.strictEqual(rates.costPerWrite, DEFAULT_RATES.costPerWrite);

    const summary = await summaryDoc(UID);
    assert.ok(summary, 'summary doc exists');
    assert.strictEqual(summary.yearMonth, MONTH);
    assert.strictEqual(summary.totals.firestore_write.count, 150);
    // Estimated $ math: 150 writes × $0.0000018 = $0.00027
    assert.ok(Math.abs(summary.totals.firestore_write.costUsd - 150 * rates.costPerWrite) < 1e-12,
      `costUsd ${summary.totals.firestore_write.costUsd} != 150 × ${rates.costPerWrite}`);
    assert.ok(Math.abs(summary.grandTotalCostUsd - 150 * rates.costPerWrite) < 1e-12);
  });

  it('intensity events count but carry no cost (costUsd null on event, absent in summary)', async () => {
    await logUsageEvent(UID, 'ws-x', 'user_login');
    const events = await eventsFor(UID, 'user_login');
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].estimatedCostUsd, null);

    const summary = await summaryDoc(UID);
    assert.strictEqual(summary.totals.user_login.count, 1);
    assert.strictEqual(summary.totals.user_login.costUsd, undefined, 'no costUsd field for intensity types');
    // Grand total untouched by the login
    const rates = await getUsageRates();
    assert.ok(Math.abs(summary.grandTotalCostUsd - 150 * rates.costPerWrite) < 1e-12);
  });

  it('concurrent events do not lose updates (30 parallel increments)', async () => {
    const UID2 = 'usage-concurrent-uid';
    await Promise.all(Array.from({ length: 30 }, () =>
      logUsageEvent(UID2, 'ws-x', 'api_call', { connectorType: 'notion', units: 1 })));

    const summary = await summaryDoc(UID2);
    assert.strictEqual(summary.totals.api_call.count, 30, 'all 30 concurrent increments landed');
    const rates = await getUsageRates();
    assert.ok(Math.abs(summary.totals.api_call.costUsd - 30 * rates.costPerApiCall) < 1e-12);
  });

  it('admin-triggered events are recorded but excluded from the user AND workspace summaries', async () => {
    const UID3 = 'usage-adminexcl-uid';
    const WS3 = 'ws-adminexcl-only'; // dedicated workspace so no other test's activity pollutes this assertion
    await logUsageEvent(UID3, WS3, 'member_invited', { actor: 'admin' });

    const events = await eventsFor(UID3, 'member_invited');
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].actor, 'admin');
    assert.strictEqual(await summaryDoc(UID3), null, 'no summary doc created for admin-attributed action');
    assert.strictEqual(await wsSummaryDoc(WS3), null, 'admin actions excluded from the workspace rollup too');
  });

  it('a failed write surfaces in usage_meta/write_failures (never silent)', async () => {
    const beforeDoc = await db.collection('usage_meta').doc('write_failures').get();
    const beforeCount = beforeDoc.exists ? beforeDoc.data().count : 0;

    await logUsageEvent('some-uid', 'ws-x', 'not_a_real_activity_type');

    const afterDoc = await db.collection('usage_meta').doc('write_failures').get();
    assert.ok(afterDoc.exists, 'failure marker doc exists');
    assert.strictEqual(afterDoc.data().count, beforeCount + 1);
    assert.strictEqual(afterDoc.data().lastActivityType, 'not_a_real_activity_type');
    assert.ok(afterDoc.data().lastError.includes('Unknown activityType'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('per-workspace usage rollup (usage_workspace_summaries)', () => {
  it('sums multiple users\' activity into one workspace summary', async () => {
    const WS = 'ws-rollup-test';
    await logUsageEvent('rollup-user-a', WS, 'firestore_write', { units: 10 });
    await logUsageEvent('rollup-user-b', WS, 'firestore_write', { units: 5 });

    const [summaryA, summaryB, wsSummary] = await Promise.all([
      summaryDoc('rollup-user-a'), summaryDoc('rollup-user-b'), wsSummaryDoc(WS),
    ]);
    assert.strictEqual(summaryA.totals.firestore_write.count, 10, "user A's own summary unaffected by user B");
    assert.strictEqual(summaryB.totals.firestore_write.count, 5);
    assert.strictEqual(wsSummary.totals.firestore_write.count, 15, 'workspace summary sums both members');
    const rates = await getUsageRates();
    assert.ok(Math.abs(wsSummary.grandTotalCostUsd - 15 * rates.costPerWrite) < 1e-12);
  });

  it('concurrent events from different users in the same workspace do not lose updates', async () => {
    const WS = 'ws-rollup-concurrent';
    await Promise.all([
      ...Array.from({ length: 15 }, () => logUsageEvent('rollup-c-user1', WS, 'api_call', { connectorType: 'notion' })),
      ...Array.from({ length: 15 }, () => logUsageEvent('rollup-c-user2', WS, 'api_call', { connectorType: 'notion' })),
    ]);
    const wsSummary = await wsSummaryDoc(WS);
    assert.strictEqual(wsSummary.totals.api_call.count, 30, 'all 30 concurrent increments across 2 users landed');
  });

  it('an event with no workspaceId does not create a workspace summary doc', async () => {
    await logUsageEvent('rollup-no-ws-user', null, 'user_login');
    const userSummary = await summaryDoc('rollup-no-ws-user');
    assert.strictEqual(userSummary.totals.user_login.count, 1, 'the user summary itself is still created');
    const events = await eventsFor('rollup-no-ws-user', 'user_login');
    assert.strictEqual(events[0].workspaceId, null);
    assert.strictEqual(await wsSummaryDoc('null'), null, 'no workspace summary doc for a null workspaceId');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('real sync execution records cost-driving usage', () => {
  const SYNC_UID = 'usage-sync-owner';

  function syncConfig(workspaceId, configId) {
    return {
      workspaceId,
      ownerId: SYNC_UID,
      platform1: 'usagesrc', platform2: 'usagedst',
      p1Settings: { storeKey: `${configId}_src`, targetEntity: 'Tasks' },
      p2Settings: { storeKey: `${configId}_dst` },
      syncType: 'Source_to_Dest',
      fieldMappings: [],
    };
  }

  it('one run → sync_execution + compute_estimate + api_call + firestore events, summary incremented', async () => {
    const configId = 'usage-cfg-1';
    makeStore(`${configId}_src`, [{ id: 's1', title: 'Alpha', modifiedTime: new Date().toISOString() }]);
    makeStore(`${configId}_dst`, []);

    const res = await runSync(syncConfig('usage-sync-ws-1', configId), configId);
    assert.strictEqual(res.synced, 1);

    const summary = await summaryDoc(SYNC_UID);
    assert.ok(summary, 'summary doc created by the sync run');
    assert.strictEqual(summary.totals.sync_execution.count, 1);
    assert.ok(summary.totals.compute_estimate.count > 0, 'measured duration ms recorded');
    // fetch + fetchIds on source, fetch + fetchIds + create on dest = 5 contract calls
    assert.strictEqual(summary.totals.api_call.count, 5);
    assert.ok(summary.totals.firestore_read.count >= 2, 'config + mapping reads counted');
    assert.ok(summary.totals.firestore_write.count >= 3, 'log writes + mapping write + config update counted');
    assert.ok(summary.grandTotalCostUsd > 0);

    // api_call events preserve per-connector granularity
    const apiEvents = await eventsFor(SYNC_UID, 'api_call');
    const byConnector = Object.fromEntries(apiEvents.map(e => [e.connectorType, e.units]));
    assert.strictEqual(byConnector.usagesrc, 2, 'source: fetch + fetchIds');
    assert.strictEqual(byConnector.usagedst, 3, 'dest: fetch + fetchIds + create');

    // A real sync run also rolls up into that workspace's aggregate, not just the user's.
    const wsSummary = await wsSummaryDoc('usage-sync-ws-1');
    assert.strictEqual(wsSummary.totals.sync_execution.count, 1);
    assert.strictEqual(wsSummary.grandTotalCostUsd, summary.grandTotalCostUsd, 'sole member — workspace total matches user total');
  });

  it('three concurrent runs for the same user → summary totals exact (no lost updates)', async () => {
    const beforeSummary = await summaryDoc(SYNC_UID);
    const beforeExec = beforeSummary.totals.sync_execution.count;

    const runs = ['usage-cfg-c1', 'usage-cfg-c2', 'usage-cfg-c3'].map((configId, i) => {
      makeStore(`${configId}_src`, [{ id: `s${i}`, title: `Item ${i}`, modifiedTime: new Date().toISOString() }]);
      makeStore(`${configId}_dst`, []);
      return runSync(syncConfig(`usage-sync-ws-c${i}`, configId), configId);
    });
    const results = await Promise.all(runs);
    assert.ok(results.every(r => r.synced === 1), 'all three runs synced');

    const summary = await summaryDoc(SYNC_UID);
    assert.strictEqual(summary.totals.sync_execution.count, beforeExec + 3,
      'exactly 3 more sync_executions — concurrent increments all landed');
    // Each run makes the same 5 contract calls
    const apiEvents = await eventsFor(SYNC_UID, 'api_call');
    const totalApiUnits = apiEvents.reduce((s, e) => s + e.units, 0);
    assert.strictEqual(summary.totals.api_call.count, totalApiUnits, 'summary matches sum of event units');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('usage-intensity actions through their real HTTP routes', () => {
  it('POST /api/usage/event records user_login and workspace_created for the token uid', async () => {
    currentUid = OWNER_UID;
    for (const activityType of ['user_login', 'workspace_created']) {
      const { status } = await apiFetch('/api/usage/event', {
        method: 'POST', body: JSON.stringify({ activityType }),
      });
      assert.strictEqual(status, 204);
    }
    const summary = await summaryDoc(OWNER_UID);
    assert.strictEqual(summary.totals.user_login.count, 1);
    assert.strictEqual(summary.totals.workspace_created.count, 1);
    const loginEvents = await eventsFor(OWNER_UID, 'user_login');
    assert.strictEqual(loginEvents[0].workspaceId, WORKSPACE_ID, 'workspace derived server-side from users doc');
  });

  it('POST /api/usage/event rejects non-whitelisted (cost-driving) types from clients', async () => {
    currentUid = OWNER_UID;
    const { status } = await apiFetch('/api/usage/event', {
      method: 'POST', body: JSON.stringify({ activityType: 'firestore_write' }),
    });
    assert.strictEqual(status, 400, 'clients must not self-report cost-driving events');
  });

  it('POST /api/sync-configs records flow_created; PUT with changed mappings records field_mapping_changed', async () => {
    currentUid = OWNER_UID;
    const create = await apiFetch('/api/sync-configs', {
      method: 'POST',
      body: JSON.stringify({
        description: 'Usage test flow',
        platform1: 'usagesrc', platform2: 'usagedst',
        platform1ConnectionId: 'conn-a', platform2ConnectionId: 'conn-b',
        status: 'draft',
        fieldMappings: [{ source: 'title', dest: 'Name' }],
      }),
    });
    assert.strictEqual(create.status, 201);

    // Unchanged mappings → no field_mapping_changed
    const putSame = await apiFetch(`/api/sync-configs/${create.body.id}`, {
      method: 'PUT',
      body: JSON.stringify({ fieldMappings: [{ source: 'title', dest: 'Name' }] }),
    });
    assert.strictEqual(putSame.status, 200);

    // Changed mappings → field_mapping_changed
    const putChanged = await apiFetch(`/api/sync-configs/${create.body.id}`, {
      method: 'PUT',
      body: JSON.stringify({ fieldMappings: [{ source: 'title', dest: 'Title' }] }),
    });
    assert.strictEqual(putChanged.status, 200);

    const summary = await summaryDoc(OWNER_UID);
    assert.strictEqual(summary.totals.flow_created.count, 1);
    assert.strictEqual(summary.totals.field_mapping_changed.count, 1, 'only the actually-changed PUT counted');
  });

  it('POST /api/workspace/invite records member_invited for a member inviter', async () => {
    currentUid = OWNER_UID;
    const { status } = await apiFetch('/api/workspace/invite', {
      method: 'POST',
      body: JSON.stringify({ email: 'invitee@usagetest.com', workspaceId: WORKSPACE_ID }),
    });
    assert.strictEqual(status, 200);
    const summary = await summaryDoc(OWNER_UID);
    assert.strictEqual(summary.totals.member_invited.count, 1);
  });

  it('a superadmin (non-member) inviting is tagged admin and NOT added to any summary', async () => {
    currentUid = ADMIN_UID;
    const { status } = await apiFetch('/api/workspace/invite', {
      method: 'POST',
      body: JSON.stringify({ email: 'invitee2@usagetest.com', workspaceId: WORKSPACE_ID }),
    });
    assert.strictEqual(status, 200);

    const events = await eventsFor(ADMIN_UID, 'member_invited');
    assert.strictEqual(events.length, 1, 'admin action still auditable in usage_events');
    assert.strictEqual(events[0].actor, 'admin');
    assert.strictEqual(await summaryDoc(ADMIN_UID), null, 'admin panel actions never hit a cost summary');

    const ownerSummary = await summaryDoc(OWNER_UID);
    assert.strictEqual(ownerSummary.totals.member_invited.count, 1, "owner's totals untouched by the admin's action");
  });

  it('POST /api/oauth/exchange (real route, local token server) records platform_connected', async () => {
    currentUid = OWNER_UID;
    // authRoutes is mounted at the app root (no /api prefix) — see server.js
    const { status, body } = await apiFetch('/oauth/exchange', {
      method: 'POST',
      body: JSON.stringify({ code: 'fake-code', platformId: 'usageplat', redirectUri: 'https://velync.web.app/cb' }),
    });
    assert.strictEqual(status, 200, JSON.stringify(body));

    const summary = await summaryDoc(OWNER_UID);
    assert.strictEqual(summary.totals.platform_connected.count, 1);
    const events = await eventsFor(OWNER_UID, 'platform_connected');
    assert.strictEqual(events[0].connectorType, 'usageplat');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('admin usage endpoints', () => {
  it('GET /api/admin/usage/:userId matches the Firestore summary doc exactly', async () => {
    currentUid = ADMIN_UID;
    const { status, body } = await apiFetch(`/api/admin/usage/${OWNER_UID}?month=${MONTH}`);
    assert.strictEqual(status, 200);

    const raw = await summaryDoc(OWNER_UID);
    assert.strictEqual(body.user.email, `${OWNER_UID}@usagetest.com`);
    for (const [type, cell] of Object.entries(body.user.totals)) {
      const rawCell = (raw.totals || {})[type] || {};
      assert.strictEqual(cell.count, rawCell.count || 0, `count mismatch for ${type}`);
    }
    assert.strictEqual(body.user.grandTotalCostUsd, raw.grandTotalCostUsd || 0);
  });

  it('GET /api/admin/usage/workspace/:workspaceId matches the Firestore workspace summary exactly', async () => {
    currentUid = ADMIN_UID;
    const { status, body } = await apiFetch(`/api/admin/usage/workspace/usage-sync-ws-1?month=${MONTH}`);
    assert.strictEqual(status, 200);

    const raw = await wsSummaryDoc('usage-sync-ws-1');
    assert.ok(raw, 'the workspace used by the real sync-execution test has a rollup doc');
    for (const [type, cell] of Object.entries(body.workspace.totals)) {
      const rawCell = (raw.totals || {})[type] || {};
      assert.strictEqual(cell.count, rawCell.count || 0, `count mismatch for ${type}`);
    }
    assert.strictEqual(body.workspace.grandTotalCostUsd, raw.grandTotalCostUsd || 0);
  });

  it('GET /api/admin/usage/workspace/:workspaceId returns zeroed totals for a workspace with no usage yet', async () => {
    currentUid = ADMIN_UID;
    const { status, body } = await apiFetch(`/api/admin/usage/workspace/never-used-ws?month=${MONTH}`);
    assert.strictEqual(status, 200);
    assert.strictEqual(body.workspace.grandTotalCostUsd, 0);
    assert.strictEqual(body.workspace.totals.firestore_read.count, 0);
  });

  it('GET /api/admin/workspaces attaches this month\'s estimated cost per workspace', async () => {
    currentUid = ADMIN_UID;
    const { status, body } = await apiFetch('/api/admin/workspaces?limit=200');
    assert.strictEqual(status, 200);
    const ws1 = body.items.find(w => w.id === 'usage-sync-ws-1');
    assert.ok(ws1, 'the workspace used by the real sync-execution test is in the list');
    const raw = await wsSummaryDoc('usage-sync-ws-1');
    assert.strictEqual(ws1.estimatedCostUsd, raw.grandTotalCostUsd, "list endpoint's cost matches the rollup doc");
    const wsWithoutUsage = body.items.find(w => w.id === WORKSPACE_ID); // the original owner workspace has no sync activity
    assert.strictEqual(wsWithoutUsage.estimatedCostUsd, 0, 'workspace with no usage_workspace_summaries doc defaults to 0, not undefined');
  });

  it('GET /api/admin/usage lists all users for the month, sorted by cost, with emails joined', async () => {
    currentUid = ADMIN_UID;
    const { status, body } = await apiFetch(`/api/admin/usage?month=${MONTH}`);
    assert.strictEqual(status, 200);
    assert.ok(body.users.length >= 3, 'multiple users tracked this month');
    for (let i = 1; i < body.users.length; i++) {
      assert.ok(body.users[i - 1].grandTotalCostUsd >= body.users[i].grandTotalCostUsd, 'sorted desc by cost');
    }
    const owner = body.users.find(u => u.userId === OWNER_UID);
    assert.strictEqual(owner.email, `${OWNER_UID}@usagetest.com`);
    // Firestore types expose BOTH count and estimated $ (cost-driving), intensity types cost null
    assert.strictEqual(typeof owner.totals.firestore_read.count, 'number');
    assert.strictEqual(typeof owner.totals.firestore_read.costUsd, 'number');
    assert.strictEqual(owner.totals.user_login.costUsd, null);
  });

  it('non-superadmin is rejected (403)', async () => {
    currentUid = OWNER_UID;
    const { status } = await apiFetch(`/api/admin/usage?month=${MONTH}`);
    assert.strictEqual(status, 403);
  });

  it('rejects a malformed month', async () => {
    currentUid = ADMIN_UID;
    const { status } = await apiFetch('/api/admin/usage?month=2026-13');
    assert.strictEqual(status, 400);
  });

  it('CSV export rows match the usage_summaries docs exactly', async () => {
    currentUid = ADMIN_UID;
    const { status, body: csv, headers } = await apiFetch(`/api/admin/usage/export?month=${MONTH}`);
    assert.strictEqual(status, 200);
    assert.ok(headers.get('content-type').includes('text/csv'));
    assert.ok(headers.get('content-disposition').includes(`usage-${MONTH}.csv`));

    const lines = csv.trim().split(/\r\n/);
    const header = lines[0].split(',');
    assert.strictEqual(header[0], 'userId');
    assert.strictEqual(header[1], 'email');
    assert.strictEqual(header[header.length - 1], 'grandTotalCostUsd');
    // Both a count AND a cost column for each firestore type — never just one
    for (const t of ['firestore_read', 'firestore_write', 'firestore_delete']) {
      assert.ok(header.includes(`${t}_count`), `${t}_count column present`);
      assert.ok(header.includes(`${t}_costUsd`), `${t}_costUsd column present`);
    }

    const snap = await db.collection('usage_summaries').where('yearMonth', '==', MONTH).get();
    assert.strictEqual(lines.length - 1, snap.size, 'one CSV row per summary doc');

    // Cross-check every row's counts + grand total against its Firestore doc
    for (const line of lines.slice(1)) {
      const cols = line.split(',');
      const row = Object.fromEntries(header.map((h, i) => [h, cols[i]]));
      const docSnap = await db.collection('usage_summaries').doc(`${row.userId}_${MONTH}`).get();
      assert.ok(docSnap.exists, `summary doc for CSV row ${row.userId}`);
      const data = docSnap.data();
      for (const h of header) {
        if (h.endsWith('_count')) {
          const type = h.slice(0, -'_count'.length);
          assert.strictEqual(Number(row[h]), (data.totals?.[type]?.count) || 0, `${row.userId} ${h}`);
        }
      }
      assert.ok(Math.abs(Number(row.grandTotalCostUsd) - (data.grandTotalCostUsd || 0)) < 1e-12, `${row.userId} grand total`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('usage_events retention cleanup (90-day flat cutoff)', () => {
  it('deletes events older than 90 days, keeps recent ones, never touches summaries', async () => {
    const UID = 'usage-retention-uid';
    // A real recent event (also creates the user's summary doc).
    await logUsageEvent(UID, 'ws-retention', 'firestore_write', { units: 7 });

    // Two stale raw events, seeded directly with old ISO timestamps — the
    // summaries they would have incremented are represented by the summary
    // doc above, which must survive the raw-event purge.
    const oldTs = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString();
    const veryOldTs = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    for (const timestamp of [oldTs, veryOldTs]) {
      await db.collection('usage_events').add({
        userId: UID, workspaceId: 'ws-retention', activityType: 'api_call',
        connectorType: 'notion', units: 1, estimatedCostUsd: 0.000001,
        actor: 'user', timestamp,
      });
    }

    const before = await eventsFor(UID);
    assert.strictEqual(before.length, 3, 'one recent + two stale events seeded');

    const deleted = await cleanupUsageEvents();
    assert.ok(deleted >= 2, `at least the two stale events deleted (got ${deleted})`);

    const after = await eventsFor(UID);
    assert.strictEqual(after.length, 1, 'only the recent event survives');
    assert.strictEqual(after[0].activityType, 'firestore_write');

    // The monthly rollup — the long-term record — is untouched by the purge.
    const summary = await summaryDoc(UID);
    assert.strictEqual(summary.totals.firestore_write.count, 7);
    const wsSummary = await wsSummaryDoc('ws-retention');
    assert.strictEqual(wsSummary.totals.firestore_write.count, 7);
  });

  it('is a no-op when nothing is old enough', async () => {
    const deleted = await cleanupUsageEvents();
    assert.strictEqual(deleted, 0, 'second pass finds nothing left to delete');
  });
});

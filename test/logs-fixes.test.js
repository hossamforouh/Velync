/**
 * Execution Logs page fixes — regression tests.
 *
 * Covers two of the backend changes from the Execution Logs audit:
 *   1. POST /api/sync-configs/:configId/run — the new properly-scoped retry
 *      endpoint that replaced the removed, unscoped POST /api/sync (which let
 *      any authenticated user trigger every workspace's syncs).
 *   2. reconcileStuckRuns() — marks execution_logs stuck at status:'running'
 *      (e.g. the process died mid-sync) as status:'error' after a timeout,
 *      so the Execution Logs page doesn't show permanently "running" entries.
 *
 * Run:  npm run test:logs-fixes
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

const TEST_UID = 'route-test-user';

// Stub verifyAuth before anything requires it (same pattern as admin-platforms.test.js)
const authPath = require.resolve('../src/api/middleware/auth');
require.cache[authPath] = {
  id: authPath,
  filename: authPath,
  loaded: true,
  exports: {
    verifyAuth: (req, res, next) => {
      req.user = { uid: TEST_UID, email: 'user@test.com' };
      next();
    },
  },
};

const db = require('../src/core/db');
const { createApp } = require('../src/api/server');
const { reconcileStuckRuns } = require('../src/domains/sync/log-cleanup');

let server;
let baseUrl;
const WORKSPACE_ID = 'ws-logs-test';
const OTHER_WORKSPACE_ID = 'ws-other-test';

before(async () => {
  await db.collection('users').doc(TEST_UID).set({ workspaceId: WORKSPACE_ID });
  await db.collection('workspaces').doc(WORKSPACE_ID).set({ planId: 'free', ownerId: TEST_UID, members: [] });
  await db.collection('plans').doc('free').set({ name: 'Free', maxActiveConfigs: 5 });

  await db.collection('workspaces').doc(WORKSPACE_ID)
    .collection('sync_configs').doc('own-config').set({
      workspaceId: WORKSPACE_ID,
      description: 'Own Config',
      status: 'draft',
      platform1: 'nonexistent-platform-a',
      platform2: 'nonexistent-platform-b',
    });

  // A config that belongs to a DIFFERENT workspace — must not be runnable by TEST_UID
  await db.collection('workspaces').doc(OTHER_WORKSPACE_ID)
    .collection('sync_configs').doc('other-config').set({
      workspaceId: OTHER_WORKSPACE_ID,
      description: 'Other Config',
      status: 'draft',
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

describe('POST /api/sync-configs/:configId/run', () => {
  it('runs a config in the caller\'s own workspace and records an execution_logs entry', async () => {
    const { status } = await apiFetch('/api/sync-configs/own-config/run', { method: 'POST' });
    // The fake platforms don't resolve to a real connector, so the sync itself
    // fails — but the route must still respond and a log entry must exist.
    assert.ok(status === 200 || status === 500);

    const logsSnap = await db.collection('execution_logs')
      .where('configId', '==', 'own-config')
      .where('workspaceId', '==', WORKSPACE_ID)
      .get();
    assert.ok(logsSnap.size >= 1, 'expected at least one execution_logs entry for the retried config');
  });

  it('cannot run a config belonging to another workspace', async () => {
    const { status, body } = await apiFetch('/api/sync-configs/other-config/run', { method: 'POST' });
    assert.strictEqual(status, 404);
    assert.match(body.error, /not found/i);
  });

  it('404s for a nonexistent config id', async () => {
    const { status } = await apiFetch('/api/sync-configs/does-not-exist/run', { method: 'POST' });
    assert.strictEqual(status, 404);
  });
});

describe('reconcileStuckRuns', () => {
  it('marks a long-stuck "running" log as error, leaves a recent one alone', async () => {
    const oldStart = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago
    const recentStart = new Date().toISOString();

    const stuckRef = await db.collection('execution_logs').add({
      configId: 'stuck-cfg', workspaceId: WORKSPACE_ID, status: 'running', startTime: oldStart,
    });
    const freshRef = await db.collection('execution_logs').add({
      configId: 'fresh-cfg', workspaceId: WORKSPACE_ID, status: 'running', startTime: recentStart,
    });

    await reconcileStuckRuns();

    const stuckDoc = await stuckRef.get();
    assert.strictEqual(stuckDoc.data().status, 'error');
    assert.ok(stuckDoc.data().endTime);
    assert.ok(stuckDoc.data().error);

    const freshDoc = await freshRef.get();
    assert.strictEqual(freshDoc.data().status, 'running');
  });
});

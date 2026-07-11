/**
 * Admin — manual workspace plan grant (comp access without billing).
 *
 * Covers PATCH /api/admin/workspaces/:workspaceId/plan:
 *  1. Requires superadmin (403 for a regular authenticated user).
 *  2. Sets planId directly, without touching lsCustomerId/lsSubscriptionId —
 *     so the workspace correctly shows as "no billing subscription on file"
 *     rather than fabricating a fake real subscription.
 *  3. 404s for an unknown workspace or unknown plan.
 *
 * Run:  npm run test:admin-workspace-plan
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

const SUPERADMIN_UID = 'admin-ws-plan-test-superadmin';
const REGULAR_UID = 'admin-ws-plan-test-regular';

let currentUid = SUPERADMIN_UID;

const adminAuthPath = require.resolve('firebase-admin/auth');
require.cache[adminAuthPath] = {
  id: adminAuthPath,
  filename: adminAuthPath,
  loaded: true,
  exports: {
    getAuth: () => ({
      verifyIdToken: async () => ({ uid: currentUid, email: `${currentUid}@admintest.com`, iat: Math.floor(Date.now() / 1000) }),
    }),
  },
};

const db = require('../src/core/db');
const { createApp } = require('../src/api/server');

let server;
let baseUrl;

before(async () => {
  await db.collection('superadmins').doc(SUPERADMIN_UID).set({ addedAt: new Date().toISOString() });
  await db.collection('plans').doc('pro').set({ name: 'Pro', isActive: true });

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

describe('PATCH /api/admin/workspaces/:workspaceId/plan', () => {
  it('rejects a non-superadmin', async () => {
    const wsId = 'admin-ws-plan-reject-ws';
    await db.collection('workspaces').doc(wsId).set({ name: 'W', ownerId: REGULAR_UID, planId: 'free' });

    currentUid = REGULAR_UID;
    const { status, body } = await apiFetch(`/api/admin/workspaces/${wsId}/plan`, {
      method: 'PATCH', body: JSON.stringify({ planId: 'pro' }),
    });
    assert.strictEqual(status, 403);
    assert.match(body.error, /superadmin/);
  });

  it('sets planId without fabricating a billing subscription', async () => {
    const wsId = 'admin-ws-plan-grant-ws';
    const ownerUid = 'admin-ws-plan-grant-owner';
    await db.collection('users').doc(ownerUid).set({ email: `${ownerUid}@admintest.com` });
    await db.collection('workspaces').doc(wsId).set({ name: 'W', ownerId: ownerUid, planId: 'free' });

    currentUid = SUPERADMIN_UID;
    const { status, body } = await apiFetch(`/api/admin/workspaces/${wsId}/plan`, {
      method: 'PATCH', body: JSON.stringify({ planId: 'pro' }),
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.planId, 'pro');

    const wsDoc = await db.collection('workspaces').doc(wsId).get();
    assert.strictEqual(wsDoc.data().planId, 'pro');
    assert.strictEqual(wsDoc.data().lsCustomerId, undefined);
    assert.strictEqual(wsDoc.data().lsSubscriptionId, undefined);

    const mailSnap = await db.collection('mail').where('to', '==', `${ownerUid}@admintest.com`).get();
    assert.strictEqual(mailSnap.size, 1);
  });

  it('404s for an unknown workspace', async () => {
    currentUid = SUPERADMIN_UID;
    const { status, body } = await apiFetch('/api/admin/workspaces/does-not-exist/plan', {
      method: 'PATCH', body: JSON.stringify({ planId: 'pro' }),
    });
    assert.strictEqual(status, 404);
    assert.match(body.error, /Workspace not found/);
  });

  it('404s for an unknown plan', async () => {
    const wsId = 'admin-ws-plan-badplan-ws';
    await db.collection('workspaces').doc(wsId).set({ name: 'W', ownerId: 'someone', planId: 'free' });

    currentUid = SUPERADMIN_UID;
    const { status, body } = await apiFetch(`/api/admin/workspaces/${wsId}/plan`, {
      method: 'PATCH', body: JSON.stringify({ planId: 'does-not-exist' }),
    });
    assert.strictEqual(status, 404);
    assert.match(body.error, /Plan not found/);
  });

  it('is a no-op when the workspace is already on the requested plan — no audit entry, no email', async () => {
    // Regression test: previously this route always wrote, logged an
    // 'update' audit entry, AND emailed the workspace owner "your plan was
    // updated" even when re-submitting the SAME plan (e.g. clicking Save
    // in the admin panel without actually changing the selection).
    const wsId = 'admin-ws-plan-noop-ws';
    const ownerUid = 'admin-ws-plan-noop-owner';
    await db.collection('users').doc(ownerUid).set({ email: `${ownerUid}@admintest.com` });
    await db.collection('workspaces').doc(wsId).set({ name: 'W', ownerId: ownerUid, planId: 'pro' });

    currentUid = SUPERADMIN_UID;
    const { status, body } = await apiFetch(`/api/admin/workspaces/${wsId}/plan`, {
      method: 'PATCH', body: JSON.stringify({ planId: 'pro' }),
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.changed, false);

    const logsSnap = await db.collection('activity_logs')
      .where('targetType', '==', 'workspace-plan')
      .where('targetId', '==', wsId)
      .get();
    assert.strictEqual(logsSnap.size, 0, 'no audit entry should be written for a no-op plan grant');

    const mailSnap = await db.collection('mail').where('to', '==', `${ownerUid}@admintest.com`).get();
    assert.strictEqual(mailSnap.size, 0, 'no "plan updated" email should be sent for a no-op plan grant');
  });
});

/**
 * Admin Platforms/Integrations Route Test Suite
 *
 * Verifies the backend CRUD routes added to replace the broken client-side
 * Firestore writes (platforms/integrations have `allow write: if false`).
 * Runs the real Express app against the Firestore emulator, with only
 * verifyAuth stubbed (via require.cache injection) so every other layer —
 * requireSuperAdmin, express-validator, the actual Firestore writes — runs
 * for real. No live Firebase ID token is ever minted.
 *
 * Run:  npm run test:admin-platforms
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');

const TEST_UID = 'route-test-superadmin';

// Stub verifyAuth before anything requires it, so every route file that does
// `require('../middleware/auth')` gets the stub.
const authPath = require.resolve('../src/api/middleware/auth');
require.cache[authPath] = {
  id: authPath,
  filename: authPath,
  loaded: true,
  exports: {
    verifyAuth: (req, res, next) => {
      req.user = { uid: TEST_UID, email: 'superadmin@test.com' };
      next();
    },
  },
};

const db = require('../src/core/db');
const { createApp } = require('../src/api/server');

let server;
let baseUrl;

before(async () => {
  await db.collection('superadmins').doc(TEST_UID).set({ addedAt: new Date().toISOString() });
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

describe('POST/PUT/DELETE /api/admin/platforms', () => {
  let platformId;

  it('creates a platform without leaking clientSecret into the platforms doc', async () => {
    const { status, body } = await apiFetch('/api/admin/platforms', {
      method: 'POST',
      body: JSON.stringify({ name: 'TestPlatform', clientId: 'cid', clientSecret: 'super-secret', authType: 'oauth2' }),
    });
    assert.strictEqual(status, 200);
    assert.ok(body.id);
    platformId = body.id;

    const platformDoc = await db.collection('platforms').doc(platformId).get();
    assert.strictEqual(platformDoc.data().clientSecret, undefined);
    assert.strictEqual(platformDoc.data().clientId, 'cid');

    const secretDoc = await db.collection('platform_secrets').doc(platformId).get();
    assert.strictEqual(secretDoc.data().clientSecret, 'super-secret');
  });

  it('updates a platform and cascades the name to related integrations', async () => {
    await db.collection('integrations').doc('int1').set({
      name: 'Old Combo', platform1: { id: platformId, name: 'TestPlatform' }, platform2: { id: 'other', name: 'Other' },
    });

    const { status } = await apiFetch(`/api/admin/platforms/${platformId}`, {
      method: 'PUT',
      body: JSON.stringify({ name: 'RenamedPlatform' }),
    });
    assert.strictEqual(status, 200);

    const intDoc = await db.collection('integrations').doc('int1').get();
    assert.strictEqual(intDoc.data().platform1.name, 'RenamedPlatform');
  });

  it('is a no-op when Save is clicked with no actual field changes — no NEW audit entry', async () => {
    // Regression test: previously every PUT logged an 'update' audit entry
    // unconditionally, even when the submitted data was identical to what
    // was already stored (e.g. opening the editor and clicking Save without
    // touching anything). Compares the count before/after (rather than
    // asserting it's exactly 0) because the earlier "renames a platform"
    // test in this same describe block already wrote one legitimate
    // 'update' entry for this platformId.
    const query = () => db.collection('activity_logs')
      .where('targetType', '==', 'platform')
      .where('targetId', '==', platformId)
      .where('action', '==', 'update')
      .get();
    const before = await db.collection('platforms').doc(platformId).get();
    const unchangedPayload = { name: before.data().name, tier: before.data().tier };
    const countBefore = (await query()).size;

    const { status, body } = await apiFetch(`/api/admin/platforms/${platformId}`, {
      method: 'PUT',
      body: JSON.stringify(unchangedPayload),
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.changed, false);

    const countAfter = (await query()).size;
    assert.strictEqual(countAfter, countBefore, 'no NEW update audit entry should be written for a no-op save');
  });

  it('deletes a platform, returns deletedData with the secret, and supports restore', async () => {
    const { status, body } = await apiFetch(`/api/admin/platforms/${platformId}`, { method: 'DELETE' });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.deletedData.clientSecret, 'super-secret');

    const gone = await db.collection('platforms').doc(platformId).get();
    assert.strictEqual(gone.exists, false);
    const secretGone = await db.collection('platform_secrets').doc(platformId).get();
    assert.strictEqual(secretGone.exists, false);

    const restore = await apiFetch(`/api/admin/platforms/${platformId}/restore`, {
      method: 'POST',
      body: JSON.stringify(body.deletedData),
    });
    assert.strictEqual(restore.status, 200);
    const restored = await db.collection('platforms').doc(platformId).get();
    assert.strictEqual(restored.data().name, 'RenamedPlatform');
    const restoredSecret = await db.collection('platform_secrets').doc(platformId).get();
    assert.strictEqual(restoredSecret.data().clientSecret, 'super-secret');
  });
});

describe('platform tier (connectorTiers gating)', () => {
  it('defaults to "basic" when not supplied', async () => {
    const { status, body } = await apiFetch('/api/admin/platforms', {
      method: 'POST',
      body: JSON.stringify({ name: 'DefaultTierPlatform' }),
    });
    assert.strictEqual(status, 200);
    const doc = await db.collection('platforms').doc(body.id).get();
    assert.strictEqual(doc.data().tier, 'basic');
  });

  it('accepts an explicit "premium" tier on create, and can be changed via update', async () => {
    const { status, body } = await apiFetch('/api/admin/platforms', {
      method: 'POST',
      body: JSON.stringify({ name: 'PremiumPlatform', tier: 'premium' }),
    });
    assert.strictEqual(status, 200);
    let doc = await db.collection('platforms').doc(body.id).get();
    assert.strictEqual(doc.data().tier, 'premium');

    const update = await apiFetch(`/api/admin/platforms/${body.id}`, {
      method: 'PUT',
      body: JSON.stringify({ tier: 'basic' }),
    });
    assert.strictEqual(update.status, 200);
    doc = await db.collection('platforms').doc(body.id).get();
    assert.strictEqual(doc.data().tier, 'basic');
  });

  it('rejects an invalid tier value', async () => {
    const { status, body } = await apiFetch('/api/admin/platforms', {
      method: 'POST',
      body: JSON.stringify({ name: 'BadTierPlatform', tier: 'enterprise' }),
    });
    assert.strictEqual(status, 400);
    assert.match(body.error, /Validation failed/);
  });
});

describe('POST/PUT/DELETE /api/admin/integrations', () => {
  let integrationId;

  it('creates an integration', async () => {
    const { status, body } = await apiFetch('/api/admin/integrations', {
      method: 'POST',
      body: JSON.stringify({ name: 'TestIntegration', status: 'active' }),
    });
    assert.strictEqual(status, 200);
    assert.ok(body.id);
    integrationId = body.id;
  });

  it('updates an integration', async () => {
    const { status } = await apiFetch(`/api/admin/integrations/${integrationId}`, {
      method: 'PUT',
      body: JSON.stringify({ name: 'RenamedIntegration' }),
    });
    assert.strictEqual(status, 200);
    const doc = await db.collection('integrations').doc(integrationId).get();
    assert.strictEqual(doc.data().name, 'RenamedIntegration');
  });

  it('is a no-op when Save is clicked with no actual field changes — no NEW audit entry', async () => {
    // Compares before/after count rather than asserting exactly 0, since the
    // earlier "updates an integration" test already wrote one legitimate
    // 'update' entry for this integrationId.
    const query = () => db.collection('activity_logs')
      .where('targetType', '==', 'integration')
      .where('targetId', '==', integrationId)
      .where('action', '==', 'update')
      .get();
    const before = await db.collection('integrations').doc(integrationId).get();
    const countBefore = (await query()).size;

    const { status, body } = await apiFetch(`/api/admin/integrations/${integrationId}`, {
      method: 'PUT',
      body: JSON.stringify({ name: before.data().name }),
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.changed, false);

    const countAfter = (await query()).size;
    assert.strictEqual(countAfter, countBefore, 'no NEW update audit entry should be written for a no-op save');
  });

  it('deletes and restores an integration', async () => {
    const { status, body } = await apiFetch(`/api/admin/integrations/${integrationId}`, { method: 'DELETE' });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.deletedData.name, 'RenamedIntegration');

    const gone = await db.collection('integrations').doc(integrationId).get();
    assert.strictEqual(gone.exists, false);

    const restore = await apiFetch(`/api/admin/integrations/${integrationId}/restore`, {
      method: 'POST',
      body: JSON.stringify(body.deletedData),
    });
    assert.strictEqual(restore.status, 200);
    const restored = await db.collection('integrations').doc(integrationId).get();
    assert.strictEqual(restored.exists, true);
  });
});

describe('activity logging', () => {
  it('writes an audit entry with a real Firestore Timestamp for admin actions', async () => {
    const { body } = await apiFetch('/api/admin/platforms', {
      method: 'POST',
      body: JSON.stringify({ name: 'AuditedPlatform' }),
    });
    const logsSnap = await db.collection('activity_logs')
      .where('targetType', '==', 'platform')
      .where('targetId', '==', body.id)
      .get();
    assert.strictEqual(logsSnap.size, 1);
    const log = logsSnap.docs[0].data();
    assert.strictEqual(log.action, 'create');
    assert.strictEqual(typeof log.timestamp.toDate, 'function');
  });
});

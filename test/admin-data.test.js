/**
 * Admin Data (export/import) route test suite.
 *
 * Runs the real Express app against the Firestore emulator with only
 * verifyAuth stubbed (via require.cache injection), same pattern as
 * test/admin-platforms.test.js. An x-test-uid header lets a test impersonate
 * a non-superadmin to exercise the 403 path.
 *
 * Run: npx firebase emulators:exec --only firestore "node --test test/admin-data.test.js"
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

const TEST_UID = 'admin-data-test-superadmin';

const authPath = require.resolve('../src/api/middleware/auth');
require.cache[authPath] = {
  id: authPath, filename: authPath, loaded: true,
  exports: {
    verifyAuth: (req, res, next) => {
      const uid = req.headers['x-test-uid'] || TEST_UID;
      req.user = { uid, email: `${uid}@test.com` };
      next();
    },
  },
};

const db = require('../src/core/db');
const { createApp } = require('../src/api/server');

let server, baseUrl;

before(async () => {
  await db.collection('superadmins').doc(TEST_UID).set({ addedAt: new Date().toISOString() });
  // Seed a couple of platforms to export.
  await db.collection('platforms').doc('notion').set({ name: 'Notion', authType: 'oauth', connectorKey: 'notion' });
  await db.collection('platforms').doc('ticktick').set({ name: 'TickTick', authType: 'oauth', connectorKey: 'ticktick' });
  const app = createApp();
  await new Promise((resolve) => { server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); }); });
});

after(async () => { await new Promise((resolve) => server.close(resolve)); });

async function api(path, options = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer fake', ...(options.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

describe('GET /api/admin/export/:collection', () => {
  it('exports a known collection with docs + metadata', async () => {
    const { status, body } = await api('/api/admin/export/platforms');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.collection, 'platforms');
    assert.strictEqual(body.version, 1);
    assert.ok(body.count >= 2);
    assert.ok(Array.isArray(body.docs));
    assert.ok(body.docs.every(d => typeof d.id === 'string'));
  });

  it('rejects an unknown collection', async () => {
    const { status } = await api('/api/admin/export/credentials');
    assert.strictEqual(status, 400);
  });

  it('rejects a non-superadmin', async () => {
    const { status } = await api('/api/admin/export/platforms', { headers: { 'x-test-uid': 'not-admin' } });
    assert.strictEqual(status, 403);
  });
});

describe('POST /api/admin/import/:collection', () => {
  it('upserts docs by id (overwrite existing + add new)', async () => {
    const { status, body } = await api('/api/admin/import/plans', {
      method: 'POST',
      body: JSON.stringify({ collection: 'plans', docs: [
        { id: 'free', name: 'Free', priceMonthly: 0 },
        { id: 'pro', name: 'Pro', priceMonthly: 19 },
      ] }),
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.imported, 2);
    const free = await db.collection('plans').doc('free').get();
    assert.strictEqual(free.data().name, 'Free');
  });

  it('accepts a bare array too', async () => {
    const { status, body } = await api('/api/admin/import/plans', {
      method: 'POST',
      body: JSON.stringify([{ id: 'business', name: 'Business', priceMonthly: 79 }]),
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.imported, 1);
  });

  it('strips clientSecret from platform imports (never writes it into the client-readable doc)', async () => {
    const { status } = await api('/api/admin/import/platforms', {
      method: 'POST',
      body: JSON.stringify({ collection: 'platforms', docs: [
        { id: 'evil', name: 'Evil', clientSecret: 'should-not-persist' },
      ] }),
    });
    assert.strictEqual(status, 200);
    const doc = await db.collection('platforms').doc('evil').get();
    assert.strictEqual(doc.data().clientSecret, undefined);
    assert.strictEqual(doc.data().name, 'Evil');
  });

  it('rejects a file whose collection does not match the URL', async () => {
    const { status } = await api('/api/admin/import/plans', {
      method: 'POST',
      body: JSON.stringify({ collection: 'platforms', docs: [{ id: 'x', name: 'X' }] }),
    });
    assert.strictEqual(status, 400);
  });

  it('rejects docs without a string id', async () => {
    const { status } = await api('/api/admin/import/plans', {
      method: 'POST',
      body: JSON.stringify({ docs: [{ name: 'no id' }] }),
    });
    assert.strictEqual(status, 400);
  });

  it('rejects an empty docs array', async () => {
    const { status } = await api('/api/admin/import/plans', {
      method: 'POST',
      body: JSON.stringify({ docs: [] }),
    });
    assert.strictEqual(status, 400);
  });

  it('rejects a non-superadmin', async () => {
    const { status } = await api('/api/admin/import/plans', {
      method: 'POST',
      headers: { 'x-test-uid': 'not-admin' },
      body: JSON.stringify({ docs: [{ id: 'x', name: 'X' }] }),
    });
    assert.strictEqual(status, 403);
  });
});

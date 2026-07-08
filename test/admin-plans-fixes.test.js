/**
 * Admin Panel Plans tab fixes — regression tests.
 *
 * Covers the backend side of removing the Plan ID / Sort Order fields from
 * the New Plan form:
 *  1. POST /api/admin/plans no longer requires a client-supplied `id` —
 *     it generates a readable slug from `name` (matching the existing
 *     'free'/'pro'/'business' convention, since plan IDs are referenced as
 *     literal string keys elsewhere in the codebase).
 *  2. Colliding names get disambiguated (`_2`, `_3`, ...).
 *  3. `sortOrder` is computed server-side as (max existing) + 10 when the
 *     client doesn't supply one.
 *
 * Run:  npm run test:admin-plans-fixes
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

const TEST_UID = 'admin-plans-test-superadmin';

const adminAuthPath = require.resolve('firebase-admin/auth');
require.cache[adminAuthPath] = {
  id: adminAuthPath,
  filename: adminAuthPath,
  loaded: true,
  exports: {
    getAuth: () => ({
      verifyIdToken: async () => ({ uid: TEST_UID, email: `${TEST_UID}@plantest.com`, iat: Math.floor(Date.now() / 1000) }),
    }),
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

describe('POST /api/admin/plans — id-less creation', () => {
  it('rejects a request with no name', async () => {
    const { status } = await apiFetch('/api/admin/plans', { method: 'POST', body: JSON.stringify({}) });
    assert.strictEqual(status, 400);
  });

  it('generates a slug id from the plan name', async () => {
    const { status, body } = await apiFetch('/api/admin/plans', {
      method: 'POST', body: JSON.stringify({ name: 'Enterprise Plus' }),
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.id, 'enterprise_plus');
    const doc = await db.collection('plans').doc('enterprise_plus').get();
    assert.strictEqual(doc.data().name, 'Enterprise Plus');
  });

  it('disambiguates a colliding name-derived slug', async () => {
    const { status, body } = await apiFetch('/api/admin/plans', {
      method: 'POST', body: JSON.stringify({ name: 'Enterprise Plus' }),
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.id, 'enterprise_plus_2');
  });

  it('auto-assigns sortOrder as (max existing) + 10 when not supplied', async () => {
    await db.collection('plans').doc('sortorder-seed').set({ name: 'Seed', sortOrder: 40 });
    const { status, body } = await apiFetch('/api/admin/plans', {
      method: 'POST', body: JSON.stringify({ name: 'Sort Order Check' }),
    });
    assert.strictEqual(status, 200);
    const doc = await db.collection('plans').doc(body.id).get();
    assert.strictEqual(doc.data().sortOrder, 50);
  });
});

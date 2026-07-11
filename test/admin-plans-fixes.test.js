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

describe('POST /api/admin/plans — isDefault uniqueness', () => {
  it('creating a new plan with isDefault:true unsets isDefault on the previously-default plan', async () => {
    // Regression test: PUT (update) already unset other defaults, but POST
    // (create) did not — creating a second plan marked default left BOTH the
    // old and new plan simultaneously flagged isDefault:true.
    const first = await apiFetch('/api/admin/plans', {
      method: 'POST', body: JSON.stringify({ name: 'Default Test A', isDefault: true }),
    });
    assert.strictEqual(first.status, 200);
    let firstDoc = await db.collection('plans').doc(first.body.id).get();
    assert.strictEqual(firstDoc.data().isDefault, true);

    const second = await apiFetch('/api/admin/plans', {
      method: 'POST', body: JSON.stringify({ name: 'Default Test B', isDefault: true }),
    });
    assert.strictEqual(second.status, 200);

    firstDoc = await db.collection('plans').doc(first.body.id).get();
    const secondDoc = await db.collection('plans').doc(second.body.id).get();
    assert.strictEqual(firstDoc.data().isDefault, false, 'the previously-default plan must be unset');
    assert.strictEqual(secondDoc.data().isDefault, true, 'the newly-created plan is the sole default');
  });

  it('creating a plan WITHOUT isDefault does not disturb the existing default', async () => {
    const existing = await apiFetch('/api/admin/plans', {
      method: 'POST', body: JSON.stringify({ name: 'Default Test C', isDefault: true }),
    });
    const bystander = await apiFetch('/api/admin/plans', {
      method: 'POST', body: JSON.stringify({ name: 'Non-Default Bystander' }),
    });
    assert.strictEqual(bystander.status, 200);

    const existingDoc = await db.collection('plans').doc(existing.body.id).get();
    const bystanderDoc = await db.collection('plans').doc(bystander.body.id).get();
    assert.strictEqual(existingDoc.data().isDefault, true);
    assert.strictEqual(bystanderDoc.data().isDefault, false);
  });
});

describe('PUT /api/admin/plans/:planId — no-op save guard', () => {
  it('clicking Save without changing anything writes no audit entry and reports changed:false', async () => {
    // Regression test: previously every PUT logged an 'update' audit entry
    // unconditionally, even when the submitted data was identical to what
    // was already stored.
    const created = await apiFetch('/api/admin/plans', {
      method: 'POST', body: JSON.stringify({ name: 'NoOp Save Test', priceMonthly: 9, maxActiveConfigs: 3 }),
    });
    assert.strictEqual(created.status, 200);
    const planId = created.body.id;

    const doc = await db.collection('plans').doc(planId).get();
    const unchangedPayload = {
      name: doc.data().name,
      priceMonthly: doc.data().priceMonthly,
      maxActiveConfigs: doc.data().maxActiveConfigs,
      minSyncIntervalMinutes: doc.data().minSyncIntervalMinutes,
      maxItemsPerRun: doc.data().maxItemsPerRun,
      connectorTiers: doc.data().connectorTiers,
      logRetentionDays: doc.data().logRetentionDays,
      isActive: doc.data().isActive,
      isDefault: doc.data().isDefault,
    };

    const resave = await apiFetch(`/api/admin/plans/${planId}`, {
      method: 'PUT', body: JSON.stringify(unchangedPayload),
    });
    assert.strictEqual(resave.status, 200);
    assert.strictEqual(resave.body.changed, false);

    const logsSnap = await db.collection('activity_logs')
      .where('targetType', '==', 'plan')
      .where('targetId', '==', planId)
      .where('action', '==', 'update')
      .get();
    assert.strictEqual(logsSnap.size, 0, 'no update audit entry should be written for a no-op save');
  });

  it('a real field change still writes exactly one audit entry with a changes diff', async () => {
    const created = await apiFetch('/api/admin/plans', {
      method: 'POST', body: JSON.stringify({ name: 'Real Change Test', priceMonthly: 9 }),
    });
    const planId = created.body.id;

    const update = await apiFetch(`/api/admin/plans/${planId}`, {
      method: 'PUT', body: JSON.stringify({ priceMonthly: 19 }),
    });
    assert.strictEqual(update.status, 200);
    assert.strictEqual(update.body.changed, true);

    const logsSnap = await db.collection('activity_logs')
      .where('targetType', '==', 'plan')
      .where('targetId', '==', planId)
      .where('action', '==', 'update')
      .get();
    assert.strictEqual(logsSnap.size, 1);
    const log = logsSnap.docs[0].data();
    assert.deepStrictEqual(log.changes.priceMonthly, { before: 9, after: 19 });
  });
});

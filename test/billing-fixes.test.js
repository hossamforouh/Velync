/**
 * Billing & Plan page fixes — regression tests.
 *
 * Covers:
 *  1. Checkout/portal routes now reject non-owner workspace members (403).
 *  2. reconcileActiveConfigsForPlan() pauses the newest active configs
 *     beyond a plan's maxActiveConfigs, keeping the oldest ones running.
 *  3. notifyAdmins() emails every superadmin.
 *
 * Stripe itself is stubbed (require.cache injection) since these tests only
 * need to verify authorization/reconciliation logic, not real Stripe calls.
 *
 * Run:  npm run test:billing-fixes
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

const OWNER_UID = 'billing-test-owner';
const MEMBER_UID = 'billing-test-member';
const WORKSPACE_ID = 'billing-test-ws';

let currentUid = OWNER_UID;

const authPath = require.resolve('../src/api/middleware/auth');
require.cache[authPath] = {
  id: authPath,
  filename: authPath,
  loaded: true,
  exports: {
    verifyAuth: (req, res, next) => {
      req.user = { uid: currentUid, email: `${currentUid}@billingtest.com` };
      next();
    },
  },
};

// Stub the Stripe SDK so checkout/portal routes never make real network
// calls — only the ownership-check logic ahead of those calls is under test.
const stripePath = require.resolve('stripe');
function fakeStripe() {
  return {
    customers: { create: async () => ({ id: 'cus_fake' }) },
    checkout: { sessions: { create: async () => ({ url: 'https://checkout.stripe.com/fake' }) } },
    billingPortal: { sessions: { create: async () => ({ url: 'https://billing.stripe.com/fake' }) } },
  };
}
require.cache[stripePath] = { id: stripePath, filename: stripePath, loaded: true, exports: fakeStripe };

const db = require('../src/core/db');
const { createApp } = require('../src/api/server');
const { reconcileActiveConfigsForPlan } = require('../src/core/plan');
const { notifyAdmins } = require('../src/core/notifications');

let server;
let baseUrl;

before(async () => {
  await db.collection('users').doc(OWNER_UID).set({ workspaceId: WORKSPACE_ID, email: `${OWNER_UID}@billingtest.com` });
  await db.collection('users').doc(MEMBER_UID).set({ workspaceId: WORKSPACE_ID, email: `${MEMBER_UID}@billingtest.com` });
  await db.collection('workspaces').doc(WORKSPACE_ID).set({ ownerId: OWNER_UID, members: [MEMBER_UID], planId: 'free' });
  await db.collection('plans').doc('pro').set({ name: 'Pro', maxActiveConfigs: 2, isActive: true, stripePriceIdMonthly: 'price_fake' });

  process.env.STRIPE_SECRET_KEY = 'sk_fake_for_tests';

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

describe('billing routes restricted to the workspace owner', () => {
  it('owner can create a checkout session', async () => {
    currentUid = OWNER_UID;
    const { status, body } = await apiFetch('/api/billing/create-checkout-session', {
      method: 'POST',
      body: JSON.stringify({ planId: 'pro', billingInterval: 'monthly' }),
    });
    assert.strictEqual(status, 200);
    assert.ok(body.url);
  });

  it('non-owner member is rejected from creating a checkout session', async () => {
    currentUid = MEMBER_UID;
    const { status, body } = await apiFetch('/api/billing/create-checkout-session', {
      method: 'POST',
      body: JSON.stringify({ planId: 'pro', billingInterval: 'monthly' }),
    });
    assert.strictEqual(status, 403);
    assert.match(body.error, /workspace owner/);
  });

  it('non-owner member is rejected from opening the billing portal', async () => {
    currentUid = MEMBER_UID;
    await db.collection('workspaces').doc(WORKSPACE_ID).update({ stripeCustomerId: 'cus_existing' });
    const { status, body } = await apiFetch('/api/billing/create-portal-session', { method: 'POST' });
    assert.strictEqual(status, 403);
    assert.match(body.error, /workspace owner/);
  });

  it('owner can open the billing portal', async () => {
    currentUid = OWNER_UID;
    const { status, body } = await apiFetch('/api/billing/create-portal-session', { method: 'POST' });
    assert.strictEqual(status, 200);
    assert.ok(body.url);
  });
});

describe('GET /billing/plan backfills a missing planId', () => {
  it('defaults to free and persists it when the workspace has no planId', async () => {
    const uid = 'billing-test-no-planid-owner';
    const wsId = 'billing-test-no-planid-ws';
    await db.collection('users').doc(uid).set({ workspaceId: wsId, email: `${uid}@billingtest.com` });
    // Mirrors what the client's signup flow actually writes — no planId field.
    await db.collection('workspaces').doc(wsId).set({ ownerId: uid, members: [uid] });

    currentUid = uid;
    const { status, body } = await apiFetch('/api/billing/plan');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.plan.id, 'free');

    const wsDoc = await db.collection('workspaces').doc(wsId).get();
    assert.strictEqual(wsDoc.data().planId, 'free');
  });

  it('trims whitespace-corrupted planId (e.g. a manual Firestore edit with a trailing newline) and resolves the correct plan', async () => {
    const uid = 'billing-test-corrupt-planid-owner';
    const wsId = 'billing-test-corrupt-planid-ws';
    await db.collection('users').doc(uid).set({ workspaceId: wsId, email: `${uid}@billingtest.com` });
    await db.collection('workspaces').doc(wsId).set({ ownerId: uid, members: [uid], planId: 'pro\n' });

    currentUid = uid;
    const { status, body } = await apiFetch('/api/billing/plan');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.plan.id, 'pro');
    assert.strictEqual(body.plan.name, 'Pro');

    const wsDoc = await db.collection('workspaces').doc(wsId).get();
    assert.strictEqual(wsDoc.data().planId, 'pro');
  });
});

describe('reconcileActiveConfigsForPlan', () => {
  it('pauses the newest active configs beyond the limit, keeps the oldest active', async () => {
    const wsId = 'billing-reconcile-ws';
    const cfgs = db.collection('workspaces').doc(wsId).collection('sync_configs');
    await cfgs.doc('oldest').set({ status: 'active', createdAt: '2026-01-01T00:00:00.000Z', description: 'Oldest' });
    await cfgs.doc('middle').set({ status: 'active', createdAt: '2026-01-02T00:00:00.000Z', description: 'Middle' });
    await cfgs.doc('newest').set({ status: 'active', createdAt: '2026-01-03T00:00:00.000Z', description: 'Newest' });

    const result = await reconcileActiveConfigsForPlan(wsId, 'pro'); // maxActiveConfigs: 2
    assert.strictEqual(result.pausedCount, 1);
    assert.deepStrictEqual(result.pausedNames, ['Newest']);

    const oldest = await cfgs.doc('oldest').get();
    const middle = await cfgs.doc('middle').get();
    const newest = await cfgs.doc('newest').get();
    assert.strictEqual(oldest.data().status, 'active');
    assert.strictEqual(middle.data().status, 'active');
    assert.strictEqual(newest.data().status, 'paused');
  });

  it('does nothing when already within the limit', async () => {
    const result = await reconcileActiveConfigsForPlan(WORKSPACE_ID, 'pro');
    assert.strictEqual(result.pausedCount, 0);
  });
});

describe('notifyAdmins', () => {
  it('emails every superadmin', async () => {
    await db.collection('superadmins').doc('admin-1').set({});
    await db.collection('users').doc('admin-1').set({ email: 'admin1@billingtest.com' });

    await notifyAdmins('[Test] Something broke', 'details here');

    const mailSnap = await db.collection('mail').where('to', '==', 'admin1@billingtest.com').get();
    assert.strictEqual(mailSnap.size, 1);
    assert.strictEqual(mailSnap.docs[0].data().message.subject, '[Test] Something broke');
  });
});

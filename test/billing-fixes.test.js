/**
 * Billing & Plan page fixes — regression tests.
 *
 * Covers:
 *  1. Checkout/portal routes now reject non-owner workspace members (403).
 *  2. create-checkout-session swaps the variant on an existing subscription
 *     in place instead of creating a second (duplicate-billing) subscription.
 *  3. POST /billing/downgrade-to-free schedules/undoes a cancel-at-period-end.
 *  4. GET /billing/plan backfills a missing or whitespace-corrupted planId.
 *  5. reconcileActiveConfigsForPlan() pauses the newest active configs
 *     beyond a plan's maxActiveConfigs, keeping the oldest ones running.
 *  6. notifyAdmins() emails every superadmin.
 *
 * Lemon Squeezy itself is stubbed (require.cache injection on
 * src/core/lemonSqueezy.js) since these tests only need to verify
 * authorization/reconciliation/webhook-effect logic, not real network calls.
 *
 * Run:  npm run test:billing-fixes
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

// Must be set before anything require()s src/api/server.js — config.js reads
// these from process.env at require-time, not lazily, so setting them inside
// before() would be too late (the same class of stub-timing bug this
// project has hit before: see profile-settings-fixes.test.js's comment).
process.env.LEMONSQUEEZY_API_KEY = 'ls_fake_for_tests';
process.env.LEMONSQUEEZY_STORE_ID = '1';

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

// Stub src/core/lemonSqueezy.js so checkout/portal/webhook routes never make
// real network calls — only the ownership-check and Firestore-side logic
// ahead of/after those calls is under test. fakeSubscriptions mirrors the
// shape of Lemon Squeezy's JSON:API subscription resource (`data.attributes`).
const fakeSubscriptions = new Map(); // subscriptionId -> { id, attributes: {...} }
const lsPath = require.resolve('../src/core/lemonSqueezy');
require.cache[lsPath] = {
  id: lsPath,
  filename: lsPath,
  loaded: true,
  exports: {
    createCheckout: async () => 'https://checkout.lemonsqueezy.com/fake',
    getSubscription: async (id) => {
      const sub = fakeSubscriptions.get(id);
      if (!sub) throw new Error('No such subscription: ' + id);
      return sub;
    },
    updateSubscriptionVariant: async (id, variantId) => {
      const sub = fakeSubscriptions.get(id);
      if (!sub) throw new Error('No such subscription: ' + id);
      sub.attributes.variant_id = Number(variantId);
      return sub;
    },
    resumeSubscription: async (id) => {
      const sub = fakeSubscriptions.get(id);
      if (!sub) throw new Error('No such subscription: ' + id);
      sub.attributes.cancelled = false;
      sub.attributes.status = 'active';
      sub.attributes.ends_at = null;
      return sub;
    },
    cancelSubscription: async (id) => {
      const sub = fakeSubscriptions.get(id);
      if (!sub) throw new Error('No such subscription: ' + id);
      sub.attributes.cancelled = true;
      sub.attributes.ends_at = sub.attributes.renews_at;
      return sub;
    },
    verifyWebhookSignature: () => true,
  },
};

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
  await db.collection('plans').doc('pro').set({ name: 'Pro', maxActiveConfigs: 2, isActive: true, lsVariantIdMonthly: '1001' });

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
    const subId = 'sub_fake_portal';
    fakeSubscriptions.set(subId, {
      id: subId,
      attributes: { status: 'active', cancelled: false, variant_id: 1001, renews_at: new Date(Date.now() + 86400000).toISOString(), ends_at: null, customer_id: 5001, urls: { customer_portal: 'https://portal.lemonsqueezy.com/fake' } },
    });
    await db.collection('workspaces').doc(WORKSPACE_ID).update({ lsCustomerId: '5001', lsSubscriptionId: subId });
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

describe('create-checkout-session swaps variant in place instead of creating a duplicate subscription', () => {
  it('updates the existing subscription (no url, no new Checkout) when one is already active', async () => {
    const uid = 'billing-test-existing-sub-owner';
    const wsId = 'billing-test-existing-sub-ws';
    const subId = 'sub_fake_existing';
    await db.collection('users').doc(uid).set({ workspaceId: wsId, email: `${uid}@billingtest.com` });
    await db.collection('workspaces').doc(wsId).set({
      ownerId: uid, members: [uid], planId: 'pro',
      lsCustomerId: 'cust_existing_sub', lsSubscriptionId: subId,
    });
    await db.collection('plans').doc('business').set({
      name: 'Business', maxActiveConfigs: 25, isActive: true, lsVariantIdMonthly: '1002',
    });
    fakeSubscriptions.set(subId, {
      id: subId,
      attributes: { status: 'active', cancelled: false, variant_id: 1001, renews_at: new Date(Date.now() + 86400000).toISOString(), ends_at: null, customer_id: 5002, urls: {} },
    });

    currentUid = uid;
    const { status, body } = await apiFetch('/api/billing/create-checkout-session', {
      method: 'POST',
      body: JSON.stringify({ planId: 'business', billingInterval: 'monthly' }),
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.updated, true);
    assert.strictEqual(body.url, undefined);

    const sub = fakeSubscriptions.get(subId);
    assert.strictEqual(sub.attributes.variant_id, 1002);
  });
});

describe('POST /billing/downgrade-to-free', () => {
  const uid = 'billing-test-downgrade-owner';
  const wsId = 'billing-test-downgrade-ws';
  const subId = 'sub_fake_downgrade';

  before(async () => {
    await db.collection('users').doc(uid).set({ workspaceId: wsId, email: `${uid}@billingtest.com` });
    await db.collection('workspaces').doc(wsId).set({
      ownerId: uid, members: [uid], planId: 'pro',
      lsCustomerId: 'cust_downgrade', lsSubscriptionId: subId,
    });
    fakeSubscriptions.set(subId, {
      id: subId,
      attributes: { status: 'active', cancelled: false, variant_id: 1001, renews_at: new Date(Date.now() + 86400000).toISOString(), ends_at: null, customer_id: 5003, urls: {} },
    });
  });

  it('rejects a non-owner member', async () => {
    const memberUid = 'billing-test-downgrade-member';
    await db.collection('users').doc(memberUid).set({ workspaceId: wsId, email: `${memberUid}@billingtest.com` });
    currentUid = memberUid;
    const { status, body } = await apiFetch('/api/billing/downgrade-to-free', { method: 'POST', body: JSON.stringify({}) });
    assert.strictEqual(status, 403);
    assert.match(body.error, /workspace owner/);
  });

  it('schedules a cancel-at-period-end and persists cancelAtPeriodEnd on the workspace', async () => {
    currentUid = uid;
    const { status, body } = await apiFetch('/api/billing/downgrade-to-free', { method: 'POST', body: JSON.stringify({}) });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.cancelAtPeriodEnd, true);
    assert.strictEqual(fakeSubscriptions.get(subId).attributes.cancelled, true);

    const wsDoc = await db.collection('workspaces').doc(wsId).get();
    assert.strictEqual(wsDoc.data().cancelAtPeriodEnd, true);
  });

  it('undoes the pending downgrade', async () => {
    currentUid = uid;
    const { status, body } = await apiFetch('/api/billing/downgrade-to-free', { method: 'POST', body: JSON.stringify({ undo: true }) });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.cancelAtPeriodEnd, false);
    assert.strictEqual(fakeSubscriptions.get(subId).attributes.cancelled, false);

    const wsDoc = await db.collection('workspaces').doc(wsId).get();
    assert.strictEqual(wsDoc.data().cancelAtPeriodEnd, false);
  });

  it('rejects a workspace with no active subscription', async () => {
    const uid2 = 'billing-test-downgrade-no-sub-owner';
    const wsId2 = 'billing-test-downgrade-no-sub-ws';
    await db.collection('users').doc(uid2).set({ workspaceId: wsId2, email: `${uid2}@billingtest.com` });
    await db.collection('workspaces').doc(wsId2).set({ ownerId: uid2, members: [uid2], planId: 'free' });

    currentUid = uid2;
    const { status, body } = await apiFetch('/api/billing/downgrade-to-free', { method: 'POST', body: JSON.stringify({}) });
    assert.strictEqual(status, 400);
    assert.match(body.error, /No active subscription/);
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

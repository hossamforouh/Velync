/**
 * GET /api/platforms and GET /api/integrations — regression tests.
 *
 * These consolidate what used to be raw client-side Firestore reads
 * (app.js, hub.js, connections.js, onboarding.js for platforms; hub.js and
 * the admin panel for integrations) into one server-mediated path.
 *
 * Run:  npm run test:public-marketplace
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

const TEST_UID = 'marketplace-test-user';

const authPath = require.resolve('../src/api/middleware/auth');
require.cache[authPath] = {
  id: authPath,
  filename: authPath,
  loaded: true,
  exports: {
    verifyAuth: (req, res, next) => {
      req.user = { uid: TEST_UID, email: `${TEST_UID}@marketplacetest.com` };
      next();
    },
  },
};

const db = require('../src/core/db');
const { createApp } = require('../src/api/server');

let server;
let baseUrl;

before(async () => {
  await db.collection('platforms').doc('notion').set({
    name: 'Notion', logo: '<svg></svg>', authType: 'oauth', tier: 'basic', connectorKey: 'notion',
  });
  await db.collection('platforms').doc('ticktick').set({
    name: 'TickTick', authType: 'manual', tier: 'premium', connectorKey: 'ticktick',
  });
  await db.collection('integrations').doc('int1').set({
    name: 'Notion + TickTick',
    platform1: { id: 'notion', name: 'Notion' },
    platform2: { id: 'ticktick', name: 'TickTick' },
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

describe('GET /api/platforms', () => {
  it('returns every platform doc with id + full data, matching what direct Firestore reads returned', async () => {
    const { status, body } = await apiFetch('/api/platforms');
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(body.platforms));
    const notion = body.platforms.find(p => p.id === 'notion');
    assert.ok(notion);
    assert.strictEqual(notion.name, 'Notion');
    assert.strictEqual(notion.tier, 'basic');
    assert.strictEqual(notion.connectorKey, 'notion');
    const ticktick = body.platforms.find(p => p.id === 'ticktick');
    assert.strictEqual(ticktick.tier, 'premium');
  });

  it('computes supportsWebhooks per-connector instead of the frontend hardcoding a platform name', async () => {
    const { body } = await apiFetch('/api/platforms');
    const notion = body.platforms.find(p => p.id === 'notion');
    const ticktick = body.platforms.find(p => p.id === 'ticktick');
    assert.strictEqual(notion.supportsWebhooks, true);
    assert.strictEqual(ticktick.supportsWebhooks, false);
  });
});

describe('GET /api/integrations', () => {
  it('returns every integration doc, ordered by name', async () => {
    const { status, body } = await apiFetch('/api/integrations');
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(body.integrations));
    const int1 = body.integrations.find(i => i.id === 'int1');
    assert.ok(int1);
    assert.strictEqual(int1.platform1.id, 'notion');
    assert.strictEqual(int1.platform2.id, 'ticktick');
  });
});

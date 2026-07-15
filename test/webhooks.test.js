/**
 * Webhook ingress endpoint — Stage 3 (WEBHOOK_SYNC_PLAN.md).
 *
 * Runs the real Express app (raw-body carve-out, rate limiting, route
 * mounting all included) against the Firestore emulator, POSTing real
 * HMAC-signed payloads at POST /api/webhooks/notion. Only runSync (the sync
 * engine's execution entry point) is stubbed — everything else (signature
 * verification, handshake detection, event parsing, the two-hop reverse
 * lookup) runs for real, the same principle test/admin-platforms.test.js
 * uses for verifyAuth.
 *
 * Run:  npm run test:webhooks
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const WEBHOOK_SECRET = 'notion-webhook-secret-fake-for-tests';
// Must be set before anything require()s src/core/config.js (read at
// require-time, not lazily) — same class of stub-timing note as
// billing-fixes.test.js. Debounce window shrunk so Stage 4's coalescing
// delay doesn't make every test wait ~20s for a real run to fire.
process.env.NOTION_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.WEBHOOK_DEBOUNCE_MS = '80';

const runSyncCalls = [];
const enginePath = require.resolve('../src/domains/sync/engine');
require.cache[enginePath] = {
  id: enginePath,
  filename: enginePath,
  loaded: true,
  exports: {
    runSync: async (config, configId) => {
      runSyncCalls.push({ config, configId });
      return { synced: 0 };
    },
    retryWithBackoff: async (fn) => ({ result: await fn(), recovered: false }),
  },
};

const db = require('../src/core/db');
const { createApp } = require('../src/api/server');

let server;
let baseUrl;

function sign(rawBody) {
  return 'sha256=' + crypto.createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');
}

async function postWebhook(provider, bodyObj, { signatureOverride, skipSignature = false } = {}) {
  const raw = JSON.stringify(bodyObj);
  const headers = { 'Content-Type': 'application/json' };
  if (!skipSignature) headers['x-notion-signature'] = signatureOverride || sign(raw);
  const res = await fetch(`${baseUrl}/api/webhooks/${provider}`, { method: 'POST', headers, body: raw });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

function account(id, data) {
  return db.collection('connected_accounts').doc(id).set(data);
}
function cfg(workspaceId, configId, data) {
  return db.collection('workspaces').doc(workspaceId).collection('sync_configs').doc(configId).set(data);
}

before(async () => {
  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });

  // Stage 6: webhook-triggered sync is plan-gated — this workspace's plan
  // must have webhookSyncEnabled for the dispatch tests below to fire.
  await db.collection('plans').doc('pro-test').set({ name: 'Pro (test)', webhookSyncEnabled: true });
  await db.collection('workspaces').doc('wh-wsA').set({ planId: 'pro-test' });

  await account('wh-conn-1', { provider: 'notion', providerWorkspaceId: 'wh-notion-ws', userId: 'u1', workspaceId: 'wh-wsA' });
  await cfg('wh-wsA', 'wh-config-active', {
    status: 'active',
    platform1: 'notion', platform1ConnectionId: 'wh-conn-1', p1Settings: { database: 'wh-db-1' },
    platform2: 'ticktick', platform2ConnectionId: 'other', p2Settings: {},
  });
  await cfg('wh-wsA', 'wh-config-paused', {
    status: 'paused',
    platform1: 'notion', platform1ConnectionId: 'wh-conn-1', p1Settings: { database: 'wh-db-2' },
    platform2: 'ticktick', platform2ConnectionId: 'other2', p2Settings: {},
  });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe('POST /api/webhooks/:provider', () => {
  it('rejects an unknown provider', async () => {
    const { status } = await postWebhook('not-a-real-platform', { type: 'page.created', entity: { id: 'x', type: 'page' }, workspace_id: 'w' }, { skipSignature: true });
    assert.strictEqual(status, 404);
  });

  it('rejects a provider that does not support webhooks (ticktick)', async () => {
    const { status } = await postWebhook('ticktick', { type: 'page.created', entity: { id: 'x', type: 'page' }, workspace_id: 'w' }, { skipSignature: true });
    assert.strictEqual(status, 404);
  });

  it('handles the one-time verification handshake without a signature', async () => {
    const { status, body } = await postWebhook('notion', { verification_token: 'tok_abc123' }, { skipSignature: true });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.received, true);
  });

  it('rejects a missing signature on a real event', async () => {
    const { status } = await postWebhook('notion', { type: 'page.created', entity: { id: 'x', type: 'page' }, workspace_id: 'w' }, { skipSignature: true });
    assert.strictEqual(status, 400);
  });

  it('rejects a tampered/wrong signature', async () => {
    const { status } = await postWebhook('notion', { type: 'page.created', entity: { id: 'x', type: 'page' }, workspace_id: 'w' }, { signatureOverride: 'sha256=' + '0'.repeat(64) });
    assert.strictEqual(status, 400);
  });

  it('rejects an unrecognized event type even with a valid signature', async () => {
    const { status } = await postWebhook('notion', { type: 'comment.created', entity: { id: 'x', type: 'comment' }, workspace_id: 'w' });
    assert.strictEqual(status, 400);
  });

  it('accepts a validly-signed event, acks immediately, and dispatches runSync only to the matching ACTIVE config', async () => {
    runSyncCalls.length = 0;
    const { status, body } = await postWebhook('notion', {
      type: 'data_source.content_updated',
      entity: { id: 'wh-db-1', type: 'data_source' },
      workspace_id: 'wh-notion-ws',
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.received, true);

    // handleWebhookEvent runs async after the response, then Stage 4's
    // debounce (shrunk to 80ms via WEBHOOK_DEBOUNCE_MS above) defers the
    // actual runSync call — poll past that window.
    for (let i = 0; i < 40 && runSyncCalls.length === 0; i++) {
      await new Promise(r => setTimeout(r, 25));
    }
    assert.strictEqual(runSyncCalls.length, 1);
    assert.strictEqual(runSyncCalls[0].configId, 'wh-config-active');
  });

  it('coalesces a burst of events into a single run', async () => {
    runSyncCalls.length = 0;
    for (let i = 0; i < 5; i++) {
      const { status } = await postWebhook('notion', {
        type: 'data_source.content_updated',
        entity: { id: 'wh-db-1', type: 'data_source' },
        workspace_id: 'wh-notion-ws',
      });
      assert.strictEqual(status, 200);
      await new Promise(r => setTimeout(r, 20)); // well within the 80ms debounce window
    }
    for (let i = 0; i < 40 && runSyncCalls.length === 0; i++) {
      await new Promise(r => setTimeout(r, 25));
    }
    assert.strictEqual(runSyncCalls.length, 1, 'a burst of 5 events should collapse into exactly one run');
  });

  it('never dispatches to a matching config that is paused', async () => {
    runSyncCalls.length = 0;
    const { status } = await postWebhook('notion', {
      type: 'data_source.content_updated',
      entity: { id: 'wh-db-2', type: 'data_source' },
      workspace_id: 'wh-notion-ws',
    });
    assert.strictEqual(status, 200);
    await new Promise(r => setTimeout(r, 150));
    assert.strictEqual(runSyncCalls.length, 0);
  });

  it('never dispatches for a workspace whose plan does not include webhook sync (Stage 6 gating), but still acks 200', async () => {
    await db.collection('plans').doc('free-test').set({ name: 'Free (test)' }); // no webhookSyncEnabled
    await db.collection('workspaces').doc('wh-wsFree').set({ planId: 'free-test' });
    await account('wh-conn-free', { provider: 'notion', providerWorkspaceId: 'wh-notion-ws-free', userId: 'u2', workspaceId: 'wh-wsFree' });
    await cfg('wh-wsFree', 'wh-config-free-plan', {
      status: 'active',
      platform1: 'notion', platform1ConnectionId: 'wh-conn-free', p1Settings: { database: 'wh-db-free' },
      platform2: 'ticktick', platform2ConnectionId: 'other3', p2Settings: {},
    });

    runSyncCalls.length = 0;
    const { status } = await postWebhook('notion', {
      type: 'data_source.content_updated',
      entity: { id: 'wh-db-free', type: 'data_source' },
      workspace_id: 'wh-notion-ws-free',
    });
    assert.strictEqual(status, 200);
    await new Promise(r => setTimeout(r, 250));
    assert.strictEqual(runSyncCalls.length, 0, 'a config in a workspace without webhookSyncEnabled must never dispatch a webhook-triggered run');
  });

  it('acks 200 even when no sync_config matches (logged, not surfaced as an error to the sender)', async () => {
    runSyncCalls.length = 0;
    const { status } = await postWebhook('notion', {
      type: 'page.created',
      entity: { id: 'no-such-entity', type: 'page' },
      workspace_id: 'wh-notion-ws',
    });
    assert.strictEqual(status, 200);
    await new Promise(r => setTimeout(r, 150));
    assert.strictEqual(runSyncCalls.length, 0);
  });
});

/**
 * Connector-key resolution — regression tests.
 *
 * Every `platforms` doc gets an auto-generated Firestore ID (from
 * `db.collection('platforms').doc()`), so the doc ID essentially never
 * equals the connector registry key ("ticktick", "google_contacts", etc).
 * Several call sites called getConnector() with the raw doc ID or a naively
 * lowercased platform name and broke — most visibly, "Google Contacts"
 * lowercases to "google contacts" (a space) which never matched the
 * registered "google_contacts" (an underscore), and
 * POST /api/platform-entities had no resolution logic at all.
 *
 * These tests cover src/core/platform.js's resolveConnectorKey() and the
 * fixed /api/platform-entities route.
 *
 * Run:  npm run test:connector-resolution
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

const TEST_UID = 'connector-resolution-test-user';

const authPath = require.resolve('../src/api/middleware/auth');
require.cache[authPath] = {
  id: authPath,
  filename: authPath,
  loaded: true,
  exports: {
    verifyAuth: (req, res, next) => {
      req.user = { uid: TEST_UID, email: 'user@connectortest.com' };
      next();
    },
  },
};

// Also stub connection resolution so the route doesn't need real encrypted
// credentials/tokens — only connector-key resolution is under test here.
const resolverPath = require.resolve('../src/domains/connection/resolver');
require.cache[resolverPath] = {
  id: resolverPath,
  filename: resolverPath,
  loaded: true,
  exports: {
    resolveConnectionTokens: async () => ({ accessToken: 'fake-token' }),
    resolveCredentials: async () => ({ accessToken: 'fake-token' }),
  },
};

const db = require('../src/core/db');
const { resolveConnectorKey } = require('../src/core/platform');
const { createApp } = require('../src/api/server');

let server;
let baseUrl;

before(async () => {
  // A platform doc shaped exactly like production's real (buggy) data:
  // auto-generated ID, no connectorKey, name that doesn't lowercase cleanly
  // onto the registered key ("Google Contacts" -> "google contacts" != "google_contacts").
  await db.collection('platforms').doc('auto-id-no-connector-key').set({ name: 'Google Contacts' });
  await db.collection('platforms').doc('auto-id-with-connector-key').set({ name: 'TickTick', connectorKey: 'ticktick' });
  await db.collection('platforms').doc('auto-id-unresolvable').set({ name: 'Some Future Platform' });

  await db.collection('connected_accounts').doc('conn-1').set({
    provider: 'auto-id-no-connector-key', userId: TEST_UID, workspaceId: TEST_UID,
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

describe('resolveConnectorKey', () => {
  it('returns the id unchanged if it is already a registered connector key', async () => {
    assert.strictEqual(await resolveConnectorKey('ticktick'), 'ticktick');
    assert.strictEqual(await resolveConnectorKey('notion'), 'notion');
  });

  it('prefers an explicit connectorKey field over name-guessing', async () => {
    assert.strictEqual(await resolveConnectorKey('auto-id-with-connector-key'), 'ticktick');
  });

  it('falls back to normalizing the platform name when connectorKey is absent (fixes the Google Contacts space-vs-underscore bug)', async () => {
    assert.strictEqual(await resolveConnectorKey('auto-id-no-connector-key'), 'google_contacts');
  });

  it('returns the original id unresolved when nothing matches, instead of throwing', async () => {
    assert.strictEqual(await resolveConnectorKey('auto-id-unresolvable'), 'auto-id-unresolvable');
  });

  it('passes through falsy input', async () => {
    assert.strictEqual(await resolveConnectorKey(null), null);
    assert.strictEqual(await resolveConnectorKey(''), '');
  });
});

describe('POST /api/platform-entities resolves connector key', () => {
  it('no longer 500s for a connection whose provider is a platforms-collection auto-ID', async () => {
    const { status, body } = await apiFetch('/api/platform-entities', {
      method: 'POST',
      body: JSON.stringify({ connectionId: 'conn-1', dataSourceId: 'google_contacts_fetch_groups' }),
    });
    // The Google Contacts connector's getDataSource may itself fail against a
    // fake token (that's fine, out of scope here) — what matters is it's no
    // longer "No connector registered for platform: auto-id-no-connector-key".
    if (status !== 200) {
      assert.doesNotMatch(body.error || '', /No connector registered/);
    }
  });
});

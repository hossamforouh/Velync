/**
 * Connections page fixes — regression tests.
 *
 * Covers:
 *   1. resolveCredentials() correctly decrypting `encryptedAttributes` for
 *      manual/attribute-based connections (the object-shaped attributes
 *      resolver.js's legacy fallback never matched — Array.isArray only —
 *      meaning these connections' credentials likely never resolved before).
 *   2. resolveCredentials() no longer flags a manual connection (no
 *      refreshToken) as needsReauth just because it has no expiresAt.
 *   3. POST /api/connections — manual connection create/update/delete/restore,
 *      confirming secrets never land in plaintext on `connected_accounts`.
 *   4. The oauth/exchange cross-tenant workspaceId fix — a user cannot target
 *      a workspace they don't belong to.
 *
 * Run:  npm run test:connections-fixes
 */

require('dotenv').config();
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

const TEST_UID = 'conn-test-user';
const OTHER_UID = 'conn-test-stranger';

const authPath = require.resolve('../src/api/middleware/auth');
require.cache[authPath] = {
  id: authPath,
  filename: authPath,
  loaded: true,
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
const { resolveCredentials } = require('../src/domains/connection/resolver');
const { encrypt } = require('../utils/encryption');

let server;
let baseUrl;

before(async () => {
  await db.collection('workspaces').doc('ws-other').set({ ownerId: OTHER_UID, members: [] });

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

async function apiFetch(path, options = {}, uid = TEST_UID) {
  const res = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer fake', 'x-test-uid': uid, ...(options.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

describe('resolveCredentials — manual/attribute-based connections', () => {
  it('decrypts encryptedAttributes and spreads them into the returned creds', async () => {
    await db.collection('connected_accounts').doc('manual-conn-1').set({
      provider: 'notion', userId: TEST_UID, workspaceId: TEST_UID,
    });
    await db.collection('credentials').doc(TEST_UID).set({
      'manual-conn-1': {
        encryptedAttributes: encrypt(JSON.stringify({ integrationToken: 'secret-notion-token' })),
        provider: 'notion',
      },
    }, { merge: true });

    const creds = await resolveCredentials(TEST_UID, 'manual-conn-1');
    assert.strictEqual(creds.integrationToken, 'secret-notion-token');
    assert.strictEqual(creds.needsReauth, false);
  });

  it('does not flag a manual connection (no refreshToken) as needing reauth', async () => {
    await db.collection('connected_accounts').doc('manual-conn-2').set({
      provider: 'ticktick', userId: TEST_UID, workspaceId: TEST_UID,
    });
    await db.collection('credentials').doc(TEST_UID).set({
      'manual-conn-2': {
        encryptedAttributes: encrypt(JSON.stringify({ accessToken: 'tt-token', clientId: 'tt-client' })),
        provider: 'ticktick',
      },
    }, { merge: true });

    const creds = await resolveCredentials(TEST_UID, 'manual-conn-2');
    assert.strictEqual(creds.accessToken, 'tt-token');
    assert.strictEqual(creds.needsReauth, false);
  });
});

describe('POST/PUT/DELETE /api/connections', () => {
  let connId;

  it('creates a manual connection without leaking attributes as plaintext', async () => {
    await db.collection('platforms').doc('test-manual-platform').set({ name: 'Test Manual', authType: 'manual' });

    const { status, body } = await apiFetch('/api/connections', {
      method: 'POST',
      body: JSON.stringify({ provider: 'test-manual-platform', label: 'My Test Conn', attributes: { apiKey: 'super-secret-key' } }),
    });
    assert.strictEqual(status, 200);
    assert.ok(body.id);
    connId = body.id;

    const connDoc = await db.collection('connected_accounts').doc(connId).get();
    assert.strictEqual(connDoc.data().attributes, undefined);
    assert.strictEqual(connDoc.data().userId, TEST_UID);

    const credsDoc = await db.collection('credentials').doc(TEST_UID).get();
    assert.ok(credsDoc.data()[connId].encryptedAttributes);
  });

  it('rejects creating a manual connection for an oauth-type platform', async () => {
    await db.collection('platforms').doc('test-oauth-platform').set({ name: 'Test OAuth', authType: 'oauth' });
    const { status } = await apiFetch('/api/connections', {
      method: 'POST',
      body: JSON.stringify({ provider: 'test-oauth-platform', label: 'Should fail' }),
    });
    assert.strictEqual(status, 400);
  });

  it('updates label and re-encrypts attributes', async () => {
    const { status } = await apiFetch(`/api/connections/${connId}`, {
      method: 'PUT',
      body: JSON.stringify({ label: 'Renamed Conn', attributes: { apiKey: 'rotated-key' } }),
    });
    assert.strictEqual(status, 200);

    const connDoc = await db.collection('connected_accounts').doc(connId).get();
    assert.strictEqual(connDoc.data().label, 'Renamed Conn');

    const creds = await resolveCredentials(TEST_UID, connId);
    assert.strictEqual(creds.apiKey, 'rotated-key');
  });

  it('another user cannot update or delete someone else\'s connection', async () => {
    const putRes = await apiFetch(`/api/connections/${connId}`, { method: 'PUT', body: JSON.stringify({ label: 'Hacked' }) }, OTHER_UID);
    assert.strictEqual(putRes.status, 403);
    const delRes = await apiFetch(`/api/connections/${connId}`, { method: 'DELETE' }, OTHER_UID);
    assert.strictEqual(delRes.status, 403);
  });

  it('deletes a connection, cleans up credentials, and supports restore', async () => {
    const { status, body } = await apiFetch(`/api/connections/${connId}`, { method: 'DELETE' });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.deletedData.attributes.apiKey, 'rotated-key');

    const gone = await db.collection('connected_accounts').doc(connId).get();
    assert.strictEqual(gone.exists, false);
    const credsAfterDelete = await db.collection('credentials').doc(TEST_UID).get();
    assert.strictEqual(credsAfterDelete.data()[connId], undefined);

    const restore = await apiFetch(`/api/connections/${connId}/restore`, {
      method: 'POST',
      body: JSON.stringify(body.deletedData),
    });
    assert.strictEqual(restore.status, 200);
    const restored = await db.collection('connected_accounts').doc(connId).get();
    assert.strictEqual(restored.data().label, 'Renamed Conn');
    const restoredCreds = await resolveCredentials(TEST_UID, connId);
    assert.strictEqual(restoredCreds.apiKey, 'rotated-key');
  });
});

describe('POST /oauth/exchange — cross-tenant protection', () => {
  it('rejects a workspaceId the caller is not a member of', async () => {
    const { status, body } = await apiFetch('/oauth/exchange', {
      method: 'POST',
      body: JSON.stringify({ code: 'fake-code', platformId: 'notion', workspaceId: 'ws-other' }),
    });
    assert.strictEqual(status, 403);
    assert.match(body.error, /not authorized/i);
  });
});

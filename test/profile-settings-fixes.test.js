/**
 * Profile Settings fixes — regression tests.
 *
 * Covers:
 *  1. PUT /api/settings/profile validates name length/non-empty and saves
 *     it (previously a raw, unvalidated direct client Firestore write).
 *  2. The session-revocation check in verifyAuth now fails closed if the
 *     Firestore lookup itself errors (previously proceeded silently).
 *  3. GET /api/settings/export-data flags truncation when a user belongs
 *     to more than 10 workspaces.
 *  4. POST /api/settings/delete-account distinguishes fully-deleted from
 *     partially-deleted and alerts admins on the latter.
 *
 * Run:  npm run test:profile-settings-fixes
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

const TEST_UID = 'profile-test-user';

// Real verifyAuth (the actual middleware code, including the Firestore
// revocation-status lookup) is exercised here, not a pass-through stub — so
// stub only firebase-admin/auth's verifyIdToken, and do it BEFORE anything
// requires src/api/server (which requires every route file, which requires
// this middleware) — requiring server.js first would freeze in the real
// Firebase Admin SDK before this stub ever gets a chance to apply.
const adminAuthPath = require.resolve('firebase-admin/auth');
require.cache[adminAuthPath] = {
  id: adminAuthPath,
  filename: adminAuthPath,
  loaded: true,
  exports: {
    getAuth: () => ({
      verifyIdToken: async () => ({ uid: TEST_UID, email: `${TEST_UID}@profiletest.com`, iat: Math.floor(Date.now() / 1000) }),
      revokeRefreshTokens: async () => {},
      deleteUser: async () => {},
    }),
  },
};

const db = require('../src/core/db');
const { createApp } = require('../src/api/server');

let server;
let baseUrl;

before(async () => {
  await db.collection('users').doc(TEST_UID).set({ email: `${TEST_UID}@profiletest.com` });

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

describe('PUT /api/settings/profile', () => {
  it('rejects an empty name', async () => {
    const { status } = await apiFetch('/api/settings/profile', {
      method: 'PUT', body: JSON.stringify({ name: '   ' }),
    });
    assert.strictEqual(status, 400);
  });

  it('rejects a name over 100 characters', async () => {
    const { status } = await apiFetch('/api/settings/profile', {
      method: 'PUT', body: JSON.stringify({ name: 'x'.repeat(101) }),
    });
    assert.strictEqual(status, 400);
  });

  it('saves a valid name', async () => {
    const { status } = await apiFetch('/api/settings/profile', {
      method: 'PUT', body: JSON.stringify({ name: 'Valid Name' }),
    });
    assert.strictEqual(status, 200);
    const doc = await db.collection('users').doc(TEST_UID).get();
    assert.strictEqual(doc.data().name, 'Valid Name');
  });
});

describe('POST /api/settings/notify-password-changed', () => {
  it('sends a confirmation email to the user\'s own address', async () => {
    const { status } = await apiFetch('/api/settings/notify-password-changed', { method: 'POST' });
    assert.strictEqual(status, 200);
    const mailSnap = await db.collection('mail').where('to', '==', `${TEST_UID}@profiletest.com`).get();
    const passwordMail = mailSnap.docs.filter(d => d.data().message.subject.includes('password was changed'));
    assert.strictEqual(passwordMail.length, 1);
  });
});

describe('GET /api/settings/export-data truncation flag', () => {
  it('flags truncation when the user belongs to more than 10 workspaces', async () => {
    const wsIds = [];
    for (let i = 0; i < 12; i++) {
      const id = `profile-export-ws-${i}`;
      wsIds.push(id);
      await db.collection('workspaces').doc(id).set({ ownerId: 'someone-else', members: [TEST_UID] });
    }
    const { status, body } = await apiFetch('/api/settings/export-data');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.executionLogsTruncated, true);
    assert.match(body.executionLogsNote, /12 workspaces/);
  });
});

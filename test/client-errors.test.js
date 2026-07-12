/**
 * Client Errors Route Test Suite
 *
 * Verifies the frontend-error-reporting pipeline: the public POST endpoint
 * (no auth — errors can happen before login) and the superadmin-only
 * resolve/delete actions. Runs the real Express app against the Firestore
 * emulator, with only verifyAuth stubbed (via require.cache injection), same
 * pattern as test/admin-platforms.test.js.
 *
 * Run:  npx firebase emulators:exec --only firestore "node --test test/client-errors.test.js"
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

const TEST_UID = 'client-errors-test-superadmin';

const authPath = require.resolve('../src/api/middleware/auth');
require.cache[authPath] = {
  id: authPath,
  filename: authPath,
  loaded: true,
  exports: {
    // x-test-uid header lets individual tests impersonate a non-superadmin
    // to exercise the requireSuperAdmin rejection path; defaults to the
    // seeded superadmin for everything else.
    verifyAuth: (req, res, next) => {
      const uid = req.headers['x-test-uid'] || TEST_UID;
      req.user = { uid, email: `${uid}@test.com` };
      next();
    },
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

describe('POST /api/client-errors', () => {
  it('works with no Authorization header at all (errors can happen before login)', async () => {
    const res = await fetch(`${baseUrl}/api/client-errors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Pre-login crash', url: 'https://velync.web.app/' }),
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.success, true);
  });

  it('stores message/stack/url/userAgent/uid/workspaceId and defaults resolved to false', async () => {
    const { status, body } = await apiFetch('/api/client-errors', {
      method: 'POST',
      body: JSON.stringify({
        message: 'TypeError: x is not a function',
        stack: 'TypeError: x is not a function\n  at foo (app.js:1:1)',
        url: 'https://velync.web.app/settings',
        userAgent: 'test-agent',
        uid: 'some-real-user-uid',
        workspaceId: 'some-workspace-id',
        type: 'error',
      }),
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.success, true);

    const snap = await db.collection('client_errors')
      .where('message', '==', 'TypeError: x is not a function').limit(1).get();
    assert.strictEqual(snap.empty, false);
    const doc = snap.docs[0].data();
    assert.strictEqual(doc.uid, 'some-real-user-uid');
    assert.strictEqual(doc.workspaceId, 'some-workspace-id');
    assert.strictEqual(doc.resolved, false);
    assert.ok(doc.stack.includes('at foo'));
  });

  it('truncates absurdly long fields instead of erroring', async () => {
    // A distinct short prefix marks the doc for lookup — Firestore rejects
    // equality queries on values over ~1500 bytes, so we can't query on the
    // 5000-char string itself even after truncation to 2000.
    const marker = 'TRUNCATION_TEST_MARKER_' + Date.now();
    const longMsg = marker + 'x'.repeat(5000);
    const { status, body } = await apiFetch('/api/client-errors', {
      method: 'POST',
      body: JSON.stringify({ message: longMsg, stack: 'y'.repeat(5000) }),
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.success, true);

    const snap = await db.collection('client_errors').orderBy('createdAt', 'desc').limit(1).get();
    assert.strictEqual(snap.empty, false);
    const doc = snap.docs[0].data();
    assert.ok(doc.message.startsWith(marker));
    assert.strictEqual(doc.message.length, 2000);
    assert.strictEqual(doc.stack.length, 2000);
  });

  it('rejects a missing message with 400', async () => {
    const { status } = await apiFetch('/api/client-errors', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    assert.strictEqual(status, 400);
  });

  it('ignores a non-string uid/workspaceId rather than storing garbage', async () => {
    const { status } = await apiFetch('/api/client-errors', {
      method: 'POST',
      body: JSON.stringify({ message: 'weird payload', uid: { hack: true }, workspaceId: 12345 }),
    });
    assert.strictEqual(status, 200);

    const snap = await db.collection('client_errors')
      .where('message', '==', 'weird payload').limit(1).get();
    assert.strictEqual(snap.docs[0].data().uid, null);
    assert.strictEqual(snap.docs[0].data().workspaceId, null);
  });
});

describe('PATCH /api/admin/client-errors/:id/resolved', () => {
  let errorId;

  before(async () => {
    const ref = await db.collection('client_errors').add({
      message: 'to be resolved', createdAt: new Date(), resolved: false,
    });
    errorId = ref.id;
  });

  it('non-superadmin gets 403', async () => {
    const { status } = await apiFetch(`/api/admin/client-errors/${errorId}/resolved`, {
      method: 'PATCH',
      headers: { 'x-test-uid': 'not-a-superadmin' },
      body: JSON.stringify({ resolved: true }),
    });
    assert.strictEqual(status, 403);
  });

  it('superadmin can mark resolved and reopen', async () => {
    let res = await apiFetch(`/api/admin/client-errors/${errorId}/resolved`, {
      method: 'PATCH',
      body: JSON.stringify({ resolved: true }),
    });
    assert.strictEqual(res.status, 200);
    let doc = await db.collection('client_errors').doc(errorId).get();
    assert.strictEqual(doc.data().resolved, true);

    res = await apiFetch(`/api/admin/client-errors/${errorId}/resolved`, {
      method: 'PATCH',
      body: JSON.stringify({ resolved: false }),
    });
    assert.strictEqual(res.status, 200);
    doc = await db.collection('client_errors').doc(errorId).get();
    assert.strictEqual(doc.data().resolved, false);
  });

  it('404s for a nonexistent id', async () => {
    const { status } = await apiFetch('/api/admin/client-errors/does-not-exist/resolved', {
      method: 'PATCH',
      body: JSON.stringify({ resolved: true }),
    });
    assert.strictEqual(status, 404);
  });
});

describe('DELETE /api/admin/client-errors/:id', () => {
  it('non-superadmin gets 403', async () => {
    const ref = await db.collection('client_errors').add({ message: 'x', createdAt: new Date(), resolved: false });
    const { status } = await apiFetch(`/api/admin/client-errors/${ref.id}`, {
      method: 'DELETE',
      headers: { 'x-test-uid': 'not-a-superadmin' },
    });
    assert.strictEqual(status, 403);
  });

  it('superadmin can delete', async () => {
    const ref = await db.collection('client_errors').add({ message: 'to delete', createdAt: new Date(), resolved: false });
    const { status } = await apiFetch(`/api/admin/client-errors/${ref.id}`, { method: 'DELETE' });
    assert.strictEqual(status, 200);
    const doc = await db.collection('client_errors').doc(ref.id).get();
    assert.strictEqual(doc.exists, false);
  });
});

/**
 * verifyAuth session-revocation check — fails closed on lookup errors.
 *
 * Isolated into its own process/file because it stubs firebase-admin/auth
 * and core/db via require.cache injection to simulate a Firestore outage —
 * keeping that separate from any test file that spins up a real HTTP server
 * against the real (or differently-stubbed) db avoids any cross-contamination.
 *
 * Run:  npm run test:auth-fail-closed
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');

const adminAuthPath = require.resolve('firebase-admin/auth');
require.cache[adminAuthPath] = {
  id: adminAuthPath, filename: adminAuthPath, loaded: true,
  exports: {
    getAuth: () => ({
      verifyIdToken: async () => ({ uid: 'whoever', iat: Math.floor(Date.now() / 1000) }),
    }),
  },
};

const dbPath = require.resolve('../src/core/db');
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: {
    collection: () => ({
      doc: () => ({ get: async () => { throw new Error('simulated Firestore outage'); } }),
    }),
  },
};

const { verifyAuth } = require('../src/api/middleware/auth');

describe('verifyAuth fails closed on session-revocation check errors', () => {
  it('rejects the request (401) if the Firestore lookup itself throws, instead of proceeding', async () => {
    let statusCode = null, body = null;
    const req = { headers: { authorization: 'Bearer fake' } };
    const res = {
      status(code) { statusCode = code; return this; },
      json(payload) { body = payload; return this; },
    };
    let nextCalled = false;
    await verifyAuth(req, res, () => { nextCalled = true; });

    assert.strictEqual(nextCalled, false, 'next() must not be called when the revocation check errors');
    assert.strictEqual(statusCode, 401);
    assert.ok(body.error);
  });
});

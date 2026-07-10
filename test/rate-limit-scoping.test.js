/**
 * Regression test for a real rate-limiter scoping bug found while migrating
 * sync-configs.js: `app.use('/api', authLimiter, platformRoutes)` in
 * server.js mounted a 20-req/min limiter at the '/api' path PREFIX — since
 * Express's app.use(path, ...) matches by prefix, that limiter counted
 * EVERY '/api/*' request in the whole app (any request reaching that
 * middleware, whether or not platformRoutes had a matching sub-route for
 * it), not just platformRoutes' own two endpoints (/data-sources,
 * /platform-entities). A normal page load easily exceeds 20 total API
 * calls, so this was a real, silent production ceiling on ALL API traffic,
 * not just platform-entity fetches. Fixed by moving the limiter into
 * platform.js itself, applied directly to its own two routes only.
 *
 * Run:  npm run test:rate-limit-scoping
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

const TEST_UID = 'ratelimit-test-user';

const authPath = require.resolve('../src/api/middleware/auth');
require.cache[authPath] = {
  id: authPath,
  filename: authPath,
  loaded: true,
  exports: {
    verifyAuth: (req, res, next) => {
      req.user = { uid: TEST_UID, email: `${TEST_UID}@ratelimittest.com` };
      next();
    },
  },
};

const db = require('../src/core/db');
const { createApp } = require('../src/api/server');

let server;
let baseUrl;

before(async () => {
  await db.collection('users').doc(TEST_UID).set({ workspaceId: TEST_UID, email: `${TEST_UID}@ratelimittest.com` });
  await db.collection('workspaces').doc(TEST_UID).set({ ownerId: TEST_UID, members: [TEST_UID], planId: 'free' });

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

describe('the platform-entities rate limiter no longer applies to unrelated /api routes', () => {
  it('25 consecutive GET /api/sync-configs requests (more than platformLimiter\'s 20/min) all succeed', async () => {
    for (let i = 0; i < 25; i++) {
      const res = await fetch(`${baseUrl}/api/sync-configs`, {
        headers: { 'Authorization': 'Bearer fake' },
      });
      assert.strictEqual(res.status, 200, `request ${i + 1} of 25 should not be rate-limited`);
    }
  });
});

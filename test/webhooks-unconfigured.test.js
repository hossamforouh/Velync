/**
 * Webhook ingress — unconfigured-secret fail-closed behavior.
 *
 * Separate process/file from webhooks.test.js specifically because
 * NOTION_WEBHOOK_SECRET must be left UNSET here (config.js reads it once at
 * require-time) to verify the route fails closed (503, not a crash or an
 * accidental pass-through) when Stage 5's runbook hasn't been completed yet
 * for this environment.
 *
 * Runs against the Firestore emulator (see the test:webhooks-unconfigured
 * script) AND stubs notifyAdmins — belt and suspenders. Without both, this
 * file previously reached real production Firestore/email: this repo has no
 * FIRESTORE_EMULATOR_HOST set by default, src/core/db.js falls back to
 * whatever project gcloud's ADC currently points at (which was production,
 * not staging, when this was first written), and the verification-handshake
 * path calls the real notifyAdmins() — which reads real superadmins/users
 * and writes a real `mail` doc that the Trigger Email extension actually
 * sends. That happened once for real (a real email to a real inbox) before
 * this fix; never remove either safeguard.
 *
 * Run:  npm run test:webhooks-unconfigured
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

delete process.env.NOTION_WEBHOOK_SECRET;

const notificationsPath = require.resolve('../src/core/notifications');
require.cache[notificationsPath] = {
  id: notificationsPath,
  filename: notificationsPath,
  loaded: true,
  exports: {
    notifyAdmins: async () => {},
    notifySyncFailure: async () => {},
  },
};

const { createApp } = require('../src/api/server');

let server;
let baseUrl;

before(async () => {
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

describe('POST /api/webhooks/notion with no NOTION_WEBHOOK_SECRET configured', () => {
  it('fails closed with 503 rather than accepting unverifiable events', async () => {
    const raw = JSON.stringify({ type: 'page.created', entity: { id: 'x', type: 'page' }, workspace_id: 'w' });
    const res = await fetch(`${baseUrl}/api/webhooks/notion`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: raw,
    });
    assert.strictEqual(res.status, 503);
  });

  it('still processes the one-time verification handshake even with no secret configured yet', async () => {
    // Regression test: the handshake is the exact mechanism that PRECEDES
    // having a secret (Notion sends verification_token before revealing the
    // signing secret) — an earlier version of this route checked
    // "is a secret configured?" before checking "is this a handshake?",
    // which 503'd the handshake itself and silently dropped it before it
    // was ever logged/emailed. Caught by checking real staging logs after
    // deploy: only "No webhook secret configured" ever appeared, never
    // "Verification handshake received".
    const raw = JSON.stringify({ verification_token: 'tok_regression_test' });
    const res = await fetch(`${baseUrl}/api/webhooks/notion`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: raw,
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.received, true);
  });
});

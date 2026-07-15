/**
 * Webhook debounce/coalescing — Stage 4 (WEBHOOK_SYNC_PLAN.md §5).
 *
 * Tests scheduleDebouncedRun() directly against the Firestore emulator, with
 * runSync stubbed so timing/coalescing behavior can be asserted precisely
 * without a real sync execution in the loop.
 *
 * Run:  npm run test:webhook-debounce
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');

const runSyncCalls = [];
const enginePath = require.resolve('../src/domains/sync/engine');
require.cache[enginePath] = {
  id: enginePath,
  filename: enginePath,
  loaded: true,
  exports: {
    runSync: async (data, configId) => {
      runSyncCalls.push({ configId, data });
      return {};
    },
    retryWithBackoff: async (fn) => ({ result: await fn(), recovered: false }),
  },
};

const db = require('../src/core/db');
const { scheduleDebouncedRun } = require('../src/domains/sync/webhookDebounce');

const DEBOUNCE_MS = 80;

function cfg(workspaceId, configId, data) {
  return db.collection('workspaces').doc(workspaceId).collection('sync_configs').doc(configId).set(data);
}

async function waitFor(predicate, { timeoutMs = 1000, stepMs = 20 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise(r => setTimeout(r, stepMs));
  }
  return predicate();
}

beforeEach(() => {
  runSyncCalls.length = 0;
});

describe('scheduleDebouncedRun', () => {
  it('fires exactly one run after the debounce window for a single event', async () => {
    await cfg('db-wsA', 'db-config-1', { status: 'active', description: 'one' });
    await scheduleDebouncedRun('db-wsA', 'db-config-1', DEBOUNCE_MS);

    // Should NOT have fired immediately.
    assert.strictEqual(runSyncCalls.length, 0);

    const fired = await waitFor(() => runSyncCalls.length === 1);
    assert.ok(fired, 'expected exactly one run to fire after the debounce window');
    assert.strictEqual(runSyncCalls[0].configId, 'db-config-1');
  });

  it('coalesces repeated calls within the window into a single run', async () => {
    await cfg('db-wsA', 'db-config-2', { status: 'active', description: 'burst' });
    for (let i = 0; i < 4; i++) {
      await scheduleDebouncedRun('db-wsA', 'db-config-2', DEBOUNCE_MS);
      await new Promise(r => setTimeout(r, DEBOUNCE_MS / 3));
    }
    const fired = await waitFor(() => runSyncCalls.length >= 1, { timeoutMs: 1200 });
    assert.ok(fired);
    // Give any (incorrect) second run a chance to appear before asserting.
    await new Promise(r => setTimeout(r, 150));
    assert.strictEqual(runSyncCalls.length, 1, 'a burst of overlapping events should produce exactly one run');
  });

  it('clears webhookPendingUntil once fired', async () => {
    await cfg('db-wsA', 'db-config-3', { status: 'active' });
    await scheduleDebouncedRun('db-wsA', 'db-config-3', DEBOUNCE_MS);
    await waitFor(() => runSyncCalls.length === 1);
    await new Promise(r => setTimeout(r, 50)); // let the post-fire update settle
    const snap = await db.collection('workspaces').doc('db-wsA').collection('sync_configs').doc('db-config-3').get();
    assert.strictEqual(snap.data().webhookPendingUntil, null);
  });

  it('skips firing if the config is no longer active by the time the window elapses', async () => {
    await cfg('db-wsA', 'db-config-4', { status: 'active' });
    await scheduleDebouncedRun('db-wsA', 'db-config-4', DEBOUNCE_MS);
    // Pause it mid-window — the debounce loop re-reads status at fire time.
    await new Promise(r => setTimeout(r, DEBOUNCE_MS / 2));
    await db.collection('workspaces').doc('db-wsA').collection('sync_configs').doc('db-config-4').update({ status: 'paused' });

    await new Promise(r => setTimeout(r, DEBOUNCE_MS + 200));
    assert.strictEqual(runSyncCalls.length, 0);
  });

  it('is a no-op for a nonexistent config (no throw)', async () => {
    await assert.doesNotReject(scheduleDebouncedRun('db-wsA', 'no-such-config', DEBOUNCE_MS));
  });
});

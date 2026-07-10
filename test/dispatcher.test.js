/**
 * Scheduler Dispatcher Test Suite
 *
 * Verifies selectDueConfigs() against the Firestore emulator: it should return
 * only ACTIVE configs whose schedule has elapsed since their last run.
 *
 * Run:  npm run test:dispatcher
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert');

const db = require('../src/core/db');
const { selectDueConfigs, mapConcurrent } = require('../src/domains/sync/dispatcher');

const NOW = new Date('2026-07-06T12:00:30.000Z');

function cfg(workspaceId, configId, data) {
  return db.collection('workspaces').doc(workspaceId).collection('sync_configs').doc(configId).set(data);
}

before(async () => {
  await cfg('wsA', 'never', { status: 'active', cronSchedule: '*/5 * * * *' }); // never run → due
  await cfg('wsA', 'stale', { status: 'active', cronSchedule: '*/5 * * * *', lastRunAt: '2026-07-06T11:00:00.000Z' }); // long ago → due
  await cfg('wsB', 'fresh', { status: 'active', cronSchedule: '*/5 * * * *', lastRunAt: '2026-07-06T12:00:10.000Z' }); // after last boundary → NOT due
  await cfg('wsB', 'draft', { status: 'draft', cronSchedule: '*/5 * * * *' }); // not active → excluded
  await cfg('wsB', 'hourly-notdue', { status: 'active', cronSchedule: '0 * * * *', lastRunAt: '2026-07-06T12:00:05.000Z' }); // ran this hour → NOT due
});

describe('selectDueConfigs', () => {
  it('returns only active configs whose schedule has elapsed', async () => {
    const due = await selectDueConfigs(NOW);
    const ids = due.map(d => d.configId).sort();
    assert.deepStrictEqual(ids, ['never', 'stale']);
  });

  it('includes config data alongside the id', async () => {
    const due = await selectDueConfigs(NOW);
    const never = due.find(d => d.configId === 'never');
    assert.ok(never);
    assert.strictEqual(never.config.status, 'active');
  });
});

describe('mapConcurrent (bounded-parallel tick execution)', () => {
  it('runs every item exactly once', async () => {
    const items = Array.from({ length: 25 }, (_, i) => i);
    const seen = [];
    await mapConcurrent(items, 10, async (n) => { seen.push(n); });
    assert.deepStrictEqual(seen.sort((a, b) => a - b), items);
  });

  it('never exceeds the concurrency limit of in-flight tasks', async () => {
    const items = Array.from({ length: 30 }, (_, i) => i);
    let inFlight = 0;
    let maxInFlight = 0;
    await mapConcurrent(items, 5, async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(r => setTimeout(r, 5));
      inFlight--;
    });
    assert.ok(maxInFlight <= 5, `max in-flight was ${maxInFlight}, expected <= 5`);
    assert.ok(maxInFlight > 1, 'expected genuine parallelism, not serial execution');
  });

  it('handles an empty list without spawning workers', async () => {
    let called = false;
    await mapConcurrent([], 10, async () => { called = true; });
    assert.strictEqual(called, false);
  });
});

/**
 * Sync Engine Test Suite
 *
 * Runs the REAL engine (src/domains/sync/engine.js) against the Firestore
 * emulator with in-memory fake connectors. The Admin SDK (new Firestore())
 * auto-connects to the emulator because `firebase emulators:exec` sets
 * FIRESTORE_EMULATOR_HOST for the child process — so no port is hardcoded here.
 *
 * Run:  npm run test:engine
 *   (which is: firebase emulators:exec --only firestore "node --test test/engine.test.js")
 *
 * These tests are a safety net around the mapping-load / deletion-reconciliation
 * behaviour, so the periodic-reconciliation optimisation can be proven safe.
 */

const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert');

const db = require('../src/core/db');
const { Connector } = require('../src/domains/connector/interface');
const { register } = require('../src/domains/connector/registry');
const { runSync } = require('../src/domains/sync/engine');

// ── Shared in-memory stores, keyed by a storeKey passed via connector creds ──
const stores = {};
function resetStores() {
  for (const k of Object.keys(stores)) delete stores[k];
}
function makeStore(key, items = []) {
  stores[key] = {
    items: items.map(i => ({ ...i })),
    created: [], updated: [], deleted: [],
  };
  return stores[key];
}

/** A fake platform connector backed by an in-memory store (creds.storeKey). */
class FakeConnector extends Connector {
  constructor(creds) {
    super(creds);
    this.store = stores[creds.storeKey];
    if (!this.store) throw new Error(`No fake store for key "${creds.storeKey}"`);
  }
  async fetch() { return this.store.items.map(i => ({ ...i })); }
  async fetchIds() { return this.store.items.map(i => ({ id: i.id })); }
  getSchema() { return {}; }
  getDisplayTitle(item) { return item.title || item.name || 'Untitled'; }
  async create(entityType, data) {
    const id = `new_${this.store.created.length + 1}_${Math.random().toString(36).slice(2, 6)}`;
    const item = { id, title: data.title, modifiedTime: new Date().toISOString() };
    this.store.items.push(item);
    this.store.created.push({ id, data });
    return { id, last_edited_time: item.modifiedTime, modifiedTime: item.modifiedTime };
  }
  async update(entityType, id, data) {
    this.store.updated.push({ id, data });
    return { id, last_edited_time: new Date().toISOString() };
  }
  async retrieve(entityType, id) {
    return { last_edited_time: new Date().toISOString() };
  }
  async delete(entityType, id) {
    this.store.deleted.push(id);
    this.store.items = this.store.items.filter(i => i.id !== id);
    return true;
  }
}

// Register the fake under two platform ids. No `platforms` docs are seeded, so
// the engine keeps the platform id as-is (getPlatform returns null) and resolves
// the connector directly from the registry.
before(() => {
  register('fakesrc', FakeConnector);
  register('fakedst', FakeConnector);
});

// Unique ids per test avoid cross-test Firestore pollution (locks/logs/mappings).
let seq = 0;
function ids() {
  seq++;
  return { workspaceId: `ws_${seq}`, configId: `cfg_${seq}` };
}

function mappingsCol(workspaceId, configId) {
  return db.collection('workspaces').doc(workspaceId)
    .collection('sync_configs').doc(configId).collection('sync_mappings');
}

async function seedMapping(workspaceId, configId, mapping) {
  await mappingsCol(workspaceId, configId).doc(mapping.id).set(mapping.data);
}
async function readMappings(workspaceId, configId) {
  const snap = await mappingsCol(workspaceId, configId).get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
function configDoc(workspaceId, configId) {
  return db.collection('workspaces').doc(workspaceId).collection('sync_configs').doc(configId);
}
async function readConfigDoc(workspaceId, configId) {
  const d = await configDoc(workspaceId, configId).get();
  return d.exists ? d.data() : null;
}

function baseConfig(workspaceId, configId, extra = {}) {
  return {
    workspaceId,
    platform1: 'fakesrc', platform2: 'fakedst',
    p1Settings: { storeKey: `${configId}_src`, targetEntity: 'Tasks' },
    p2Settings: { storeKey: `${configId}_dst` },
    syncType: 'Source_to_Dest',
    fieldMappings: [],
    ...extra,
  };
}

beforeEach(resetStores);

describe('sync engine — create/update/delete behaviour', () => {
  it('creates a destination item + mapping for a new source item', async () => {
    const { workspaceId, configId } = ids();
    makeStore(`${configId}_src`, [{ id: 's1', title: 'Alpha', modifiedTime: new Date().toISOString() }]);
    const dst = makeStore(`${configId}_dst`, []);

    const res = await runSync(baseConfig(workspaceId, configId), configId);

    assert.strictEqual(dst.created.length, 1, 'one dest item created');
    assert.strictEqual(res.synced, 1);
    const maps = await readMappings(workspaceId, configId);
    assert.strictEqual(maps.length, 1, 'one mapping persisted');
    assert.strictEqual(maps[0].sourceEntityId, 's1');
  });

  it('updates an existing destination item when the source changed', async () => {
    const { workspaceId, configId } = ids();
    const old = '2020-01-01T00:00:00.000Z';
    makeStore(`${configId}_src`, [{ id: 's1', title: 'Alpha v2', modifiedTime: new Date().toISOString() }]);
    const dst = makeStore(`${configId}_dst`, [{ id: 'd1', title: 'Alpha', modifiedTime: old }]);
    await seedMapping(workspaceId, configId, {
      id: 'm1',
      data: { sourceEntityId: 's1', destEntityId: 'd1', sourceLastModified: old, destLastEdited: old },
    });

    const res = await runSync(baseConfig(workspaceId, configId), configId);

    assert.strictEqual(dst.created.length, 0, 'no new create');
    assert.strictEqual(dst.updated.length, 1, 'existing dest updated');
    assert.strictEqual(dst.updated[0].id, 'd1');
    assert.strictEqual(res.synced, 1);
  });

  it('propagates a source deletion to the destination (reconcile cycle)', async () => {
    const { workspaceId, configId } = ids();
    makeStore(`${configId}_src`, []); // source item removed
    const dst = makeStore(`${configId}_dst`, [{ id: 'd1', title: 'Orphan', modifiedTime: new Date().toISOString() }]);
    await seedMapping(workspaceId, configId, {
      id: 'm1',
      data: { sourceEntityId: 's1', destEntityId: 'd1', sourceLastModified: '2020-01-01T00:00:00.000Z' },
    });

    const res = await runSync(baseConfig(workspaceId, configId), configId);

    assert.strictEqual(dst.deleted.length, 1, 'dest item deleted');
    assert.strictEqual(dst.deleted[0], 'd1');
    assert.strictEqual(res.deleted, 1);
    const maps = await readMappings(workspaceId, configId);
    assert.strictEqual(maps.length, 0, 'stale mapping removed');
  });

  it('handles a no-op cycle without error', async () => {
    const { workspaceId, configId } = ids();
    makeStore(`${configId}_src`, []);
    makeStore(`${configId}_dst`, []);
    const res = await runSync(baseConfig(workspaceId, configId), configId);
    assert.deepStrictEqual(
      { synced: res.synced, deleted: res.deleted, failed: res.failed },
      { synced: 0, deleted: 0, failed: 0 },
    );
  });
});

describe('sync engine — periodic reconciliation optimisation', () => {
  // A config that has "just reconciled", so deletion reconciliation is skipped this run.
  const recent = (workspaceId, configId, extra = {}) => baseConfig(workspaceId, configId, {
    reconcileIntervalMinutes: 60,
    lastReconcileAt: new Date().toISOString(),
    ...extra,
  });

  it('does NOT propagate deletions on a non-reconcile cycle (deferred)', async () => {
    const { workspaceId, configId } = ids();
    makeStore(`${configId}_src`, []); // source item deleted
    const dst = makeStore(`${configId}_dst`, [{ id: 'd1', title: 'Orphan', modifiedTime: new Date().toISOString() }]);
    await seedMapping(workspaceId, configId, {
      id: 'm1', data: { sourceEntityId: 's1', destEntityId: 'd1', sourceLastModified: '2020-01-01T00:00:00.000Z' },
    });

    await runSync(recent(workspaceId, configId), configId);

    assert.strictEqual(dst.deleted.length, 0, 'deletion deferred, not propagated');
    const maps = await readMappings(workspaceId, configId);
    assert.strictEqual(maps.length, 1, 'mapping preserved for next reconcile');
  });

  it('still updates changed items with no duplicate create on a non-reconcile cycle', async () => {
    const { workspaceId, configId } = ids();
    const old = '2020-01-01T00:00:00.000Z';
    makeStore(`${configId}_src`, [{ id: 's1', title: 'Alpha v2', modifiedTime: new Date().toISOString() }]);
    const dst = makeStore(`${configId}_dst`, [{ id: 'd1', title: 'Alpha', modifiedTime: old }]);
    await seedMapping(workspaceId, configId, {
      id: 'm1', data: { sourceEntityId: 's1', destEntityId: 'd1', sourceLastModified: old, destLastEdited: old },
    });

    await runSync(recent(workspaceId, configId), configId);

    assert.strictEqual(dst.created.length, 0, 'targeted load found the mapping — no duplicate');
    assert.strictEqual(dst.updated.length, 1, 'existing dest still updated');
    assert.strictEqual(dst.updated[0].id, 'd1');
  });

  it('propagates deferred deletions once the reconcile interval elapses', async () => {
    const { workspaceId, configId } = ids();
    makeStore(`${configId}_src`, []);
    const dst = makeStore(`${configId}_dst`, [{ id: 'd1', title: 'Orphan', modifiedTime: new Date().toISOString() }]);
    await seedMapping(workspaceId, configId, {
      id: 'm1', data: { sourceEntityId: 's1', destEntityId: 'd1', sourceLastModified: '2020-01-01T00:00:00.000Z' },
    });

    const config = recent(workspaceId, configId, {
      lastReconcileAt: new Date(Date.now() - 61 * 60_000).toISOString(), // 61 min ago → reconcile now
    });
    const res = await runSync(config, configId);

    assert.strictEqual(dst.deleted.length, 1, 'deletion propagated on reconcile cycle');
    assert.strictEqual(res.deleted, 1);
  });

  it('records lastReconcileAt after a reconcile cycle', async () => {
    const { workspaceId, configId } = ids();
    await configDoc(workspaceId, configId).set({ status: 'active' });
    makeStore(`${configId}_src`, [{ id: 's1', title: 'A', modifiedTime: new Date().toISOString() }]);
    makeStore(`${configId}_dst`, []);

    await runSync(baseConfig(workspaceId, configId), configId); // no lastReconcileAt → reconcile

    const doc = await readConfigDoc(workspaceId, configId);
    assert.ok(doc && doc.lastReconcileAt, 'lastReconcileAt persisted to the config doc');
  });
});

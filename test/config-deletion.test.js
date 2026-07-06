/**
 * Config Deletion Test Suite
 *
 * Verifies that deleting a sync config cascades to its sync_mappings subcollection
 * and its lock — preventing orphaned mapping documents (the sync_mappings growth bug).
 *
 * Run:  npm run test:config-deletion
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');

const db = require('../src/core/db');
const { deleteSyncConfig } = require('../src/domains/sync/config-deletion');

let seq = 0;
function ids() {
  seq++;
  return { workspaceId: `wsdel_${seq}`, configId: `cfgdel_${seq}` };
}

function configRef(workspaceId, configId) {
  return db.collection('workspaces').doc(workspaceId).collection('sync_configs').doc(configId);
}

async function seed(workspaceId, configId, mappingCount) {
  await configRef(workspaceId, configId).set({ status: 'active', description: 'to delete' });
  const mappings = configRef(workspaceId, configId).collection('sync_mappings');
  for (let i = 0; i < mappingCount; i++) {
    await mappings.doc(`m${i}`).set({ sourceEntityId: `s${i}`, destEntityId: `d${i}` });
  }
  await db.collection('sync_locks').doc(configId).set({ heldBy: 'x', expiresAt: new Date() });
}

describe('deleteSyncConfig', () => {
  it('deletes the config, all its mappings, and its lock', async () => {
    const { workspaceId, configId } = ids();
    await seed(workspaceId, configId, 5);

    const { deletedMappings } = await deleteSyncConfig(workspaceId, configId);

    assert.strictEqual(deletedMappings, 5);
    assert.strictEqual((await configRef(workspaceId, configId).get()).exists, false, 'config gone');
    const remaining = await configRef(workspaceId, configId).collection('sync_mappings').get();
    assert.strictEqual(remaining.size, 0, 'no orphaned mappings');
    assert.strictEqual((await db.collection('sync_locks').doc(configId).get()).exists, false, 'lock gone');
  });

  it('handles a config with no mappings', async () => {
    const { workspaceId, configId } = ids();
    await configRef(workspaceId, configId).set({ status: 'draft' });

    const { deletedMappings } = await deleteSyncConfig(workspaceId, configId);

    assert.strictEqual(deletedMappings, 0);
    assert.strictEqual((await configRef(workspaceId, configId).get()).exists, false);
  });

  it('deletes mappings across multiple batches (>BATCH_SIZE)', async () => {
    const { workspaceId, configId } = ids();
    // 320 mappings > BATCH_SIZE (300) forces a second batch.
    await configRef(workspaceId, configId).set({ status: 'active' });
    const mappings = configRef(workspaceId, configId).collection('sync_mappings');
    let writer = db.batch();
    for (let i = 0; i < 320; i++) {
      writer.set(mappings.doc(`m${i}`), { sourceEntityId: `s${i}`, destEntityId: `d${i}` });
      if ((i + 1) % 300 === 0) { await writer.commit(); writer = db.batch(); }
    }
    await writer.commit();

    const { deletedMappings } = await deleteSyncConfig(workspaceId, configId);

    assert.strictEqual(deletedMappings, 320);
    assert.strictEqual((await mappings.get()).size, 0);
  });
});

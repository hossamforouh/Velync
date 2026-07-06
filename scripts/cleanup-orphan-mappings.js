#!/usr/bin/env node
/**
 * One-off cleanup: delete orphaned sync_mappings.
 *
 * Before the server-side cascade delete (DELETE /api/sync-configs/:id), configs
 * were deleted client-side, which left their sync_mappings subcollections behind
 * (Firestore does not cascade subcollection deletes). This finds sync_mappings
 * whose parent sync_config no longer exists and deletes them.
 *
 * Safe to re-run. Pass --dry-run to only report counts without deleting.
 *
 * Usage:
 *   node scripts/cleanup-orphan-mappings.js [--dry-run]
 */

require('dotenv').config();
const { Firestore } = require('@google-cloud/firestore');

const db = new Firestore();
const BATCH_SIZE = 300;
const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  console.log(`=== Orphan sync_mappings cleanup ${DRY_RUN ? '(dry run)' : ''} ===\n`);

  // Group every mapping by its parent config path so we check each config once.
  const snap = await db.collectionGroup('sync_mappings').get();
  const byConfig = new Map(); // parentPath -> { ref, docs: [] }
  snap.docs.forEach(d => {
    const configRef = d.ref.parent.parent; // sync_mappings -> {configId} doc
    const key = configRef.path;
    if (!byConfig.has(key)) byConfig.set(key, { ref: configRef, docs: [] });
    byConfig.get(key).docs.push(d.ref);
  });

  console.log(`Scanned ${snap.size} mapping(s) across ${byConfig.size} config(s).`);

  let orphanConfigs = 0;
  let orphanMappings = 0;

  for (const { ref, docs } of byConfig.values()) {
    const parent = await ref.get();
    if (parent.exists) continue; // config still exists → mappings are valid

    orphanConfigs++;
    orphanMappings += docs.length;
    console.log(`  Orphaned config ${ref.path} — ${docs.length} mapping(s)${DRY_RUN ? '' : ' → deleting'}`);

    if (!DRY_RUN) {
      for (let i = 0; i < docs.length; i += BATCH_SIZE) {
        const batch = db.batch();
        docs.slice(i, i + BATCH_SIZE).forEach(r => batch.delete(r));
        await batch.commit();
      }
    }
  }

  console.log(`\nDone. ${orphanConfigs} orphaned config(s), ${orphanMappings} mapping(s) ${DRY_RUN ? 'would be' : ''} deleted.`);
  process.exit(0);
}

main().catch(err => {
  console.error('Cleanup failed:', err.message);
  process.exit(1);
});

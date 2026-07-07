#!/usr/bin/env node
/**
 * One-off migration: move `clientSecret` out of `platforms` docs (readable by
 * any authenticated user) into the new `platform_secrets` collection
 * (Admin SDK only, allow read/write: if false in firestore.rules).
 *
 * Safe to re-run — skips platforms that have no clientSecret field, and
 * skips writing platform_secrets if it already holds the same value.
 *
 * Usage:
 *   node scripts/migrate-platform-secrets.js [--dry-run]
 */

require('dotenv').config();
const { Firestore } = require('@google-cloud/firestore');

const db = new Firestore();
const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  console.log(`=== Platform secrets migration ${DRY_RUN ? '(dry run)' : ''} ===\n`);

  const snap = await db.collection('platforms').get();
  let migrated = 0;
  let skipped = 0;

  for (const doc of snap.docs) {
    const data = doc.data();
    if (!data.clientSecret) {
      skipped++;
      continue;
    }

    console.log(`  ${doc.id} (${data.name || 'unnamed'}) — moving clientSecret${DRY_RUN ? ' (dry run)' : ''}`);

    if (!DRY_RUN) {
      await db.collection('platform_secrets').doc(doc.id).set({ clientSecret: data.clientSecret });
      await doc.ref.update({ clientSecret: Firestore.FieldValue.delete() });
    }
    migrated++;
  }

  console.log(`\nDone. ${migrated} platform(s) migrated, ${skipped} skipped (no clientSecret).`);
  process.exit(0);
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});

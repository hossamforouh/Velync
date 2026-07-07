#!/usr/bin/env node
/**
 * One-off migration: move plaintext connection secrets off `connected_accounts`
 * docs (readable by any workspace member) into the encrypted `credentials`
 * collection (Admin SDK only, allow read/write: if false in firestore.rules).
 *
 * Covers three legacy shapes that predate this migration:
 *   - top-level accessToken/clientId/clientSecret fields (dead-code path,
 *     unlikely to exist in practice but checked anyway)
 *   - `attributes` stored as an array of {id, value} (an older connector shape)
 *   - `attributes` stored as a plain object (attrId -> value) — the shape
 *     connections.js has always actually written for manual connections
 *
 * All three get folded into a single encrypted `encryptedAttributes` blob in
 * `credentials/{userId}/{connectionId}`, matching what the backend
 * connections routes now write for new connections. The plaintext fields are
 * then stripped from the `connected_accounts` doc.
 *
 * Safe to re-run — skips connections that have no plaintext secret fields.
 *
 * Usage:
 *   node scripts/migrate-connection-secrets.js [--dry-run]
 */

require('dotenv').config();
const { Firestore, FieldValue } = require('@google-cloud/firestore');
const { encrypt } = require('../utils/encryption');

const db = new Firestore();
const DRY_RUN = process.argv.includes('--dry-run');

function extractPlaintextAttributes(data) {
  const attrs = {};

  if (data.accessToken || data.clientId || data.clientSecret) {
    if (data.accessToken) attrs.accessToken = data.accessToken;
    if (data.clientId) attrs.clientId = data.clientId;
    if (data.clientSecret) attrs.clientSecret = data.clientSecret;
  }
  if (data.integrationToken) attrs.integrationToken = data.integrationToken;

  if (Array.isArray(data.attributes)) {
    for (const attr of data.attributes) {
      if (attr && attr.id && attr.value !== undefined) attrs[attr.id] = attr.value;
    }
  } else if (data.attributes && typeof data.attributes === 'object' && Object.keys(data.attributes).length > 0) {
    Object.assign(attrs, data.attributes);
  }

  return attrs;
}

async function main() {
  console.log(`=== Connection secrets migration ${DRY_RUN ? '(dry run)' : ''} ===\n`);

  const snap = await db.collection('connected_accounts').get();
  let migrated = 0;
  let skipped = 0;

  for (const doc of snap.docs) {
    const data = doc.data();
    const attrs = extractPlaintextAttributes(data);

    if (Object.keys(attrs).length === 0) {
      skipped++;
      continue;
    }

    console.log(`  ${doc.id} (${data.label || data.provider}) — migrating ${Object.keys(attrs).length} field(s)${DRY_RUN ? ' (dry run)' : ''}`);

    if (!DRY_RUN) {
      await db.collection('credentials').doc(data.userId).set({
        [doc.id]: {
          encryptedAttributes: encrypt(JSON.stringify(attrs)),
          provider: data.provider,
          updatedAt: new Date().toISOString(),
        },
      }, { merge: true });

      await doc.ref.update({
        accessToken: FieldValue.delete(),
        clientId: FieldValue.delete(),
        clientSecret: FieldValue.delete(),
        integrationToken: FieldValue.delete(),
        attributes: FieldValue.delete(),
      });
    }
    migrated++;
  }

  console.log(`\nDone. ${migrated} connection(s) migrated, ${skipped} skipped (no plaintext secrets found).`);
  process.exit(0);
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});

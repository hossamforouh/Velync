#!/usr/bin/env node
/**
 * One-off migration: set an explicit `connectorKey` field on `platforms` docs.
 *
 * Every platform doc is created with `db.collection('platforms').doc()` (an
 * auto-generated ID), so the doc ID essentially never matches the connector
 * registry key (e.g. "ticktick", "google_contacts"). Several code paths that
 * called getConnector() with the raw doc ID or a naively-lowercased platform
 * name broke as a result — most visibly, "Google Contacts" lowercases to
 * "google contacts" (a space), which never matched the registered
 * "google_contacts" (an underscore).
 *
 * This resolves each platform's connector key by normalizing its `name`
 * field (lowercase, non-alphanumeric runs collapsed to underscores) and
 * matching it against the actual registered connectors, then writes it back
 * as `connectorKey` so every resolution path (src/core/platform.js
 * resolveConnectorKey()) can use it directly instead of guessing.
 *
 * Safe to re-run — skips platforms that already have the correct connectorKey.
 * Platforms with no confident match are left untouched and reported, so an
 * admin can set connectorKey manually via the Admin Panel.
 *
 * Usage:
 *   node scripts/migrate-platform-connector-keys.js [--dry-run]
 */

require('dotenv').config();
const { Firestore } = require('@google-cloud/firestore');
const { getConnector, getRegisteredPlatforms } = require('../src/domains/connector');

const db = new Firestore();
const DRY_RUN = process.argv.includes('--dry-run');

function normalize(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

async function main() {
  console.log(`=== Platform connectorKey migration ${DRY_RUN ? '(dry run)' : ''} ===\n`);
  console.log(`Registered connectors: ${getRegisteredPlatforms().join(', ')}\n`);

  const snap = await db.collection('platforms').get();
  let updated = 0, alreadySet = 0, unresolved = 0;

  for (const doc of snap.docs) {
    const data = doc.data();

    // Already correctly set — nothing to do.
    if (data.connectorKey) {
      try {
        getConnector(data.connectorKey);
        alreadySet++;
        continue;
      } catch (_) {
        // stored value doesn't match anything registered — fall through and re-resolve
      }
    }

    const normalized = normalize(data.name);
    let resolvedKey = null;
    if (normalized) {
      try {
        getConnector(normalized);
        resolvedKey = normalized;
      } catch (_) {
        resolvedKey = null;
      }
    }

    if (!resolvedKey) {
      unresolved++;
      console.log(`  ⚠ ${doc.id} ("${data.name}") — no matching connector for normalized name "${normalized}". Set connectorKey manually in the Admin Panel.`);
      continue;
    }

    console.log(`  ${doc.id} ("${data.name}") → connectorKey: "${resolvedKey}"${DRY_RUN ? ' (dry run)' : ''}`);
    if (!DRY_RUN) {
      await doc.ref.update({ connectorKey: resolvedKey });
    }
    updated++;
  }

  console.log(`\nDone. ${updated} updated, ${alreadySet} already correct, ${unresolved} unresolved.`);
  process.exit(0);
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});

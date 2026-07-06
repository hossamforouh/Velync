#!/usr/bin/env node
/**
 * Trigger a live sync against REAL connectors, for P0 validation.
 *
 * Requires real credentials / connected accounts in Firestore (i.e. run against
 * a real or staging project, not the emulator). Runs the actual sync engine.
 *
 * Usage:
 *   node scripts/trigger-sync.js <configId>   # run one config by id
 *   node scripts/trigger-sync.js --all        # run every active config once
 */

require('dotenv').config();
require('../src/domains/connector'); // register connectors
const db = require('../src/core/db');
const { runSync } = require('../src/domains/sync/engine');

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('Usage: node scripts/trigger-sync.js <configId> | --all');
    process.exit(1);
  }

  if (arg === '--all') {
    const snap = await db.collectionGroup('sync_configs').where('status', '==', 'active').get();
    console.log(`Running ${snap.size} active config(s)…\n`);
    for (const d of snap.docs) {
      try {
        const result = await runSync(d.data(), d.id);
        console.log(`  ✓ ${d.id}:`, result);
      } catch (err) {
        console.error(`  ✗ ${d.id} FAILED:`, err.message);
      }
    }
  } else {
    const snap = await db.collectionGroup('sync_configs').get();
    const doc = snap.docs.find(d => d.id === arg);
    if (!doc) {
      console.error(`Config "${arg}" not found.`);
      process.exit(1);
    }
    console.log(`Running config "${arg}"…\n`);
    try {
      const result = await runSync(doc.data(), doc.id);
      console.log('Result:', result);
    } catch (err) {
      console.error('FAILED:', err.message);
      process.exit(1);
    }
  }
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });

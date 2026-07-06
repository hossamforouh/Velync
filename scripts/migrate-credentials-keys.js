#!/usr/bin/env node
/**
 * Migration: Re-key credentials by connectionId instead of provider.
 *
 * Before: credentials/{uid} = { notion: { accessToken, ... }, ticktick: { ... } }
 * After:  credentials/{uid} = { <connectionId>: { accessToken, ..., provider: 'notion' }, ... }
 *
 * Run ONCE after deploying the code changes from Fix 1.
 * Safe to re-run — skips already-migrated entries.
 *
 * Usage: node scripts/migrate-credentials-keys.js
 */

require('dotenv').config();
const { Firestore } = require('@google-cloud/firestore');

const db = new Firestore();
const BATCH_SIZE = 100;

const KNOWN_PROVIDER_KEYS = new Set([
  'notion', 'ticktick', 'google_contacts',
  'google', 'microsoft', 'slack', 'asana', 'trello',
  // Add any other provider keys your platform uses
]);

async function main() {
  console.log('=== Credentials key migration (provider → connectionId) ===\n');

  // 1. Collect all connected_accounts grouped by userId
  const accountsByUser = {};
  const connSnap = await db.collection('connected_accounts').get();
  console.log(`Found ${connSnap.size} connected_account documents`);

  connSnap.forEach(doc => {
    const data = doc.data();
    const uid = data.userId;
    if (!uid) return;
    if (!accountsByUser[uid]) accountsByUser[uid] = [];
    accountsByUser[uid].push({ id: doc.id, provider: data.provider });
  });

  console.log(`  across ${Object.keys(accountsByUser).length} users\n`);

  // 2. For each user, migrate their credentials doc
  let migratedCount = 0;
  let warningUsers = [];
  let skippedCount = 0;

  for (const [uid, connections] of Object.entries(accountsByUser)) {
    const credsRef = db.collection('credentials').doc(uid);
    const credsDoc = await credsRef.get();

    if (!credsDoc.exists) {
      skippedCount++;
      continue;
    }

    const credsData = credsDoc.data();

    // Identify provider-keyed entries (old format)
    const oldKeys = Object.keys(credsData).filter(k => KNOWN_PROVIDER_KEYS.has(k));

    if (oldKeys.length === 0) {
      skippedCount++;
      continue; // already migrated or no provider-keyed data
    }

    // Check for duplicate-provider connections (only one had valid tokens)
    const providerCounts = {};
    for (const conn of connections) {
      providerCounts[conn.provider] = (providerCounts[conn.provider] || 0) + 1;
    }
    const duplicateProviders = Object.entries(providerCounts)
      .filter(([, count]) => count > 1)
      .map(([provider]) => provider);

    if (duplicateProviders.length > 0) {
      warningUsers.push({ uid, providers: duplicateProviders, connections });
    }

    // Build the new credentials map
    const newEntries = {};
    for (const conn of connections) {
      const oldData = credsData[conn.provider];
      if (oldData) {
        newEntries[conn.id] = {
          ...oldData,
          provider: conn.provider,
          migratedAt: new Date().toISOString(),
        };
      }
    }

    if (Object.keys(newEntries).length === 0) {
      skippedCount++;
      continue;
    }

    // Remove old provider-keyed entries
    for (const key of oldKeys) {
      delete newEntries[key];
    }

    // Write back — replace entire doc with only connectionId-keyed entries
    await credsRef.set(newEntries, { merge: false });
    migratedCount++;
    console.log(`  Migrated credentials for user "${uid}": ${Object.keys(newEntries).length} connection(s)`);
  }

  // 3. Summary
  console.log(`\n=== Migration complete ===`);
  console.log(`  Users migrated:   ${migratedCount}`);
  console.log(`  Users skipped:    ${skippedCount}`);
  console.log(`  Warnings issued:  ${warningUsers.length}`);

  if (warningUsers.length > 0) {
    console.log(`\n⚠  WARNING: The following users had multiple connections of the same provider.`);
    console.log(`   Only the most-recently-written credential was preserved for each provider,`);
    console.log(`   and that same credential was copied to ALL connections of that provider.`);
    console.log(`   The other connections' original tokens were ALREADY lost to the overwrite`);
    console.log(`   bug before this migration ran. Those connections need to be reconnected:`);
    for (const w of warningUsers) {
      const detail = w.connections
        .filter(c => w.providers.includes(c.provider))
        .map(c => `      - ${c.id} (${c.provider})`)
        .join('\n');
      console.log(`\n  User: ${w.uid}`);
      console.log(`    Duplicate providers: ${w.providers.join(', ')}`);
      console.log(`    Affected connections:\n${detail}`);
      console.log(`    → Reconnect manually via the dashboard.`);
    }
  }

  console.log(`\nDone.`);
  process.exit(0);
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});

/**
 * Superadmin Check Test Suite
 *
 * Verifies isSuperAdmin() reads the `superadmins` Firestore collection — the
 * same source of truth as the Firestore security rules and scripts/seed-superadmin.js.
 * (Previously it read a hardcoded env var, disconnected from that collection —
 * a half-finished migration that made adding a superadmin via Firestore silently
 * not work.)
 *
 * Run:  npm run test:superadmin
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert');

const db = require('../src/core/db');
const { isSuperAdmin } = require('../src/core/superadmin');

before(async () => {
  // Seed both before any isSuperAdmin() call — the module caches the whole
  // collection on first read (60s TTL), so a doc added mid-test wouldn't be
  // visible until the cache expires.
  await db.collection('superadmins').doc('admin-uid-1').set({ role: 'superadmin' });
  await db.collection('superadmins').doc('admin-uid-2').set({ role: 'superadmin' });
});

describe('isSuperAdmin', () => {
  it('returns true for a uid present in the superadmins collection', async () => {
    assert.strictEqual(await isSuperAdmin('admin-uid-1'), true);
  });

  it('returns false for a uid not in the collection', async () => {
    assert.strictEqual(await isSuperAdmin('random-uid'), false);
  });

  it('returns false for a falsy uid without querying', async () => {
    assert.strictEqual(await isSuperAdmin(null), false);
    assert.strictEqual(await isSuperAdmin(undefined), false);
    assert.strictEqual(await isSuperAdmin(''), false);
  });

  it('recognizes multiple superadmins from the same collection read', async () => {
    assert.strictEqual(await isSuperAdmin('admin-uid-1'), true);
    assert.strictEqual(await isSuperAdmin('admin-uid-2'), true);
    assert.strictEqual(await isSuperAdmin('still-not-admin'), false);
  });
});

/**
 * Seeds a superadmin document in Firestore.
 *
 * firestore.rules checks isSuperAdmin() via document existence at
 * superadmins/{uid}. This is a bootstrap script — the first superadmin can't
 * be granted through the app itself (nobody has admin access yet to grant
 * it), so this writes the doc directly.
 *
 * Firebase Auth UIDs are per-project: the same email gets a DIFFERENT uid in
 * each Firebase project (e.g. production vs staging). This script takes the
 * uid/email explicitly rather than hardcoding one, so the same script is
 * safe to run against any project without editing source per-environment.
 *
 * Usage:
 *   node scripts/seed-superadmin.js <uid-or-email>
 *   node scripts/seed-superadmin.js hossamforouh@icloud.com
 *   node scripts/seed-superadmin.js gaWobXFAxdVEtX7q62Vi4Fw6rlI2
 *
 * Requires:
 *   - GOOGLE_APPLICATION_CREDENTIALS env var (or ADC via gcloud auth)
 *   - A running Firebase project with Firestore + Authentication
 *   - GOOGLE_CLOUD_PROJECT / GCLOUD_PROJECT set (or gcloud's default project)
 *     to target the right project — this script does NOT default to any
 *     specific project.
 */
const { Firestore } = require('@google-cloud/firestore');
const { initializeApp, getApps } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');

async function resolveUid(input) {
  if (!input.includes('@')) return input;
  const app = getApps()[0] || initializeApp();
  const user = await getAuth(app).getUserByEmail(input);
  return user.uid;
}

async function seed() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('Usage: node scripts/seed-superadmin.js <uid-or-email>');
    process.exit(1);
  }

  const uid = await resolveUid(arg);
  const db = new Firestore();
  const ref = db.collection('superadmins').doc(uid);

  const existing = await ref.get();
  if (existing.exists) {
    console.log(`Superadmin document for "${uid}" already exists.`);
    return;
  }

  await ref.set({
    uid,
    role: 'superadmin',
    createdAt: new Date().toISOString(),
  });

  console.log(`Superadmin document "${uid}" created.`);
  console.log('Firestore rules isSuperAdmin() will now resolve to true for this UID.');
}

seed().catch((err) => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});

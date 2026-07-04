/**
 * Seeds the initial superadmin document in Firestore.
 *
 * The new firestore.rules checks isSuperAdmin() via document existence at
 * superadmins/{uid}, replacing the old hardcoded UID approach.
 *
 * Usage:
 *   node scripts/seed-superadmin.js
 *
 * Requires:
 *   - GOOGLE_APPLICATION_CREDENTIALS env var (or ADC via gcloud auth)
 *   - A running Firebase project with Firestore
 */
const { Firestore } = require('@google-cloud/firestore');

const SUPERADMIN_UID = 'o4gf5QBNlnaLXCqfjYmmhVLVNlg1';

async function seed() {
  const db = new Firestore();
  const ref = db.collection('superadmins').doc(SUPERADMIN_UID);

  const existing = await ref.get();
  if (existing.exists) {
    console.log(`Superadmin document for "${SUPERADMIN_UID}" already exists.`);
    return;
  }

  await ref.set({
    uid: SUPERADMIN_UID,
    role: 'superadmin',
    createdAt: new Date().toISOString(),
  });

  console.log(`Superadmin document "${SUPERADMIN_UID}" created.`);
  console.log('Firestore rules isSuperAdmin() will now resolve to true for this UID.');
}

seed().catch((err) => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});

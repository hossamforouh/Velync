require('dotenv').config();
const { Firestore, FieldValue } = require('@google-cloud/firestore');

const db = new Firestore();

async function migrate() {
  console.log('Migrating workspaces — adding planId and subscription fields...');

  const snap = await db.collection('workspaces').get();
  let updated = 0;
  let skipped = 0;

  for (const doc of snap.docs) {
    const data = doc.data();
    if (data.planId) {
      skipped++;
      continue;
    }

    await doc.ref.set({
      planId: 'free',
      subscriptionStatus: 'active',
      billingInterval: 'monthly',
      currentPeriodEnd: null,
      stripeCustomerId: FieldValue.delete(),
      stripeSubscriptionId: FieldValue.delete(),
    }, { merge: true });

    updated++;
    console.log(`  ✅ workspace "${doc.id}" → planId: free`);
  }

  console.log(`\nDone. ${updated} workspace(s) updated, ${skipped} already had planId.`);
  process.exit(0);
}

migrate().catch(err => { console.error(err); process.exit(1); });

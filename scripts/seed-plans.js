require('dotenv').config();
const { Firestore } = require('@google-cloud/firestore');

const db = new Firestore();

const plans = [
  {
    id: 'free',
    name: 'Free',
    description: 'Get started with basic sync capabilities. Perfect for personal use.',
    priceMonthly: 0,
    priceAnnual: 0,
    lsVariantIdMonthly: '',
    lsVariantIdAnnual: '',
    maxActiveConfigs: 1,
    minSyncIntervalMinutes: 30,
    maxItemsPerRun: 100,
    connectorTiers: ['basic'],
    logRetentionDays: 7,
    sortOrder: 0,
    isActive: true,
    isDefault: true,
  },
  {
    id: 'pro',
    name: 'Pro',
    description: 'Unlock more power with faster sync and higher limits for growing teams.',
    priceMonthly: 19,
    priceAnnual: 190,
    lsVariantIdMonthly: '',
    lsVariantIdAnnual: '',
    maxActiveConfigs: 5,
    minSyncIntervalMinutes: 15,
    maxItemsPerRun: 500,
    connectorTiers: ['basic', 'premium'],
    logRetentionDays: 30,
    sortOrder: 1,
    isActive: true,
    isDefault: false,
  },
  {
    id: 'business',
    name: 'Business',
    description: 'Maximum velocity, unlimited configs, and premium connectors for demanding workflows.',
    priceMonthly: 79,
    priceAnnual: 790,
    lsVariantIdMonthly: '',
    lsVariantIdAnnual: '',
    maxActiveConfigs: 25,
    minSyncIntervalMinutes: 5,
    maxItemsPerRun: 2000,
    connectorTiers: ['basic', 'premium'],
    logRetentionDays: 90,
    sortOrder: 2,
    isActive: true,
    isDefault: false,
  },
];

async function seed() {
  console.log('Seeding plans...');
  for (const plan of plans) {
    await db.collection('plans').doc(plan.id).set(plan, { merge: true });
    console.log(`  ✅ plan: ${plan.id} — ${plan.name} ($${plan.priceMonthly}/mo)`);
  }

  console.log('Adding tier field to existing platforms...');
  const platformsSnap = await db.collection('platforms').get();
  let updated = 0;
  for (const doc of platformsSnap.docs) {
    const data = doc.data();
    if (!data.tier) {
      await doc.ref.set({ tier: 'basic' }, { merge: true });
      updated++;
    }
  }
  console.log(`  ✅ ${updated} platform(s) updated with tier: basic`);

  console.log('Done. Plans seeded.');
  process.exit(0);
}

seed().catch(err => { console.error(err); process.exit(1); });

require('dotenv').config();
const { Firestore, FieldValue } = require('@google-cloud/firestore');

const db = new Firestore();

async function migrate() {
  console.log('Migrating workspaces — adding planId and subscription fields...');

  const [wsSnap, planSnap] = await Promise.all([
    db.collection('workspaces').get(),
    db.collection('plans').get(),
  ]);

  // Build a plan lookup map
  const plans = {};
  planSnap.forEach(d => { plans[d.id] = d.data(); });
  const freePlan = plans.free || { maxActiveConfigs: 1 };
  const FREE_MAX = freePlan.maxActiveConfigs || 1;

  let updated = 0;
  let skipped = 0;
  let grandfathered = 0;
  const overLimitWarnings = [];

  for (const doc of wsSnap.docs) {
    const data = doc.data();
    if (data.planId) {
      skipped++;
      continue;
    }

    // Count active configs
    const cfgSnap = await db.collection('workspaces').doc(doc.id)
      .collection('sync_configs')
      .where('status', '==', 'active')
      .get();
    const activeCount = cfgSnap.size;

    let assignedPlanId = 'free';

    if (activeCount > FREE_MAX) {
      // Check if there's a seeded "legacy" plan that covers this count
      const legacyPlan = Object.entries(plans).find(([, p]) =>
        p.connectorTiers && p.connectorTiers.includes('legacy') &&
        p.maxActiveConfigs >= activeCount
      );
      if (legacyPlan) {
        assignedPlanId = legacyPlan[0];
        grandfathered++;
        console.log(`  ⚠ workspace "${doc.id}" has ${activeCount} active config(s) — assigning to "${assignedPlanId}" plan`);
      } else {
        // At minimum, log this workspace for manual review
        overLimitWarnings.push({ id: doc.id, activeCount, maxAllowed: FREE_MAX });
        console.log(`  ⚠ workspace "${doc.id}" has ${activeCount} active config(s) — Free plan allows ${FREE_MAX}. Assigning Free — some configs will pause.`);
      }
    }

    const updateFields = {
      planId: assignedPlanId,
      subscriptionStatus: 'active',
      currentPeriodEnd: null,
    };

    // Only delete these if they don't exist (may have stale demo data)
    if (!data.lsCustomerId) {
      updateFields.lsCustomerId = FieldValue.delete();
    }
    if (!data.lsSubscriptionId) {
      updateFields.lsSubscriptionId = FieldValue.delete();
    }

    await doc.ref.set(updateFields, { merge: true });
    updated++;
  }

  console.log(`\nDone. ${updated} workspace(s) updated, ${skipped} already had planId.`);
  if (grandfathered > 0) {
    console.log(`  ${grandfathered} workspace(s) grandfathered into a legacy plan.`);
  }
  if (overLimitWarnings.length > 0) {
    console.log(`\n⚠ ${overLimitWarnings.length} workspace(s) exceed Free plan limits and need manual review:`);
    overLimitWarnings.forEach(w => {
      console.log(`  - "${w.id}" (${w.activeCount} active configs, max ${w.maxAllowed})`);
    });
    console.log('\nAction needed: Upgrade these workspaces to an appropriate plan or reduce their config count.');
  }

  process.exit(0);
}

migrate().catch(err => { console.error(err); process.exit(1); });

const { Firestore } = require('@google-cloud/firestore');

async function migrateData() {
  console.log('Starting Firestore Data Migration...');

  // Initialize clients for both projects
  // Assumes you are authenticated via Application Default Credentials (e.g. gcloud auth application-default login)
  const srcDb = new Firestore({ projectId: 'ticktick-notion-sync' });
  const destDb = new Firestore({ projectId: 'velync' });

  const collectionsToMigrate = ['sync_configs', 'sync_mappings', 'connected_accounts'];

  for (const collName of collectionsToMigrate) {
    console.log(`\nMigrating collection: ${collName}`);
    
    try {
      const snapshot = await srcDb.collection(collName).get();
      if (snapshot.empty) {
        console.log(`  -> No documents found in ${collName}. Skipping.`);
        continue;
      }

      console.log(`  -> Found ${snapshot.size} documents in ${collName}. Copying...`);

      // Write in batches
      let batch = destDb.batch();
      let count = 0;

      for (const doc of snapshot.docs) {
        const destRef = destDb.collection(collName).doc(doc.id);
        batch.set(destRef, doc.data());
        count++;

        if (count % 400 === 0) {
          await batch.commit();
          console.log(`    Committed ${count} documents...`);
          batch = destDb.batch();
        }
      }

      if (count % 400 !== 0) {
        await batch.commit();
      }

      console.log(`  -> Successfully migrated ${count} documents for ${collName}.`);
    } catch (err) {
      console.error(`  -> Error migrating collection ${collName}:`, err.message);
    }
  }

  console.log('\nMigration complete!');
}

migrateData().catch(console.error);

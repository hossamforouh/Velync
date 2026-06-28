const { Firestore } = require('@google-cloud/firestore');
require('dotenv').config();

const db = new Firestore();

async function migrate() {
  console.log('--- Seeding Firestore with default configurations from .env ---');
  
  const notionToken = process.env.NOTION_INTEGRATION_TOKEN;
  const databaseId = process.env.NOTION_DATABASE_ID;
  
  if (!notionToken || notionToken.startsWith('secret_your')) {
    console.error('Error: NOTION_INTEGRATION_TOKEN is not configured in your .env file.');
    process.exit(1);
  }

  const configData = {
    enabled: true,
    description: "Default Sync Configuration (Migrated from .env)",
    ticktick: {
      accessToken: process.env.TICKTICK_ACCESS_TOKEN || "",
      clientId: process.env.TICKTICK_CLIENT_ID || "",
      clientSecret: process.env.TICKTICK_CLIENT_SECRET || "",
      username: process.env.TICKTICK_USERNAME || "",
      password: process.env.TICKTICK_PASSWORD || "",
      cookie: process.env.TICKTICK_COOKIE || "",
      listName: "Inbox",
      syncTag: process.env.TICKTICK_SYNC_TAG || "sync"
    },
    notion: {
      integrationToken: notionToken,
      databaseId: databaseId,
      statusValue: "Inbox",
      formatValue: "Note / Idea"
    }
  };

  try {
    const docRef = db.collection('sync_configs').doc('default');
    await docRef.set(configData);
    console.log('✅ Successfully seeded Firestore! Created/Updated document: "sync_configs/default"');
    console.log('Please note that the credentials have been safely stored in the Firestore database.');
  } catch (err) {
    console.error('❌ Failed to seed Firestore database:', err.message);
    process.exit(1);
  }
}

migrate();

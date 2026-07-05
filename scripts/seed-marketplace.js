require('dotenv').config();
const { Firestore } = require('@google-cloud/firestore');
const admin = require('firebase-admin');

try { admin.initializeApp(); } catch (e) {}

const db = new Firestore();

const platforms = [
  {
    id: 'ticktick',
    name: 'TickTick',
    logo: '<svg viewBox="0 0 32 32" fill="none"><rect width="32" height="32" rx="8" fill="#5B6AEB"/><path d="M8 16l5 5 11-11" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    authType: 'oauth',
    authUrl: 'https://ticktick.com/oauth/authorize',
    tokenUrl: 'https://ticktick.com/oauth/token',
    scopes: 'tasks:read tasks:write',
    attributes: [],
    configSchema: [
      { id: 'listName', label: 'List / Project', type: 'dynamic_select', dataSource: 'lists' },
      { id: 'syncTag', label: 'Sync Tags (optional)', type: 'dynamic_multi_select', dataSource: 'tags', description: 'Only sync items with selected tags' },
    ],
  },
  {
    id: 'notion',
    name: 'Notion',
    logo: '<svg viewBox="0 0 32 32" fill="none"><rect width="32" height="32" rx="8" fill="#1A1A1A"/><path d="M8 10l6-2v15l-6 2V10z" fill="white" opacity="0.9"/><path d="M14 8l10-2v15l-10 2V8z" fill="white" opacity="0.6"/></svg>',
    authType: 'oauth',
    authUrl: 'https://api.notion.com/v1/oauth/authorize',
    tokenUrl: 'https://api.notion.com/v1/oauth/token',
    scopes: '',
    attributes: [],
    configSchema: [
      { id: 'databaseId', label: 'Database', type: 'dynamic_select', dataSource: 'databases' },
      { id: 'templateId', label: 'Template (optional)', type: 'dynamic_select', dataSource: 'templates', dependsOn: 'databaseId' },
    ],
  },
  {
    id: 'google_contacts',
    connectorKey: 'google_contacts',
    name: 'Google Contacts',
    logo: '<svg viewBox="0 0 32 32" fill="none"><rect width="32" height="32" rx="8" fill="#4285F4"/><path d="M16 10a3 3 0 100 6 3 3 0 000-6zm-6 10c0-2 2.7-4 6-4s6 2 6 4" stroke="white" stroke-width="1.5" fill="none"/></svg>',
    authType: 'oauth',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: 'https://www.googleapis.com/auth/contacts.readonly',
    attributes: [],
    configSchema: [
      { id: 'group', label: 'Contact Group', type: 'dynamic_select', dataSource: 'contactGroups' },
    ],
  },
];

const integrations = [
  {
    id: 'ticktick-to-notion',
    name: 'TickTick → Notion',
    description: 'Sync your TickTick tasks, notes, and habits to a Notion database automatically. Supports custom field mapping, tags, and bidirectional updates.',
    platform1: 'ticktick',
    platform2: 'notion',
    status: 'Active',
    syncTypes: ['Source_to_Dest', 'Dest_to_Source', 'Bidirectional'],
    tags: ['productivity', 'tasks'],
    defaultMappings: [
      { sourceField: 'title', destField: 'Name' },
      { sourceField: 'tags', destField: 'Topic' },
      { sourceField: 'desc', destField: '__content__' },
    ],
  },
  {
    id: 'notion-to-ticktick',
    name: 'Notion → TickTick',
    description: 'Push Notion database entries into TickTick as tasks or notes. Ideal for capturing ideas and tasks in Notion and executing them in TickTick.',
    platform1: 'notion',
    platform2: 'ticktick',
    status: 'Active',
    syncTypes: ['Source_to_Dest', 'Bidirectional'],
    tags: ['productivity', 'notes'],
    defaultMappings: [
      { sourceField: 'title', destField: 'Name' },
      { sourceField: 'tags', destField: 'Topic' },
      { sourceField: 'desc', destField: '__content__' },
    ],
  },
  {
    id: 'ticktick-contact-sync',
    name: 'TickTick → Google Contacts',
    description: 'Sync your TickTick contacts into Google Contacts. Automatically push task contacts to your Google address book with customizable field mapping.',
    platform1: 'ticktick',
    platform2: 'google_contacts',
    status: 'Active',
    syncTypes: ['Source_to_Dest', 'Bidirectional'],
    tags: ['contacts', 'crm'],
    defaultMappings: [
      { sourceField: 'title', destField: 'name' },
      { sourceField: 'desc', destField: 'organization' },
      { sourceField: 'tags', destField: '__content__' },
    ],
  },
];

async function seed() {
  console.log('Seeding platforms...');
  for (const p of platforms) {
    await db.collection('platforms').doc(p.id).set(p, { merge: true });
    console.log(`  ✅ platform: ${p.id}`);
  }

  console.log('Seeding integrations...');
  for (const i of integrations) {
    await db.collection('integrations').doc(i.id).set(i, { merge: true });
    console.log(`  ✅ integration: ${i.id}`);
  }

  console.log('Done. Marketplace seeded with 3 platforms and 3 integrations.');
  process.exit(0);
}

seed().catch(err => { console.error(err); process.exit(1); });

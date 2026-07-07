/**
 * Firestore Security Rules Test Suite
 *
 * Prerequisites:
 *   1. java (required by Firebase emulators): brew install java && sudo ln -sfn /opt/homebrew/opt/openjdk/libexec/openjdk.jdk /Library/Java/JavaVirtualMachines/openjdk.jdk
 *   2. firebase-tools: npm install -g firebase-tools
 *   3. Start emulator: npx firebase emulators:exec --only firestore "node --test test/firestore-rules.test.js"
 *      OR start manually: npx firebase emulators:start --only firestore
 *        then: node --test test/firestore-rules.test.js
 *
 * This test validates every collection's read/write rules to prevent
 * unauthorized client-side access to Firestore data.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} = require('@firebase/rules-unit-testing');

const PROJECT_ID = 'velync-test-' + Date.now();
const RULES_PATH = path.resolve(__dirname, '..', 'firestore.rules');

/** Seed/docs for rules to resolve against */
const SEED = {
  superadmins: { 'superadmin-uid': {} },
  workspaces: {
    'owner-wsid': {
      name: 'Owner Workspace',
      ownerId: 'owner-uid',
      members: ['member-uid'],
      invitedEmails: ['invited@test.com'],
    },
    'member-wsid': {
      name: 'Member Workspace',
      ownerId: 'other-owner',
      members: ['member-uid', 'owner-uid'],
    },
    'nonmember-wsid': {
      name: 'Non-member Workspace',
      ownerId: 'stranger-uid',
      members: [],
    },
  },
  platforms: {
    notion: { name: 'Notion', tier: 'standard' },
    premium: { name: 'Premium', tier: 'premium' },
  },
  plans: {
    free: { name: 'Free', maxActiveConfigs: 1 },
    pro: { name: 'Pro', maxActiveConfigs: 10 },
  },
  integrations: { 'some-integration': { name: 'Test Integration' } },
  app_settings: { theme: { value: 'dark' } },
};

let testEnv;

/**
 * Helper: write seed documents using admin SDK (bypasses security rules).
 */
async function seed(testEnv) {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const firestore = context.firestore();
    await seedDocs(firestore);
  });
}

/** Writes all seed documents. Runs with security rules disabled. */
async function seedDocs(firestore) {
  for (const [collection, docs] of Object.entries(SEED)) {
    for (const [docId, data] of Object.entries(docs)) {
      await firestore.collection(collection).doc(docId).set(data);
    }
  }

  // Seed workspaces subcollections
  for (const wsId of Object.keys(SEED.workspaces)) {
    await firestore
      .collection('workspaces').doc(wsId)
      .collection('sync_configs').doc('test-config')
      .set({ description: 'test', platform1: 'notion', platform2: 'ticktick' });

    await firestore
      .collection('workspaces').doc(wsId)
      .collection('sync_configs').doc('test-config')
      .collection('sync_mappings').doc('test-mapping')
      .set({ sourceField: 'a', destField: 'b' });
  }

  // Seed connected_accounts with workspaceId
  await firestore.collection('connected_accounts').doc('owner-acct').set({
    provider: 'notion',
    userId: 'owner-uid',
    workspaceId: 'owner-wsid',
  });
  await firestore.collection('connected_accounts').doc('member-acct').set({
    provider: 'ticktick',
    userId: 'member-uid',
    workspaceId: 'member-wsid',
  });
  await firestore.collection('connected_accounts').doc('stranger-acct').set({
    provider: 'google',
    userId: 'stranger-uid',
    workspaceId: 'nonmember-wsid',
  });

  // Seed execution_logs
  await firestore.collection('execution_logs').doc('owner-log').set({
    workspaceId: 'owner-wsid',
    status: 'success',
  });

  // Seed credentials
  await firestore.collection('credentials').doc('owner-uid').set({
    accessToken: 'encrypted-secret',
  });

  // Seed activity_logs
  await firestore.collection('activity_logs').doc('test-log').set({
    action: 'test',
    timestamp: new Date().toISOString(),
  });

  // Seed mail (for firestore-send-email extension)
  await firestore.collection('mail').doc('test-mail').set({
    to: 'test@test.com',
    message: { subject: 'Test' },
  });
}

before(async () => {
  const rules = fs.readFileSync(RULES_PATH, 'utf8');
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      host: 'localhost',
      port: process.env.FIRESTORE_EMULATOR_HOST
        ? parseInt(process.env.FIRESTORE_EMULATOR_HOST.split(':')[1], 10)
        : 8080,
      rules,
    },
  });
  await seed(testEnv);
});

after(async () => {
  if (testEnv) await testEnv.cleanup();
});

// ─────────────────────────────────────────────
// Auth context helpers
// ─────────────────────────────────────────────
const ctx = {
  unauth: () => testEnv.unauthenticatedContext(),
  superAdmin: () => testEnv.authenticatedContext('superadmin-uid', { email: 'admin@test.com' }),
  owner: () => testEnv.authenticatedContext('owner-uid', { email: 'owner@test.com' }),
  member: () => testEnv.authenticatedContext('member-uid', { email: 'member@test.com' }),
  stranger: () => testEnv.authenticatedContext('stranger-uid', { email: 'stranger@test.com' }),
  invited: () => testEnv.authenticatedContext('invited-uid', { email: 'invited@test.com' }),
  nonOwnerToken: () => testEnv.authenticatedContext('other-owner', { email: 'otherowner@test.com' }),
};

// ─────────────────────────────────────────────
// 1. Unauthenticated access
// ─────────────────────────────────────────────
describe('Unauthenticated — no auth', () => {
  it('cannot read any collection', async () => {
    const db = ctx.unauth().firestore();
    await assertFails(db.collection('workspaces').doc('owner-wsid').get());
    await assertFails(db.collection('platforms').doc('notion').get());
    await assertFails(db.collection('plans').doc('free').get());
    await assertFails(db.collection('users').doc('owner-uid').get());
    await assertFails(db.collection('activity_logs').doc('test-log').get());
    await assertFails(db.collection('superadmins').doc('superadmin-uid').get());
    // Note: app_settings is intentionally world-readable (see its own test below),
    // so it is deliberately excluded from this "no unauth read" assertion.
  });

  it('cannot write to any collection', async () => {
    const db = ctx.unauth().firestore();
    await assertFails(db.collection('workspaces').add({ name: 'hack' }));
    await assertFails(db.collection('activity_logs').add({ action: 'hack', timestamp: new Date().toISOString() }));
  });
});

// ─────────────────────────────────────────────
// 2. /superadmins/{uid}
// ─────────────────────────────────────────────
describe('/superadmins/{uid}', () => {
  it('any authed user can read', async () => {
    await assertSucceeds(ctx.stranger().firestore().collection('superadmins').doc('superadmin-uid').get());
  });

  it('only superadmin can write', async () => {
    await assertSucceeds(ctx.superAdmin().firestore().collection('superadmins').doc('another-superadmin').set({}));
    await assertFails(ctx.owner().firestore().collection('superadmins').doc('admin').set({}));
    await assertFails(ctx.stranger().firestore().collection('superadmins').doc('admin').set({}));
  });
});

// ─────────────────────────────────────────────
// 3. /users/{userId}
// ─────────────────────────────────────────────
describe('/users/{userId}', () => {
  it('any authed user can read', async () => {
    await assertSucceeds(ctx.stranger().firestore().collection('users').doc('owner-uid').get());
  });

  it('can create own doc with required fields', async () => {
    await assertSucceeds(ctx.owner().firestore().collection('users').doc('owner-uid').set({ email: 'owner@test.com' }));
  });

  it('cannot create doc for another user', async () => {
    await assertFails(ctx.owner().firestore().collection('users').doc('stranger-uid').set({ email: 'hack@test.com' }));
  });

  it('cannot create doc without required email field', async () => {
    // Use invited-uid (never written elsewhere) so this is a genuine create, not an
    // update of a doc a prior test already created.
    await assertFails(ctx.invited().firestore().collection('users').doc('invited-uid').set({ name: 'No Email' }));
  });

  it('can update own doc with allowed fields', async () => {
    await assertSucceeds(ctx.owner().firestore().collection('users').doc('owner-uid').update({ name: 'New Name' }));
  });

  it('cannot update own doc with disallowed fields', async () => {
    await assertFails(ctx.owner().firestore().collection('users').doc('owner-uid').update({ admin: true }));
    await assertFails(ctx.owner().firestore().collection('users').doc('owner-uid').update({ role: 'superadmin' }));
  });

  it('cannot update another user doc', async () => {
    await assertFails(ctx.owner().firestore().collection('users').doc('stranger-uid').update({ name: 'Hack' }));
  });

  it('can delete own doc', async () => {
    await assertSucceeds(ctx.owner().firestore().collection('users').doc('owner-uid').delete());
  });
});

// ─────────────────────────────────────────────
// 4. /workspaces/{workspaceId}
// ─────────────────────────────────────────────
describe('/workspaces/{workspaceId}', () => {
  it('owner can read', async () => {
    await assertSucceeds(ctx.owner().firestore().collection('workspaces').doc('owner-wsid').get());
  });

  it('member can read', async () => {
    await assertSucceeds(ctx.member().firestore().collection('workspaces').doc('owner-wsid').get());
  });

  it('stranger cannot read', async () => {
    await assertFails(ctx.stranger().firestore().collection('workspaces').doc('owner-wsid').get());
  });

  it('pending invitee can read', async () => {
    await assertSucceeds(ctx.invited().firestore().collection('workspaces').doc('owner-wsid').get());
  });

  it('any authed user can create a workspace', async () => {
    await assertSucceeds(ctx.stranger().firestore().collection('workspaces').add({ name: 'New WS' }));
  });

  it('owner can update with allowed field', async () => {
    await assertSucceeds(ctx.owner().firestore().collection('workspaces').doc('owner-wsid').update({ name: 'Updated' }));
  });

  it('owner cannot update with disallowed field (planId)', async () => {
    await assertFails(ctx.owner().firestore().collection('workspaces').doc('owner-wsid').update({ planId: 'pro' }));
  });

  it('owner cannot update with disallowed field (stripeCustomerId)', async () => {
    await assertFails(ctx.owner().firestore().collection('workspaces').doc('owner-wsid').update({ stripeCustomerId: 'cus_hack' }));
  });

  it('member cannot update workspace', async () => {
    await assertFails(ctx.member().firestore().collection('workspaces').doc('owner-wsid').update({ name: 'Member update' }));
  });

  it('stranger cannot update workspace', async () => {
    await assertFails(ctx.stranger().firestore().collection('workspaces').doc('owner-wsid').update({ name: 'Stranger update' }));
  });

  it('delete is denied', async () => {
    await assertFails(ctx.owner().firestore().collection('workspaces').doc('owner-wsid').delete());
    await assertFails(ctx.superAdmin().firestore().collection('workspaces').doc('owner-wsid').delete());
  });
});

// ─────────────────────────────────────────────
// 4b. /workspaces/{workspaceId} — solo-user convention (workspaceId === own uid,
// no workspace document ever created). This is the app's actual default: see
// auth.js `resolvedWsId = workspaceId || uid` and app.js's login-time
// getDoc-then-create-if-missing flow for the default workspace. isWorkspaceMember()
// regressed on this exact case once before (required exists() unconditionally) —
// these guard against that recurring.
// ─────────────────────────────────────────────
describe('/workspaces/{workspaceId} — solo user, workspaceId is own uid, no document', () => {
  it('owner can read their own not-yet-created default workspace (returns not-found, not denied)', async () => {
    const snap = await ctx.owner().firestore().collection('workspaces').doc('owner-uid').get();
    assert.strictEqual(snap.exists, false);
  });

  it('a different user cannot read someone else\'s not-yet-created workspace', async () => {
    await assertFails(ctx.stranger().firestore().collection('workspaces').doc('owner-uid').get());
  });

  it('owner can create their own default workspace at their own uid', async () => {
    await assertSucceeds(ctx.owner().firestore().collection('workspaces').doc('owner-uid').set({
      id: 'owner-uid', name: 'My Workspace', ownerId: 'owner-uid', members: ['owner-uid'], invitedEmails: [],
    }));
  });
});

// ─────────────────────────────────────────────
// 5. /workspaces/{wsId}/sync_configs/{configId}
// ─────────────────────────────────────────────
describe('/workspaces/{wsId}/sync_configs/{configId}', () => {
  it('workspace member can read', async () => {
    await assertSucceeds(ctx.member().firestore().collection('workspaces').doc('owner-wsid').collection('sync_configs').doc('test-config').get());
  });

  it('superadmin can read', async () => {
    await assertSucceeds(ctx.superAdmin().firestore().collection('workspaces').doc('owner-wsid').collection('sync_configs').doc('test-config').get());
  });

  it('stranger cannot read', async () => {
    await assertFails(ctx.stranger().firestore().collection('workspaces').doc('owner-wsid').collection('sync_configs').doc('test-config').get());
  });

  it('workspace member can create', async () => {
    await assertSucceeds(ctx.member().firestore().collection('workspaces').doc('owner-wsid').collection('sync_configs').add({
      description: 'new', platform1: 'notion', platform2: 'ticktick',
    }));
  });

  it('workspace member can update', async () => {
    await assertSucceeds(ctx.member().firestore().collection('workspaces').doc('owner-wsid').collection('sync_configs').doc('test-config').update({ description: 'updated' }));
  });

  it('solo user can read/create sync_configs under their own uid, with no parent workspace doc', async () => {
    await assertSucceeds(ctx.owner().firestore().collection('workspaces').doc('owner-uid').collection('sync_configs').add({
      description: 'solo config', platform1: 'notion', platform2: 'ticktick',
    }));
    await assertFails(ctx.stranger().firestore().collection('workspaces').doc('owner-uid').collection('sync_configs').add({
      description: 'hack', platform1: 'notion', platform2: 'ticktick',
    }));
  });

  it('delete denied client-side — server-only (cascades sync_mappings)', async () => {
    await assertFails(ctx.member().firestore().collection('workspaces').doc('member-wsid').collection('sync_configs').doc('test-config').delete());
    await assertFails(ctx.owner().firestore().collection('workspaces').doc('owner-wsid').collection('sync_configs').doc('test-config').delete());
  });

  it('stranger cannot create', async () => {
    await assertFails(ctx.stranger().firestore().collection('workspaces').doc('owner-wsid').collection('sync_configs').add({
      description: 'hack', platform1: 'notion', platform2: 'ticktick',
    }));
  });
});

// ─────────────────────────────────────────────
// 6. /workspaces/{wsId}/sync_configs/{cId}/sync_mappings/{mId}
// ─────────────────────────────────────────────
describe('/workspaces/{wsId}/sync_configs/{cId}/sync_mappings/{mId}', () => {
  it('workspace member can read', async () => {
    await assertSucceeds(ctx.member().firestore()
      .collection('workspaces').doc('owner-wsid').collection('sync_configs').doc('test-config')
      .collection('sync_mappings').doc('test-mapping').get());
  });

  it('workspace member can write', async () => {
    await assertSucceeds(ctx.member().firestore()
      .collection('workspaces').doc('owner-wsid').collection('sync_configs').doc('test-config')
      .collection('sync_mappings').add({ sourceField: 'x', destField: 'y' }));
  });

  it('stranger cannot read', async () => {
    await assertFails(ctx.stranger().firestore()
      .collection('workspaces').doc('owner-wsid').collection('sync_configs').doc('test-config')
      .collection('sync_mappings').doc('test-mapping').get());
  });

  it('stranger cannot write', async () => {
    await assertFails(ctx.stranger().firestore()
      .collection('workspaces').doc('owner-wsid').collection('sync_configs').doc('test-config')
      .collection('sync_mappings').add({ sourceField: 'x', destField: 'y' }));
  });
});

// ─────────────────────────────────────────────
// 7. Collection-group: sync_configs
// ─────────────────────────────────────────────
describe('Collection-group: sync_configs', () => {
  it('superadmin can read', async () => {
    await assertSucceeds(ctx.superAdmin().firestore().collectionGroup('sync_configs').limit(1).get());
  });

  it('non-superadmin cannot read collection-group', async () => {
    await assertFails(ctx.owner().firestore().collectionGroup('sync_configs').limit(1).get());
    await assertFails(ctx.member().firestore().collectionGroup('sync_configs').limit(1).get());
  });

  it('write always denied', async () => {
    // The collection-group scope is read-only for superadmins. There is no client API to
    // write "through" a collectionGroup, so assert a superadmin (a non-member) cannot create
    // a sync_config at a concrete nested path — the create rule requires workspace membership.
    const db = ctx.superAdmin().firestore();
    await assertFails(db.collection('workspaces').doc('owner-wsid').collection('sync_configs').doc('new').set({ description: 'hack' }));
  });
});

// ─────────────────────────────────────────────
// 8. /execution_logs/{logId}
// ─────────────────────────────────────────────
describe('/execution_logs/{logId}', () => {
  it('workspace member can read own workspace logs', async () => {
    await assertSucceeds(ctx.owner().firestore().collection('execution_logs').doc('owner-log').get());
    await assertSucceeds(ctx.member().firestore().collection('execution_logs').doc('owner-log').get());
  });

  it('stranger cannot read logs', async () => {
    await assertFails(ctx.stranger().firestore().collection('execution_logs').doc('owner-log').get());
  });

  it('write always denied', async () => {
    await assertFails(ctx.superAdmin().firestore().collection('execution_logs').add({ workspaceId: 'owner-wsid', status: 'success' }));
  });

  it('solo user can read a log whose workspaceId is their own uid (no workspace doc)', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await context.firestore().collection('execution_logs').doc('solo-log').set({ workspaceId: 'owner-uid', status: 'success' });
    });
    await assertSucceeds(ctx.owner().firestore().collection('execution_logs').doc('solo-log').get());
    await assertFails(ctx.stranger().firestore().collection('execution_logs').doc('solo-log').get());
  });
});

// ─────────────────────────────────────────────
// 9. /connected_accounts/{accountId}
// ─────────────────────────────────────────────
describe('/connected_accounts/{accountId}', () => {
  it('workspace member can read own workspace accounts', async () => {
    await assertSucceeds(ctx.member().firestore().collection('connected_accounts').doc('owner-acct').get());
  });

  it('stranger cannot read', async () => {
    await assertFails(ctx.stranger().firestore().collection('connected_accounts').doc('owner-acct').get());
  });

  it('write always denied — create/update/delete go through backend routes only', async () => {
    await assertFails(ctx.owner().firestore().collection('connected_accounts').add({
      provider: 'notion', userId: 'owner-uid', workspaceId: 'owner-wsid',
    }));
    await assertFails(ctx.owner().firestore().collection('connected_accounts').doc('owner-acct').update({
      label: 'hack',
    }));
    await assertFails(ctx.owner().firestore().collection('connected_accounts').doc('owner-acct').delete());
  });

  it('solo user can read an account whose workspaceId is their own uid (no workspace doc)', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await context.firestore().collection('connected_accounts').doc('solo-acct').set({
        provider: 'notion', userId: 'owner-uid', workspaceId: 'owner-uid',
      });
    });
    await assertSucceeds(ctx.owner().firestore().collection('connected_accounts').doc('solo-acct').get());
    await assertFails(ctx.stranger().firestore().collection('connected_accounts').doc('solo-acct').get());
  });
});

// ─────────────────────────────────────────────
// 10. /platforms/{documentId}
// ─────────────────────────────────────────────
describe('/platforms/{documentId}', () => {
  it('any authed user can read', async () => {
    await assertSucceeds(ctx.stranger().firestore().collection('platforms').doc('notion').get());
  });

  it('write denied', async () => {
    await assertFails(ctx.superAdmin().firestore().collection('platforms').doc('hack').set({ name: 'Hack' }));
    await assertFails(ctx.owner().firestore().collection('platforms').doc('hack').set({ name: 'Hack' }));
  });
});

// ─────────────────────────────────────────────
// 11. /integrations/{documentId}
// ─────────────────────────────────────────────
describe('/integrations/{documentId}', () => {
  it('any authed user can read', async () => {
    await assertSucceeds(ctx.stranger().firestore().collection('integrations').doc('some-integration').get());
  });

  it('write denied', async () => {
    await assertFails(ctx.superAdmin().firestore().collection('integrations').add({ name: 'Hack' }));
  });
});

// ─────────────────────────────────────────────
// 12. /plans/{planId}
// ─────────────────────────────────────────────
describe('/plans/{planId}', () => {
  it('any authed user can read', async () => {
    await assertSucceeds(ctx.stranger().firestore().collection('plans').doc('free').get());
    await assertSucceeds(ctx.owner().firestore().collection('plans').doc('pro').get());
  });

  it('superadmin can write', async () => {
    await assertSucceeds(ctx.superAdmin().firestore().collection('plans').doc('new-plan').set({ name: 'Test' }));
  });

  it('non-superadmin cannot write', async () => {
    await assertFails(ctx.owner().firestore().collection('plans').doc('free').update({ maxActiveConfigs: 999 }));
    await assertFails(ctx.stranger().firestore().collection('plans').doc('free').update({ maxActiveConfigs: 999 }));
  });
});

// ─────────────────────────────────────────────
// 13. /app_settings/{documentId}
// ─────────────────────────────────────────────
describe('/app_settings/{documentId}', () => {
  it('anyone (even unauth) can read', async () => {
    await assertSucceeds(ctx.unauth().firestore().collection('app_settings').doc('theme').get());
  });

  it('only superadmin can write', async () => {
    await assertSucceeds(ctx.superAdmin().firestore().collection('app_settings').doc('new-setting').set({ value: 'test' }));
    await assertFails(ctx.owner().firestore().collection('app_settings').doc('theme').update({ value: 'hack' }));
  });
});

// ─────────────────────────────────────────────
// 14. /activity_logs/{logId}
// ─────────────────────────────────────────────
describe('/activity_logs/{logId}', () => {
  it('any authed user can read', async () => {
    await assertSucceeds(ctx.stranger().firestore().collection('activity_logs').doc('test-log').get());
  });

  it('any authed user can create with required fields', async () => {
    await assertSucceeds(ctx.stranger().firestore().collection('activity_logs').add({
      action: 'login', timestamp: new Date().toISOString(),
    }));
  });

  it('cannot create without required fields', async () => {
    await assertFails(ctx.stranger().firestore().collection('activity_logs').add({ foo: 'bar' }));
  });

  it('only superadmin can update', async () => {
    await assertSucceeds(ctx.superAdmin().firestore().collection('activity_logs').doc('test-log').update({ action: 'resolved' }));
    await assertFails(ctx.owner().firestore().collection('activity_logs').doc('test-log').update({ action: 'hack' }));
  });

  it('only superadmin can delete', async () => {
    await assertSucceeds(ctx.superAdmin().firestore().collection('activity_logs').doc('test-log').delete());
    await assertFails(ctx.owner().firestore().collection('activity_logs').doc('test-log').delete());
  });
});

// ─────────────────────────────────────────────
// 15. /credentials/{documentId}
// ─────────────────────────────────────────────
describe('/credentials/{documentId}', () => {
  it('read always denied — admin-sdk-only collection', async () => {
    await assertFails(ctx.owner().firestore().collection('credentials').doc('owner-uid').get());
    await assertFails(ctx.stranger().firestore().collection('credentials').doc('owner-uid').get());
    await assertFails(ctx.superAdmin().firestore().collection('credentials').doc('owner-uid').get());
  });

  it('write always denied', async () => {
    await assertFails(ctx.owner().firestore().collection('credentials').doc('owner-uid').update({ accessToken: 'hack' }));
    await assertFails(ctx.superAdmin().firestore().collection('credentials').doc('owner-uid').set({ accessToken: 'hack' }));
  });
});

// ─────────────────────────────────────────────
// 16. /api_keys/{keyId}
// ─────────────────────────────────────────────
describe('/api_keys/{keyId}', () => {
  it('read always denied', async () => {
    await assertFails(ctx.superAdmin().firestore().collection('api_keys').doc('test-key').get());
    await assertFails(ctx.owner().firestore().collection('api_keys').doc('test-key').get());
  });

  it('write always denied', async () => {
    await assertFails(ctx.superAdmin().firestore().collection('api_keys').add({ key: 'hack' }));
    await assertFails(ctx.owner().firestore().collection('api_keys').add({ key: 'hack' }));
  });
});

// ─────────────────────────────────────────────
// 17. /platform_secrets/{platformId}
// ─────────────────────────────────────────────
describe('/platform_secrets/{platformId}', () => {
  it('read always denied — admin-sdk-only collection', async () => {
    await assertFails(ctx.superAdmin().firestore().collection('platform_secrets').doc('notion').get());
    await assertFails(ctx.owner().firestore().collection('platform_secrets').doc('notion').get());
    await assertFails(ctx.stranger().firestore().collection('platform_secrets').doc('notion').get());
  });

  it('write always denied', async () => {
    await assertFails(ctx.superAdmin().firestore().collection('platform_secrets').doc('notion').set({ clientSecret: 'hack' }));
    await assertFails(ctx.owner().firestore().collection('platform_secrets').doc('notion').set({ clientSecret: 'hack' }));
  });
});

// ─────────────────────────────────────────────
// 17. /mail/{mailId}
// ─────────────────────────────────────────────
describe('/mail/{mailId}', () => {
  it('any authed user can read', async () => {
    await assertSucceeds(ctx.stranger().firestore().collection('mail').doc('test-mail').get());
  });

  it('any authed user can create with required fields', async () => {
    await assertSucceeds(ctx.stranger().firestore().collection('mail').add({ to: 'x@y.com', message: { subject: 'Hi' } }));
  });

  it('update denied', async () => {
    await assertFails(ctx.superAdmin().firestore().collection('mail').doc('test-mail').update({ to: 'hack@x.com' }));
  });

  it('delete denied', async () => {
    await assertFails(ctx.superAdmin().firestore().collection('mail').doc('test-mail').delete());
  });
});

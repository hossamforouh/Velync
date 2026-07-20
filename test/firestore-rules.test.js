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

  // Seed client_errors
  await firestore.collection('client_errors').doc('test-error').set({
    message: 'TypeError: x is not a function',
    createdAt: new Date().toISOString(),
    status: 'open',
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
  it('a user in the same workspace can read another user\'s profile', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const firestore = context.firestore();
      await firestore.collection('users').doc('samews-a').set({ email: 'a@test.com', workspaceId: 'shared-wsid' });
      await firestore.collection('users').doc('samews-b').set({ email: 'b@test.com', workspaceId: 'shared-wsid' });
    });
    await assertSucceeds(
      testEnv.authenticatedContext('samews-a', { email: 'a@test.com' })
        .firestore().collection('users').doc('samews-b').get()
    );
  });

  it('a stranger in a different workspace cannot read another user\'s profile', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await context.firestore().collection('users').doc('diffws-uid').set({ email: 'diff@test.com', workspaceId: 'some-other-wsid' });
    });
    await assertFails(ctx.stranger().firestore().collection('users').doc('diffws-uid').get());
  });

  it('superadmin can read any profile', async () => {
    await assertSucceeds(ctx.superAdmin().firestore().collection('users').doc('samews-a').get());
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

  it('cannot set authVersion or lastSessionRevokedAt directly, even on own doc — server-authoritative, only /api/settings/revoke-sessions may set them', async () => {
    await assertFails(ctx.owner().firestore().collection('users').doc('owner-uid').update({ authVersion: 99 }));
    await assertFails(ctx.owner().firestore().collection('users').doc('owner-uid').update({ lastSessionRevokedAt: new Date().toISOString() }));
  });

  it('can still update other allowed fields on a doc that already has authVersion/lastSessionRevokedAt set (regression: full-doc keys() check would break this)', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await context.firestore().collection('users').doc('owner-uid').set({
        email: 'owner@test.com', authVersion: 1, lastSessionRevokedAt: new Date().toISOString(),
      }, { merge: true });
    });
    await assertSucceeds(ctx.owner().firestore().collection('users').doc('owner-uid').update({ name: 'Still Works' }));
  });

  it('cannot update another user doc', async () => {
    await assertFails(ctx.owner().firestore().collection('users').doc('stranger-uid').update({ name: 'Hack' }));
  });

  it('can update notificationPrefs on a doc shaped like the real first-login write (id/workspaceName/createdAt present)', async () => {
    // Regression test: the first-login client code (app.js) creates the user
    // doc with id/workspaceName/createdAt in addition to email/name/workspaceId.
    // The update rule's hasOnly(...) allowlist must include every field that
    // create actually persists, or every subsequent update — not just
    // notification preference saves — fails with permission-denied.
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await context.firestore().collection('users').doc('first-login-uid').set({
        id: 'first-login-uid',
        email: 'firstlogin@test.com',
        workspaceName: "Personal Workspace",
        name: '',
        workspaceId: 'first-login-uid',
        createdAt: new Date().toISOString(),
      });
    });
    await assertSucceeds(
      testEnv.authenticatedContext('first-login-uid', { email: 'firstlogin@test.com' })
        .firestore().collection('users').doc('first-login-uid')
        .update({ notificationPrefs: { 'notif-sync-failure': true } })
    );
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

  it('any authed user can create a workspace matching the real signup payload', async () => {
    await assertSucceeds(ctx.stranger().firestore().collection('workspaces').doc('stranger-new-wsid').set({
      id: 'stranger-new-wsid', name: 'New WS', ownerId: 'stranger-uid', members: ['stranger-uid'], invitedEmails: [], planId: 'free',
    }));
  });

  it('create without planId still succeeds (field is optional)', async () => {
    await assertSucceeds(ctx.stranger().firestore().collection('workspaces').doc('stranger-no-plan-wsid').set({
      name: 'New WS', ownerId: 'stranger-uid', members: ['stranger-uid'],
    }));
  });

  // Regression: the create rule used to only check hasAny(['name']) with no
  // allowlist or value validation — a client could set planId to a paid
  // tier directly at creation and get a free upgrade, bypassing billing
  // entirely. See the rule's own comment for the full explanation.
  it('cannot create a workspace with a non-free planId', async () => {
    await assertFails(ctx.stranger().firestore().collection('workspaces').doc('stranger-hack-wsid').set({
      name: 'Hacked WS', ownerId: 'stranger-uid', members: ['stranger-uid'], planId: 'business',
    }));
  });

  it('cannot create a workspace claiming a different ownerId than yourself', async () => {
    await assertFails(ctx.stranger().firestore().collection('workspaces').doc('stranger-spoof-wsid').set({
      name: 'Spoofed WS', ownerId: 'owner-uid', members: ['stranger-uid'],
    }));
  });

  it('cannot create a workspace with members including someone else', async () => {
    await assertFails(ctx.stranger().firestore().collection('workspaces').doc('stranger-addmember-wsid').set({
      name: 'WS', ownerId: 'stranger-uid', members: ['stranger-uid', 'owner-uid'],
    }));
  });

  it('cannot create a workspace with a disallowed field (e.g. lsCustomerId)', async () => {
    await assertFails(ctx.stranger().firestore().collection('workspaces').doc('stranger-extra-field-wsid').set({
      name: 'WS', ownerId: 'stranger-uid', members: ['stranger-uid'], lsCustomerId: 'cus_hack',
    }));
  });

  it('owner can update with allowed field', async () => {
    await assertSucceeds(ctx.owner().firestore().collection('workspaces').doc('owner-wsid').update({ name: 'Updated' }));
  });

  it('owner cannot update with disallowed field (planId)', async () => {
    await assertFails(ctx.owner().firestore().collection('workspaces').doc('owner-wsid').update({ planId: 'pro' }));
  });

  it('owner cannot update with disallowed field (lsCustomerId)', async () => {
    await assertFails(ctx.owner().firestore().collection('workspaces').doc('owner-wsid').update({ lsCustomerId: 'cus_hack' }));
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

  it('create denied client-side — server-only (POST /api/sync-configs runs enforcePlanLimits)', async () => {
    await assertFails(ctx.member().firestore().collection('workspaces').doc('owner-wsid').collection('sync_configs').add({
      description: 'new', platform1: 'notion', platform2: 'ticktick',
    }));
  });

  it('update denied client-side — server-only, even for the doc owner', async () => {
    await assertFails(ctx.member().firestore().collection('workspaces').doc('owner-wsid').collection('sync_configs').doc('test-config').update({ description: 'updated' }));
  });

  it('solo user cannot create sync_configs client-side either, even under their own uid', async () => {
    await assertFails(ctx.owner().firestore().collection('workspaces').doc('owner-uid').collection('sync_configs').add({
      description: 'solo config', platform1: 'notion', platform2: 'ticktick',
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
  it('only superadmin can read (was: any authed user)', async () => {
    await assertSucceeds(ctx.superAdmin().firestore().collection('activity_logs').doc('test-log').get());
    await assertFails(ctx.stranger().firestore().collection('activity_logs').doc('test-log').get());
    await assertFails(ctx.owner().firestore().collection('activity_logs').doc('test-log').get());
  });

  it('client writes are always denied (Admin-SDK-only audit trail)', async () => {
    await assertFails(ctx.stranger().firestore().collection('activity_logs').add({
      action: 'login', timestamp: new Date().toISOString(),
    }));
    await assertFails(ctx.superAdmin().firestore().collection('activity_logs').add({
      action: 'login', timestamp: new Date().toISOString(),
    }));
  });

  it('even superadmin cannot update or delete from the client', async () => {
    await assertFails(ctx.superAdmin().firestore().collection('activity_logs').doc('test-log').update({ action: 'resolved' }));
    await assertFails(ctx.superAdmin().firestore().collection('activity_logs').doc('test-log').delete());
  });
});

// ─────────────────────────────────────────────
// 15. /client_errors/{errorId}
// ─────────────────────────────────────────────
describe('/client_errors/{errorId}', () => {
  it('only superadmin can read', async () => {
    await assertSucceeds(ctx.superAdmin().firestore().collection('client_errors').doc('test-error').get());
    await assertFails(ctx.stranger().firestore().collection('client_errors').doc('test-error').get());
    await assertFails(ctx.owner().firestore().collection('client_errors').doc('test-error').get());
    await assertFails(ctx.unauth().firestore().collection('client_errors').doc('test-error').get());
  });

  it('client writes are always denied — even the reporting endpoint only writes via Admin SDK', async () => {
    await assertFails(ctx.unauth().firestore().collection('client_errors').add({
      message: 'hack', createdAt: new Date().toISOString(),
    }));
    await assertFails(ctx.superAdmin().firestore().collection('client_errors').add({
      message: 'hack', createdAt: new Date().toISOString(),
    }));
  });

  it('even superadmin cannot update or delete from the client (status change/delete go through the backend)', async () => {
    await assertFails(ctx.superAdmin().firestore().collection('client_errors').doc('test-error').update({ status: 'closed' }));
    await assertFails(ctx.superAdmin().firestore().collection('client_errors').doc('test-error').delete());
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
  it('read always denied — server-only, every send goes through a backend route', async () => {
    await assertFails(ctx.stranger().firestore().collection('mail').doc('test-mail').get());
    await assertFails(ctx.superAdmin().firestore().collection('mail').doc('test-mail').get());
  });

  it('write always denied client-side, even with well-formed fields', async () => {
    await assertFails(ctx.stranger().firestore().collection('mail').add({ to: 'x@y.com', message: { subject: 'Hi' } }));
    await assertFails(ctx.superAdmin().firestore().collection('mail').doc('test-mail').update({ to: 'hack@x.com' }));
    await assertFails(ctx.superAdmin().firestore().collection('mail').doc('test-mail').delete());
  });
});

// ─────────────────────────────────────────────
// 18. /usage_events, /usage_summaries, /usage_workspace_summaries, /usage_meta
// ─────────────────────────────────────────────
describe('usage tracking collections (usage_events / usage_summaries / usage_workspace_summaries / usage_meta)', () => {
  it('usage_events: read and write always denied — admin-sdk-only', async () => {
    await assertFails(ctx.owner().firestore().collection('usage_events').doc('evt1').get());
    await assertFails(ctx.superAdmin().firestore().collection('usage_events').doc('evt1').get());
    await assertFails(ctx.owner().firestore().collection('usage_events').add({
      userId: 'owner-uid', activityType: 'sync_execution', units: 999999, estimatedCostUsd: 0,
    }));
  });

  it('usage_summaries: a user cannot read or forge their own monthly totals', async () => {
    await assertFails(ctx.owner().firestore().collection('usage_summaries').doc('owner-uid_2026-07').get());
    await assertFails(ctx.owner().firestore().collection('usage_summaries').doc('owner-uid_2026-07').set({
      userId: 'owner-uid', yearMonth: '2026-07', grandTotalCostUsd: 0,
    }));
    await assertFails(ctx.superAdmin().firestore().collection('usage_summaries').doc('owner-uid_2026-07').get());
  });

  it('usage_workspace_summaries: a member cannot read or forge their workspace\'s monthly totals', async () => {
    await assertFails(ctx.owner().firestore().collection('usage_workspace_summaries').doc('owner-wsid_2026-07').get());
    await assertFails(ctx.member().firestore().collection('usage_workspace_summaries').doc('owner-wsid_2026-07').get());
    await assertFails(ctx.owner().firestore().collection('usage_workspace_summaries').doc('owner-wsid_2026-07').set({
      workspaceId: 'owner-wsid', yearMonth: '2026-07', grandTotalCostUsd: 0,
    }));
    await assertFails(ctx.superAdmin().firestore().collection('usage_workspace_summaries').doc('owner-wsid_2026-07').get());
  });

  it('usage_meta: read and write always denied', async () => {
    await assertFails(ctx.stranger().firestore().collection('usage_meta').doc('write_failures').get());
    await assertFails(ctx.superAdmin().firestore().collection('usage_meta').doc('write_failures').set({ count: 0 }));
  });

  it('usage_actuals: read and write always denied (admin-recorded GCP bill, server-only)', async () => {
    await assertFails(ctx.stranger().firestore().collection('usage_actuals').doc('2026-07').get());
    await assertFails(ctx.superAdmin().firestore().collection('usage_actuals').doc('2026-07').get());
    await assertFails(ctx.superAdmin().firestore().collection('usage_actuals').doc('2026-07').set({ actualBillUsd: 100 }));
  });
});

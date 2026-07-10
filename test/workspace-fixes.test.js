/**
 * Workspace Settings fixes — regression tests.
 *
 * Covers:
 *  1. DELETE /workspace/member now requires ownership and blocks removing the owner.
 *  2. PUT /workspace/name is owner-only (previously any member could rename).
 *  3. POST /workspace/invite rejects an email that already belongs to a member.
 *  4. POST /workspace/transfer-ownership flips ownerId, keeps both old and
 *     new owner in `members`.
 *  5. POST /workspace/decline-invite lets an invited (non-member) user
 *     remove their own pending invite.
 *  6. deleteWorkspace() resets departed members'/owner's own workspaceId
 *     back to their own uid instead of leaving a dangling reference.
 *
 * Run:  npm run test:workspace-fixes
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

const OWNER_UID = 'ws-test-owner';
const MEMBER_UID = 'ws-test-member';
const OTHER_UID = 'ws-test-other';
const WORKSPACE_ID = 'ws-test-workspace';

let currentUid = OWNER_UID;
let currentEmail = `${OWNER_UID}@wstest.com`;

const authPath = require.resolve('../src/api/middleware/auth');
require.cache[authPath] = {
  id: authPath,
  filename: authPath,
  loaded: true,
  exports: {
    verifyAuth: (req, res, next) => {
      req.user = { uid: currentUid, email: currentEmail, firebase: { identities: { email: [currentEmail] } } };
      next();
    },
  },
};

const db = require('../src/core/db');
const { createApp } = require('../src/api/server');
const { deleteWorkspace } = require('../src/domains/workspace/deletion');

let server;
let baseUrl;

before(async () => {
  await db.collection('users').doc(OWNER_UID).set({ workspaceId: WORKSPACE_ID, email: `${OWNER_UID}@wstest.com` });
  await db.collection('users').doc(MEMBER_UID).set({ workspaceId: WORKSPACE_ID, email: `${MEMBER_UID}@wstest.com` });
  await db.collection('users').doc(OTHER_UID).set({ workspaceId: OTHER_UID, email: `${OTHER_UID}@wstest.com` });
  await db.collection('workspaces').doc(WORKSPACE_ID).set({
    name: 'Test Workspace', ownerId: OWNER_UID, members: [OWNER_UID, MEMBER_UID], invitedEmails: [],
  });

  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function asUser(uid, email) {
  currentUid = uid;
  currentEmail = email;
}

async function apiFetch(path, options = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer fake', ...(options.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

describe('DELETE /workspace/member authorization', () => {
  it('non-owner member cannot remove another member', async () => {
    asUser(MEMBER_UID, `${MEMBER_UID}@wstest.com`);
    const { status, body } = await apiFetch('/api/workspace/member', {
      method: 'DELETE', body: JSON.stringify({ userId: OWNER_UID }),
    });
    assert.strictEqual(status, 403);
    assert.match(body.error, /owner/i);
  });

  it('cannot remove the owner even as the owner themself', async () => {
    asUser(OWNER_UID, `${OWNER_UID}@wstest.com`);
    const { status, body } = await apiFetch('/api/workspace/member', {
      method: 'DELETE', body: JSON.stringify({ userId: OWNER_UID }),
    });
    assert.strictEqual(status, 400);
    assert.match(body.error, /owner/i);
  });

  it('owner can remove a regular member, and that member is reset to their own solo workspace', async () => {
    asUser(OWNER_UID, `${OWNER_UID}@wstest.com`);
    const { status } = await apiFetch('/api/workspace/member', {
      method: 'DELETE', body: JSON.stringify({ userId: MEMBER_UID }),
    });
    assert.strictEqual(status, 200);

    const wsDoc = await db.collection('workspaces').doc(WORKSPACE_ID).get();
    assert.ok(!wsDoc.data().members.includes(MEMBER_UID));

    const memberUserDoc = await db.collection('users').doc(MEMBER_UID).get();
    assert.strictEqual(memberUserDoc.data().workspaceId, MEMBER_UID);

    // restore for subsequent tests
    await db.collection('workspaces').doc(WORKSPACE_ID).update({ members: [OWNER_UID, MEMBER_UID] });
    await db.collection('users').doc(MEMBER_UID).update({ workspaceId: WORKSPACE_ID });
  });
});

describe('PUT /workspace/name is owner-only', () => {
  it('non-owner member cannot rename the workspace', async () => {
    asUser(MEMBER_UID, `${MEMBER_UID}@wstest.com`);
    const { status, body } = await apiFetch('/api/workspace/name', {
      method: 'PUT', body: JSON.stringify({ name: 'Hijacked Name', workspaceId: WORKSPACE_ID }),
    });
    assert.strictEqual(status, 403);
    assert.match(body.error, /owner/i);
  });

  it('owner can rename and set a description', async () => {
    asUser(OWNER_UID, `${OWNER_UID}@wstest.com`);
    const { status } = await apiFetch('/api/workspace/name', {
      method: 'PUT', body: JSON.stringify({ name: 'Renamed Workspace', description: 'A test workspace', workspaceId: WORKSPACE_ID }),
    });
    assert.strictEqual(status, 200);
    const wsDoc = await db.collection('workspaces').doc(WORKSPACE_ID).get();
    assert.strictEqual(wsDoc.data().name, 'Renamed Workspace');
    assert.strictEqual(wsDoc.data().description, 'A test workspace');
  });
});

describe('POST /workspace/invite rejects existing members', () => {
  it('rejects inviting an email that already belongs to a member', async () => {
    asUser(OWNER_UID, `${OWNER_UID}@wstest.com`);
    const { status, body } = await apiFetch('/api/workspace/invite', {
      method: 'POST', body: JSON.stringify({ email: `${MEMBER_UID}@wstest.com`, workspaceId: WORKSPACE_ID }),
    });
    assert.strictEqual(status, 409);
    assert.match(body.error, /already a member/i);
  });
});

describe('POST /workspace/transfer-ownership', () => {
  it('non-owner cannot transfer ownership', async () => {
    asUser(MEMBER_UID, `${MEMBER_UID}@wstest.com`);
    const { status } = await apiFetch('/api/workspace/transfer-ownership', {
      method: 'POST', body: JSON.stringify({ workspaceId: WORKSPACE_ID, newOwnerId: MEMBER_UID }),
    });
    assert.strictEqual(status, 403);
  });

  it('owner can transfer to an existing member, who stays listed as a member', async () => {
    asUser(OWNER_UID, `${OWNER_UID}@wstest.com`);
    const { status } = await apiFetch('/api/workspace/transfer-ownership', {
      method: 'POST', body: JSON.stringify({ workspaceId: WORKSPACE_ID, newOwnerId: MEMBER_UID }),
    });
    assert.strictEqual(status, 200);

    const wsDoc = await db.collection('workspaces').doc(WORKSPACE_ID).get();
    assert.strictEqual(wsDoc.data().ownerId, MEMBER_UID);
    assert.ok(wsDoc.data().members.includes(MEMBER_UID));
    assert.ok(wsDoc.data().members.includes(OWNER_UID), 'old owner should remain a member, not be removed');
  });

  it('rejects transferring to someone who is not a member', async () => {
    asUser(MEMBER_UID, `${MEMBER_UID}@wstest.com`); // now the owner after the previous test
    const { status } = await apiFetch('/api/workspace/transfer-ownership', {
      method: 'POST', body: JSON.stringify({ workspaceId: WORKSPACE_ID, newOwnerId: OTHER_UID }),
    });
    assert.strictEqual(status, 400);
  });
});

describe('POST /workspace/decline-invite', () => {
  it('a non-member with a pending invite can decline it themselves', async () => {
    await db.collection('workspaces').doc(WORKSPACE_ID).update({ invitedEmails: [`${OTHER_UID}@wstest.com`] });
    asUser(OTHER_UID, `${OTHER_UID}@wstest.com`);
    const { status } = await apiFetch('/api/workspace/decline-invite', {
      method: 'POST', body: JSON.stringify({ workspaceId: WORKSPACE_ID }),
    });
    assert.strictEqual(status, 200);
    const wsDoc = await db.collection('workspaces').doc(WORKSPACE_ID).get();
    assert.ok(!wsDoc.data().invitedEmails.includes(`${OTHER_UID}@wstest.com`));
  });

  it('rejects declining when there is no invite for that user', async () => {
    asUser(OTHER_UID, `${OTHER_UID}@wstest.com`);
    const { status } = await apiFetch('/api/workspace/decline-invite', {
      method: 'POST', body: JSON.stringify({ workspaceId: WORKSPACE_ID }),
    });
    assert.strictEqual(status, 403);
  });
});

describe('deleteWorkspace resets member workspaceId references', () => {
  it('resets owner and members back to their own uid instead of a dangling reference', async () => {
    const delWsId = 'ws-test-delete-me';
    const delOwner = 'ws-test-del-owner';
    const delMember = 'ws-test-del-member';
    await db.collection('users').doc(delOwner).set({ workspaceId: delWsId });
    await db.collection('users').doc(delMember).set({ workspaceId: delWsId });
    await db.collection('workspaces').doc(delWsId).set({ name: 'To Delete', ownerId: delOwner, members: [delOwner, delMember] });

    const result = await deleteWorkspace(delWsId, { initiatedBy: delOwner });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.summary.membersReset, 2);

    const ownerDoc = await db.collection('users').doc(delOwner).get();
    const memberDoc = await db.collection('users').doc(delMember).get();
    assert.strictEqual(ownerDoc.data().workspaceId, delOwner);
    assert.strictEqual(memberDoc.data().workspaceId, delMember);

    const wsDoc = await db.collection('workspaces').doc(delWsId).get();
    assert.strictEqual(wsDoc.exists, false);
  });
});

describe('GET /workspace/:id/plan', () => {
  it('a member can resolve their own workspace\'s plan connectorTiers', async () => {
    await db.collection('plans').doc('pro').set({ name: 'Pro', connectorTiers: ['basic', 'premium'] });
    await db.collection('workspaces').doc(WORKSPACE_ID).set({ planId: 'pro' }, { merge: true });
    asUser(MEMBER_UID, `${MEMBER_UID}@wstest.com`);
    const { status, body } = await apiFetch(`/api/workspace/${WORKSPACE_ID}/plan`);
    assert.strictEqual(status, 200);
    assert.strictEqual(body.plan.id, 'pro');
    assert.deepStrictEqual(body.plan.connectorTiers, ['basic', 'premium']);
  });

  it('defaults to free/basic when the workspace has no planId', async () => {
    const noPlanWs = 'ws-test-no-plan';
    await db.collection('workspaces').doc(noPlanWs).set({ ownerId: OWNER_UID, members: [OWNER_UID] });
    asUser(OWNER_UID, `${OWNER_UID}@wstest.com`);
    const { status, body } = await apiFetch(`/api/workspace/${noPlanWs}/plan`);
    assert.strictEqual(status, 200);
    assert.strictEqual(body.plan.id, 'free');
  });

  it('a stranger (non-member, non-superadmin) is rejected', async () => {
    asUser('ws-test-stranger', 'stranger@wstest.com');
    const { status } = await apiFetch(`/api/workspace/${WORKSPACE_ID}/plan`);
    assert.strictEqual(status, 403);
  });

  it('404s for a nonexistent workspace', async () => {
    asUser(OWNER_UID, `${OWNER_UID}@wstest.com`);
    const { status } = await apiFetch('/api/workspace/does-not-exist/plan');
    assert.strictEqual(status, 404);
  });
});

describe('GET /workspace/invites', () => {
  it('returns pending invites using the token email, WITHOUT requiring users/{uid} to exist', async () => {
    // Regression test: a brand-new signup's users/{uid} doc is created by the
    // frontend's ensureUserDoc() concurrently with this call (Promise.all in
    // app.js's onAuthStateChanged) — reading the invite email back out of
    // users/{uid} could lose that race on first sign-in and silently return no
    // invites (fixed only by a page refresh). The route must resolve the email
    // from the verified ID token directly, so it works even with no users doc.
    const freshUid = 'ws-test-brand-new-signup';
    const freshEmail = 'brand-new-signup@wstest.com';
    // Deliberately do NOT create users/{freshUid} — simulates the race.
    const inviteWsId = 'ws-test-invite-target';
    await db.collection('workspaces').doc(inviteWsId).set({
      name: 'Invited Workspace', ownerId: OWNER_UID, members: [OWNER_UID], invitedEmails: [freshEmail],
    });

    asUser(freshUid, freshEmail);
    const { status, body } = await apiFetch('/api/workspace/invites');
    assert.strictEqual(status, 200);
    assert.ok(body.invites.some(w => w.id === inviteWsId), 'expected the pending invite to be returned even with no users/{uid} doc');
  });

  it('returns an empty list when there are no invites for the caller', async () => {
    asUser(OTHER_UID, `${OTHER_UID}@wstest.com`);
    const { status, body } = await apiFetch('/api/workspace/invites');
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body.invites, []);
  });
});

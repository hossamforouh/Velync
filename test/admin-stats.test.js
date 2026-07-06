/**
 * Admin Stats / Management Test Suite
 *
 * Runs the real admin domain functions (src/domains/admin/stats.js) against the
 * Firestore emulator with a known seed dataset. The Admin SDK auto-connects to
 * the emulator because `firebase emulators:exec` sets FIRESTORE_EMULATOR_HOST.
 *
 * Run:  npm run test:admin
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert');

const db = require('../src/core/db');
const { getAdminStats, listWorkspaces, getRecentSyncHealth } = require('../src/domains/admin/stats');

// Deterministic seed — the emulator starts empty each run, so exact counts hold.
before(async () => {
  await db.collection('plans').doc('free').set({ name: 'Free' });
  await db.collection('plans').doc('pro').set({ name: 'Pro' });

  await db.collection('workspaces').doc('ws1').set({ name: 'W1', ownerId: 'u1', planId: 'pro', members: ['u1', 'u2'] });
  await db.collection('workspaces').doc('ws2').set({ name: 'W2', ownerId: 'u3', planId: 'free', members: ['u3'] });
  await db.collection('workspaces').doc('ws3').set({ name: 'W3', ownerId: 'u4', members: [] }); // no planId → treated as free

  await db.collection('users').doc('u1').set({ email: 'u1@test.com' });
  await db.collection('users').doc('u2').set({ email: 'u2@test.com' });
  await db.collection('users').doc('u3').set({ email: 'u3@test.com' });

  await db.collection('connected_accounts').doc('a1').set({ provider: 'notion', userId: 'u1', workspaceId: 'ws1' });
  await db.collection('connected_accounts').doc('a2').set({ provider: 'ticktick', userId: 'u3', workspaceId: 'ws2' });

  await db.collection('workspaces').doc('ws1').collection('sync_configs').doc('c1').set({ status: 'active' });
  await db.collection('workspaces').doc('ws1').collection('sync_configs').doc('c2').set({ status: 'draft' });
  await db.collection('workspaces').doc('ws2').collection('sync_configs').doc('c3').set({ status: 'active' });

  await db.collection('execution_logs').doc('l1').set({ startTime: '2026-01-01T10:00:00.000Z', status: 'success', workspaceId: 'ws1' });
  await db.collection('execution_logs').doc('l2').set({ startTime: '2026-01-01T11:00:00.000Z', status: 'error', workspaceId: 'ws1' });
  await db.collection('execution_logs').doc('l3').set({ startTime: '2026-01-01T12:00:00.000Z', status: 'success', workspaceId: 'ws2' });
});

describe('admin stats — getAdminStats', () => {
  it('counts core entities via aggregation', async () => {
    const s = await getAdminStats();
    assert.strictEqual(s.totalWorkspaces, 3);
    assert.strictEqual(s.totalUsers, 3);
    assert.strictEqual(s.totalConnectedAccounts, 2);
    assert.strictEqual(s.totalActiveConfigs, 2, 'two configs with status active');
  });

  it('breaks workspaces down by plan and derives paid count', async () => {
    const s = await getAdminStats();
    assert.strictEqual(s.workspacesByPlan.pro.count, 1);
    assert.strictEqual(s.workspacesByPlan.free.count, 1);
    assert.strictEqual(s.paidWorkspaces, 1, 'only the pro workspace is paid');
  });
});

describe('admin stats — listWorkspaces', () => {
  it('lists all workspaces with member counts', async () => {
    const { items } = await listWorkspaces();
    assert.strictEqual(items.length, 3);
    const ws1 = items.find(w => w.id === 'ws1');
    assert.strictEqual(ws1.memberCount, 2);
    assert.strictEqual(ws1.planId, 'pro');
    const ws3 = items.find(w => w.id === 'ws3');
    assert.strictEqual(ws3.planId, 'free', 'missing planId defaults to free');
  });

  it('paginates via limit + cursor without dropping docs', async () => {
    const page1 = await listWorkspaces({ limit: 2 });
    assert.strictEqual(page1.items.length, 2);
    assert.ok(page1.nextCursor, 'cursor returned when more remain');
    const page2 = await listWorkspaces({ limit: 2, startAfter: page1.nextCursor });
    assert.strictEqual(page2.items.length, 1);
    assert.strictEqual(page2.nextCursor, null, 'no cursor on the last page');
    const allIds = [...page1.items, ...page2.items].map(w => w.id).sort();
    assert.deepStrictEqual(allIds, ['ws1', 'ws2', 'ws3']);
  });
});

describe('admin stats — getRecentSyncHealth', () => {
  it('summarises recent execution logs by status, newest first', async () => {
    const { summary, recent } = await getRecentSyncHealth({ limit: 10 });
    assert.strictEqual(summary.total, 3);
    assert.strictEqual(summary.byStatus.success, 2);
    assert.strictEqual(summary.byStatus.error, 1);
    assert.strictEqual(recent[0].id, 'l3', 'ordered by startTime desc');
  });
});

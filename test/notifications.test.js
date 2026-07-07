/**
 * Notification delivery — regression tests.
 *
 * Covers the sync-failure email pipeline (src/core/notifications.js), which
 * previously didn't exist at all — the Notifications Settings toggles saved
 * a preference but nothing ever read it. Also covers reconcileStuckRuns()
 * now notifying on timed-out runs.
 *
 * Run:  npm run test:notifications
 */

require('dotenv').config();
const { describe, it, before } = require('node:test');
const assert = require('node:assert');

const db = require('../src/core/db');
const { notifySyncFailure } = require('../src/core/notifications');
const { reconcileStuckRuns } = require('../src/domains/sync/log-cleanup');

async function getMailTo(email) {
  const snap = await db.collection('mail').where('to', '==', email).get();
  return snap.docs.map(d => d.data());
}

before(async () => {
  await db.collection('workspaces').doc('notif-ws').set({ ownerId: 'notif-owner', members: ['notif-member'] });
  await db.collection('users').doc('notif-owner').set({ email: 'owner@notiftest.com' });
  await db.collection('users').doc('notif-member').set({ email: 'member@notiftest.com', notificationPrefs: { 'notif-sync-failure': false } });
});

describe('notifySyncFailure', () => {
  it('emails opted-in members but not an opted-out member', async () => {
    await notifySyncFailure({
      workspaceId: 'notif-ws', configId: 'cfg-a', configName: 'My Sync', error: 'boom', currentLogId: 'log-1',
    });

    const ownerMail = await getMailTo('owner@notiftest.com');
    assert.strictEqual(ownerMail.length, 1);
    assert.match(ownerMail[0].message.subject, /Sync failed/);
    assert.match(ownerMail[0].message.text, /boom/);

    const memberMail = await getMailTo('member@notiftest.com');
    assert.strictEqual(memberMail.length, 0);
  });

  it('defaults to opted-in when notificationPrefs is unset', async () => {
    await db.collection('workspaces').doc('notif-ws-2').set({ ownerId: 'notif-owner-2', members: [] });
    await db.collection('users').doc('notif-owner-2').set({ email: 'owner2@notiftest.com' });

    await notifySyncFailure({
      workspaceId: 'notif-ws-2', configId: 'cfg-b', configName: 'Another Sync', error: 'oops', currentLogId: 'log-2',
    });

    const mail = await getMailTo('owner2@notiftest.com');
    assert.strictEqual(mail.length, 1);
  });

  it('does not re-notify on a second consecutive failure for the same config', async () => {
    await db.collection('execution_logs').doc('log-3').set({
      configId: 'cfg-c', workspaceId: 'notif-ws', status: 'error', startTime: new Date(Date.now() - 60000).toISOString(),
    });

    await notifySyncFailure({
      workspaceId: 'notif-ws', configId: 'cfg-c', configName: 'Repeat Fail', error: 'still broken', currentLogId: 'log-4',
    });

    const mail = await getMailTo('owner@notiftest.com');
    // Only the one email from the first test above — nothing new for cfg-c.
    assert.strictEqual(mail.filter(m => m.message.text.includes('still broken')).length, 0);
  });
});

describe('reconcileStuckRuns — notifies on timeout', () => {
  it('sends a sync-failure email for a reconciled stuck run', async () => {
    await db.collection('execution_logs').doc('stuck-log-1').set({
      configId: 'cfg-stuck', workspaceId: 'notif-ws', status: 'running',
      startTime: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      configName: 'Stuck Config',
    });

    await reconcileStuckRuns();

    const stuckDoc = await db.collection('execution_logs').doc('stuck-log-1').get();
    assert.strictEqual(stuckDoc.data().status, 'error');

    const mail = await getMailTo('owner@notiftest.com');
    const timeoutMail = mail.filter(m => m.message.subject.includes('Stuck Config'));
    assert.strictEqual(timeoutMail.length, 1);
  });
});

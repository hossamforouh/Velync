const db = require('./db');
const logger = require('./logger');

/**
 * Resolve the email addresses of workspace members who have opted into a
 * given notification preference. Preferences default to enabled (matching
 * the Settings UI, which ships with these toggles checked) — a user must
 * explicitly opt out.
 */
async function getOptedInRecipientEmails(workspaceId, prefKey) {
  let uids;
  const wsDoc = await db.collection('workspaces').doc(workspaceId).get();
  if (wsDoc.exists) {
    const ws = wsDoc.data();
    uids = [ws.ownerId, ...(ws.members || [])].filter(Boolean);
  } else {
    // Solo workspace shortcut: the app uses the owner's own uid as the workspaceId.
    uids = [workspaceId];
  }
  uids = [...new Set(uids)];

  const emails = [];
  for (const uid of uids) {
    try {
      const userDoc = await db.collection('users').doc(uid).get();
      if (!userDoc.exists) continue;
      const user = userDoc.data();
      const optedIn = (user.notificationPrefs || {})[prefKey] !== false;
      if (optedIn && user.email) emails.push(user.email);
    } catch (err) {
      logger.warn('notifications', `Failed to resolve recipient "${uid}"`, { error: err.message });
    }
  }
  return emails;
}

/**
 * Email workspace members when a sync config fails. Only fires on the first
 * failure in a streak (skips if the previous run for this config also
 * errored) — otherwise a persistently broken connection would email on every
 * scheduled retry.
 */
async function notifySyncFailure({ workspaceId, configId, configName, error, currentLogId }) {
  try {
    const prevSnap = await db.collection('execution_logs')
      .where('configId', '==', configId)
      .orderBy('startTime', 'desc')
      .limit(2)
      .get();
    const prevLog = prevSnap.docs.find(d => d.id !== currentLogId);
    if (prevLog && prevLog.data().status === 'error') {
      return; // already notified for this failure streak
    }

    const emails = await getOptedInRecipientEmails(workspaceId, 'notif-sync-failure');
    if (emails.length === 0) return;

    const label = configName || configId;
    for (const to of emails) {
      await db.collection('mail').add({
        to,
        message: {
          subject: `[Velync] Sync failed — "${label}"`,
          text: `Your sync "${label}" failed to complete.\n\nError: ${error}\n\nView details: https://velync.web.app/\n\nYou can turn these emails off anytime in Settings > Notifications.`,
        },
      });
    }
    logger.info('notifications', `Sent sync-failure email(s) for "${configId}"`, { recipients: emails.length });
  } catch (err) {
    logger.error('notifications', 'Failed to send sync-failure email', { error: err.message });
  }
}

module.exports = { getOptedInRecipientEmails, notifySyncFailure };

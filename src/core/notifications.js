const db = require('./db');
const logger = require('./logger');
const { renderEmailHtml, escHtml, p } = require('./emailTemplate');

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
    const html = renderEmailHtml({
      eyebrow: 'Sync failed',
      accent: 'danger',
      heading: `"${label}" failed to complete`,
      bodyHtml:
        p(`Your sync <strong style="color:#E2E4F0;">${escHtml(label)}</strong> ran into an error and did not finish.`) +
        `<div style="background:rgba(251,113,133,0.08);border:1px solid rgba(251,113,133,0.25);border-radius:10px;padding:14px 16px;margin:0 0 20px;">
          <p style="color:#FB7185;font-size:13px;font-family:'SF Mono',Consolas,monospace;margin:0;word-break:break-word;">${escHtml(error)}</p>
        </div>` +
        p('You can turn these emails off anytime in Settings &rsaquo; Notifications.'),
      ctaText: 'View Execution Logs',
      ctaUrl: 'https://velync.web.app/',
    });
    const text = `Your sync "${label}" failed to complete.\n\nError: ${error}\n\nView details: https://velync.web.app/\n\nYou can turn these emails off anytime in Settings > Notifications.`;
    for (const to of emails) {
      await db.collection('mail').add({
        to,
        message: {
          subject: `[Velync] Sync failed — "${label}"`,
          text,
          html,
        },
      });
    }
    logger.info('notifications', `Sent sync-failure email(s) for "${configId}"`, { recipients: emails.length });
  } catch (err) {
    logger.error('notifications', 'Failed to send sync-failure email', { error: err.message });
  }
}

/**
 * Email workspace members when a connection flips into the needs-reauth
 * state (expired/revoked refresh token). Distinct from notifySyncFailure:
 * that one reports "a run failed" with a technical error, which for an auth
 * problem reads as noise — this one tells the user the one thing that
 * actually fixes it (reconnect the account). Callers only invoke this on
 * the false→true transition, so a connection that stays broken doesn't
 * re-email on every subsequent refresh attempt.
 */
async function notifyConnectionNeedsReauth({ workspaceId, provider, label }) {
  try {
    // Same preference key as sync-failure emails — to the user these are
    // one category ("tell me when my syncs stop working"), and a separate
    // toggle nobody has set yet would default-on anyway.
    const emails = await getOptedInRecipientEmails(workspaceId, 'notif-sync-failure');
    if (emails.length === 0) return;

    const providerName = (provider || 'platform').split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    const connLabel = label || providerName;
    const html = renderEmailHtml({
      eyebrow: 'Action needed',
      accent: 'warning',
      heading: `Reconnect your ${escHtml(providerName)} account`,
      bodyHtml:
        p(`Velync lost access to <strong style="color:#E2E4F0;">${escHtml(connLabel)}</strong>. This usually happens when a password was changed or access was revoked on the other platform's side.`) +
        p('Any syncs using this connection are paused from flowing until it is reconnected. Your data and settings are untouched — reconnecting picks up right where things left off.') +
        p('Open Velync, go to <strong style="color:#E2E4F0;">Connections</strong>, and click <strong style="color:#E2E4F0;">Reconnect</strong> next to this account.'),
      ctaText: 'Reconnect Now',
      ctaUrl: 'https://velync.web.app/',
    });
    const text = `Velync lost access to your ${providerName} connection "${connLabel}".\n\nSyncs using it are paused until it's reconnected. Open Velync > Connections and click Reconnect.\n\nhttps://velync.web.app/`;
    for (const to of emails) {
      await db.collection('mail').add({
        to,
        message: {
          subject: `[Velync] Action needed — reconnect your ${providerName} account`,
          text,
          html,
        },
      });
    }
    logger.info('notifications', `Sent reauth-needed email(s) for a ${provider} connection`, { recipients: emails.length });
  } catch (err) {
    logger.error('notifications', 'Failed to send reauth-needed email', { error: err.message });
  }
}

/**
 * Email every superadmin. Used for failures that would otherwise be
 * invisible to everyone (e.g. a billing webhook handler throwing) — a log
 * line alone means nobody finds out until a user complains.
 */
async function notifyAdmins(subject, text) {
  try {
    const superadminsSnap = await db.collection('superadmins').get();
    const uids = superadminsSnap.docs.map(d => d.id);
    if (uids.length === 0) return;

    const emails = [];
    for (const uid of uids) {
      try {
        const userDoc = await db.collection('users').doc(uid).get();
        if (userDoc.exists && userDoc.data().email) emails.push(userDoc.data().email);
      } catch (err) {
        logger.warn('notifications', `Failed to resolve superadmin "${uid}"`, { error: err.message });
      }
    }

    // notifyAdmins() is called with free-form technical text from several
    // unrelated places (webhook failures, deletion errors, verification
    // tokens) — rather than touching every call site, wrap whatever text
    // was passed in the same branded shell, preserving its line breaks.
    const html = renderEmailHtml({
      eyebrow: 'Admin alert',
      accent: 'warning',
      heading: subject.replace(/^\[Velync\]\s*/, ''),
      bodyHtml: `<div style="background:rgba(251,191,36,0.08);border:1px solid rgba(251,191,36,0.25);border-radius:10px;padding:16px;">
          <p style="color:#A8AEC0;font-size:14px;line-height:22px;margin:0;white-space:pre-wrap;font-family:'SF Mono',Consolas,monospace;">${escHtml(text)}</p>
        </div>`,
      footerNote: 'Sent to superadmins only.',
    });
    for (const to of emails) {
      await db.collection('mail').add({ to, message: { subject, text, html } });
    }
    if (emails.length > 0) {
      logger.info('notifications', `Sent admin alert: "${subject}"`, { recipients: emails.length });
    }
  } catch (err) {
    logger.error('notifications', 'Failed to send admin alert', { error: err.message, subject });
  }
}

module.exports = { getOptedInRecipientEmails, notifySyncFailure, notifyConnectionNeedsReauth, notifyAdmins };

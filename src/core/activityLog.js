const { FieldValue } = require('@google-cloud/firestore');
const db = require('./db');
const logger = require('./logger');

/**
 * Records an admin action to activity_logs. Server-side equivalent of the
 * client-side logActivity() that used to live in admin-integrations.js —
 * moved here because admin writes for platforms/integrations now go through
 * backend routes (see src/api/routes/admin-platforms.js, admin-integrations.js),
 * and because client-side logging was trivially spoofable (any authenticated
 * user could write directly to activity_logs, not just admins).
 *
 * Same document shape as the retired client-side version, so the existing
 * Activity Log tab renders both old and new entries identically.
 *
 * Never throws — a failed audit-log write must not block the actual admin
 * action it's describing.
 */
async function logAdminActivity({ uid, userEmail, action, targetType, targetId, targetName }) {
  try {
    const resolvedName = targetName || targetId;
    await db.collection('activity_logs').add({
      action,
      targetType,
      targetId,
      targetName: resolvedName,
      userId: uid || 'system',
      userEmail: userEmail || 'system@velync.app',
      userDisplayName: (userEmail || 'system').split('@')[0],
      timestamp: FieldValue.serverTimestamp(),
      details: `${action} ${targetType} "${resolvedName}"`,
    });
  } catch (err) {
    logger.warn('activity-log', 'Failed to write activity log', { error: err.message, action, targetType, targetId });
  }
}

module.exports = { logAdminActivity };

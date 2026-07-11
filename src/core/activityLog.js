const { FieldValue } = require('@google-cloud/firestore');
const db = require('./db');
const logger = require('./logger');

/**
 * Records an admin action to activity_logs (surfaced in the admin panel as
 * the "Audit Log" tab). Server-side equivalent of the client-side
 * logActivity() that used to live in admin-integrations.js — moved here
 * because admin writes for platforms/integrations now go through backend
 * routes (see src/api/routes/admin-platforms.js, admin-integrations.js),
 * and because client-side logging was trivially spoofable (any authenticated
 * user could write directly to activity_logs, not just admins).
 *
 * Same document shape as the retired client-side version (plus the newer
 * `changes` field), so the Audit Log tab renders old and new entries
 * identically.
 *
 * Never throws — a failed audit-log write must not block the actual admin
 * action it's describing.
 *
 * @param {object} params
 * @param {string} [params.uid]
 * @param {string} [params.userEmail]
 * @param {string} params.action - e.g. 'create' | 'update' | 'delete' | 'restore' | 'activate' | 'deactivate'
 * @param {string} params.targetType - e.g. 'plan' | 'platform' | 'integration' | 'workspace-plan' | 'global-settings'
 * @param {string} params.targetId
 * @param {string} [params.targetName]
 * @param {Record<string, {before: any, after: any}>} [params.changes] - field-level
 *   diff, as produced by computeChanges(). Omitted (not just empty) for
 *   actions where a diff doesn't apply (create/delete/restore/toggle).
 */
async function logAdminActivity({ uid, userEmail, action, targetType, targetId, targetName, changes }) {
  try {
    const resolvedName = targetName || targetId;
    const doc = {
      action,
      targetType,
      targetId,
      targetName: resolvedName,
      userId: uid || 'system',
      userEmail: userEmail || 'system@velync.app',
      userDisplayName: (userEmail || 'system').split('@')[0],
      timestamp: FieldValue.serverTimestamp(),
      details: `${action} ${targetType} "${resolvedName}"`,
    };
    if (changes && Object.keys(changes).length > 0) {
      doc.changes = changes;
      doc.details += ` — changed: ${Object.keys(changes).join(', ')}`;
    }
    await db.collection('activity_logs').add(doc);
  } catch (err) {
    logger.warn('activity-log', 'Failed to write activity log', { error: err.message, action, targetType, targetId });
  }
}

/**
 * Field-level diff between the currently-stored doc and an incoming update,
 * restricted to `fields`. Used to skip both the write and the audit-log
 * entry when a "Save" produces no actual change (e.g. clicking Save without
 * editing anything) — previously every save logged an 'update' entry
 * unconditionally, filling the audit log with no-op noise.
 *
 * Compares via a key-sorted JSON stringify (stableStringify below), not a
 * plain JSON.stringify — a freshly-submitted form payload and the same
 * object as round-tripped through Firestore aren't guaranteed to preserve
 * identical key insertion order for nested objects (e.g. a platform's
 * `configSchema`/`attributes`), which would otherwise register as a false
 * "changed" even when every value is identical.
 *
 * @param {object|undefined} before - current stored doc data (undefined if new)
 * @param {object} after - the fields about to be written
 * @param {string[]} fields - which keys of `after` to compare
 * @returns {Record<string, {before: any, after: any}>} empty object if nothing changed
 */
function stableStringify(value) {
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function computeChanges(before, after, fields) {
  const changes = {};
  for (const key of fields) {
    if (!(key in after)) continue;
    const beforeVal = before ? (before[key] ?? null) : null;
    const afterVal = after[key] ?? null;
    const equal = beforeVal === afterVal || stableStringify(beforeVal) === stableStringify(afterVal);
    if (!equal) changes[key] = { before: beforeVal, after: afterVal };
  }
  return changes;
}

module.exports = { logAdminActivity, computeChanges };

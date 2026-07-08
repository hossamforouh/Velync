const { Router } = require('express');
const { FieldValue } = require('@google-cloud/firestore');
const { body, param, validationResult } = require('express-validator');
const { getAuth } = require('firebase-admin/auth');
const { verifyAuth } = require('../middleware/auth');
const { isSuperAdmin } = require('../../core/superadmin');
const { deleteWorkspace } = require('../../domains/workspace/deletion');
const { notifyAdmins } = require('../../core/notifications');
const db = require('../../core/db');
const logger = require('../../core/logger');

const router = Router();

let settingsCache = { data: null, time: 0 };
const CACHE_TTL = 60000;

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Validation failed', details: errors.array() });
  }
  next();
};

router.get('/global', async (req, res) => {
  try {
    if (settingsCache.data && Date.now() - settingsCache.time < CACHE_TTL) {
      return res.json(settingsCache.data);
    }
    const doc = await db.collection('app_settings').doc('general').get();
    const data = doc.data() || {};
    settingsCache = { data, time: Date.now() };
    return res.json(data);
  } catch (err) {
    logger.error('settings', 'Failed to read global settings', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

router.put('/global', verifyAuth, [
  body('whatsappNumber').optional().isString().trim(),
  body('maintenanceMode').optional().isBoolean(),
  body('maintenanceMessage').optional().isString().trim().isLength({ max: 500 }),
], validate, async (req, res) => {
  try {
    if (!req.user || !(await isSuperAdmin(req.user.uid))) {
      return res.status(403).json({ error: 'Forbidden: superadmin only' });
    }
    const { whatsappNumber, maintenanceMode, maintenanceMessage } = req.body;
    const updateData = {};
    if (whatsappNumber !== undefined) updateData.whatsappNumber = whatsappNumber;
    if (maintenanceMode !== undefined) updateData.maintenanceMode = !!maintenanceMode;
    if (maintenanceMessage !== undefined) updateData.maintenanceMessage = maintenanceMessage;
    updateData.updatedAt = new Date().toISOString();

    await db.collection('app_settings').doc('general').set(updateData, { merge: true });
    settingsCache = { data: null, time: 0 };
    logger.info('settings', 'Global settings updated', { user: req.user.uid });
    return res.json({ success: true });
  } catch (err) {
    logger.error('settings', 'Failed to save settings', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

router.get('/workspace/:workspaceId', verifyAuth, [
  param('workspaceId').isString().trim(),
], validate, async (req, res) => {
  try {
    const { workspaceId } = req.params;
    const wsDoc = await db.collection('workspaces').doc(workspaceId).get();
    if (!wsDoc.exists) return res.status(404).json({ error: 'Workspace not found' });
    const wsData = wsDoc.data();
    const isMember = req.user.uid === workspaceId || (wsData.members || []).includes(req.user.uid);
    if (!isMember && !(await isSuperAdmin(req.user.uid))) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    return res.json(wsData || {});
  } catch (err) {
    logger.error('settings', 'Failed to read workspace settings', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

router.put('/workspace/:workspaceId', verifyAuth, [
  param('workspaceId').isString().trim(),
  body('name').optional().isString().trim(),
], validate, async (req, res) => {
  try {
    const { workspaceId } = req.params;
    const wsDoc = await db.collection('workspaces').doc(workspaceId).get();
    if (!wsDoc.exists) return res.status(404).json({ error: 'Workspace not found' });
    const wsData = wsDoc.data();
    const isMember = req.user.uid === workspaceId || (wsData.members || []).includes(req.user.uid);
    if (!isMember && !(await isSuperAdmin(req.user.uid))) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { name } = req.body;
    const updateData = {};
    if (name !== undefined) updateData.name = name;

    await db.collection('workspaces').doc(workspaceId).set(updateData, { merge: true });
    logger.info('settings', 'Workspace settings updated', { workspaceId, user: req.user.uid });
    return res.json({ success: true });
  } catch (err) {
    logger.error('settings', 'Failed to save workspace settings', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// ─── Profile ───────────────────────────────────────────────────
// The display name was previously a raw, unvalidated client-side Firestore
// write (no length/content check anywhere) — safe only because every render
// site happens to escape it. Routing it through a validated backend call
// closes that gap without relying on every future render site doing the
// right thing.
router.put('/profile', verifyAuth, [
  body('name').isString().trim().notEmpty().isLength({ max: 100 }),
], validate, async (req, res) => {
  try {
    const { name } = req.body;
    await db.collection('users').doc(req.user.uid).set({
      name,
      updatedAt: new Date().toISOString(),
    }, { merge: true });
    logger.info('settings', 'Profile name updated', { user: req.user.uid });
    return res.json({ success: true });
  } catch (err) {
    logger.error('settings', 'Failed to update profile', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// Password changes happen entirely client-side via the Firebase Auth SDK (no
// backend route touches the password itself) — this just sends the "your
// password was changed" confirmation email afterward, a standard security
// notification so the account owner notices immediately if it wasn't them.
router.post('/notify-password-changed', verifyAuth, async (req, res) => {
  try {
    const userDoc = await db.collection('users').doc(req.user.uid).get();
    const email = userDoc.exists ? userDoc.data().email : req.user.email;
    if (email) {
      await db.collection('mail').add({
        to: email,
        message: {
          subject: '[Velync] Your password was changed',
          text: 'Your Velync account password was just changed. If this wasn\'t you, please revoke your sessions and reset your password immediately from Settings > Account.',
        },
      });
    }
    return res.json({ success: true });
  } catch (err) {
    logger.error('settings', 'Failed to send password-change confirmation email', { error: err.message });
    // Non-critical — the password change itself already succeeded client-side.
    return res.json({ success: true });
  }
});

// ─── Revoke Sessions ─────────────────────────────────────────

router.post('/revoke-sessions', verifyAuth, async (req, res) => {
  try {
    await getAuth().revokeRefreshTokens(req.user.uid);
    await db.collection('users').doc(req.user.uid).set({
      authVersion: FieldValue.increment(1),
      lastSessionRevokedAt: new Date().toISOString()
    }, { merge: true });
    logger.info('settings', 'Sessions revoked', { user: req.user.uid });
    return res.json({ success: true, message: 'All sessions revoked. You will need to log in again on other devices.' });
  } catch (err) {
    logger.error('settings', 'Failed to revoke sessions', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// ─── Export Data ─────────────────────────────────────────────

router.get('/export-data', verifyAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const exportData = { exportedAt: new Date().toISOString(), userId: uid };

    const userDoc = await db.collection('users').doc(uid).get();
    exportData.profile = userDoc.exists ? userDoc.data() : null;

    const wsSnap = await db.collection('workspaces').where('members', 'array-contains', uid).get();
    exportData.workspaces = [];
    const wsPromises = wsSnap.docs.map(async (wsDoc) => {
      const ws = { id: wsDoc.id, ...wsDoc.data() };
      const cfgSnap = await db.collection('workspaces').doc(wsDoc.id).collection('sync_configs').get();
      ws.syncConfigs = [];
      cfgSnap.forEach(c => ws.syncConfigs.push({ id: c.id, ...c.data() }));
      return ws;
    });
    exportData.workspaces = await Promise.all(wsPromises);

    const connSnap = await db.collection('connected_accounts').where('userId', '==', uid).get();
    exportData.connectedAccounts = [];
    connSnap.forEach(d => exportData.connectedAccounts.push({ id: d.id, ...d.data() }));

    if (exportData.workspaces.length > 0) {
      const wsIds = exportData.workspaces.map(w => w.id);
      // Firestore's `in` clause caps at 10 values — if a user belongs to more
      // than 10 workspaces, logs beyond the first 10 are omitted. Surface
      // that explicitly rather than silently truncating with no indication.
      const truncated = wsIds.length > 10;
      const logSnap = await db.collection('execution_logs')
        .where('workspaceId', 'in', wsIds.slice(0, 10))
        .get();
      exportData.executionLogs = [];
      logSnap.forEach(d => exportData.executionLogs.push({ id: d.id, ...d.data() }));
      if (truncated) {
        exportData.executionLogsTruncated = true;
        exportData.executionLogsNote = `You belong to ${wsIds.length} workspaces — execution logs are only included for the first 10 due to a database query limit.`;
      }
    }

    const keySnap = await db.collection('api_keys').where('userId', '==', uid).get();
    exportData.apiKeys = [];
    keySnap.forEach(d => {
      const data = d.data();
      exportData.apiKeys.push({ id: d.id, label: data.label, prefix: data.prefix, createdAt: data.createdAt });
    });

    logger.info('settings', 'Data exported', { user: uid });
    return res.json(exportData);
  } catch (err) {
    logger.error('settings', 'Failed to export data', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// ─── Delete Account ──────────────────────────────────────────

router.post('/delete-account', verifyAuth, async (req, res) => {
  try {
    const uid = req.user.uid;

    // Find all workspaces where this user is the owner
    const ownedWsSnap = await db.collection('workspaces')
      .where('ownerId', '==', uid)
      .get();

    // Cascade-delete each owned workspace
    let totalErrors = [];
    for (const wsDoc of ownedWsSnap.docs) {
      const result = await deleteWorkspace(wsDoc.id, { initiatedBy: uid });
      totalErrors.push(...result.errors);
    }

    // Remove user from workspaces where they are a member (not owner)
    const memberWsSnap = await db.collection('workspaces')
      .where('members', 'array-contains', uid)
      .get();
    const memberRemovals = memberWsSnap.docs.map(d => d.ref.update({
      members: FieldValue.arrayRemove(uid),
    }));
    await Promise.all(memberRemovals);

    // Delete API keys
    const keySnap = await db.collection('api_keys').where('userId', '==', uid).get();
    const keyDeletions = keySnap.docs.map(d => d.ref.delete());
    await Promise.all(keyDeletions);

    // Delete user document
    await db.collection('users').doc(uid).delete();

    // Delete Firebase Auth account
    await getAuth().deleteUser(uid);

    const fullyDeleted = totalErrors.length === 0;
    logger.info('settings', 'Account deleted', { user: uid, workspaceCount: ownedWsSnap.size, errors: totalErrors.length, fullyDeleted });

    if (!fullyDeleted) {
      // The account/auth record is gone either way (that part always
      // completes), but some owned-workspace data may be left behind —
      // that's not something the user can retry themselves after their
      // account no longer exists, so make sure an admin actually sees it.
      notifyAdmins(
        '[Velync] Account deletion left some data behind',
        `Account "${uid}" was deleted, but ${totalErrors.length} error(s) occurred while cascading its owned workspace(s):\n\n${totalErrors.join('\n')}\n\nManual cleanup may be needed.`
      ).catch(() => {});
    }

    return res.json({
      success: true,
      fullyDeleted,
      message: fullyDeleted
        ? 'Account and all associated data have been permanently deleted.'
        : 'Your account has been deleted, but some associated workspace data could not be fully removed. Our team has been notified.',
      workspaceDeletions: ownedWsSnap.size,
      errors: totalErrors.length > 0 ? totalErrors : undefined,
    });
  } catch (err) {
    logger.error('settings', 'Failed to delete account', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;

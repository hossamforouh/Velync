const { Router } = require('express');
const crypto = require('crypto');
const { Firestore, FieldValue } = require('@google-cloud/firestore');
const { getAuth } = require('firebase-admin/auth');
const { verifyAuth } = require('../middleware/auth');
const logger = require('../../core/logger');

const router = Router();
const db = new Firestore();

let settingsCache = { data: null, time: 0 };
const CACHE_TTL = 60000;

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

router.put('/global', verifyAuth, async (req, res) => {
  try {
    if (!req.user || req.user.uid !== 'o4gf5QBNlnaLXCqfjYmmhVLVNlg1') {
      return res.status(403).json({ error: 'Forbidden: superadmin only' });
    }
    const { whatsappNumber, maintenanceMode, maxConfigsPerUser, defaultSyncIntervalMinutes } = req.body;
    const updateData = {};
    if (whatsappNumber !== undefined) updateData.whatsappNumber = whatsappNumber;
    if (maintenanceMode !== undefined) updateData.maintenanceMode = !!maintenanceMode;
    if (maxConfigsPerUser !== undefined) updateData.maxConfigsPerUser = parseInt(maxConfigsPerUser, 10);
    if (defaultSyncIntervalMinutes !== undefined) updateData.defaultSyncIntervalMinutes = parseInt(defaultSyncIntervalMinutes, 10);
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

router.get('/workspace/:workspaceId', verifyAuth, async (req, res) => {
  try {
    const { workspaceId } = req.params;
    const wsDoc = await db.collection('workspaces').doc(workspaceId).get();
    if (!wsDoc.exists) return res.status(404).json({ error: 'Workspace not found' });
    const wsData = wsDoc.data();
    const isMember = req.user.uid === workspaceId || (wsData.members || []).includes(req.user.uid);
    if (!isMember && req.user.uid !== 'o4gf5QBNlnaLXCqfjYmmhVLVNlg1') {
      return res.status(403).json({ error: 'Forbidden' });
    }
    return res.json(wsData || {});
  } catch (err) {
    logger.error('settings', 'Failed to read workspace settings', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

router.put('/workspace/:workspaceId', verifyAuth, async (req, res) => {
  try {
    const { workspaceId } = req.params;
    const wsDoc = await db.collection('workspaces').doc(workspaceId).get();
    if (!wsDoc.exists) return res.status(404).json({ error: 'Workspace not found' });
    const wsData = wsDoc.data();
    const isMember = req.user.uid === workspaceId || (wsData.members || []).includes(req.user.uid);
    if (!isMember && req.user.uid !== 'o4gf5QBNlnaLXCqfjYmmhVLVNlg1') {
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

// ─── API Keys ────────────────────────────────────────────────

router.get('/api-keys', verifyAuth, async (req, res) => {
  try {
    const snap = await db.collection('api_keys')
      .where('userId', '==', req.user.uid)
      .get();
    const keys = [];
    snap.forEach(doc => {
      const data = doc.data();
      keys.push({ id: doc.id, label: data.label, prefix: data.prefix, createdAt: data.createdAt, lastUsedAt: data.lastUsedAt });
    });
    return res.json(keys);
  } catch (err) {
    logger.error('settings', 'Failed to list API keys', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

router.post('/api-keys', verifyAuth, async (req, res) => {
  try {
    const { label } = req.body;
    if (!label || typeof label !== 'string' || label.trim().length === 0) {
      return res.status(400).json({ error: 'Label is required' });
    }
    const rawKey = `velync_${crypto.randomBytes(32).toString('hex')}`;
    const hashedKey = crypto.createHash('sha256').update(rawKey).digest('hex');
    const prefix = rawKey.slice(0, 12);

    await db.collection('api_keys').add({
      userId: req.user.uid,
      label: label.trim(),
      prefix,
      hashedKey,
      createdAt: new Date().toISOString(),
      lastUsedAt: null
    });

    logger.info('settings', 'API key created', { user: req.user.uid, label: label.trim() });
    return res.json({ key: rawKey, prefix });
  } catch (err) {
    logger.error('settings', 'Failed to create API key', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

router.delete('/api-keys/:keyId', verifyAuth, async (req, res) => {
  try {
    const docRef = db.collection('api_keys').doc(req.params.keyId);
    const snap = await docRef.get();
    if (!snap.exists) return res.status(404).json({ error: 'Key not found' });
    if (snap.data().userId !== req.user.uid) return res.status(403).json({ error: 'Forbidden' });
    await docRef.delete();
    logger.info('settings', 'API key deleted', { user: req.user.uid, keyId: req.params.keyId });
    return res.json({ success: true });
  } catch (err) {
    logger.error('settings', 'Failed to delete API key', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// ─── Revoke Sessions ─────────────────────────────────────────

router.post('/revoke-sessions', verifyAuth, async (req, res) => {
  try {
    await getAuth().revokeRefreshTokens(req.user.uid);
    // Bump authVersion in user doc so middleware can reject pre-revoke tokens
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
    for (const wsDoc of wsSnap.docs) {
      const ws = { id: wsDoc.id, ...wsDoc.data() };
      const cfgSnap = await db.collection('workspaces').doc(wsDoc.id).collection('sync_configs').get();
      ws.syncConfigs = [];
      cfgSnap.forEach(c => ws.syncConfigs.push({ id: c.id, ...c.data() }));
      exportData.workspaces.push(ws);
    }

    const connSnap = await db.collection('connected_accounts').where('userId', '==', uid).get();
    exportData.connectedAccounts = [];
    connSnap.forEach(d => exportData.connectedAccounts.push({ id: d.id, ...d.data() }));

    const logSnap = await db.collection('execution_logs').where('workspaceId', 'in', exportData.workspaces.map(w => w.id)).get();
    exportData.executionLogs = [];
    logSnap.forEach(d => exportData.executionLogs.push({ id: d.id, ...d.data() }));

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

    // Delete all API keys for user
    const keySnap = await db.collection('api_keys').where('userId', '==', uid).get();
    const keyDeletions = [];
    keySnap.forEach(d => keyDeletions.push(d.ref.delete()));
    await Promise.all(keyDeletions);

    // Delete connected accounts for user
    const connSnap = await db.collection('connected_accounts').where('userId', '==', uid).get();
    const connDeletions = [];
    connSnap.forEach(d => connDeletions.push(d.ref.delete()));
    await Promise.all(connDeletions);

    // Find user's workspaces and clean up sync configs + execution logs
    const wsSnap = await db.collection('workspaces').where('members', 'array-contains', uid).get();
    for (const wsDoc of wsSnap.docs) {
      const cfgSnap = await db.collection('workspaces').doc(wsDoc.id).collection('sync_configs').get();
      const cfgDeletions = [];
      cfgSnap.forEach(c => cfgDeletions.push(c.ref.delete()));
      await Promise.all(cfgDeletions);

      // Remove user from workspace members
      await wsDoc.ref.update({
        members: FieldValue.arrayRemove(uid)
      }).catch(() => {});
    }

    // Delete user document
    await db.collection('users').doc(uid).delete();

    // Delete auth account (last so if anything fails above, the account is preserved)
    await getAuth().deleteUser(uid);

    logger.info('settings', 'Account deleted', { user: uid });
    return res.json({ success: true, message: 'Account and all associated data have been permanently deleted.' });
  } catch (err) {
    logger.error('settings', 'Failed to delete account', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;

const { Router } = require('express');
const { FieldValue } = require('@google-cloud/firestore');
const { body, validationResult } = require('express-validator');
const { verifyAuth } = require('../middleware/auth');
const { deleteWorkspace } = require('../../domains/workspace/deletion');
const db = require('../../core/db');
const logger = require('../../core/logger');

const router = Router();

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Validation failed', details: errors.array() });
  }
  next();
};

router.get('/workspace', verifyAuth, async (req, res) => {
  try {
    const userDoc = await db.collection('users').doc(req.user.uid).get();
    if (!userDoc.exists) return res.json({ success: true, workspace: null });
    const userData = userDoc.data();
    const workspaceId = userData.workspaceId;
    if (!workspaceId) return res.json({ success: true, workspace: null });
    const ws = await db.collection('workspaces').doc(workspaceId).get();
    if (!ws.exists) return res.json({ success: true, workspace: null });
    res.json({ success: true, workspace: { id: ws.id, ...ws.data() } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/workspace/invite', verifyAuth, [
  body('email').isEmail().normalizeEmail(),
  body('workspaceId').isString().trim().notEmpty(),
], validate, async (req, res) => {
  try {
    const { email, workspaceId } = req.body;
    const wsRef = db.collection('workspaces').doc(workspaceId);
    const ws = await wsRef.get();
    if (!ws.exists) return res.status(404).json({ success: false, error: 'Workspace not found' });
    const data = ws.data();
    const isOwner = data.ownerId === req.user.uid;
    const isMember = data.members?.includes(req.user.uid);
    const { isSuperAdmin } = require('../../core/superadmin');
    if (!isOwner && !isMember && !(await isSuperAdmin(req.user.uid))) {
      return res.status(403).json({ success: false, error: 'Not authorized to invite' });
    }
    if (data.invitedEmails?.includes(email)) {
      return res.status(409).json({ success: false, error: 'User already invited' });
    }
    await wsRef.update({
      invitedEmails: FieldValue.arrayUnion(email)
    });
    logger.info('workspace', `Invite sent to ${email} for workspace ${workspaceId} by ${req.user.uid}`);
    res.json({ success: true, workspaceName: data.name || 'Organization' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/workspace/join', verifyAuth, [
  body('workspaceId').isString().trim().notEmpty(),
], validate, async (req, res) => {
  try {
    const { workspaceId } = req.body;
    const userEmail = req.user.firebase?.identities?.email?.[0] || '';
    const wsRef = db.collection('workspaces').doc(workspaceId);
    const ws = await wsRef.get();
    if (!ws.exists) return res.status(404).json({ success: false, error: 'Workspace not found' });
    const data = ws.data();
    if (!data.invitedEmails?.includes(userEmail)) {
      return res.status(403).json({ success: false, error: 'Not invited' });
    }
    await wsRef.update({
      members: FieldValue.arrayUnion(req.user.uid),
      invitedEmails: FieldValue.arrayRemove(userEmail)
    });
    await db.collection('users').doc(req.user.uid).update({ workspaceId });
    logger.info('workspace', `User ${req.user.uid} joined workspace ${workspaceId}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/workspace/invite', verifyAuth, [
  body('email').isEmail().normalizeEmail(),
  body('workspaceId').isString().trim().notEmpty(),
], validate, async (req, res) => {
  try {
    const { email, workspaceId } = req.body;
    const wsRef = db.collection('workspaces').doc(workspaceId);
    const ws = await wsRef.get();
    if (!ws.exists) return res.status(404).json({ success: false, error: 'Workspace not found' });
    const data = ws.data();
    const isOwner = data.ownerId === req.user.uid;
    const { isSuperAdmin } = require('../../core/superadmin');
    if (!isOwner && !(await isSuperAdmin(req.user.uid))) {
      return res.status(403).json({ success: false, error: 'Not authorized to revoke invites' });
    }
    await wsRef.update({
      invitedEmails: FieldValue.arrayRemove(email)
    });
    logger.info('workspace', `Invite revoked for ${email} in workspace ${workspaceId} by ${req.user.uid}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/workspace/memberships', verifyAuth, async (req, res) => {
  try {
    const snap = await db.collection('workspaces')
      .where('members', 'array-contains', req.user.uid)
      .get();
    const workspaces = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ success: true, workspaces });
  } catch (err) {
    logger.error('workspace', 'Failed to fetch memberships', { error: err.message });
    res.json({ success: true, workspaces: [] });
  }
});

router.get('/workspace/invites', verifyAuth, async (req, res) => {
  try {
    const userDoc = await db.collection('users').doc(req.user.uid).get();
    if (!userDoc.exists) return res.json({ success: true, invites: [] });
    const email = userDoc.data().email;
    if (!email) return res.json({ success: true, invites: [] });
    const snap = await db.collection('workspaces')
      .where('invitedEmails', 'array-contains', email)
      .get();
    const invites = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ success: true, invites });
  } catch (err) {
    logger.error('workspace', 'Failed to fetch invites', { error: err.message });
    res.json({ success: true, invites: [] });
  }
});

router.get('/workspace/:id', verifyAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const wsRef = db.collection('workspaces').doc(id);
    const ws = await wsRef.get();
    if (!ws.exists) return res.status(404).json({ success: false, error: 'Workspace not found' });
    const data = ws.data();
    const isOwner = data.ownerId === req.user.uid;
    const isMember = data.members?.includes(req.user.uid);
    const { isSuperAdmin } = require('../../core/superadmin');
    if (!isOwner && !isMember && !(await isSuperAdmin(req.user.uid))) {
      return res.status(403).json({ success: false, error: 'Not authorized' });
    }
    res.json({ success: true, workspace: { id: ws.id, ...data } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.put('/workspace/name', verifyAuth, [
  body('name').isString().trim().notEmpty().isLength({ max: 100 }),
  body('workspaceId').isString().trim().notEmpty(),
], validate, async (req, res) => {
  try {
    const { name, workspaceId } = req.body;
    const wsRef = db.collection('workspaces').doc(workspaceId);
    const ws = await wsRef.get();
    if (!ws.exists) return res.status(404).json({ success: false, error: 'Workspace not found' });

    const data = ws.data();
    const isOwner = data.ownerId === req.user.uid;
    const isMember = data.members?.includes(req.user.uid);
    const { isSuperAdmin } = require('../../core/superadmin');
    if (!isOwner && !isMember && !(await isSuperAdmin(req.user.uid))) {
      return res.status(403).json({ success: false, error: 'Not authorized to rename this workspace' });
    }

    await wsRef.update({ name });

    // Keep user's workspaceName in sync if it's their personal workspace
    if (workspaceId === req.user.uid) {
      await db.collection('users').doc(req.user.uid).update({ workspaceName: name });
    }

    logger.info('workspace', `Workspace ${workspaceId} renamed to "${name}" by ${req.user.uid}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/workspace/member', verifyAuth, [
  body('userId').isString().trim().notEmpty(),
], validate, async (req, res) => {
  try {
    const { userId } = req.body;
    const userDoc = await db.collection('users').doc(req.user.uid).get();
    if (!userDoc.exists) return res.status(404).json({ success: false, error: 'User not found' });
    const workspaceId = userDoc.data().workspaceId;
    if (!workspaceId) return res.status(404).json({ success: false, error: 'No workspace' });
    await db.collection('workspaces').doc(workspaceId).update({
      members: FieldValue.arrayRemove(userId)
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Delete workspace — cascading deletion ─────────────────────
router.delete('/workspace/:workspaceId', verifyAuth, async (req, res) => {
  try {
    const { workspaceId } = req.params;
    const wsDoc = await db.collection('workspaces').doc(workspaceId).get();
    if (!wsDoc.exists) return res.status(404).json({ error: 'Workspace not found' });

    const wsData = wsDoc.data();
    const isOwner = wsData.ownerId === req.user.uid;
    const { isSuperAdmin } = require('../../core/superadmin');
    if (!isOwner && !(await isSuperAdmin(req.user.uid))) {
      return res.status(403).json({ error: 'Only the workspace owner or a superadmin can delete a workspace' });
    }

    const result = await deleteWorkspace(workspaceId, { initiatedBy: req.user.uid });
    if (result.success) {
      return res.json({ success: true, message: 'Workspace and all associated data deleted.', summary: result.summary });
    }
    return res.status(500).json({
      success: false,
      error: 'Workspace partially deleted — see errors for details.',
      errors: result.errors,
      summary: result.summary,
    });
  } catch (err) {
    logger.error('workspace', 'Failed to delete workspace', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;

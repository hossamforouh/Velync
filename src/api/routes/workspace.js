const { Router } = require('express');
const { FieldValue } = require('@google-cloud/firestore');
const { body, validationResult } = require('express-validator');
const { verifyAuth } = require('../middleware/auth');
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
], validate, async (req, res) => {
  try {
    const { email } = req.body;
    const userDoc = await db.collection('users').doc(req.user.uid).get();
    if (!userDoc.exists) return res.status(404).json({ success: false, error: 'User not found' });
    const workspaceId = userDoc.data().workspaceId;
    if (!workspaceId) return res.status(404).json({ success: false, error: 'No workspace' });
    await db.collection('workspaces').doc(workspaceId).update({
      invitedEmails: FieldValue.arrayUnion(email)
    });
    logger.info('workspace', `Invite sent to ${email} for workspace ${workspaceId}`);
    res.json({ success: true });
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
], validate, async (req, res) => {
  try {
    const { email } = req.body;
    const userDoc = await db.collection('users').doc(req.user.uid).get();
    if (!userDoc.exists) return res.status(404).json({ success: false, error: 'User not found' });
    const workspaceId = userDoc.data().workspaceId;
    if (!workspaceId) return res.status(404).json({ success: false, error: 'No workspace' });
    await db.collection('workspaces').doc(workspaceId).update({
      invitedEmails: FieldValue.arrayRemove(email)
    });
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

module.exports = router;

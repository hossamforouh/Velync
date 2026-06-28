const { Router } = require('express');
const { Firestore, FieldValue } = require('@google-cloud/firestore');
const { verifyAuth } = require('../middleware/auth');
const logger = require('../../core/logger');

const db = new Firestore();
const router = Router();

// GET /api/workspace — get current workspace
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

// POST /api/workspace/invite — add email to workspace invites
router.post('/workspace/invite', verifyAuth, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, error: 'Email required' });
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

// POST /api/workspace/join — accept invite and join workspace
router.post('/workspace/join', verifyAuth, async (req, res) => {
  try {
    const { workspaceId } = req.body;
    if (!workspaceId) return res.status(400).json({ success: false, error: 'workspaceId required' });
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

// DELETE /api/workspace/invite — remove an invited email
router.delete('/workspace/invite', verifyAuth, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, error: 'Email required' });
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

// DELETE /api/workspace/member — remove a member
router.delete('/workspace/member', verifyAuth, async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ success: false, error: 'userId required' });
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

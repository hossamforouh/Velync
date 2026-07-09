const { Router } = require('express');
const { FieldValue } = require('@google-cloud/firestore');
const { body, validationResult } = require('express-validator');
const { verifyAuth } = require('../middleware/auth');
const { deleteWorkspace } = require('../../domains/workspace/deletion');
const db = require('../../core/db');
const logger = require('../../core/logger');
const { logUsageEvent } = require('../../domains/usage');

const router = Router();

function buildInviteEmailHtml(workspaceName) {
  return `
<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background-color:#0a0819;color:#e2e8f0;font-family:'Helvetica Neue', Helvetica, Arial, sans-serif;">
  <table width="100%" border="0" cellspacing="0" cellpadding="0" style="background-color:#0a0819;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="600" border="0" cellspacing="0" cellpadding="0" style="background-color:#1e1b4b;border-radius:16px;overflow:hidden;box-shadow:0 10px 30px rgba(0,0,0,0.5);border:1px solid rgba(255,255,255,0.1);">
          <tr>
            <td align="center" style="padding:40px 0 35px 0;background:linear-gradient(135deg, #4f46e5 0%, #06b6d4 100%);">
              <h1 style="color:#ffffff;margin:0;font-size:32px;letter-spacing:1px;">Velync</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:40px 40px;">
              <h2 style="color:#ffffff;font-size:22px;margin-top:0;margin-bottom:20px;">Hi there,</h2>
              <p style="color:#cbd5e1;font-size:16px;line-height:24px;margin-bottom:24px;">
                You have been invited to collaborate on <strong>${workspaceName}</strong> in Velync.
              </p>

              <p style="color:#cbd5e1;font-size:16px;line-height:24px;margin-bottom:16px;">
                By joining this workspace, you will be able to work together with your team to:
              </p>

              <ul style="color:#cbd5e1;font-size:16px;line-height:26px;margin-bottom:32px;padding-left:20px;">
                <li style="margin-bottom:10px;"><strong>Build Active Flows:</strong> Create, manage, and monitor automated sync pipelines.</li>
                <li style="margin-bottom:10px;"><strong>Connect Platforms:</strong> Securely link third-party tools like Notion, TickTick, and Google.</li>
                <li style="margin-bottom:10px;"><strong>Monitor Execution Logs:</strong> Track live data mapping and system operations in real time.</li>
              </ul>

              <p style="color:#cbd5e1;font-size:16px;line-height:24px;margin-bottom:40px;">
                Ready to align your workflows? Click the button below to accept your invitation, set up your account, and jump straight into the dashboard.
              </p>

              <div style="text-align:center;">
                <a href="https://velync.web.app" style="display:inline-block;padding:16px 32px;background:linear-gradient(135deg, #4f46e5 0%, #06b6d4 100%);color:#ffffff;text-decoration:none;border-radius:12px;font-size:16px;font-weight:bold;box-shadow:0 4px 15px rgba(79,70,229,0.4);">Join the Workspace</a>
              </div>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:24px;background-color:#161436;border-top:1px solid rgba(255,255,255,0.05);">
              <p style="color:#64748b;font-size:13px;margin:0;">
                © 2026 Velync. All rights reserved.<br>
                Secure integrations for modern teams.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `;
}

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

// Flat cap on workspace members (owner + members array), a growth guard
// rather than a monetization lever — mirrors TOTAL_CONFIG_CAP in core/plan.js.
const MAX_WORKSPACE_MEMBERS = 25;

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

    // `members` already includes the owner (set at workspace creation), so
    // it alone is the full headcount.
    const memberCount = data.members?.length || 0;
    if (memberCount + (data.invitedEmails?.length || 0) >= MAX_WORKSPACE_MEMBERS) {
      return res.status(400).json({ success: false, error: `This workspace has reached the maximum of ${MAX_WORKSPACE_MEMBERS} members (including pending invites).` });
    }

    // Reject inviting someone who's already a member (only invitedEmails was
    // being checked before, so an existing member's email slipped through).
    const memberUids = [...new Set([data.ownerId, ...(data.members || [])])].filter(Boolean);
    for (const uid of memberUids) {
      const memberDoc = await db.collection('users').doc(uid).get();
      if (memberDoc.exists && memberDoc.data().email === email) {
        return res.status(409).json({ success: false, error: 'This person is already a member of the workspace' });
      }
    }

    await wsRef.update({
      invitedEmails: FieldValue.arrayUnion(email)
    });
    logger.info('workspace', `Invite sent to ${email} for workspace ${workspaceId} by ${req.user.uid}`);

    // A superadmin inviting into someone else's workspace is an admin-panel
    // action — recorded but excluded from any regular user's usage totals.
    await logUsageEvent(req.user.uid, workspaceId, 'member_invited', {
      actor: (isOwner || isMember) ? 'user' : 'admin',
    });

    const workspaceName = data.name || 'Organization';
    try {
      await db.collection('mail').add({
        to: [email],
        message: {
          subject: 'Collaboration Invite: Access a Workspace on Velync',
          html: buildInviteEmailHtml(workspaceName),
        },
      });
    } catch (emailErr) {
      logger.error('workspace', 'Failed to send invite email', { email, workspaceId, error: emailErr.message });
    }

    res.json({ success: true, workspaceName });
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
    const memberCount = data.members?.length || 0;
    if (memberCount >= MAX_WORKSPACE_MEMBERS) {
      return res.status(400).json({ success: false, error: `This workspace has reached the maximum of ${MAX_WORKSPACE_MEMBERS} members.` });
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

// Self-service decline — unlike the owner-only revoke above, an invited
// person can always decline their own invite (no membership required yet).
router.post('/workspace/decline-invite', verifyAuth, [
  body('workspaceId').isString().trim().notEmpty(),
], validate, async (req, res) => {
  try {
    const { workspaceId } = req.body;
    const userEmail = req.user.firebase?.identities?.email?.[0] || req.user.email || '';
    const wsRef = db.collection('workspaces').doc(workspaceId);
    const ws = await wsRef.get();
    if (!ws.exists) return res.status(404).json({ success: false, error: 'Workspace not found' });
    const data = ws.data();
    if (!data.invitedEmails?.includes(userEmail)) {
      return res.status(403).json({ success: false, error: 'No pending invite for you on this workspace' });
    }
    await wsRef.update({ invitedEmails: FieldValue.arrayRemove(userEmail) });
    logger.info('workspace', `User ${req.user.uid} declined invite to workspace ${workspaceId}`);
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
  body('description').optional().isString().trim().isLength({ max: 500 }),
  body('workspaceId').isString().trim().notEmpty(),
], validate, async (req, res) => {
  try {
    const { name, description, workspaceId } = req.body;
    const wsRef = db.collection('workspaces').doc(workspaceId);
    const ws = await wsRef.get();
    if (!ws.exists) return res.status(404).json({ success: false, error: 'Workspace not found' });

    const data = ws.data();
    const isOwner = data.ownerId === req.user.uid;
    // Owner-only — matches the Firestore rules' direct-write policy for this
    // collection, and avoids any one member unilaterally renaming a shared
    // workspace for everyone.
    const { isSuperAdmin } = require('../../core/superadmin');
    if (!isOwner && !(await isSuperAdmin(req.user.uid))) {
      return res.status(403).json({ success: false, error: 'Only the workspace owner can rename this workspace' });
    }

    const update = { name };
    if (description !== undefined) update.description = description;
    await wsRef.update(update);

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

// Transfer ownership to an existing member. `members` includes the owner
// (set at workspace creation — see ensureWorkspaceDoc in app.js), and the
// member list UI tags whoever matches `ownerId` as "(Owner)" — so this only
// needs to flip `ownerId`; both old and new owner stay listed as members.
router.post('/workspace/transfer-ownership', verifyAuth, [
  body('workspaceId').isString().trim().notEmpty(),
  body('newOwnerId').isString().trim().notEmpty(),
], validate, async (req, res) => {
  try {
    const { workspaceId, newOwnerId } = req.body;
    const wsRef = db.collection('workspaces').doc(workspaceId);
    const ws = await wsRef.get();
    if (!ws.exists) return res.status(404).json({ success: false, error: 'Workspace not found' });
    const data = ws.data();

    const { isSuperAdmin } = require('../../core/superadmin');
    if (data.ownerId !== req.user.uid && !(await isSuperAdmin(req.user.uid))) {
      return res.status(403).json({ success: false, error: 'Only the workspace owner can transfer ownership' });
    }
    if (newOwnerId === data.ownerId) {
      return res.status(400).json({ success: false, error: 'That user is already the owner' });
    }
    if (!data.members?.includes(newOwnerId)) {
      return res.status(400).json({ success: false, error: 'The new owner must already be a member of this workspace' });
    }

    await wsRef.update({ ownerId: newOwnerId });

    logger.info('workspace', `Workspace ${workspaceId} ownership transferred from ${data.ownerId} to ${newOwnerId} by ${req.user.uid}`);
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

    const wsRef = db.collection('workspaces').doc(workspaceId);
    const ws = await wsRef.get();
    if (!ws.exists) return res.status(404).json({ success: false, error: 'Workspace not found' });
    const data = ws.data();

    const { isSuperAdmin } = require('../../core/superadmin');
    if (data.ownerId !== req.user.uid && !(await isSuperAdmin(req.user.uid))) {
      return res.status(403).json({ success: false, error: 'Only the workspace owner can remove members' });
    }
    if (userId === data.ownerId) {
      return res.status(400).json({ success: false, error: 'Cannot remove the workspace owner. Transfer ownership first.' });
    }

    await wsRef.update({
      members: FieldValue.arrayRemove(userId)
    });

    // The removed member's own profile still points at this workspace —
    // reset it back to their solo default so they aren't left with a
    // dangling reference (they still have read access via the members
    // array check until this update lands, which is fine/expected here).
    await db.collection('users').doc(userId).update({ workspaceId: userId }).catch(() => {});

    logger.info('workspace', `Member ${userId} removed from workspace ${workspaceId} by ${req.user.uid}`);
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

const { Router } = require('express');
const { body, validationResult } = require('express-validator');
const { verifyAuth } = require('../middleware/auth');
const { isSuperAdmin } = require('../../core/superadmin');
const logger = require('../../core/logger');
const db = require('../../core/db');
const { logAdminActivity } = require('../../core/activityLog');
const { getAdminStats, listWorkspaces, getRecentSyncHealth, getAdminOverview } = require('../../domains/admin/stats');
const { renderEmailHtml, escHtml, p } = require('../../core/emailTemplate');

const router = Router();

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Validation failed', details: errors.array() });
  }
  next();
};

const requireSuperAdmin = async (req, res, next) => {
  if (!req.user || !(await isSuperAdmin(req.user.uid))) {
    return res.status(403).json({ error: 'Forbidden: superadmin only' });
  }
  next();
};

const clampLimit = (raw, def = 50, max = 200) => Math.min(Math.max(parseInt(raw, 10) || def, 1), max);

// Platform-wide statistics for the admin dashboard
router.get('/admin/stats', verifyAuth, requireSuperAdmin, async (req, res) => {
  try {
    return res.json(await getAdminStats());
  } catch (err) {
    logger.error('admin-stats', 'Failed to build stats', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// Paginated workspace list for management
router.get('/admin/workspaces', verifyAuth, requireSuperAdmin, async (req, res) => {
  try {
    const limit = clampLimit(req.query.limit);
    const startAfter = req.query.startAfter || null;
    const search = (req.query.search || '').trim() || null;
    return res.json(await listWorkspaces({ limit, startAfter, search }));
  } catch (err) {
    logger.error('admin-stats', 'Failed to list workspaces', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// Full dashboard overview (server-side aggregation, cached)
router.get('/admin/overview', verifyAuth, requireSuperAdmin, async (req, res) => {
  try {
    return res.json(await getAdminOverview());
  } catch (err) {
    logger.error('admin-stats', 'Failed to build overview', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// Recent sync execution health across all workspaces
router.get('/admin/sync-health', verifyAuth, requireSuperAdmin, async (req, res) => {
  try {
    const limit = clampLimit(req.query.limit);
    return res.json(await getRecentSyncHealth({ limit }));
  } catch (err) {
    logger.error('admin-stats', 'Failed to build sync health', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// Manually set a workspace's plan (e.g. comping a user onto Pro without a
// real subscription). Deliberately does NOT touch lsCustomerId/
// lsSubscriptionId/subscriptionStatus — leaving those unset means
// GET /billing/plan and the Billing tab already show the correct "you're on
// the X plan but no billing subscription is on file" state (see
// dashboard/public/js/billing.js) rather than fabricating a fake
// subscription that downstream billing logic would treat as real.
router.patch('/admin/workspaces/:workspaceId/plan', verifyAuth, requireSuperAdmin, [
  body('planId').isString().trim().notEmpty(),
], validate, async (req, res) => {
  try {
    const { workspaceId } = req.params;
    const { planId } = req.body;

    const [wsDoc, planDoc] = await Promise.all([
      db.collection('workspaces').doc(workspaceId).get(),
      db.collection('plans').doc(planId).get(),
    ]);
    if (!wsDoc.exists) return res.status(404).json({ error: 'Workspace not found' });
    if (!planDoc.exists) return res.status(404).json({ error: 'Plan not found' });

    const ws = wsDoc.data();
    const plan = planDoc.data();

    // No-op guard: previously this always wrote, logged an 'update' entry,
    // AND emailed the workspace owner "your plan was updated" even when the
    // admin clicked Save with the same plan already selected.
    if (ws.planId === planId) {
      return res.json({ success: true, planId, changed: false });
    }

    const previousPlanDoc = ws.planId ? await db.collection('plans').doc(ws.planId).get() : null;
    const previousPlanName = previousPlanDoc && previousPlanDoc.exists ? previousPlanDoc.data().name : (ws.planId || 'none');

    await wsDoc.ref.set({ planId }, { merge: true });

    logger.info('admin-stats', `Superadmin set workspace "${workspaceId}" planId → "${planId}"`, { user: req.user.uid });
    await logAdminActivity({
      uid: req.user.uid, userEmail: req.user.email,
      action: 'update', targetType: 'workspace-plan', targetId: workspaceId, targetName: `${ws.name || workspaceId} → ${plan.name}`,
      changes: { planId: { before: previousPlanName, after: plan.name } },
    });

    if (ws.ownerId) {
      try {
        const ownerDoc = await db.collection('users').doc(ws.ownerId).get();
        const ownerEmail = ownerDoc.exists ? ownerDoc.data().email : null;
        if (ownerEmail) {
          const wsName = ws.name || workspaceId;
          await db.collection('mail').add({
            to: ownerEmail,
            message: {
              subject: '[Velync] Your plan was updated',
              text: `Your workspace "${wsName}" has been moved to the ${plan.name} plan by a Velync admin. If you have questions about this change, contact support.`,
              html: renderEmailHtml({
                eyebrow: 'Plan updated',
                heading: `You're now on the ${escHtml(plan.name)} plan`,
                bodyHtml:
                  p(`Your workspace <strong style="color:#E2E4F0;">${escHtml(wsName)}</strong> has been moved to the <strong style="color:#E2E4F0;">${escHtml(plan.name)}</strong> plan by a Velync admin.`) +
                  p('If you have questions about this change, contact support.'),
                ctaText: 'Open Velync',
                ctaUrl: 'https://velync.web.app/',
              }),
            },
          });
        }
      } catch (emailErr) {
        logger.error('admin-stats', 'Failed to send plan-change email', { error: emailErr.message });
      }
    }

    return res.json({ success: true, planId });
  } catch (err) {
    logger.error('admin-stats', 'Failed to set workspace plan', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;

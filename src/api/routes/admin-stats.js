const { Router } = require('express');
const { verifyAuth } = require('../middleware/auth');
const { isSuperAdmin } = require('../../core/superadmin');
const logger = require('../../core/logger');
const { getAdminStats, listWorkspaces, getRecentSyncHealth, getAdminOverview } = require('../../domains/admin/stats');

const router = Router();

const requireSuperAdmin = (req, res, next) => {
  if (!req.user || !isSuperAdmin(req.user.uid)) {
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
    return res.json(await listWorkspaces({ limit, startAfter }));
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

module.exports = router;

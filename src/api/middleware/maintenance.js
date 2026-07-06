const { getAuth } = require('firebase-admin/auth');
const db = require('../../core/db');
const logger = require('../../core/logger');
const { isSuperAdmin } = require('../../core/superadmin');

let maintenanceCache = { enabled: false, message: '', time: 0 };
const CACHE_TTL = 30000;
const DEFAULT_MESSAGE = 'Service is under maintenance. Please try again later.';

async function maintenanceMode(req, res, next) {
  if (req.method === 'OPTIONS' || req.path === '/health') return next();

  try {
    if (Date.now() - maintenanceCache.time > CACHE_TTL) {
      const doc = await db.collection('app_settings').doc('general').get();
      const data = doc.data() || {};
      maintenanceCache = {
        enabled: !!data.maintenanceMode,
        message: data.maintenanceMessage || DEFAULT_MESSAGE,
        time: Date.now(),
      };
    }

    if (maintenanceCache.enabled) {
      // Superadmins must still be able to reach the API during maintenance —
      // in particular, to turn maintenance mode back off. This middleware is
      // mounted globally on /api, BEFORE any route's own verifyAuth runs, so
      // req.user is never populated yet at this point (a prior version of this
      // bypass checked req.user and could never succeed — a real lockout risk,
      // since it would have blocked the very request needed to disable
      // maintenance mode again). Decode the token directly, just for this check.
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        try {
          const decoded = await getAuth().verifyIdToken(authHeader.split('Bearer ')[1]);
          if (await isSuperAdmin(decoded.uid)) return next();
        } catch (_) {
          // Invalid/expired token — fall through to the maintenance response below.
        }
      }
      return res.status(503).json({ error: maintenanceCache.message });
    }
  } catch (err) {
    logger.warn('maintenance', 'Failed to check maintenance mode', { error: err.message });
  }
  next();
}

module.exports = { maintenanceMode };

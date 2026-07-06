const db = require('../../core/db');
const logger = require('../../core/logger');
const { isSuperAdmin } = require('../../core/superadmin');

let maintenanceCache = { enabled: false, time: 0 };
const CACHE_TTL = 30000;

async function maintenanceMode(req, res, next) {
  if (req.method === 'OPTIONS' || req.path === '/health') return next();

  try {
    if (Date.now() - maintenanceCache.time > CACHE_TTL) {
      const doc = await db.collection('app_settings').doc('general').get();
      const data = doc.data() || {};
      maintenanceCache = { enabled: !!data.maintenanceMode, time: Date.now() };
    }

    if (maintenanceCache.enabled) {
      if (req.user && await isSuperAdmin(req.user.uid)) return next();
      return res.status(503).json({ error: 'Service is under maintenance. Please try again later.' });
    }
  } catch (err) {
    logger.warn('maintenance', 'Failed to check maintenance mode', { error: err.message });
  }
  next();
}

module.exports = { maintenanceMode };

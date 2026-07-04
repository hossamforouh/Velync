const { Firestore } = require('@google-cloud/firestore');
const logger = require('../../core/logger');

let maintenanceCache = { enabled: false, time: 0 };
const CACHE_TTL = 30000;

async function maintenanceMode(req, res, next) {
  if (req.method === 'OPTIONS' || req.path === '/health') return next();

  try {
    if (Date.now() - maintenanceCache.time > CACHE_TTL) {
      const db = new Firestore();
      const doc = await db.collection('app_settings').doc('general').get();
      const data = doc.data() || {};
      maintenanceCache = { enabled: !!data.maintenanceMode, time: Date.now() };
    }

    if (maintenanceCache.enabled) {
      if (req.user && req.user.uid === 'o4gf5QBNlnaLXCqfjYmmhVLVNlg1') return next();
      return res.status(503).json({ error: 'Service is under maintenance. Please try again later.' });
    }
  } catch (err) {
    logger.warn('maintenance', 'Failed to check maintenance mode', { error: err.message });
  }
  next();
}

module.exports = { maintenanceMode };

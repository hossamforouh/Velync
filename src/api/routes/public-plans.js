const { Router } = require('express');
const db = require('../../core/db');
const logger = require('../../core/logger');

const router = Router();

/** Public plans endpoint — no auth required. Returns active plans for pricing page. */
router.get('/plans', async (req, res) => {
  try {
    const snap = await db.collection('plans')
      .where('isActive', '==', true)
      .orderBy('sortOrder', 'asc')
      .get();

    const plans = [];
    snap.forEach(doc => {
      const d = doc.data();
      plans.push({
        id: doc.id,
        name: d.name,
        description: d.description || '',
        priceMonthly: d.priceMonthly || 0,
        maxActiveConfigs: d.maxActiveConfigs,
        minSyncIntervalMinutes: d.minSyncIntervalMinutes,
        maxItemsPerRun: d.maxItemsPerRun,
        logRetentionDays: d.logRetentionDays,
        connectorTiers: d.connectorTiers || ['basic'],
        features: d.features || [],
        highlighted: !!d.highlighted,
        isActive: d.isActive !== false,
        sortOrder: d.sortOrder,
        // Not a secret — a Lemon Squeezy variant ID, needed by billing.js to
        // decide which plans can show a checkout button.
        lsVariantIdMonthly: d.lsVariantIdMonthly || null,
      });
    });

    res.json({ success: true, plans });
  } catch (err) {
    logger.error('public-plans', 'Failed to fetch plans', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to load plans' });
  }
});

module.exports = router;

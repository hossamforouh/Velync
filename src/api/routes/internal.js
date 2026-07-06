const { Router } = require('express');
const crypto = require('crypto');
const config = require('../../core/config');
const logger = require('../../core/logger');
const { runDueConfigs } = require('../../domains/sync/dispatcher');
const { cleanupLogs } = require('../../domains/sync/log-cleanup');

const router = Router();

/** Constant-time comparison of the provided secret against the configured one. */
function secretMatches(provided) {
  const a = Buffer.from(provided || '', 'utf8');
  const b = Buffer.from(config.schedulerSecret || '', 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Guard for Cloud Scheduler → Cloud Run calls. The service is public (it also
 * serves the frontend API), so these internal endpoints require a shared secret
 * header configured on the Cloud Scheduler jobs.
 */
const requireSchedulerSecret = (req, res, next) => {
  if (!config.schedulerSecret) {
    return res.status(503).json({ error: 'Scheduler secret not configured' });
  }
  if (!secretMatches(req.get('X-Scheduler-Secret'))) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
};

// Run all due configs. Cloud Scheduler calls this on a fixed cadence (e.g. every minute).
router.post('/internal/scheduler/tick', requireSchedulerSecret, async (req, res) => {
  try {
    const summary = await runDueConfigs();
    return res.json({ ok: true, ...summary });
  } catch (err) {
    logger.error('internal', 'Scheduler tick failed', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// Daily log-retention cleanup (already lease-gated internally).
router.post('/internal/scheduler/cleanup', requireSchedulerSecret, async (req, res) => {
  try {
    const deleted = await cleanupLogs();
    return res.json({ ok: true, deleted });
  } catch (err) {
    logger.error('internal', 'Scheduler cleanup failed', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;

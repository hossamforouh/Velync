const db = require('../../core/db');
const logger = require('../../core/logger');
const { runSync } = require('./engine');
const { notifyAdmins } = require('../../core/notifications');

// Collapse a burst of webhook events for one config into a single run after
// a short quiet window, per WEBHOOK_SYNC_PLAN.md §5 Stage 4.
const DEFAULT_DEBOUNCE_MS = 20_000;

/**
 * Firestore-transaction-guarded debounce — safe across Cloud Run instances.
 * A `webhookPendingUntil` timestamp lives on the sync_config doc itself:
 *
 *   - If no window is currently pending (or it already elapsed), this call
 *     "wins" and becomes the one responsible for firing the run once the
 *     window closes.
 *   - If a window is already pending, this call just extends it — that's
 *     the coalescing: further events in the burst never spawn a second
 *     runner, they only push the fire time out.
 *
 * The winning call polls the doc rather than sleeping a fixed duration, so a
 * window repeatedly extended by new events keeps deferring correctly. If the
 * owning instance dies mid-window, the flag is simply never cleared — no
 * correctness impact, since cron's own next tick runs regardless of this
 * flag and is the documented backstop for a missed/dropped webhook fast-path.
 *
 * @param {string} workspaceId
 * @param {string} configId
 * @param {number} [debounceMs]
 */
async function scheduleDebouncedRun(workspaceId, configId, debounceMs = DEFAULT_DEBOUNCE_MS) {
  const configRef = db.collection('workspaces').doc(workspaceId).collection('sync_configs').doc(configId);
  const now = Date.now();
  const runAt = now + debounceMs;

  const outcome = await db.runTransaction(async (tx) => {
    const snap = await tx.get(configRef);
    if (!snap.exists) return 'missing';
    const existing = snap.data().webhookPendingUntil ? new Date(snap.data().webhookPendingUntil).getTime() : 0;
    tx.update(configRef, { webhookPendingUntil: new Date(runAt).toISOString() });
    return existing > now ? 'extended' : 'scheduled';
  });

  if (outcome === 'missing') {
    logger.warn('webhook-debounce', `Cannot debounce "${configId}" — config not found`);
    return;
  }
  if (outcome === 'extended') {
    logger.info('webhook-debounce', `Extended pending window for "${configId}" (coalescing burst)`);
    return;
  }

  logger.info('webhook-debounce', `Scheduling debounced run for "${configId}" in ~${debounceMs}ms`);
  waitThenFire(configRef, configId, workspaceId).catch(err => {
    logger.error('webhook-debounce', `Unhandled error in debounced run for "${configId}"`, { error: err.message });
  });
}

async function waitThenFire(configRef, configId, workspaceId) {
  for (;;) {
    const snap = await configRef.get();
    if (!snap.exists) return;
    const data = snap.data();
    const pendingUntil = data.webhookPendingUntil ? new Date(data.webhookPendingUntil).getTime() : 0;
    const waitMs = pendingUntil - Date.now();

    if (waitMs > 0) {
      await new Promise(r => setTimeout(r, waitMs));
      continue; // re-check: the window may have been extended while asleep
    }

    await configRef.update({ webhookPendingUntil: null }).catch(() => {});
    if (data.status !== 'active') {
      logger.info('webhook-debounce', `Skipping debounced run for "${configId}" — no longer active`);
      return;
    }
    try {
      await runSync(data, configId);
    } catch (err) {
      logger.error('webhook-debounce', `Debounced run failed for "${configId}"`, { error: err.message });
      notifyAdmins(
        '[Velync] Webhook-triggered sync failed',
        `A debounced webhook-triggered run for sync_config "${configId}" (workspace "${workspaceId}") failed:\n\n${err.message}\n\nCron will still catch this on its next tick, so no data was permanently missed — but this is worth checking.`
      ).catch(() => {});
    }
    return;
  }
}

module.exports = { scheduleDebouncedRun };

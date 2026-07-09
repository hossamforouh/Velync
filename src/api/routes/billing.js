const { Router } = require('express');
const { body, validationResult } = require('express-validator');
const { FieldValue } = require('@google-cloud/firestore');
const { verifyAuth } = require('../middleware/auth');
const db = require('../../core/db');
const logger = require('../../core/logger');
const config = require('../../core/config');
const ls = require('../../core/lemonSqueezy');
const { reconcileActiveConfigsForPlan } = require('../../core/plan');
const { notifyAdmins } = require('../../core/notifications');

const router = Router();

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Validation failed', details: errors.array() });
  }
  next();
};

function requireLemonSqueezy(req, res, next) {
  if (!config.lemonSqueezyApiKey || !config.lemonSqueezyStoreId) {
    return res.status(503).json({ error: 'Billing is not configured. Set LEMONSQUEEZY_API_KEY and LEMONSQUEEZY_STORE_ID.' });
  }
  next();
}

// Lemon Squeezy subscription statuses ('on_trial', 'active', 'paused',
// 'past_due', 'unpaid', 'cancelled', 'expired') vs. the single-L 'canceled'
// this app has always used internally (frontend checks `status === 'canceled'`)
// — normalize once here rather than touching every consumer.
function normalizeStatus(lsStatus) {
  if (lsStatus === 'cancelled' || lsStatus === 'expired') return 'canceled';
  if (lsStatus === 'unpaid') return 'past_due';
  return lsStatus || 'active';
}

// Find which plan a Lemon Squeezy variant belongs to. Monthly-only — there's
// no annual/yearly billing option anywhere in the app.
async function resolvePlanFromVariant(variantId) {
  if (!variantId) return null;
  const snap = await db.collection('plans').where('lsVariantIdMonthly', '==', String(variantId)).get();
  if (!snap.empty) return { planId: snap.docs[0].id };
  return null;
}

// After a plan change, pause any active configs beyond the new plan's limit
// and let the workspace owner know — otherwise they silently keep running
// until an unrelated action trips enforcePlanLimits().
async function reconcileAndNotify(workspaceId, planId, ownerId) {
  try {
    const { pausedCount, pausedNames } = await reconcileActiveConfigsForPlan(workspaceId, planId);
    if (pausedCount === 0) return;

    logger.warn('billing', `Paused ${pausedCount} config(s) in workspace "${workspaceId}" — over the new plan's active-config limit`);

    if (ownerId) {
      const userDoc = await db.collection('users').doc(ownerId).get();
      const userEmail = userDoc.exists ? userDoc.data().email : null;
      if (userEmail) {
        await db.collection('mail').add({
          to: userEmail,
          message: {
            subject: '[Velync] Some sync configs were paused',
            text: `Your plan change means you're now over your active-config limit, so ${pausedCount} sync config(s) were automatically paused:\n\n${pausedNames.map(n => '- ' + n).join('\n')}\n\nUpgrade your plan or manually choose which to keep active at https://velync.web.app/.`,
          },
        });
      }
    }
  } catch (err) {
    logger.error('billing', 'Failed to reconcile/notify paused configs', { workspaceId, error: err.message });
  }
}

// Get current plan + subscription info for a workspace
router.get('/billing/plan', verifyAuth, async (req, res) => {
  try {
    const userDoc = await db.collection('users').doc(req.user.uid).get();
    if (!userDoc.exists) return res.status(404).json({ error: 'User not found' });
    const workspaceId = userDoc.data().workspaceId;
    if (!workspaceId) return res.status(404).json({ error: 'No workspace' });

    const wsDoc = await db.collection('workspaces').doc(workspaceId).get();
    if (!wsDoc.exists) return res.status(404).json({ error: 'Workspace not found' });
    const ws = wsDoc.data();

    const planId = String(ws.planId || 'free').trim();
    if (ws.planId !== planId) {
      // Workspaces are created client-side on signup and never set planId —
      // Firestore rules deliberately keep billing fields server-write-only,
      // so nothing else backfills it. Persist the (trimmed) value here on
      // first read instead of leaving it implicit or whitespace-corrupted
      // everywhere planId is consumed — a stray "pro\n" from a manual
      // Firestore edit silently fails the doc(planId) lookup below and
      // falls back to Free with no visible error.
      await wsDoc.ref.set({ planId }, { merge: true });
    }
    const planDoc = await db.collection('plans').doc(planId).get();
    if (!planDoc.exists) {
      logger.warn('billing', `Workspace "${workspaceId}" references unknown planId "${planId}" — falling back to Free display`);
    }
    const plan = planDoc.exists ? { id: planDoc.id, ...planDoc.data() } : { id: 'free', name: 'Free', priceMonthly: 0 };

    const activeSnap = await db.collection('workspaces').doc(workspaceId)
      .collection('sync_configs').where('status', '==', 'active').get();

    return res.json({
      success: true,
      plan,
      subscription: {
        status: ws.subscriptionStatus || 'active',
        currentPeriodEnd: ws.currentPeriodEnd || null,
        lsCustomerId: ws.lsCustomerId || null,
        lsSubscriptionId: ws.lsSubscriptionId || null,
        cancelAtPeriodEnd: !!ws.cancelAtPeriodEnd,
      },
      usage: {
        activeConfigs: activeSnap.size,
      },
    });
  } catch (err) {
    logger.error('billing', 'Failed to get plan info', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// Create a Lemon Squeezy Checkout for a plan, or swap the variant in place
// on an existing subscription if the workspace already has one.
router.post('/billing/create-checkout-session', verifyAuth, requireLemonSqueezy, [
  body('planId').isString().trim().notEmpty(),
], validate, async (req, res) => {
  try {
    const { planId } = req.body;

    const planDoc = await db.collection('plans').doc(planId).get();
    if (!planDoc.exists) return res.status(404).json({ error: 'Plan not found' });
    const plan = planDoc.data();
    if (!plan.isActive) return res.status(400).json({ error: 'Plan is not available for new subscriptions' });

    const variantId = plan.lsVariantIdMonthly;
    if (!variantId) return res.status(400).json({ error: `No Lemon Squeezy Variant ID configured for ${planId}` });

    const userDoc = await db.collection('users').doc(req.user.uid).get();
    const userEmail = userDoc.exists ? userDoc.data().email : null;
    const userName = userDoc.exists ? userDoc.data().name : null;
    const workspaceId = userDoc.exists ? userDoc.data().workspaceId : null;
    if (!workspaceId) return res.status(400).json({ error: 'No workspace found' });

    const wsDoc = await db.collection('workspaces').doc(workspaceId).get();
    const ws = wsDoc.data();
    if (ws.ownerId && ws.ownerId !== req.user.uid) {
      return res.status(403).json({ error: 'Only the workspace owner can manage billing.' });
    }

    // A workspace can only have one Lemon Squeezy subscription. If one is
    // already active, swap its variant in place instead of creating a second
    // Checkout — the latter would leave the old subscription running and
    // double-bill the customer. The subscription_updated webhook (handled
    // below) picks up the resulting plan change.
    if (ws.lsSubscriptionId) {
      const existing = await ls.getSubscription(ws.lsSubscriptionId);
      if (existing && existing.attributes.status !== 'expired' && existing.attributes.status !== 'cancelled') {
        await ls.updateSubscriptionVariant(ws.lsSubscriptionId, variantId);
        return res.json({ success: true, updated: true });
      }
    }

    const url = await ls.createCheckout({
      variantId,
      email: userEmail,
      name: userName,
      custom: { workspace_id: workspaceId, plan_id: planId },
      redirectUrl: `${config.appBaseUrl || 'https://velync.web.app'}/settings?billing=success`,
    });

    return res.json({ success: true, url });
  } catch (err) {
    logger.error('billing', 'Failed to create checkout', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// Return the customer's billing-management URL. Lemon Squeezy exposes this
// directly on the subscription resource — there's no separate "create a
// portal session" call the way Stripe requires.
router.post('/billing/create-portal-session', verifyAuth, requireLemonSqueezy, async (req, res) => {
  try {
    const userDoc = await db.collection('users').doc(req.user.uid).get();
    if (!userDoc.exists) return res.status(404).json({ error: 'User not found' });
    const workspaceId = userDoc.data().workspaceId;
    if (!workspaceId) return res.status(404).json({ error: 'No workspace' });

    const wsDoc = await db.collection('workspaces').doc(workspaceId).get();
    if (!wsDoc.exists) return res.status(404).json({ error: 'Workspace not found' });
    const ws = wsDoc.data();

    if (ws.ownerId && ws.ownerId !== req.user.uid) {
      return res.status(403).json({ error: 'Only the workspace owner can manage billing.' });
    }

    if (!ws.lsSubscriptionId) {
      return res.status(400).json({ error: 'No subscription on file — subscribe first' });
    }

    const subscription = await ls.getSubscription(ws.lsSubscriptionId);
    const url = subscription.attributes.urls?.customer_portal;
    if (!url) return res.status(500).json({ error: 'Lemon Squeezy did not return a customer portal URL' });

    return res.json({ success: true, url });
  } catch (err) {
    logger.error('billing', 'Failed to get portal URL', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// Downgrade to Free — cancels the active subscription at the end of the
// current period (not immediately), so the workspace keeps its paid-tier
// access through what's already been paid for. The subscription_expired
// webhook (handled below) reverts planId to 'free' once the period actually
// ends. Pass undo:true to reverse a pending cancellation.
router.post('/billing/downgrade-to-free', verifyAuth, requireLemonSqueezy, [
  body('undo').optional().isBoolean(),
], validate, async (req, res) => {
  try {
    const userDoc = await db.collection('users').doc(req.user.uid).get();
    if (!userDoc.exists) return res.status(404).json({ error: 'User not found' });
    const workspaceId = userDoc.data().workspaceId;
    if (!workspaceId) return res.status(404).json({ error: 'No workspace' });

    const wsDoc = await db.collection('workspaces').doc(workspaceId).get();
    if (!wsDoc.exists) return res.status(404).json({ error: 'Workspace not found' });
    const ws = wsDoc.data();

    if (ws.ownerId && ws.ownerId !== req.user.uid) {
      return res.status(403).json({ error: 'Only the workspace owner can manage billing.' });
    }

    if (!ws.lsSubscriptionId) {
      return res.status(400).json({ error: 'No active subscription to downgrade.' });
    }

    const cancelAtPeriodEnd = !req.body.undo;
    const subscription = cancelAtPeriodEnd
      ? await ls.cancelSubscription(ws.lsSubscriptionId)
      : await ls.resumeSubscription(ws.lsSubscriptionId);

    const currentPeriodEnd = subscription.attributes.ends_at || subscription.attributes.renews_at || null;
    await wsDoc.ref.set({ cancelAtPeriodEnd, currentPeriodEnd }, { merge: true });
    logger.info('billing', `Workspace "${workspaceId}" ${cancelAtPeriodEnd ? 'scheduled downgrade to Free at period end' : 'undid pending downgrade'}`, { user: req.user.uid });

    return res.json({ success: true, cancelAtPeriodEnd, currentPeriodEnd });
  } catch (err) {
    logger.error('billing', 'Failed to downgrade to free', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// Lemon Squeezy webhook handler
router.post('/billing/webhook', (req, res) => {
  if (!config.lemonSqueezyWebhookSecret) {
    return res.status(503).json({ error: 'Billing not configured' });
  }

  const signature = req.headers['x-signature'];
  if (!ls.verifyWebhookSignature(req.body, signature, config.lemonSqueezyWebhookSecret)) {
    logger.error('billing', 'Webhook signature verification failed');
    return res.status(400).json({ error: 'Invalid signature' });
  }

  let event;
  try {
    event = JSON.parse(req.body.toString('utf8'));
  } catch (err) {
    logger.error('billing', 'Webhook payload was not valid JSON', { error: err.message });
    return res.status(400).json({ error: 'Invalid payload' });
  }

  const eventName = event.meta?.event_name;

  const handleEvent = async () => {
    try {
      switch (eventName) {
        case 'subscription_created': {
          const sub = event.data.attributes;
          const { workspace_id: workspaceId } = event.meta.custom_data || {};
          if (workspaceId) {
            const resolved = await resolvePlanFromVariant(sub.variant_id);
            const wsRef = db.collection('workspaces').doc(workspaceId);
            await wsRef.set({
              planId: resolved ? resolved.planId : (event.meta.custom_data.plan_id || 'free'),
              lsCustomerId: String(sub.customer_id),
              lsSubscriptionId: String(event.data.id),
              subscriptionStatus: normalizeStatus(sub.status),
              currentPeriodEnd: sub.renews_at || null,
              cancelAtPeriodEnd: false,
            }, { merge: true });
            logger.info('billing', `Subscription created — workspace "${workspaceId}" → ${resolved ? resolved.planId : '?'}`);

            const wsSnap = await wsRef.get();
            await reconcileAndNotify(workspaceId, wsSnap.data().planId, wsSnap.data().ownerId);
          } else {
            logger.warn('billing', `subscription_created webhook had no custom_data.workspace_id (subscription ${event.data.id})`);
          }
          break;
        }

        case 'subscription_updated': {
          const sub = event.data.attributes;
          const wsSnap = await db.collection('workspaces')
            .where('lsSubscriptionId', '==', String(event.data.id))
            .get();
          if (!wsSnap.empty) {
            const wsRef = wsSnap.docs[0].ref;
            const wsData = wsSnap.docs[0].data();

            const resolved = await resolvePlanFromVariant(sub.variant_id);
            const planId = resolved ? resolved.planId : wsData.planId;

            await wsRef.update({
              planId,
              subscriptionStatus: normalizeStatus(sub.status),
              currentPeriodEnd: sub.ends_at || sub.renews_at || null,
              cancelAtPeriodEnd: !!sub.cancelled && sub.status !== 'expired',
            });
            logger.info('billing', `Subscription updated — "${event.data.id}" → ${planId}`);

            await reconcileAndNotify(wsRef.id, planId, wsData.ownerId);
          }
          break;
        }

        case 'subscription_expired': {
          const wsSnap = await db.collection('workspaces')
            .where('lsSubscriptionId', '==', String(event.data.id))
            .get();
          if (!wsSnap.empty) {
            const wsRef = wsSnap.docs[0].ref;
            const wsData = wsSnap.docs[0].data();
            await wsRef.update({
              planId: 'free',
              lsSubscriptionId: FieldValue.delete(),
              subscriptionStatus: 'canceled',
              currentPeriodEnd: null,
              cancelAtPeriodEnd: false,
            });
            logger.info('billing', `Subscription expired — "${event.data.id}" reverted to free`);

            if (wsData.ownerId) {
              try {
                const userDoc = await db.collection('users').doc(wsData.ownerId).get();
                const userEmail = userDoc.exists ? userDoc.data().email : null;
                if (userEmail) {
                  await db.collection('mail').add({
                    to: userEmail,
                    message: {
                      subject: '[Velync] Subscription ended',
                      text: 'Your Velync subscription has ended and your workspace has been reverted to the Free plan. You can resubscribe anytime at https://velync.web.app/settings.',
                    },
                  });
                }
              } catch (emailErr) {
                logger.error('billing', 'Failed to send cancellation email', { error: emailErr.message });
              }
            }

            await reconcileAndNotify(wsRef.id, 'free', wsData.ownerId);
          }
          break;
        }

        case 'subscription_payment_failed': {
          const wsSnap = await db.collection('workspaces')
            .where('lsSubscriptionId', '==', String(event.data.id))
            .get();
          if (!wsSnap.empty) {
            const wsRef = wsSnap.docs[0].ref;
            const wsData = wsSnap.docs[0].data();
            await wsRef.update({ subscriptionStatus: 'past_due' });
            logger.warn('billing', `Payment failed for subscription "${event.data.id}"`);

            const ownerIds = [wsData.ownerId, ...(wsData.members || [])];
            const uniqueOwners = [...new Set(ownerIds)].slice(0, 3);
            for (const uid of uniqueOwners) {
              try {
                const userDoc = await db.collection('users').doc(uid).get();
                const userEmail = userDoc.exists ? userDoc.data().email : null;
                if (userEmail) {
                  await db.collection('mail').add({
                    to: userEmail,
                    message: {
                      subject: '[Velync] Payment failed — action required',
                      text: 'Your Velync subscription payment failed. Please update your billing details at https://velync.web.app/settings to avoid service interruption.',
                    },
                  });
                }
              } catch (emailErr) {
                logger.error('billing', 'Failed to send dunning email', { uid, error: emailErr.message });
              }
            }
          }
          break;
        }
      }
    } catch (err) {
      logger.error('billing', 'Webhook handler error', { error: err.message, eventName });
      notifyAdmins(
        '[Velync] Billing webhook handler failed',
        `A Lemon Squeezy webhook of type "${eventName}" threw an error and was not fully processed:\n\n${err.message}\n\nA workspace's plan/subscription state may now be out of sync — check the Cloud Run logs for domain "billing".`
      ).catch(() => {});
    }
  };

  handleEvent();
  return res.json({ received: true });
});

module.exports = router;

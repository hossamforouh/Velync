const { Router } = require('express');
const { body, validationResult } = require('express-validator');
const { FieldValue } = require('@google-cloud/firestore');
const { verifyAuth } = require('../middleware/auth');
const db = require('../../core/db');
const logger = require('../../core/logger');
const config = require('../../core/config');
const { reconcileActiveConfigsForPlan } = require('../../core/plan');
const { notifyAdmins } = require('../../core/notifications');

let stripe = null;
try {
  stripe = require('stripe')(config.stripeSecretKey);
} catch (e) {
  logger.warn('billing', 'Stripe not configured — billing endpoints will return 503');
}

const router = Router();

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Validation failed', details: errors.array() });
  }
  next();
};

function requireStripe(req, res, next) {
  if (!stripe) {
    return res.status(503).json({ error: 'Billing is not configured. Set STRIPE_SECRET_KEY.' });
  }
  next();
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

    const planId = ws.planId || 'free';
    if (!ws.planId) {
      // Workspaces are created client-side on signup and never set planId —
      // Firestore rules deliberately keep billing fields server-write-only,
      // so nothing else backfills it. Persist the default here on first read
      // instead of leaving it implicit everywhere planId is consumed.
      await wsDoc.ref.set({ planId: 'free' }, { merge: true });
    }
    const planDoc = await db.collection('plans').doc(planId).get();
    const plan = planDoc.exists ? { id: planDoc.id, ...planDoc.data() } : { id: 'free', name: 'Free', priceMonthly: 0 };

    const activeSnap = await db.collection('workspaces').doc(workspaceId)
      .collection('sync_configs').where('status', '==', 'active').get();

    return res.json({
      success: true,
      plan,
      subscription: {
        status: ws.subscriptionStatus || 'active',
        billingInterval: ws.billingInterval || 'monthly',
        currentPeriodEnd: ws.currentPeriodEnd || null,
        stripeCustomerId: ws.stripeCustomerId || null,
        stripeSubscriptionId: ws.stripeSubscriptionId || null,
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

// Create a Stripe Checkout Session
router.post('/billing/create-checkout-session', verifyAuth, requireStripe, [
  body('planId').isString().trim().notEmpty(),
  body('billingInterval').isIn(['monthly', 'annual']),
], validate, async (req, res) => {
  try {
    const { planId, billingInterval } = req.body;

    const planDoc = await db.collection('plans').doc(planId).get();
    if (!planDoc.exists) return res.status(404).json({ error: 'Plan not found' });
    const plan = planDoc.data();
    if (!plan.isActive) return res.status(400).json({ error: 'Plan is not available for new subscriptions' });

    const priceId = billingInterval === 'annual' ? plan.stripePriceIdAnnual : plan.stripePriceIdMonthly;
    if (!priceId) return res.status(400).json({ error: `No Stripe Price ID configured for ${planId} (${billingInterval})` });

    const userDoc = await db.collection('users').doc(req.user.uid).get();
    const userEmail = userDoc.exists ? userDoc.data().email : null;
    const workspaceId = userDoc.exists ? userDoc.data().workspaceId : null;
    if (!workspaceId) return res.status(400).json({ error: 'No workspace found' });

    // Get or create Stripe customer
    const wsDoc = await db.collection('workspaces').doc(workspaceId).get();
    const ws = wsDoc.data();
    if (ws.ownerId && ws.ownerId !== req.user.uid) {
      return res.status(403).json({ error: 'Only the workspace owner can manage billing.' });
    }
    let stripeCustomerId = ws.stripeCustomerId;

    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({
        email: userEmail,
        metadata: { workspaceId, userId: req.user.uid },
      });
      stripeCustomerId = customer.id;
      await wsDoc.ref.update({ stripeCustomerId });
    }

    const session = await stripe.checkout.sessions.create({
      customer: stripeCustomerId,
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${config.appBaseUrl || 'https://velync.web.app'}/settings?billing=success`,
      cancel_url: `${config.appBaseUrl || 'https://velync.web.app'}/settings?billing=cancel`,
      metadata: {
        workspaceId,
        planId,
        billingInterval,
      },
    });

    return res.json({ success: true, url: session.url });
  } catch (err) {
    logger.error('billing', 'Failed to create checkout session', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// Create Stripe Billing Portal session
router.post('/billing/create-portal-session', verifyAuth, requireStripe, async (req, res) => {
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

    if (!ws.stripeCustomerId) {
      return res.status(400).json({ error: 'No Stripe customer — subscribe first' });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: ws.stripeCustomerId,
      return_url: `${config.appBaseUrl || 'https://velync.web.app'}/settings`,
    });

    return res.json({ success: true, url: session.url });
  } catch (err) {
    logger.error('billing', 'Failed to create portal session', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// Stripe webhook handler
router.post('/billing/webhook', (req, res) => {
  if (!stripe) {
    return res.status(503).json({ error: 'Billing not configured' });
  }

  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, config.stripeWebhookSecret);
  } catch (err) {
    logger.error('billing', 'Webhook signature verification failed', { error: err.message });
    return res.status(400).json({ error: 'Invalid signature' });
  }

  const handleEvent = async () => {
    try {
      switch (event.type) {
        case 'checkout.session.completed': {
          const session = event.data.object;
          const { workspaceId, planId, billingInterval } = session.metadata || {};
          if (workspaceId && planId) {
            const subscription = await stripe.subscriptions.retrieve(session.subscription);
            const wsRef = db.collection('workspaces').doc(workspaceId);
            await wsRef.update({
              planId,
              stripeSubscriptionId: session.subscription,
              subscriptionStatus: subscription.status,
              billingInterval: billingInterval || 'monthly',
              currentPeriodEnd: new Date(subscription.current_period_end * 1000).toISOString(),
            });
            logger.info('billing', `Checkout completed — workspace "${workspaceId}" → ${planId}`);

            const wsSnap = await wsRef.get();
            await reconcileAndNotify(workspaceId, planId, wsSnap.data()?.ownerId);
          }
          break;
        }

        case 'customer.subscription.updated': {
          const subscription = event.data.object;
          const wsSnap = await db.collection('workspaces')
            .where('stripeSubscriptionId', '==', subscription.id)
            .get();
          if (!wsSnap.empty) {
            const wsRef = wsSnap.docs[0].ref;
            const wsData = wsSnap.docs[0].data();

            // Reverse-lookup planId from the subscription's Price ID
            const priceId = subscription.items.data[0]?.price?.id;
            let planId = wsData.planId;
            if (priceId) {
              const plansSnap = await db.collection('plans')
                .where('stripePriceIdMonthly', '==', priceId)
                .get();
              if (!plansSnap.empty) {
                planId = plansSnap.docs[0].id;
              } else {
                const annualSnap = await db.collection('plans')
                  .where('stripePriceIdAnnual', '==', priceId)
                  .get();
                if (!annualSnap.empty) {
                  planId = annualSnap.docs[0].id;
                }
              }
            }

            await wsRef.update({
              planId,
              subscriptionStatus: subscription.status,
              currentPeriodEnd: new Date(subscription.current_period_end * 1000).toISOString(),
              billingInterval: subscription.items.data[0]?.price?.recurring?.interval === 'year' ? 'annual' : 'monthly',
            });
            logger.info('billing', `Subscription updated — "${subscription.id}" → ${planId}`);

            await reconcileAndNotify(wsRef.id, planId, wsData.ownerId);
          }
          break;
        }

        case 'customer.subscription.deleted': {
          const subscription = event.data.object;
          const wsSnap = await db.collection('workspaces')
            .where('stripeSubscriptionId', '==', subscription.id)
            .get();
          if (!wsSnap.empty) {
            const wsRef = wsSnap.docs[0].ref;
            const wsData = wsSnap.docs[0].data();
            await wsRef.update({
              planId: 'free',
              stripeSubscriptionId: FieldValue.delete(),
              subscriptionStatus: 'canceled',
              currentPeriodEnd: null,
            });
            logger.info('billing', `Subscription deleted — "${subscription.id}" reverted to free`);

            if (wsData.ownerId) {
              try {
                const userDoc = await db.collection('users').doc(wsData.ownerId).get();
                const userEmail = userDoc.exists ? userDoc.data().email : null;
                if (userEmail) {
                  await db.collection('mail').add({
                    to: userEmail,
                    message: {
                      subject: '[Velync] Subscription canceled',
                      text: 'Your Velync subscription has been canceled after repeated payment failures. Your workspace has been reverted to the Free plan. You can resubscribe anytime at https://velync.web.app/settings.',
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

        case 'invoice.payment_failed': {
          const invoice = event.data.object;
          const subscriptionId = invoice.subscription;
          if (subscriptionId) {
            const wsSnap = await db.collection('workspaces')
              .where('stripeSubscriptionId', '==', subscriptionId)
              .get();
            if (!wsSnap.empty) {
              const wsRef = wsSnap.docs[0].ref;
              const wsData = wsSnap.docs[0].data();
              await wsRef.update({ subscriptionStatus: 'past_due' });
              logger.warn('billing', `Payment failed for subscription "${subscriptionId}"`);

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
          }
          break;
        }
      }
    } catch (err) {
      logger.error('billing', 'Webhook handler error', { error: err.message, type: event.type });
      notifyAdmins(
        '[Velync] Billing webhook handler failed',
        `A Stripe webhook of type "${event.type}" (event ${event.id}) threw an error and was not fully processed:\n\n${err.message}\n\nA workspace's plan/subscription state may now be out of sync — check the Cloud Run logs for domain "billing".`
      ).catch(() => {});
    }
  };

  handleEvent();
  return res.json({ received: true });
});

module.exports = router;

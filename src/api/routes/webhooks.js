const express = require('express');
const router = express.Router();
const config = require('../../core/config');
const logger = require('../../core/logger');
const db = require('../../core/db');
const { getPlan } = require('../../core/plan');
const { getConnector } = require('../../domains/connector');
const { resolveConfigsForWebhookEvent } = require('../../domains/sync/webhookLookup');
const { scheduleDebouncedRun } = require('../../domains/sync/webhookDebounce');
const { notifyAdmins } = require('../../core/notifications');

// Per-provider webhook secret + expected signature header. Only Notion
// supports webhooks today (see WEBHOOK_SYNC_PLAN.md §3) — this is
// configuration data, not platform branching logic in the request-handling
// path itself; every check below (signature verify, event parsing, reverse
// lookup, run) goes through the connector's own static methods and never
// special-cases a provider name. Adding a second push-capable platform means
// adding one line to each of these two maps, not new control flow.
const WEBHOOK_SECRETS = { notion: () => config.notionWebhookSecret };
const WEBHOOK_SIGNATURE_HEADERS = { notion: 'x-notion-signature' };

/**
 * POST /api/webhooks/:provider — raw-body + HMAC-verified ingress for
 * platforms that can push. Mounted with a raw-body carve-out in server.js
 * (global express.json() must never touch this path, or signature
 * verification fails — the exact footgun already hit once with the Lemon
 * Squeezy webhook).
 */
router.post('/webhooks/:provider', (req, res) => {
  const { provider } = req.params;

  let Connector;
  try {
    Connector = getConnector(provider);
  } catch {
    logger.warn('webhooks', `Webhook received for unregistered provider "${provider}"`);
    return res.status(404).json({ error: 'Unknown provider' });
  }
  if (!Connector.supportsWebhooks()) {
    logger.warn('webhooks', `Webhook received for "${provider}", which does not support webhooks`);
    return res.status(404).json({ error: 'Provider does not support webhooks' });
  }

  let payload;
  try {
    payload = JSON.parse(req.body.toString('utf8'));
  } catch (err) {
    logger.error('webhooks', `Invalid JSON payload from "${provider}"`, { error: err.message });
    return res.status(400).json({ error: 'Invalid payload' });
  }

  // One-time subscription-setup handshake: the very first request after a
  // webhook subscription is (re)created carries a verification_token instead
  // of a signed event — there's no secret to sign with yet, since completing
  // this handshake is what PRODUCES it. This check must run before the
  // secret-configured check below, precisely because it's expected to arrive
  // while NOTION_WEBHOOK_SECRET is still unset — checking secret existence
  // first would 503 the handshake itself and it would never be logged.
  // Providers without this concept never produce the shape
  // isVerificationHandshake() checks for.
  if (typeof Connector.isVerificationHandshake === 'function' && Connector.isVerificationHandshake(payload)) {
    logger.info('webhooks', `Verification handshake received for "${provider}"`, { token: payload.verification_token });
    notifyAdmins(
      `[Velync] ${provider} webhook verification token`,
      `A webhook subscription verification was started for "${provider}". Paste this token back into the ${provider} integration dashboard to complete setup:\n\n${payload.verification_token}\n\nThis only needs to happen once per subscription (initial setup, or if it's ever recreated).`
    ).catch(() => {});
    return res.status(200).json({ received: true });
  }

  const getSecret = WEBHOOK_SECRETS[provider];
  const secret = getSecret ? getSecret() : null;
  if (!secret) {
    logger.error('webhooks', `No webhook secret configured for "${provider}"`);
    return res.status(503).json({ error: 'Webhook not configured' });
  }

  const signatureHeaderName = WEBHOOK_SIGNATURE_HEADERS[provider];
  const signature = signatureHeaderName ? req.headers[signatureHeaderName] : null;
  if (!Connector.verifyWebhookSignature(req.body, signature, secret)) {
    logger.error('webhooks', `Signature verification failed for "${provider}"`);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  let event;
  try {
    event = Connector.parseWebhookEvent(payload);
  } catch (err) {
    logger.error('webhooks', `Failed to parse "${provider}" webhook event`, { error: err.message });
    return res.status(400).json({ error: 'Unrecognized event' });
  }

  // Respond fast, then process async — Notion retries failed/slow deliveries
  // up to 8x over ~24h, so an ack must not wait on Firestore lookups + a
  // sync run (which can take seconds).
  handleWebhookEvent(provider, event).catch(err => {
    logger.error('webhooks', `Unhandled error processing "${provider}" webhook event`, { error: err.message });
  });
  return res.status(200).json({ received: true });
});

async function handleWebhookEvent(provider, event) {
  const { workspaceId: providerWorkspaceId, entityId, entityType, eventType } = event;
  const matches = await resolveConfigsForWebhookEvent(provider, providerWorkspaceId, entityId);
  if (matches.length === 0) {
    logger.warn('webhooks', `"${provider}" event "${eventType}" on ${entityType} "${entityId}" matched no sync_config`, { providerWorkspaceId });
    return;
  }

  for (const { configId, workspaceId, config: cfg } of matches) {
    if (cfg.status !== 'active') {
      logger.info('webhooks', `Skipping "${configId}" — status is "${cfg.status}", not active`);
      continue;
    }

    // Real-time (webhook) sync is a paid-tier capability, gated through the
    // existing plan model rather than hardcoded — see WEBHOOK_SYNC_PLAN.md §5
    // Stage 6. A workspace whose plan doesn't include it is not cut off from
    // sync entirely: cron keeps running at its normal (plan-gated) interval,
    // it just doesn't get the webhook fast-path.
    let planId = 'free';
    try {
      const wsDoc = await db.collection('workspaces').doc(workspaceId).get();
      if (wsDoc.exists && wsDoc.data().planId) planId = wsDoc.data().planId;
    } catch (err) {
      logger.warn('webhooks', `Failed to resolve plan for workspace "${workspaceId}", assuming "free"`, { error: err.message });
    }
    const plan = await getPlan(planId);
    if (!plan || !plan.webhookSyncEnabled) {
      logger.info('webhooks', `Skipping "${configId}" — plan "${planId}" does not include webhook-triggered sync (cron still applies)`);
      continue;
    }

    logger.info('webhooks', `Debouncing webhook-triggered run for "${configId}" in workspace "${workspaceId}" (${provider} ${eventType})`);
    try {
      await scheduleDebouncedRun(workspaceId, configId, config.webhookDebounceMs);
    } catch (err) {
      logger.error('webhooks', `Failed to schedule debounced run for "${configId}"`, { error: err.message });
    }
  }
}

module.exports = router;

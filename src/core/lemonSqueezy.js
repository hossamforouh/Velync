/**
 * Thin client for the Lemon Squeezy REST API (JSON:API format).
 * Docs: https://docs.lemonsqueezy.com/api
 */
const axios = require('axios');
const crypto = require('crypto');
const config = require('./config');

const http = axios.create({
  baseURL: 'https://api.lemonsqueezy.com/v1',
  timeout: config.externalApiTimeout,
  headers: {
    Accept: 'application/vnd.api+json',
    'Content-Type': 'application/vnd.api+json',
  },
});

http.interceptors.request.use((req) => {
  req.headers.Authorization = `Bearer ${config.lemonSqueezyApiKey}`;
  return req;
});

/**
 * Create a hosted Checkout for a given variant, returning its URL.
 * custom (object of strings) is echoed back in the webhook payload's
 * meta.custom_data — used to carry workspaceId/planId through checkout.
 * name pre-fills the customer's name on the checkout — without it, Lemon
 * Squeezy leaves the customer record's name blank/generic instead of the
 * actual user's name.
 */
async function createCheckout({ variantId, email, name, custom, redirectUrl }) {
  const checkoutData = { email, custom };
  // Lemon Squeezy's checkout_data.name expects a non-empty string — passing
  // null/'' (e.g. for accounts with no display name on file) causes a 422,
  // so only include it when there's an actual value.
  if (name) checkoutData.name = name;
  const { data } = await http.post('/checkouts', {
    data: {
      type: 'checkouts',
      attributes: {
        checkout_data: checkoutData,
        product_options: { redirect_url: redirectUrl },
      },
      relationships: {
        store: { data: { type: 'stores', id: String(config.lemonSqueezyStoreId) } },
        variant: { data: { type: 'variants', id: String(variantId) } },
      },
    },
  });
  return data.data.attributes.url;
}

async function getSubscription(subscriptionId) {
  const { data } = await http.get(`/subscriptions/${subscriptionId}`);
  return data.data;
}

/** Swap the active variant on an existing subscription (upgrade/downgrade in place). */
async function updateSubscriptionVariant(subscriptionId, variantId) {
  const { data } = await http.patch(`/subscriptions/${subscriptionId}`, {
    data: {
      type: 'subscriptions',
      id: String(subscriptionId),
      attributes: { variant_id: Number(variantId) },
    },
  });
  return data.data;
}

/** Resume a subscription that was scheduled to cancel at period end. */
async function resumeSubscription(subscriptionId) {
  const { data } = await http.patch(`/subscriptions/${subscriptionId}`, {
    data: {
      type: 'subscriptions',
      id: String(subscriptionId),
      attributes: { cancelled: false },
    },
  });
  return data.data;
}

/**
 * Soft-cancel: Lemon Squeezy keeps the subscription active until the end of
 * the period already paid for, then transitions it to 'expired' — this is
 * exactly the "downgrade at period end" semantics the app wants, with no
 * separate proration/immediate-cancel call needed.
 */
async function cancelSubscription(subscriptionId) {
  const { data } = await http.delete(`/subscriptions/${subscriptionId}`);
  return data.data;
}

/**
 * Verify the X-Signature header (HMAC-SHA256 of the raw request body,
 * hex-encoded) against the webhook signing secret. rawBody must be the
 * unparsed Buffer/string — do not run body-parsing JSON middleware on the
 * webhook route ahead of this, or the byte-for-byte match will fail.
 */
function verifyWebhookSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const expectedBuf = Buffer.from(expected, 'utf8');
  const actualBuf = Buffer.from(String(signatureHeader), 'utf8');
  if (expectedBuf.length !== actualBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}

module.exports = {
  createCheckout,
  getSubscription,
  updateSubscriptionVariant,
  resumeSubscription,
  cancelSubscription,
  verifyWebhookSignature,
};

const { Router } = require('express');
const db = require('../../core/db');
const logger = require('../../core/logger');
const { verifyAuth } = require('../middleware/auth');
const { getConnector } = require('../../domains/connector/registry');

const router = Router();

// Server-mediated reads of the `platforms` and `integrations` collections —
// both are Firestore-readable by any authenticated user already (see
// firestore.rules), but every page that needs them (app.js, hub.js,
// connections.js, onboarding.js for platforms; hub.js and the admin panel
// for integrations) was independently reading Firestore directly and
// maintaining its own cache. Consolidated here so there's one server-side
// path instead of N duplicated client-side ones. `platforms` docs never
// contain secrets (see PLATFORM_FIELDS in admin-platforms.js — clientSecret
// lives in platform_secrets, Admin-SDK-only), so no field filtering is
// needed beyond what the collection already stores.

router.get('/platforms', verifyAuth, async (req, res) => {
  try {
    const snap = await db.collection('platforms').get();
    // Compute webhook capability from the connector itself (Connector.
    // supportsWebhooks()) rather than leaving the frontend to hardcode
    // platform-name checks — the same abstraction leak that caused several
    // prior bugs in this project (see CLAUDE.md's connector-registry note).
    const platforms = snap.docs.map(d => {
      const data = d.data();
      let supportsWebhooks = false;
      try {
        supportsWebhooks = data.connectorKey ? getConnector(data.connectorKey).supportsWebhooks() : false;
      } catch (_) { /* unregistered/stale connectorKey — treat as no webhook support */ }
      return { id: d.id, ...data, supportsWebhooks };
    });
    return res.json({ success: true, platforms });
  } catch (err) {
    logger.error('public-marketplace', 'Failed to list platforms', { error: err.message });
    return res.status(500).json({ error: 'Failed to load platforms' });
  }
});

router.get('/integrations', verifyAuth, async (req, res) => {
  try {
    const snap = await db.collection('integrations').orderBy('name').get();
    const integrations = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    return res.json({ success: true, integrations });
  } catch (err) {
    logger.error('public-marketplace', 'Failed to list integrations', { error: err.message });
    return res.status(500).json({ error: 'Failed to load integrations' });
  }
});

module.exports = router;

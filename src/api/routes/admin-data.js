const { Router } = require('express');
const { verifyAuth } = require('../middleware/auth');
const { isSuperAdmin } = require('../../core/superadmin');
const { logAdminActivity } = require('../../core/activityLog');
const db = require('../../core/db');
const logger = require('../../core/logger');

const router = Router();

const requireSuperAdmin = async (req, res, next) => {
  if (!req.user || !(await isSuperAdmin(req.user.uid))) {
    return res.status(403).json({ error: 'Forbidden: superadmin only' });
  }
  next();
};

// Only these collections are exportable/importable via this endpoint. Each
// maps a friendly URL slug to the real Firestore collection. Deliberately
// excludes any collection holding secrets/credentials/user data —
// platform_secrets, credentials, users, workspaces, etc. are never exposed
// here. The `platforms` docs are already secret-free (client secrets live
// in the separate platform_secrets collection).
const COLLECTIONS = {
  platforms: 'platforms',
  plans: 'plans',
  integrations: 'integrations',
};

// Upper bound on docs accepted in a single import, to avoid an accidental or
// abusive multi-thousand-doc write. These are small admin-curated catalogs.
const MAX_IMPORT_DOCS = 1000;

// Fields never written into a `platforms` doc from an import — clientSecret
// belongs in platform_secrets (Admin-SDK-only) and must never land in the
// client-readable platforms collection even if a hand-edited file includes it.
const FORBIDDEN_PLATFORM_FIELDS = ['clientSecret'];

// GET /api/admin/export/:collection — download the whole collection as JSON.
router.get('/admin/export/:collection', verifyAuth, requireSuperAdmin, async (req, res) => {
  const collection = COLLECTIONS[req.params.collection];
  if (!collection) return res.status(400).json({ error: 'Unknown collection' });

  try {
    const snap = await db.collection(collection).get();
    const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const payload = {
      version: 1,
      collection: req.params.collection,
      exportedAt: new Date().toISOString(),
      count: docs.length,
      docs,
    };
    await logAdminActivity({
      uid: req.user.uid, userEmail: req.user.email,
      action: 'export', targetType: req.params.collection, targetId: collection,
      targetName: `${docs.length} ${req.params.collection}`,
    });
    return res.json(payload);
  } catch (err) {
    logger.error('admin-data', 'Export failed', { collection, error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/import/:collection — upsert docs from an uploaded export.
// Accepts either the full export object ({ docs: [...] }) or a bare array.
// Upsert semantics: each doc is written by its id (full replace of that doc);
// docs NOT present in the file are left untouched (no deletes) — importing is
// additive/overwrite, never destructive to unrelated records.
router.post('/admin/import/:collection', verifyAuth, requireSuperAdmin, async (req, res) => {
  const slug = req.params.collection;
  const collection = COLLECTIONS[slug];
  if (!collection) return res.status(400).json({ error: 'Unknown collection' });

  const body = req.body || {};
  const incoming = Array.isArray(body) ? body : body.docs;
  if (!Array.isArray(incoming)) {
    return res.status(400).json({ error: 'Expected a JSON array of documents (or an export file with a "docs" array).' });
  }
  // Guard against importing a file exported from a different collection.
  if (!Array.isArray(body) && body.collection && body.collection !== slug) {
    return res.status(400).json({ error: `This file is a "${body.collection}" export, not "${slug}".` });
  }
  if (incoming.length === 0) {
    return res.status(400).json({ error: 'The file contains no documents.' });
  }
  if (incoming.length > MAX_IMPORT_DOCS) {
    return res.status(400).json({ error: `Too many documents (${incoming.length}); max ${MAX_IMPORT_DOCS}.` });
  }

  // Validate every doc has a usable string id before writing anything.
  for (const doc of incoming) {
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      return res.status(400).json({ error: 'Every entry must be an object.' });
    }
    if (typeof doc.id !== 'string' || !doc.id.trim()) {
      return res.status(400).json({ error: 'Every document must have a non-empty string "id".' });
    }
  }

  try {
    // Batched writes (Firestore caps a batch at 500 ops).
    let written = 0;
    for (let i = 0; i < incoming.length; i += 400) {
      const batch = db.batch();
      for (const doc of incoming.slice(i, i + 400)) {
        const { id, ...data } = doc;
        if (collection === 'platforms') {
          for (const f of FORBIDDEN_PLATFORM_FIELDS) delete data[f];
        }
        batch.set(db.collection(collection).doc(id), data);
        written++;
      }
      await batch.commit();
    }

    await logAdminActivity({
      uid: req.user.uid, userEmail: req.user.email,
      action: 'import', targetType: slug, targetId: collection,
      targetName: `${written} ${slug}`,
    });
    return res.json({ success: true, imported: written, collection: slug });
  } catch (err) {
    logger.error('admin-data', 'Import failed', { collection, error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;

const { Router } = require('express');
const { FieldValue } = require('@google-cloud/firestore');
const { body, validationResult } = require('express-validator');
const { verifyAuth } = require('../middleware/auth');
const { encrypt, decrypt } = require('../../../utils/encryption');
const { resolveAuthorizedWorkspaceId } = require('../../core/workspaceAuth');
const db = require('../../core/db');
const logger = require('../../core/logger');

const router = Router();

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Validation failed', details: errors.array() });
  }
  next();
};

/**
 * Manual/attribute-based connections (API keys, integration tokens — anything
 * not going through the OAuth popup + /oauth/exchange flow). Attribute values
 * are encrypted server-side into `credentials/{uid}` (Admin-SDK-only,
 * `allow read/write: if false`), never stored in plaintext on
 * `connected_accounts` (which any workspace member can read).
 */

// Create a new manual connection
router.post('/connections', verifyAuth, [
  body('provider').isString().trim().notEmpty(),
  body('label').isString().trim().notEmpty(),
  body('attributes').optional().isObject(),
  body('workspaceId').optional().isString().trim(),
], validate, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { provider, label, attributes } = req.body;

    let workspaceId;
    try {
      workspaceId = await resolveAuthorizedWorkspaceId(uid, req.body.workspaceId);
    } catch (authErr) {
      return res.status(authErr.statusCode || 403).json({ error: authErr.message });
    }

    const platformDoc = await db.collection('platforms').doc(provider).get();
    if (!platformDoc.exists) return res.status(404).json({ error: 'Platform not found' });
    const platform = platformDoc.data();
    if (platform.authType === 'oauth') {
      return res.status(400).json({ error: 'This platform uses the OAuth connect flow, not manual credentials.' });
    }
    // The connections.js frontend already excludes Coming Soon platforms
    // from the "Add New Connection" picker — this is the authoritative
    // backstop against any client that skips that filter.
    if ((platform.status || 'Active') === 'Coming Soon') {
      return res.status(400).json({ error: `${platform.name || provider} is coming soon and can't be connected yet.` });
    }

    const connRef = await db.collection('connected_accounts').add({
      provider,
      label,
      userId: uid,
      workspaceId,
      authType: platform.authType || 'manual',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    if (attributes && Object.keys(attributes).length > 0) {
      await db.collection('credentials').doc(uid).set({
        [connRef.id]: {
          encryptedAttributes: encrypt(JSON.stringify(attributes)),
          provider,
          updatedAt: new Date().toISOString(),
        },
      }, { merge: true });
    }

    logger.info('connections', `Manual connection "${connRef.id}" created for ${provider}`, { workspaceId });
    return res.json({ success: true, id: connRef.id });
  } catch (err) {
    logger.error('connections', 'Failed to create connection', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// Update a connection's label and/or attributes
router.put('/connections/:connId', verifyAuth, [
  body('label').optional().isString().trim().isLength({ min: 1 }),
  body('attributes').optional().isObject(),
], validate, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { connId } = req.params;

    const connRef = db.collection('connected_accounts').doc(connId);
    const connSnap = await connRef.get();
    if (!connSnap.exists) return res.status(404).json({ error: 'Connection not found' });
    const conn = connSnap.data();
    if (conn.userId !== uid) return res.status(403).json({ error: 'Not authorized to update this connection' });

    const update = { updatedAt: new Date().toISOString() };
    if (req.body.label !== undefined) update.label = req.body.label;
    await connRef.set(update, { merge: true });

    if (req.body.attributes && conn.authType !== 'oauth') {
      await db.collection('credentials').doc(uid).set({
        [connId]: {
          encryptedAttributes: encrypt(JSON.stringify(req.body.attributes)),
          provider: conn.provider,
          updatedAt: new Date().toISOString(),
        },
      }, { merge: true });
    }

    logger.info('connections', `Connection "${connId}" updated`, { user: uid });
    return res.json({ success: true });
  } catch (err) {
    logger.error('connections', 'Failed to update connection', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// Delete a connection. Cleans up its `credentials` entry too (previously left
// orphaned forever since the client-side delete only removed connected_accounts),
// and returns the deleted data (decrypted attributes included) so the
// frontend's "Undo" toast can restore it via POST .../restore.
router.delete('/connections/:connId', verifyAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { connId } = req.params;

    const connRef = db.collection('connected_accounts').doc(connId);
    const connSnap = await connRef.get();
    if (!connSnap.exists) return res.status(404).json({ error: 'Connection not found' });
    const conn = connSnap.data();
    if (conn.userId !== uid) return res.status(403).json({ error: 'Not authorized to delete this connection' });

    const credsRef = db.collection('credentials').doc(uid);
    const credsSnap = await credsRef.get();
    const credsEntry = credsSnap.exists ? credsSnap.data()[connId] : null;

    let attributes = null;
    if (credsEntry?.encryptedAttributes) {
      try {
        attributes = JSON.parse(decrypt(credsEntry.encryptedAttributes));
      } catch (decErr) {
        logger.warn('connections', 'Failed to decrypt attributes for deleted-connection undo', { error: decErr.message });
      }
    }

    await connRef.delete();
    if (credsEntry) {
      await credsRef.update({ [connId]: FieldValue.delete() });
    }

    logger.info('connections', `Connection "${connId}" deleted`, { user: uid });
    return res.json({ success: true, deletedData: { ...conn, id: connId, attributes } });
  } catch (err) {
    logger.error('connections', 'Failed to delete connection', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// Restore a previously-deleted connection (used by the "Undo" toast action)
router.post('/connections/:connId/restore', verifyAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { connId } = req.params;
    const { attributes, ...connData } = req.body;

    if (connData.userId !== uid) return res.status(403).json({ error: 'Not authorized to restore this connection' });

    const restoreData = { ...connData, updatedAt: new Date().toISOString() };
    delete restoreData.id;
    await db.collection('connected_accounts').doc(connId).set(restoreData);

    if (attributes && Object.keys(attributes).length > 0) {
      await db.collection('credentials').doc(uid).set({
        [connId]: {
          encryptedAttributes: encrypt(JSON.stringify(attributes)),
          provider: connData.provider,
          updatedAt: new Date().toISOString(),
        },
      }, { merge: true });
    }

    logger.info('connections', `Connection "${connId}" restored`, { user: uid });
    return res.json({ success: true });
  } catch (err) {
    logger.error('connections', 'Failed to restore connection', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;

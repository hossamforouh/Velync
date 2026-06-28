const { Router } = require('express');
const { verifyAuth } = require('../middleware/auth');
const { resolveConnectionTokens } = require('../../domains/connection/resolver');
const { getConnector } = require('../../domains/connector/registry');
const logger = require('../../core/logger');

const router = Router();

router.post('/schema', verifyAuth, async (req, res) => {
  try {
    const { connectionId, platform, entityType, context = {} } = req.body;
    if (!connectionId || !platform) {
      return res.status(400).json({ success: false, error: 'connectionId and platform required' });
    }

    const creds = await resolveConnectionTokens(req.user.uid, connectionId);
    const ConnectorClass = getConnector(platform);
    if (!ConnectorClass) {
      return res.status(400).json({ success: false, error: `No connector registered for platform: ${platform}` });
    }

    const instance = new ConnectorClass({ ...creds, ...context });
    const schema = await instance.getSchema(entityType || 'Tasks', context);

    res.json({ success: true, schema, platform, entityType: entityType || 'Tasks' });
  } catch (err) {
    logger.error('schema', 'Failed to fetch schema', { error: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/schema/suggest', verifyAuth, async (req, res) => {
  try {
    const { sourceSchema, destSchema, sourcePlatform, destPlatform } = req.body;
    if (!sourceSchema || !destSchema) {
      return res.status(400).json({ success: false, error: 'sourceSchema and destSchema required' });
    }

    const suggestions = [];
    const sourceFields = Object.entries(sourceSchema);
    const destFields = Object.entries(destSchema);

    const nameMatch = (a, b) => a.toLowerCase().trim() === b.toLowerCase().trim();
    const typeCompatible = (sType, dType) => {
      const map = {
        title: ['title', 'rich_text', 'text'],
        rich_text: ['rich_text', 'title', 'text'],
        number: ['number'],
        checkbox: ['checkbox'],
        select: ['select', 'status'],
        status: ['status', 'select'],
        multi_select: ['multi_select'],
        date: ['date'],
        url: ['url'],
        relation: ['relation'],
      };
      return (map[sType] || []).includes(dType);
    };

    const usedDest = new Set();

    for (const [sKey, sField] of sourceFields) {
      const sName = (sField.label || sKey).toLowerCase();
      let best = null;

      for (const [dKey, dField] of destFields) {
        if (usedDest.has(dKey)) continue;
        const dName = (dField.label || dKey).toLowerCase();

        if (nameMatch(sName, dName) && typeCompatible(sField.type, dField.type)) {
          best = { sourceField: sKey, destField: dKey, match: 'exact', confidence: 1 };
          usedDest.add(dKey);
          break;
        }
      }

      if (!best) {
        for (const [dKey, dField] of destFields) {
          if (usedDest.has(dKey)) continue;
          const dName = (dField.label || dKey).toLowerCase();

          if (typeCompatible(sField.type, dField.type)) {
            if (sName.includes(dName) || dName.includes(sName)) {
              best = { sourceField: sKey, destField: dKey, match: 'partial', confidence: 0.7 };
              usedDest.add(dKey);
              break;
            }
          }
        }
      }

      if (!best) {
        best = { sourceField: sKey, destField: null, match: 'unmatched', confidence: 0 };
      }
      suggestions.push(best);
    }

    res.json({ success: true, suggestions, sourcePlatform, destPlatform });
  } catch (err) {
    logger.error('schema', 'Failed to suggest mappings', { error: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;

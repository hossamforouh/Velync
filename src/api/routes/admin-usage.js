const { Router } = require('express');
const { query, body, validationResult } = require('express-validator');
const { verifyAuth } = require('../middleware/auth');
const { isSuperAdmin } = require('../../core/superadmin');
const logger = require('../../core/logger');
const db = require('../../core/db');
const { ACTIVITY_TYPES, yearMonthOf } = require('../../domains/usage');

const router = Router();

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Validation failed', details: errors.array() });
  }
  next();
};

const requireSuperAdmin = async (req, res, next) => {
  if (!req.user || !(await isSuperAdmin(req.user.uid))) {
    return res.status(403).json({ error: 'Forbidden: superadmin only' });
  }
  next();
};

const monthValidator = query('month').optional().matches(/^\d{4}-(0[1-9]|1[0-2])$/)
  .withMessage('month must be YYYY-MM');

/** Stable column order for API responses and the CSV export. */
const TYPE_ORDER = Object.keys(ACTIVITY_TYPES);

/**
 * Normalize a summary doc (per-user or per-workspace — same shape either way)
 * into { totals: {type: {count, costUsd|null}}, grandTotalCostUsd }.
 */
function normalizeSummary(data) {
  const totals = {};
  for (const type of TYPE_ORDER) {
    const t = (data.totals || {})[type] || {};
    totals[type] = {
      count: t.count || 0,
      costUsd: ACTIVITY_TYPES[type].costDriving ? (t.costUsd || 0) : null,
    };
  }
  return {
    userId: data.userId,
    workspaceId: data.workspaceId,
    yearMonth: data.yearMonth,
    totals,
    grandTotalCostUsd: data.grandTotalCostUsd || 0,
  };
}

async function loadMonthSummaries(month) {
  const snap = await db.collection('usage_summaries').where('yearMonth', '==', month).get();
  const summaries = snap.docs.map(d => normalizeSummary(d.data()));

  // Join emails in batches (getAll caps around 100 refs per call comfortably)
  const userIds = [...new Set(summaries.map(s => s.userId).filter(Boolean))];
  const emails = new Map();
  for (let i = 0; i < userIds.length; i += 100) {
    const refs = userIds.slice(i, i + 100).map(id => db.collection('users').doc(id));
    const docs = await db.getAll(...refs);
    docs.forEach(d => { if (d.exists) emails.set(d.id, d.data().email || null); });
  }
  summaries.forEach(s => { s.email = emails.get(s.userId) || null; });
  summaries.sort((a, b) => b.grandTotalCostUsd - a.grandTotalCostUsd);
  return summaries;
}

// All users' usage for a month (leaderboard-style), plus the write-failure
// counter so the admin UI can warn when cost data has been dropped.
router.get('/admin/usage', verifyAuth, requireSuperAdmin, [monthValidator], validate, async (req, res) => {
  try {
    const month = req.query.month || yearMonthOf();
    const [summaries, failuresDoc] = await Promise.all([
      loadMonthSummaries(month),
      db.collection('usage_meta').doc('write_failures').get(),
    ]);
    return res.json({
      month,
      activityTypes: TYPE_ORDER.map(t => ({ type: t, costDriving: ACTIVITY_TYPES[t].costDriving })),
      users: summaries,
      writeFailures: failuresDoc.exists ? failuresDoc.data() : null,
    });
  } catch (err) {
    logger.error('admin-usage', 'Failed to list usage', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// CSV export — one row per user. Registered before /admin/usage/:userId so
// "export" isn't swallowed as a userId.
router.get('/admin/usage/export', verifyAuth, requireSuperAdmin, [monthValidator], validate, async (req, res) => {
  try {
    const month = req.query.month || yearMonthOf();
    const summaries = await loadMonthSummaries(month);

    const esc = (v) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const header = ['userId', 'email'];
    for (const type of TYPE_ORDER) {
      header.push(`${type}_count`);
      if (ACTIVITY_TYPES[type].costDriving) header.push(`${type}_costUsd`);
    }
    header.push('grandTotalCostUsd');

    const lines = [header.join(',')];
    for (const s of summaries) {
      const row = [esc(s.userId), esc(s.email)];
      for (const type of TYPE_ORDER) {
        row.push(s.totals[type].count);
        if (ACTIVITY_TYPES[type].costDriving) row.push(s.totals[type].costUsd);
      }
      row.push(s.grandTotalCostUsd);
      lines.push(row.join(','));
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="usage-${month}.csv"`);
    return res.send(lines.join('\r\n') + '\r\n');
  } catch (err) {
    logger.error('admin-usage', 'Failed to export usage CSV', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// Full breakdown for a single workspace/month — sums all of that workspace's
// members' activity (usage_workspace_summaries is incremented alongside the
// per-user summary in logUsageEvent, same atomic pattern, keyed by
// workspaceId instead of userId). Registered before /admin/usage/:userId —
// no ambiguity since this path has an extra segment, but keeping the more
// specific route first for readability.
router.get('/admin/usage/workspace/:workspaceId', verifyAuth, requireSuperAdmin, [monthValidator], validate, async (req, res) => {
  try {
    const month = req.query.month || yearMonthOf();
    const { workspaceId } = req.params;
    const [summaryDoc, wsDoc] = await Promise.all([
      db.collection('usage_workspace_summaries').doc(`${workspaceId}_${month}`).get(),
      db.collection('workspaces').doc(workspaceId).get(),
    ]);
    const summary = summaryDoc.exists
      ? normalizeSummary(summaryDoc.data())
      : normalizeSummary({ workspaceId, yearMonth: month });
    summary.name = wsDoc.exists ? (wsDoc.data().name || null) : null;
    return res.json({
      month,
      activityTypes: TYPE_ORDER.map(t => ({ type: t, costDriving: ACTIVITY_TYPES[t].costDriving })),
      workspace: summary,
    });
  } catch (err) {
    logger.error('admin-usage', 'Failed to load workspace usage', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// ─── Cost-model reconciliation ─────────────────────────────────
// The "Est. Cost" figure is a model (count × configured rate) and only
// covers what we instrument — it can drift from the real Google Cloud bill
// (fixed infra, storage, untracked dashboard reads, etc. are outside the
// model). Letting an admin record the ACTUAL monthly bill and comparing it
// to the tracked total gives a coverage ratio — the single most useful
// number for knowing how far to trust the estimate. Stored per-month in
// usage_actuals/{month}. Registered before /admin/usage/:userId so
// "reconciliation" isn't swallowed as a userId.

/** Sum the tracked estimated cost across all users for a month. */
async function trackedTotalForMonth(month) {
  const snap = await db.collection('usage_summaries').where('yearMonth', '==', month).get();
  return snap.docs.reduce((sum, d) => sum + (Number(d.data().grandTotalCostUsd) || 0), 0);
}

router.get('/admin/usage/reconciliation', verifyAuth, requireSuperAdmin, [monthValidator], validate, async (req, res) => {
  try {
    const month = req.query.month || yearMonthOf();
    const [trackedTotalUsd, actualDoc] = await Promise.all([
      trackedTotalForMonth(month),
      db.collection('usage_actuals').doc(month).get(),
    ]);
    const actual = actualDoc.exists ? actualDoc.data() : null;
    const actualBillUsd = actual && Number.isFinite(Number(actual.actualBillUsd)) ? Number(actual.actualBillUsd) : null;
    // coverage = what fraction of the real bill our model actually captured.
    // Null when no actual recorded, or actual is 0 (avoid divide-by-zero).
    const coverageRatio = actualBillUsd && actualBillUsd > 0 ? trackedTotalUsd / actualBillUsd : null;
    return res.json({
      month,
      trackedTotalUsd,
      actualBillUsd,
      coverageRatio,
      note: actual?.note || null,
      updatedAt: actual?.updatedAt || null,
    });
  } catch (err) {
    logger.error('admin-usage', 'Failed to load reconciliation', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

router.put('/admin/usage/reconciliation', verifyAuth, requireSuperAdmin, [
  body('month').matches(/^\d{4}-(0[1-9]|1[0-2])$/).withMessage('month must be YYYY-MM'),
  body('actualBillUsd').isFloat({ min: 0 }).withMessage('actualBillUsd must be a non-negative number'),
  body('note').optional().isString().trim().isLength({ max: 500 }),
], validate, async (req, res) => {
  try {
    const { month, actualBillUsd, note } = req.body;
    await db.collection('usage_actuals').doc(month).set({
      month,
      actualBillUsd: Number(actualBillUsd),
      note: note || null,
      updatedAt: new Date().toISOString(),
      updatedBy: req.user.uid,
    }, { merge: true });
    const trackedTotalUsd = await trackedTotalForMonth(month);
    const coverageRatio = actualBillUsd > 0 ? trackedTotalUsd / Number(actualBillUsd) : null;
    return res.json({ success: true, month, trackedTotalUsd, actualBillUsd: Number(actualBillUsd), coverageRatio });
  } catch (err) {
    logger.error('admin-usage', 'Failed to save reconciliation', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// Full breakdown for a single user/month.
router.get('/admin/usage/:userId', verifyAuth, requireSuperAdmin, [monthValidator], validate, async (req, res) => {
  try {
    const month = req.query.month || yearMonthOf();
    const { userId } = req.params;
    const [summaryDoc, userDoc] = await Promise.all([
      db.collection('usage_summaries').doc(`${userId}_${month}`).get(),
      db.collection('users').doc(userId).get(),
    ]);
    const summary = summaryDoc.exists
      ? normalizeSummary(summaryDoc.data())
      : normalizeSummary({ userId, yearMonth: month });
    summary.email = userDoc.exists ? (userDoc.data().email || null) : null;
    return res.json({
      month,
      activityTypes: TYPE_ORDER.map(t => ({ type: t, costDriving: ACTIVITY_TYPES[t].costDriving })),
      user: summary,
    });
  } catch (err) {
    logger.error('admin-usage', 'Failed to load user usage', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;

const { Router } = require('express');
const { query, validationResult } = require('express-validator');
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

/** Normalize a summary doc into { totals: {type: {count, costUsd|null}}, grandTotalCostUsd }. */
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

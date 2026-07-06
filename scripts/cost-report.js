#!/usr/bin/env node
/**
 * Velync — Cost Report (Section A3)
 *
 * Queries execution_logs to compute per-workspace run counts, durations, and
 * estimated GCP cost, comparing against the pricing model used to set tiers.
 *
 * Prerequisites:
 *   1. Firestore project with execution_logs collection populated
 *   2. GOOGLE_APPLICATION_CREDENTIALS set or Cloud Run default creds
 *   3. BigQuery billing export enabled (optional, for real GCP costs):
 *      - Link billing account to BigQuery
 *      - Export daily cost detail to a dataset
 *      - Set BQ_BILLING_DATASET env var to <project>.<dataset>.gcp_billing_export_v1_<id>
 *
 * Usage:
 *   node scripts/cost-report.js [--days 30] [--billing-dataset <project.dataset.table>]
 *
 * Output: JSON report with per-workspace and aggregate costs.
 */

require('dotenv').config();
const { Firestore } = require('@google-cloud/firestore');

const db = new Firestore();
const args = process.argv.slice(2);
const DAYS = parseInt(args.find(a => a.startsWith('--days='))?.split('=')[1] || process.argv[2] || '30', 10);
const BQ_DATASET = args.find(a => a.startsWith('--billing-dataset='))?.split('=')[1] || process.env.BQ_BILLING_DATASET || null;

// Estimated unit costs (Cloud Run us-central1 + Firestore, as of mid-2026)
// Update these when you pull real GCP billing data.
const COST_PER_GB_MEMORY_SEC = 0.0000025;    // $/GB/s for Cloud Run CPU-only
const COST_PER_VCPU_SEC = 0.0000100;           // $/vCPU/s
const COST_PER_FIRESTORE_READ = 0.00000006;    // $/document read (after free tier)
const COST_PER_FIRESTORE_WRITE = 0.00000018;   // $/document write (after free tier)
const GEMINI_COST_PER_SUGGESTION = 0.0005;     // $/mapping suggestion API call (Gemini 1.5 Flash est.)

async function main() {
  console.error(`Cost report: last ${DAYS} days`);

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - DAYS);

  // ── Fetch execution_logs ──────────────────────────────────
  let logs = [];
  const snap = await db.collection('execution_logs')
    .where('startTime', '>=', cutoff.toISOString())
    .get();

  snap.forEach(d => logs.push({ id: d.id, ...d.data() }));
  console.error(`  ${logs.length} execution_logs found`);

  if (logs.length === 0) {
    console.log(JSON.stringify({ days: DAYS, totalRuns: 0, workspaces: {}, aggregate: null }));
    process.exit(0);
  }

  // ── Aggregate per workspace ────────────────────────────────
  const wsMap = {};
  for (const log of logs) {
    const wsId = log.workspaceId || 'unknown';
    if (!wsMap[wsId]) wsMap[wsId] = { runs: 0, totalDurationMs: 0, failed: 0, configs: new Set() };
    wsMap[wsId].runs++;
    wsMap[wsId].totalDurationMs += log.durationMs || 0;
    if (log.status === 'error' || log.status === 'failed') wsMap[wsId].failed++;
    if (log.configId) wsMap[wsId].configs.add(log.configId);
  }

  // ── Build report ───────────────────────────────────────────
  const workspaces = {};
  let totalRuns = 0;
  let totalCost = 0;

  for (const [wsId, data] of Object.entries(wsMap)) {
    const hours = data.totalDurationMs / 3_600_000;
    // Assume 1 vCPU + 512 MB per execution, with Firestore reads/writes per run
    const computeCost = hours * COST_PER_VCPU_SEC * 3600;  // per-second billing
    const memCost = hours * COST_PER_GB_MEMORY_SEC * 0.512 * 3600;
    const firestoreCost = data.runs * (10 * COST_PER_FIRESTORE_READ + 5 * COST_PER_FIRESTORE_WRITE);
    const wsCost = computeCost + memCost + firestoreCost;
    totalCost += wsCost;

    workspaces[wsId] = {
      runs: data.runs,
      activeConfigs: data.configs.size,
      failedRuns: data.failed,
      avgDurationMs: Math.round(data.totalDurationMs / data.runs),
      estimatedComputeCost: round(computeCost),
      estimatedMemoryCost: round(memCost),
      estimatedFirestoreCost: round(firestoreCost),
      estimatedTotalCost: round(wsCost),
    };
    totalRuns += data.runs;
  }

  // ── Per-workspace Gemini cost estimate ─────────────────────
  // If suggest-mappings usage data is stored, include it here.
  // For now, estimate based on config count (assumes ~2 suggestions per config/mo).

  // ── BigQuery billing data (if available) ───────────────────
  let actualCosts = null;
  if (BQ_DATASET) {
    try {
      const { BigQuery } = require('@google-cloud/bigquery');
      const bq = new BigQuery();
      const query = `
        SELECT
          DATE(usage_start_time) as day,
          SUM(cost) as cost,
          SUM(usage.amount) as usage
        FROM \`${BQ_DATASET}\`
        WHERE service.description = 'Cloud Run'
          AND DATE(usage_start_time) >= DATE_SUB(CURRENT_DATE(), INTERVAL ${DAYS} DAY)
        GROUP BY day
        ORDER BY day
      `;
      const [rows] = await bq.query({ query });
      actualCosts = rows.map(r => ({ day: r.day.value, cost: Number(r.cost) }));
      console.error(`  BigQuery billing data: ${actualCosts.length} days`);
    } catch (bqErr) {
      console.error(`  BigQuery query failed: ${bqErr.message} (skipping actual costs)`);
    }
  }

  // ── Output ─────────────────────────────────────────────────
  const report = {
    reportDate: new Date().toISOString(),
    days: DAYS,
    totalRuns,
    estimatedTotalCost: round(totalCost),
    estimatedGeminiCost: round(totalRuns * 0.02 * GEMINI_COST_PER_SUGGESTION),  // rough est.
    workspaces,
    actualGcpCost: actualCosts,
    notes: [
      'Costs are estimates based on unit prices in scripts/cost-report.js.',
      'Update COST_PER_* constants with real GCP billing data for accuracy.',
      'Gemini cost assumes 2% of runs trigger a mapping suggestion.',
      'Firestore free tier (50K reads, 20K writes/day) is not subtracted.',
      'Run with --billing-dataset to include actual GCP billing export data.',
    ],
  };

  console.log(JSON.stringify(report, null, 2));
}

function round(n) {
  return Math.round(n * 1_000_000) / 1_000_000;
}

main().catch(err => { console.error(err); process.exit(1); });

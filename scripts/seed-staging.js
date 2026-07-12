#!/usr/bin/env node
/**
 * Bootstraps a freshly-created staging Firestore project to a usable state:
 * default plans, superadmin doc, and marketplace platforms/integrations.
 *
 * This is a thin, safety-guarded wrapper around the existing seed scripts
 * (seed-plans.js, seed-superadmin.js, seed-marketplace.js) — it does not
 * duplicate their logic, it just runs them against the right project and
 * refuses to run against production.
 *
 * Target project resolution (first match wins):
 *   1. STAGING_PROJECT_ID env var
 *   2. .firebaserc's projects.staging alias
 *
 * Usage:
 *   npm run seed:staging            # prompts for confirmation
 *   npm run seed:staging -- --yes   # skips the confirmation prompt (CI use)
 *
 * Requires application-default credentials for the staging project:
 *   gcloud auth application-default login
 */
const { spawnSync } = require('child_process');
const readline = require('readline');
const path = require('path');
const fs = require('fs');

const PROD_PROJECT_ID = 'velync';
const SCRIPTS = ['seed-plans.js', 'seed-superadmin.js', 'seed-marketplace.js'];

function resolveProjectId() {
  if (process.env.STAGING_PROJECT_ID) return process.env.STAGING_PROJECT_ID;
  try {
    const firebaserc = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.firebaserc'), 'utf8'));
    return (firebaserc.projects && firebaserc.projects.staging) || '';
  } catch (e) {
    return '';
  }
}

function confirm(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'yes');
    });
  });
}

async function main() {
  const projectId = resolveProjectId();
  const skipConfirm = process.argv.includes('--yes');

  if (!projectId) {
    console.error('ERROR: no staging project id found (set STAGING_PROJECT_ID or .firebaserc projects.staging).');
    process.exit(1);
  }
  if (projectId === PROD_PROJECT_ID) {
    console.error(`ERROR: resolved project is "${PROD_PROJECT_ID}" (production). Refusing to seed test data into it.`);
    console.error('Update the "staging" alias in .firebaserc (or set STAGING_PROJECT_ID) to the real staging project first.');
    process.exit(1);
  }

  console.log(`This will seed default plans, a superadmin doc, and marketplace data into Firestore project: ${projectId}`);
  if (!skipConfirm) {
    const ok = await confirm('Type "yes" to continue: ');
    if (!ok) {
      console.log('Aborted.');
      process.exit(0);
    }
  }

  for (const script of SCRIPTS) {
    console.log(`\n=== Running ${script} against ${projectId} ===`);
    const result = spawnSync('node', [path.join(__dirname, script)], {
      stdio: 'inherit',
      env: { ...process.env, GOOGLE_CLOUD_PROJECT: projectId, GCLOUD_PROJECT: projectId },
    });
    if (result.status !== 0) {
      console.error(`\n${script} failed (exit ${result.status}). Stopping.`);
      process.exit(result.status || 1);
    }
  }

  console.log('\nStaging seed complete.');
  console.log('Next: log in as the seeded superadmin UID and set clientId/clientSecret');
  console.log('for each platform via the Admin Panel → Platforms tab (see STAGING_CHECKLIST.md).');
}

main();

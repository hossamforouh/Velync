#!/usr/bin/env bash
# Velync — full staging deploy (backend + hosting).
#
# Safe to run freely: this script only ever targets the "staging" alias in
# .firebaserc (never "production"), and refuses to run if that alias still
# points at the production project id ("velync") — which is its state until
# the staging project is created and the alias is updated. See
# STAGING_CHECKLIST.md for the one-time staging project setup this depends
# on.
#
# Usage: npm run deploy:staging   (or: bash scripts/deploy-staging.sh)
set -euo pipefail

STAGING_PROJECT=$(node -e "const fs=require('fs');console.log(JSON.parse(fs.readFileSync('./.firebaserc','utf8')).projects.staging || '')")

if [ -z "$STAGING_PROJECT" ]; then
  echo "ERROR: no 'staging' project alias set in .firebaserc" >&2
  exit 1
fi
if [ "$STAGING_PROJECT" = "velync" ]; then
  echo "ERROR: .firebaserc 'staging' alias still points at 'velync' (production)." >&2
  echo "       Create the staging Firebase/GCP project first, then update the" >&2
  echo "       'staging' alias in .firebaserc — see STAGING_CHECKLIST.md." >&2
  exit 1
fi

echo "==> Deploying backend to Cloud Run (project: $STAGING_PROJECT) via Cloud Build..."
gcloud builds submit --config infrastructure/cloudbuild.yaml --project "$STAGING_PROJECT"

echo "==> Deploying hosting (project alias: staging -> $STAGING_PROJECT)..."
firebase deploy --only hosting -P staging

echo "==> Staging deploy complete."

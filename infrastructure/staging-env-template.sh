#!/usr/bin/env bash
# Velync — Staging environment variables reference.
#
# These are consumed by infrastructure/cloudbuild.yaml via Secret Manager
# (--set-secrets) for the actually-secret values, and plain --update-env-vars
# for everything else. Field names below match src/core/config.js exactly.
#
# IMPORTANT: Notion / TickTick / Google OAuth client id + secret are NOT env
# vars in this app — they're stored in Firestore (`platforms`.clientId is
# admin-readable, `platform_secrets`.clientSecret is Admin-SDK-only) and set
# via the Admin Panel's Platforms tab after seeding staging (see
# scripts/seed-staging.js + STAGING_CHECKLIST.md). Don't add them here.
#
# Usage (create each secret once in the staging GCP project):
#   echo -n "<value>" | gcloud secrets create encryption-key --data-file=- --project=<staging-project>
#   echo -n "<value>" | gcloud secrets create scheduler-secret --data-file=- --project=<staging-project>
#   echo -n "<value>" | gcloud secrets create lemonsqueezy-api-key --data-file=- --project=<staging-project>
#   echo -n "<value>" | gcloud secrets create lemonsqueezy-store-id --data-file=- --project=<staging-project>
#   echo -n "<value>" | gcloud secrets create lemonsqueezy-webhook-secret --data-file=- --project=<staging-project>
# Then infrastructure/cloudbuild.yaml's --set-secrets flag wires them into
# the Cloud Run service automatically on every `npm run deploy:staging`.

# ─── Core ──────────────────────────────────────────────────────
# ENCRYPTION_KEY: generate with `openssl rand -hex 32`. Must be DIFFERENT
#   from production's — staging ciphertext must never be decryptable with
#   the production key or vice versa.
ENCRYPTION_KEY=<generate: openssl rand -hex 32 — DIFFERENT from prod>
LOG_LEVEL=info
EXTERNAL_API_TIMEOUT=15000
APP_BASE_URL=https://velync-staging.web.app

# ─── Scheduler ─────────────────────────────────────────────────
SCHEDULER_MODE=internal
SCHEDULER_SECRET=<generate: openssl rand -hex 32 — DIFFERENT from prod>

# ─── Firebase Admin SDK ────────────────────────────────────────
# No env var needed — Cloud Run's runtime service account (with
# roles/datastore.user + roles/aiplatform.user) provides Application
# Default Credentials automatically, scoped to the staging project.

# ─── Lemon Squeezy (billing) — TEST MODE ───────────────────────
# Create a separate TEST MODE store in the Lemon Squeezy dashboard (Settings
# → Stores → toggle "Test mode"), get its own API key + webhook secret, and
# point its webhook (Settings → Webhooks) at:
#   https://<staging-backend-url>/api/billing/webhook
LEMONSQUEEZY_API_KEY=<test-mode API key from Lemon Squeezy dashboard>
LEMONSQUEEZY_STORE_ID=<test-mode store id>
LEMONSQUEEZY_WEBHOOK_SECRET=<test-mode webhook signing secret>

# ─── Notion webhook fast-path — see NOTION_WEBHOOK_RUNBOOK.md ──
# Unlike the secrets above, this one is NOT self-generated (no
# `openssl rand`) — it's issued by Notion's integration dashboard only after
# completing the one-time subscription + verification handshake described in
# NOTION_WEBHOOK_RUNBOOK.md. Leave unset until that runbook has been done at
# least once for this environment; the webhook ingress route 503s cleanly
# without it (no impact on cron-based sync).
NOTION_WEBHOOK_SECRET=<signing secret shown after completing NOTION_WEBHOOK_RUNBOOK.md>

# ─── Connector OAuth (Firestore-based, NOT env vars) ───────────
# Set clientId/clientSecret per platform via the Admin Panel → Platforms tab
# after running scripts/seed-staging.js. Register separate staging OAuth
# apps with each provider (staging redirect URIs, e.g.
# https://velync-staging.web.app/auth-callback.html):
#   - Notion: https://www.notion.so/my-integrations
#   - TickTick: https://developer.ticktick.com/
#   - Google: GCP Console → APIs & Services → Credentials (staging project)

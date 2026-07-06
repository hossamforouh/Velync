#!/usr/bin/env bash
# Velync — Staging environment variables reference
# Copy this to your staging Cloud Run env or .env.staging and fill in real values.
#
# Usage:
#   gcloud run deploy velync-staging \
#     --source . \
#     --env-vars-file env.staging.yaml
#   (or set env vars individually in the Cloud Run UI/console)

# ─── Core ──────────────────────────────────────────────────────
PORT=8080
LOG_LEVEL=info
ENCRYPTION_KEY=<generate: openssl rand -hex 32>

# ─── Firebase Admin SDK ────────────────────────────────────────
# Service account with Firestore + Vertex AI access (staging project).
# Set via GOOGLE_APPLICATION_CREDENTIALS or default application credentials
# in Cloud Run (the runtime service account). No env var needed if the
# Cloud Run service account has the right IAM roles.

# ─── OAuth — Notion ────────────────────────────────────────────
NOTION_CLIENT_ID=<from Notion Integration>
NOTION_CLIENT_SECRET=<from Notion Integration>

# ─── OAuth — TickTick ──────────────────────────────────────────
TICKTICK_CLIENT_ID=<from TickTick Dev>
TICKTICK_CLIENT_SECRET=<from TickTick Dev>

# ─── OAuth — Google (Contacts) ─────────────────────────────────
GOOGLE_CLIENT_ID=<from GCP Credentials>
GOOGLE_CLIENT_SECRET=<from GCP Credentials>

# ─── Stripe (test mode) ────────────────────────────────────────
STRIPE_SECRET_KEY=sk_test_<from Stripe Dashboard>
STRIPE_WEBHOOK_SECRET=whsec_<from Stripe Dashboard — required for webhook verification>

# ─── App URLs (used by Stripe checkout return URLs) ────────────
APP_BASE_URL=https://velync-staging-<hash>.run.app

# ─── Connector test tokens (legacy; most are now OAuth) ────────
NOTION_INTEGRATION_TOKEN=ntn_<staging test token>
TICKTICK_USERNAME=<test account email>
TICKTICK_PASSWORD=<test account password>

# ─── Gemini / Vertex AI (mapping suggestions) ──────────────────
# Uses GOOGLE_APPLICATION_CREDENTIALS; no separate key needed.
# The staging service account must have aiplatform.user role.

# ─── Email (nodemailer) ────────────────────────────────────────
# For invite emails, notifications.
# Option A: Gmail SMTP
# SMTP_HOST=smtp.gmail.com
# SMTP_PORT=587
# SMTP_USER=<your-email@gmail.com>
# SMTP_PASS=<app-password>
# Option B: Use a SendGrid / Mailgun integration

# ─── External API timeout ──────────────────────────────────────
EXTERNAL_API_TIMEOUT=15000

# Velync — Staging Deployment & Validation Checklist

## A1. Deploy to Cloud Run

### GCP setup (one-time)
- [ ] Create a **separate GCP project** for staging (do NOT use production)
- [ ] Enable Firestore (Native mode), Cloud Run, Artifact Registry, Secret Manager
- [ ] Create a Firestore database in the staging project
- [ ] Enable the Vertex AI API (for Gemini mapping suggestions)
- [ ] Create a service account for Cloud Run with roles:
  - `roles/datastore.user`
  - `roles/aiplatform.user`
  - `roles/logging.logWriter`
- [ ] Store secrets in Secret Manager:
  - `stripe-secret-key` (test mode)
  - `stripe-webhook-secret` (test mode)
- [ ] Set up Firebase Authentication (same providers as prod)
- [ ] Run `scripts/seed-plans.js` against staging Firestore
- [ ] Run `scripts/seed-superadmin.js` against staging Firestore
- [ ] Run `scripts/seed-marketplace.js` against staging Firestore
- [ ] Run `scripts/migrate-workspaces.js` against staging Firestore

### Credentials setup
- [ ] Create a **Notion integration** (private) for staging — note the OAuth client ID/secret
- [ ] Create a **TickTick dev application** for staging — note the client ID/secret
- [ ] Create a **GCP OAuth consent screen + credentials** (Desktop app type) for Google Contacts
- [ ] Get **Stripe test-mode** API keys and webhook secret
- [ ] Generate `ENCRYPTION_KEY` via `openssl rand -hex 32`

### Deploy
- [ ] `gcloud builds submit --config infrastructure/cloudbuild.yaml --project <staging-project>`
- [ ] Set all env vars (see `infrastructure/staging-env-template.sh`) on the Cloud Run service
- [ ] Note the staging URL (e.g. `https://velync-staging-<hash>.run.app`)

## A2. Run smoke tests

- [ ] `bash scripts/test-staging.sh` (basic endpoint health)
- [ ] **Stripe webhook**: `stripe listen --forward-to <url>/api/billing/webhook`
  - [ ] `stripe trigger checkout.session.completed` — verify workspace doc updates in Firestore
  - [ ] `stripe trigger customer.subscription.updated` — verify subscription status sync
  - [ ] `stripe trigger customer.subscription.deleted` — verify plan reverts to free
  - [ ] `stripe trigger invoice.payment_failed` — verify status set to `past_due`
- [ ] **Full checkout**: visit `/settings` → billing tab → click Upgrade → complete with test card `4242 4242 4242 4242 4242`
  - [ ] Confirm config limit unlocks after upgrade
- [ ] **Real sync**: connect real Notion + TickTick accounts, create a sync config, run it
  - [ ] Confirm deletion-detection: modify a dest item directly, re-sync — it should NOT be deleted
  - [ ] Force token expiry: manually set `expiresAt` to past in Firestore, trigger sync — confirm auto-refresh
- [ ] **Distributed lock**: deploy with `--min-instances=2`, check logs for lease acquisition
- [ ] **Plan enforcement**: try creating/activating more configs than Free tier allows

## A3. Cost baseline
- [ ] After 3+ days of staging usage, run `node scripts/cost-report.js --days 7`
- [ ] Enable GCP BigQuery billing export and re-run: `node scripts/cost-report.js --days 7 --billing-dataset=<project.dataset.table>`
- [ ] Compare actual costs against the pricing model, update `src/core/config.js` defaults if needed

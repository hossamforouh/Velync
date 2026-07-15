# Velync — Notion Webhook Subscription Runbook (Stage 5)

One-time setup per environment (staging, then production) to turn on the
Notion webhook fast-path built in Stages 1-4 (see `WEBHOOK_SYNC_PLAN.md`).
There is **no API call that creates this subscription** — per the Stage 0
research findings, it's dashboard-only, scoped once to Velync's shared
Notion integration (`client_id`), not per-user-connection. Do this once for
staging, once for production — nothing here is per-customer.

**Verify-don't-assume note:** Notion's dashboard UI can change. The flow
below reflects the confirmed mechanism as of Stage 0's research (paste-back
verification handshake, dashboard-issued signing secret) — re-confirm the
exact screen layout against `developers.notion.com/reference/webhooks` and
the live integration dashboard before doing this for real, rather than
trusting this doc's field names blindly.

## Prerequisites

- [ ] Stages 1-4 are deployed to the target environment — `POST
      /api/webhooks/notion` must be publicly reachable at
      `https://<backend-url>/api/webhooks/notion` **before** starting this
      (Notion's dashboard will try to reach it during setup).
- [ ] You have owner/admin access to the Velync Notion integration at
      [notion.so/my-integrations](https://www.notion.so/my-integrations).

## Steps

### 1. Start the subscription in the Notion dashboard

- [ ] Open the Velync integration → **Webhooks** tab (or equivalent — see
      the verify-don't-assume note above).
- [ ] Enter the endpoint URL:
      `https://<backend-url>/api/webhooks/notion`
- [ ] Select the event types confirmed in Stage 0's build log:
      `page.created`, `page.content_updated`, `page.properties_updated`,
      `page.moved`, `page.deleted`, `page.undeleted`, `page.locked`,
      `page.unlocked`; `database.created`, `database.content_updated`,
      `database.schema_updated`, `database.moved`, `database.deleted`,
      `database.undeleted` (pre-2025-09-03-API-version compatibility);
      `data_source.created`, `data_source.content_updated`,
      `data_source.schema_updated`, `data_source.moved`,
      `data_source.deleted`, `data_source.undeleted`. Deliberately
      **excluded**: `comment.*` (Velync doesn't sync comments —
      `parseWebhookEvent()` rejects these even if they somehow arrive, see
      `src/domains/connector/notion.js`).

### 2. Complete the verification handshake

- [ ] Saving the subscription makes Notion POST a `{ verification_token }`
      payload (no signature) to the endpoint. The deployed handler
      (`src/api/routes/webhooks.js`, `isVerificationHandshake()` check)
      logs it and emails every superadmin via `notifyAdmins()` — check Cloud
      Run logs (`domain: "webhooks"`) or the superadmin inbox for the token
      if the dashboard doesn't show a "waiting for verification" indicator.
- [ ] Paste that exact token back into the dashboard's verification field to
      confirm the endpoint. The subscription should now show as active.

### 3. Store the signing secret

- [ ] Once verified, the dashboard reveals a permanent signing secret for
      this subscription (used to compute `X-Notion-Signature` on every
      future event). Copy it.
- [ ] Store it in Secret Manager for the target environment (mirrors the
      existing `LEMONSQUEEZY_WEBHOOK_SECRET` pattern — see
      `infrastructure/staging-env-template.sh`):
      ```
      echo -n "<the secret>" | gcloud secrets create notion-webhook-secret --data-file=- --project=<target-project>
      ```
      (Use `gcloud secrets versions add` instead of `create` if the secret
      already exists — e.g. re-running this after rotating it.)
- [ ] Confirm `infrastructure/cloudbuild.yaml`'s `--set-secrets` includes
      `NOTION_WEBHOOK_SECRET=notion-webhook-secret:latest` (staging — already
      wired in), and wire the production deploy command the same way if it
      doesn't already reference this secret.
- [ ] Redeploy the backend so the new secret takes effect
      (`npm run deploy:staging`, or the equivalent production deploy step in
      `PROMOTION_RUNBOOK.md`).

### 4. Verify end-to-end

- [ ] Edit a page in a database that's the Notion side of an **active**
      sync_config connected in this environment.
- [ ] Confirm in Cloud Run logs (`domain: "webhooks"` then
      `domain: "webhook-debounce"`) that the event was received, verified,
      matched to the config, debounced, and fired a real `runSync` — should
      complete within the ~20s debounce window (`WEBHOOK_DEBOUNCE_MS`), well
      under the old cron interval.
- [ ] Confirm the change actually landed on the destination platform.

## Failure mode to know about (single shared subscription)

Because this is **one subscription shared across every Velync user's Notion
workspace** (not per-connection), if it's ever removed or revoked in the
dashboard, *every* workspace loses the webhook fast-path simultaneously and
silently falls back to cron-only — correctness is unaffected (cron is the
documented backstop), but latency regresses for everyone at once without any
per-user error surfacing. There's nothing in Velync's own error/alerting
surfaces that would catch this today (it looks identical to "nobody edited
anything in Notion recently") — treat an unexplained mass drop in
webhook-triggered dispatch log lines as the signal to re-check the
subscription's status in the dashboard.

## Rotating or recreating the subscription

If the secret is ever rotated or the subscription is deleted and recreated,
repeat Steps 1-3 (a new verification handshake is required) and update the
Secret Manager value + redeploy. No connector/connection-level cleanup is
needed on the Velync side — there is no per-connection subscription state to
tear down (see Stage 5's design note in `WEBHOOK_SYNC_PLAN.md`).

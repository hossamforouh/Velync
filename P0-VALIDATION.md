# P0 — Live Validation Runbook

Everything so far is verified by automated tests against the Firestore **emulator**
with fake connectors. P0 is the gap that only **real accounts + real secret keys**
can close. These steps must be run by you (they need live credentials); the tooling
below makes each one a single command.

Recommended target: the **staging** project/service first (`npm run deploy:staging`,
see `STAGING_CHECKLIST.md` for one-time setup and `infrastructure/cloudbuild.yaml`
for the deploy config), then production once staging is clean — see
`PROMOTION_RUNBOOK.md`.

---

## A. Live bidirectional sync (the unproven core)

1. In the app, connect **two real accounts** (e.g. Notion + TickTick, or Google Contacts).
2. Create a sync config mapping fields between them; set status = active.
3. Trigger a sync directly (bypasses the schedule):
   ```
   node scripts/trigger-sync.js <configId>
   # or, run every active config once:
   node scripts/trigger-sync.js --all
   ```
4. Verify, in order:
   - **Create**: add an item on side A → after a run it appears on side B.
   - **Update**: edit the item on A → the change propagates to B.
   - **Delete**: delete the item on A → after a *reconcile* run it disappears on B.
     (Deletion propagates on reconcile cycles — default hourly; force one by
     clearing `lastReconcileAt` on the config or waiting out the interval.)
   - **No duplicates** on repeated runs (the mapping dedup works).
5. Check `execution_logs` (or the admin **Sync Health** tab) for status/counts.

## B. OAuth token refresh (Google tokens expire hourly)

1. Connect a Google account; note the connection works.
2. Wait > 1 hour (or temporarily shorten/expire the stored access token in
   `credentials/{uid}`), then run `scripts/trigger-sync.js <configId>` again.
3. Confirm the sync still succeeds (the engine refreshed the token) and that a
   new access token was written back to `credentials/{uid}`.

## C. Lemon Squeezy billing (real webhook signature)

Lemon Squeezy has no CLI event-trigger equivalent to `stripe trigger` — this
section is a real, browser-driven TEST MODE checkout instead of synthetic
events.

1. In the Lemon Squeezy dashboard (TEST MODE store), confirm the webhook
   endpoint (Settings → Webhooks) points at:
   ```
   https://<staging-backend-url>/api/billing/webhook
   ```
2. Complete a real Checkout in TEST MODE for a paid plan via the app UI
   (Settings → Billing tab → Upgrade), using a Lemon Squeezy test card.
3. Verify the workspace's `planId` / `lsSubscriptionId` / `subscriptionStatus`
   fields update correctly in Firestore, and that no signature-verification
   errors appear in the Cloud Run logs (the raw-body handling in
   `src/api/routes/billing.js`'s webhook route is what's being validated
   here — `express.json()` must not have consumed the body before the
   signature check runs).
4. Also trigger a downgrade/cancel (Settings → Billing → Cancel) and confirm
   the workspace reverts to Free at the end of the billing period (soft-cancel
   semantics, not immediate).

## D. Distributed lock under multiple instances

Only meaningful once running >1 instance (or in external-scheduler mode with
overlapping ticks).
1. Temporarily set `--min-instances=2 --max-instances=2` on Cloud Run (or fire the
   tick endpoint twice concurrently).
2. Trigger syncs and confirm each config runs **once** per cycle — check logs for
   "lease held by another instance" and no duplicated create/update in the targets.

## E. External scheduler (if adopting Decision 3)

Follow `infrastructure/external-scheduler-setup.md`, then:
```
curl -s -X POST -H "X-Scheduler-Secret: $SECRET" https://<backend-url>/api/internal/scheduler/tick
# → {"ok":true,"due":N,"ran":N,"errors":0}
```
Confirm due configs actually run and `lastRunAt` advances.

---

### Sign-off checklist
- [ ] A: create / update / delete / no-duplicates verified with live accounts
- [ ] B: token auto-refresh verified after expiry
- [ ] C: real Lemon Squeezy webhook updates the plan; signature verifies
- [ ] D: single execution under 2 instances
- [ ] E: (optional) external scheduler ticks drive syncs

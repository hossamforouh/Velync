# P0 — Live Validation Runbook

Everything so far is verified by automated tests against the Firestore **emulator**
with fake connectors. P0 is the gap that only **real accounts + real secret keys**
can close. These steps must be run by you (they need live credentials); the tooling
below makes each one a single command.

Recommended target: a **staging** project/service first (see
`infrastructure/cloudbuild.yaml`), then production.

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

## C. Stripe billing (real webhook signature)

1. Install the Stripe CLI and forward events to the backend:
   ```
   stripe listen --forward-to https://<backend-url>/api/billing/webhook
   ```
2. Complete a real Checkout (test mode) for a paid plan, or trigger events:
   ```
   stripe trigger checkout.session.completed
   stripe trigger customer.subscription.deleted
   ```
3. Verify the workspace's `planId` / subscription fields update correctly and that
   signature verification passes (no 400 "signature" errors in logs — the raw-body
   handling is the thing being validated here).

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
- [ ] C: real Stripe webhook updates the plan; signature verifies
- [ ] D: single execution under 2 instances
- [ ] E: (optional) external scheduler ticks drive syncs

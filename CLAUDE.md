# Velync — Project Context for Claude Code

This file summarizes the project's architecture and history so far, so you 
don't need to reverse-engineer *why* things are structured the way they are 
just from reading the code. Written after an extended review/fix cycle done 
with Claude (chat) across many rounds — referenced below as "the prior review."

---

## What Velync is

A SaaS platform for syncing data bidirectionally between third-party 
platforms (currently Notion, TickTick, Google Contacts — designed to support 
more). Users connect two platforms via OAuth, configure field mappings 
through a wizard, and a backend cron scheduler keeps them in sync 
continuously.

**Stack:** Node.js/Express backend, vanilla JS SPA frontend (no build step, 
no framework), Google Cloud Firestore, Cloud Run hosting, Gemini 2.5 Flash 
(via Vertex AI) for AI-assisted field mapping suggestions, Lemon Squeezy for 
billing (switched from Stripe — see history item 8 below; Stripe doesn't 
support payout accounts for Egypt-based sellers, which is where this project 
is run from).

---

## Key architectural decisions worth knowing

**The Connector contract (`src/domains/connector/interface.js` + 
`registry.js`) is the core abstraction.** Every platform implements a common 
interface (`connect()`, `fetch()`/`read()`, `create()`/`update()`/`delete()`, 
`getSchema()`, `getDataSource()`, `getDisplayTitle()`, `getEntityTypes()`, 
`fetchIds()`). This is genuinely well-designed and extensible — adding a new 
platform should require writing one connector file and registering it, 
nothing else. Don't special-case platform names in shared code (engine, 
routes, wizard) — if you find yourself doing that, it means something isn't 
generic enough yet, which has been a recurring bug pattern in this project 
(see history below).

**Plan-based enforcement (`plans` collection + `src/core/plan.js`).** Pricing 
tiers (Free/Pro/Business) are Firestore documents, not hardcoded constants — 
admin-editable via an admin panel, referenced everywhere a limit needs 
checking (`maxActiveConfigs`, `minSyncIntervalMinutes`, `maxItemsPerRun`, 
`connectorTiers`, `logRetentionDays`). `enforcePlanLimits()` in 
`src/core/plan.js` is the single shared enforcement function — used by both 
the sync-config creation route AND the update route (a real bug existed 
where updates bypassed all plan checks — now fixed, see history).

**Distributed execution locking.** The cron scheduler runs independently on 
every server instance (`src/domains/sync/scheduler.js`), but actual sync 
execution is gated by a Firestore-transaction-based lease 
(`sync_locks/{configId}`) inside `runSync()` in `engine.js` — this prevents 
duplicate execution if Cloud Run scales to multiple instances. Don't assume 
scheduler-level dedup; the lock lives at execution time, not scheduling time.

**Incremental sync uses TWO separate fetches, deliberately.** 
`source.fetch()`/`dest.fetch()` with a `modifiedSince` filter (only Notion 
currently honors this) decides what needs creating/updating. A SEPARATE 
`fetchIds()` call (unfiltered, full ID list) is used specifically for 
deletion-detection reconciliation. These must never be conflated — using the 
filtered fetch for deletion-detection was a real bug found and fixed (an item 
untouched since the last sync looks identical to a deleted item under 
filtering).

**Credentials are keyed by `connectionId`, not by platform name.** 
`credentials/{userId}` is a map keyed by `connectionId` (matching 
`connected_accounts`), NOT by provider name — this was a real bug (fixed) 
where two connections of the same platform for one user would silently 
overwrite each other's tokens.

---

## What's been built and verified (chronological)

1. **Fixed the original Map Fields bug** — a Notion API version change 
   (`data_source` object type) plus a silent-failure pattern in the frontend 
   (`loadDefaultMappingsPreset()` swallowed errors with no visible feedback).

2. **Generalized the architecture beyond TickTick/Notion** (4-phase plan): 
   generic dropdown/data-source routing through the connector registry 
   (removed hardcoded per-platform switch statements), wizard generalization 
   (removed hardcoded "Platform 1 = TickTick, Platform 2 = Notion" — now 
   generic source/destination slots), per-connector entity-type vocabulary 
   (no more shared 'Tasks'/'Database' assumptions), single-source-of-truth 
   schemas (removed duplicate hardcoded frontend fallback field lists). 
   Verified by building the Google Contacts connector as a forcing function — 
   required zero shared-code changes beyond registering it.

3. **Hardened the sync engine for correctness and scale**: automatic OAuth 
   token refresh (was completely missing — Google tokens expire hourly), 
   Google Contacts pagination fix (was silently capped at 200), removed 
   hardcoded Notion/TickTick assumptions from the shared bidirectional-sync 
   logic (added `getDisplayTitle()` per connector), retry/backoff + stale-
   mapping cleanup for failed API calls, distributed lease locking, 
   incremental fetch (with the two-fetch deletion-detection fix above).

4. **Built the pricing/billing architecture**: `plans` collection (admin-
   editable), Stripe Checkout + Billing Portal + webhook integration, plan-
   limit enforcement (config count, connector tier, sync interval, log 
   retention cleanup), workspace migration script. Found and fixed a critical 
   webhook-signature bug (global `express.json()` was consuming the raw body 
   Stripe needs for signature verification) and a critical enforcement-bypass 
   bug (editing/activating an existing config wrote directly to Firestore via 
   the client SDK, bypassing all server-side plan checks — now routed through 
   a proper `PUT /api/sync-configs/:configId` endpoint sharing the same 
   `enforcePlanLimits()` logic as creation).

5. **Fixed the credentials-keying bug** (see architecture section above) with 
   a migration script, and **built a full workspace-deletion cascade** 
   (`src/domains/workspace/deletion.js`) covering sync_configs/sync_mappings 
   (recursive), sync_locks, connected_accounts, credentials, and 
   execution_logs, with per-step error handling so partial failures are 
   diagnosable.

6. **Did a Firestore Security Rules audit** with a real test suite 
   (`test/firestore-rules.test.js` using the rules emulator) — found and 
   fixed one bug (`credentials` collection allowed unnecessary client reads 
   of encrypted token blobs — tightened to Admin-SDK-only).

7. **Started on the broader pre-launch checklist** (staging validation, 
   pricing page, onboarding flow, monitoring scripts) — see "Outstanding 
   work" below for what's actually done vs. still pending.

8. **Migrated billing from Stripe to Lemon Squeezy.** Stripe does not let 
   Egypt-based businesses open a payout-receiving account, which is where 
   this project is run from — Lemon Squeezy (a Merchant of Record with 
   broader seller-country support) was chosen instead. `src/core/lemonSqueezy.js` 
   is a thin REST client (Lemon Squeezy has no official Node SDK in active 
   use here); `src/api/routes/billing.js` was rewritten against it end to 
   end (checkout, in-place plan swap on an existing subscription instead of 
   creating a duplicate, portal URL — sourced directly from the subscription 
   resource rather than a separate "create session" call like Stripe's, 
   downgrade-at-period-end via soft-cancel/resume, webhook handling). Plan 
   docs now store `lsVariantIdMonthly`/`lsVariantIdAnnual` instead of Stripe 
   Price IDs (admin-editable via the Plans tab). Workspace docs now store 
   `lsCustomerId`/`lsSubscriptionId` instead of the Stripe equivalents. 
   **Not yet verified against the real Lemon Squeezy API** — implemented 
   from documented API shape, not exercised against a live account yet (no 
   credentials were available at the time). Verify the exact webhook event 
   names/payload shape (`meta.event_name`, `data.attributes.*`) and the 
   checkout/subscription endpoint request/response shapes against Lemon 
   Squeezy's current docs or a real test-mode call before trusting this in 
   production — this is exactly the kind of "looked correct on paper" gap 
   this project's history (see "Working style" below) warns about.

---

## Outstanding work

### Immediate follow-ups (sent, not yet confirmed complete)
- Add a delete-workspace confirmation UI (backend cascade exists and is 
  tested; there's no frontend button/dialog yet — needs a "type the 
  workspace name to confirm" pattern given how destructive this is).
- Confirm the `credentials` collection's Firestore rule was tightened to 
  `allow read: if false` (was `if request.auth.uid == documentId`), and that 
  a regression test was added for it.

### From the broader pre-launch plan (Sections A–E — status per section unclear, verify each)
- **A — Real-world validation**: nothing in this whole project has been 
  tested against live third-party APIs or a real multi-instance Cloud Run 
  deployment — everything has been verified by careful code reading only. 
  This is the highest-priority remaining gap. Specifically needs: real Stripe 
  webhook testing via the Stripe CLI, real OAuth token refresh testing 
  against Google's actual token endpoint, a real multi-instance deployment 
  test of the distributed lock, and real bidirectional sync testing with 
  live Notion/TickTick/Google accounts.
- **B — Legal/security**: Privacy Policy / ToS drafts may exist as a starting 
  point (`dashboard/public/terms.html` appeared in a recent delivery) — 
  **these need real legal review before publishing**, they were AI-drafted 
  as a starting point only. Firestore rules audit is done (see above).
- **C — Product polish**: in-app upgrade prompts (`showPlanError()` in 
  `app.js`) and an onboarding flow (`dashboard/public/js/onboarding.js`) and 
  a pricing page (`dashboard/public/pricing.html`) appear to have been built 
  — verify these actually work end-to-end, they haven't been reviewed in 
  detail yet.
- **D — Operational readiness**: a `scripts/monitor-health.sh` and 
  `scripts/cost-report.js` appeared in a recent delivery — verify what they 
  actually do, real alerting (Cloud Monitoring policies) and dunning/payment-
  failure handling logic haven't been confirmed as built.
- **E — Go-to-market**: business/process decisions, not code — a small 
  private beta before general availability is recommended given how much of 
  this stack is genuinely new.

---

## Working style this project has used (please continue it)

- **Verify with real evidence, not just code review.** This project has a 
  repeated history of fixes that looked correct on paper but weren't fully 
  tested — several rounds of this review chain existed specifically because 
  an earlier "should be fixed" turned out to have a missed edge case. Prefer 
  running things (tests, staging deploys, real API calls) over asserting 
  correctness from reading a diff.
- **Don't special-case platform names in shared/generic code.** This has been 
  the single most common bug pattern — check `engine.js`, the wizard, and any 
  shared route handler for hardcoded `'notion'`/`'ticktick'`/`'google_contacts'` 
  logic before adding a new platform or fixing a bug; it usually means the 
  abstraction needs fixing, not a one-off patch.
- **Watch for silent error-swallowing** (`.catch(() => ({}))` patterns, or 
  catch blocks that only `console.warn` with no visible UI feedback) — this 
  exact pattern caused the original Map Fields bug and has recurred more than 
  once since.

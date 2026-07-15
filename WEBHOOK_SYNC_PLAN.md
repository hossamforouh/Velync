# Velync — Webhook-Triggered Immediate Sync (Staged Plan)

Status: **Approved — building Stages 0–6.** Stage 7 (faster polling for
TickTick/Google) is de-prioritized in favor of Stage 8 (adaptive polling),
which is the actual lowest-cost lever for the platforms that can't push. See
§8 for the cost-vs-latency reasoning behind that call.

---

## 1. The decision we're actually making

Today Velync is **poll-based**. Every active `sync_config` gets a cron timer
(default `*/5 * * * *`), and when it fires, `runSync(config, configId)` does a
diff-and-reconcile against both platforms. A task created in TickTick does
**not** appear in Notion the moment it's created — it waits for the next tick
(≥5 min by default, gated by the plan's `minSyncIntervalMinutes`).

The question is whether to add a **webhook fast-path** so a change on a source
platform propagates in seconds instead of on the next cron tick.

The honest headline, decided by what each platform's API actually supports
(see §3): we can get **near-real-time in the Notion→X direction only**, and
for TickTick and Google Contacts the only available lever is **faster
polling, not real-time**. This plan is scoped to that reality — it does not
pretend TickTick can push.

**This plan does not replace the cron scheduler.** Cron stays as (a) the sole
mechanism for platforms that can't push, and (b) the reconciliation backstop
that catches missed/dropped webhook deliveries and does deletion detection.
Webhooks are a fast-path layered on top, never a replacement.

---

## 2. Why this is cheaper than it sounds: the engine is already trigger-agnostic

The execution path is already decoupled from *what* triggers it. Everything
funnels through one function:

```
cron tick ─────────────┐
                        ├──► runSync(config, configId)   ◄── the ONLY entry point
manual "Run now" ───────┘        (engine.js:83)
POST /sync-configs/:id/run
```

`runSync()` already owns the hard correctness guarantees a second trigger
source would otherwise need to reinvent:

- a **distributed Firestore lease** (`sync_locks/{configId}`) so only one
  Cloud Run instance executes a given config at a time,
- an **in-process `runningConfigs` guard** against re-entrancy,
- per-run **execution logging** and **usage/cost attribution**.

And there is already a **manual-trigger route** —
`POST /sync-configs/:configId/run` (sync-configs.js:397) — that does exactly
"resolve a config, call `runSync()`, return the result." A webhook handler is
the same shape, minus the user's Bearer token and plus a platform signature
check.

**Consequence:** the sync engine needs essentially no new code. All the work
is *ingress* — receiving an authenticated push, mapping it to the affected
config(s), and calling the `runSync()` that already exists. Keep that framing
throughout: we are adding a doorbell to a house that already knows how to
answer the door.

---

## 3. The hard constraint — per-platform webhook reality

This is the part to agree on before writing anything, because it bounds the
whole feature.

| Platform | Native push / webhook? | What we can actually do |
|---|---|---|
| **Notion** | ✅ Yes — integration webhooks on page/database change events | True webhook fast-path. This is the whole real-time story. |
| **TickTick** | ❌ No — Open API is OAuth polling only, no subscription endpoint | Faster polling only. Cannot be made real-time. |
| **Google Contacts** | ❌ No — People API has no `watch`/push channel (unlike Calendar/Drive/Gmail) | Faster polling only. Cannot be made real-time. |

> **Verify-don't-assume (per CLAUDE.md working style, and given the knowledge
> cutoff):** confirm each row against the platform's *current* docs before
> building. Webhook availability changes; this table reflects the state at
> writing and must be re-checked, especially for TickTick/Google in case they
> add push.

The direct answer to the original framing "TickTick → Notion in real-time":
**not possible** — TickTick can't tell us when a task changes, so that
direction stays on the poll no matter what we build. Webhooks make
**Notion-sourced** changes fast; the reverse direction is always cron.

---

## 4. Architecture — how a webhook flows

```
Notion (change happens)
      │  POST (signed)
      ▼
POST /webhooks/notion            ← new public endpoint, raw-body + HMAC verified
      │  (respond 200 in <3s, then hand off async)
      ▼
parse event → resource id (database/page)
      │
      ▼
reverse lookup: which sync_config(s) reference this resource?
      │  (collectionGroup query over sync_configs, using p1Settings/p2Settings)
      ▼
debounce per configId  (collapse edit bursts into one run in the next ~15–30s)
      │
      ▼
runSync(config, configId)        ← the SAME engine cron already calls
      │
      ▼
cron keeps running on its normal cadence as the reconciliation backstop
```

Two design rules carried over from this project's history:

- **Don't special-case platform names in shared code.** Webhook capability
  must live on the connector as an *optional* interface extension (see §5,
  Stage 2), implemented by Notion, defaulting to a no-op everywhere else. If
  the webhook route or dispatcher ever contains `if (platform === 'notion')`,
  the abstraction is wrong — that exact pattern is the most common bug source
  in this codebase.
- **No silent error-swallowing.** A dropped webhook, a failed signature check,
  a reverse-lookup that finds no config — each must be logged and (where it
  matters) surfaced, not `.catch(() => {})`'d. The cron backstop makes a
  *missed* webhook non-fatal for data correctness, but it must still be
  *visible* in Client Errors / execution logs so we can tell a healthy
  webhook pipeline from a broken one.

---

## 5. Staged plan

Each stage is independently shippable and independently verifiable, following
the same staging-first → verify → commit → ask-before-prod discipline the rest
of the project uses (see PROMOTION_RUNBOOK.md).

### Stage 0 — Verify platform capabilities (no code)

Before committing to any of this, confirm against live docs / a test-mode
call:

- Notion: exact webhook event names, payload shape, signature scheme, and the
  subscription registration/verification handshake.
- TickTick + Google Contacts: re-confirm they still have **no** push API. If
  either gained one, this plan expands.

Deliverable: a short findings note appended here. **Gate:** if Notion's
webhook shape isn't what we assume, re-scope Stage 3 before building.

### Stage 1 — Connector-contract extension (foundation, no ingress yet)

Add optional webhook capability to the `Connector` interface
(`src/domains/connector/interface.js`), defaulting to "not supported":

- `supportsWebhooks()` → `false` by default.
- `verifyWebhookSignature(rawBody, signatureHeader, secret)` → `false` by
  default (not `throws` — a connector without webhook support should fail a
  verification check safely, not blow up a caller that didn't check
  `supportsWebhooks()` first).
- `parseWebhookEvent(payload)` → returns a normalized
  `{ workspaceId, entityId, entityType, eventType }` so downstream code
  (reverse-lookup, Stage 2) never touches platform-specific payload shapes.

No `registerWebhook()`/`unregisterWebhook()` — dropped after the Stage 0
finding that Notion subscriptions are dashboard-managed, not per-connection
(see Stage 5). Only Notion implements the above; TickTick/Google inherit the
`false`/default-throw behavior untouched. Unit-tested in isolation (pure
functions). Nothing user-facing ships yet.

### Stage 2 — Reverse-lookup helper (pure, unit-tested)

Two hops, not one: a webhook gives us Notion's own `workspace_id` + the
changed `entity.id` — neither is a Velync ID, so there's a connection lookup
before the config lookup.

1. **`workspace_id` → `connectionId`.** Notion's `workspace_id` is already
   captured today at OAuth-connect time
   (`credentials/{uid}[connectionId].providerWorkspaceId`, set in
   `auth.js`'s OAuth exchange from the token response's `workspace_id`) — no
   new capture logic needed. **Design wrinkle found while scoping this
   stage:** `credentials` is a doc-per-`uid` with connections nested in a
   map field, which Firestore cannot query into ("find any uid's doc whose
   map has an entry with `providerWorkspaceId == X`") — that shape exists
   specifically because `credentials` is Admin-SDK-read-only (tightened in
   an earlier security pass) and was never meant to be queried this way.
   Resolve by also writing `providerWorkspaceId` onto the **`connected_accounts`**
   doc for Notion connections (a real per-connection document, already
   queryable) at connect time, so the lookup is
   `connected_accounts.where('provider','==','notion').where('providerWorkspaceId','==', workspace_id)`.
   Small, additive change to the existing OAuth exchange handler — not a
   new collection.
2. **`connectionId` + `entity.id` → `sync_config`(s).** `collectionGroup`
   query over `sync_configs` for configs whose `platform1ConnectionId` or
   `platform2ConnectionId` matches, **then** filter to those whose
   `p1Settings`/`p2Settings` reference the specific database/data_source
   matching `entity.id` (a connection can be reused across multiple configs
   pointing at different Notion databases — matching on connection alone
   would over-fire).

One event can fan out to multiple configs (same database used as the source
in more than one config). Pure and emulator-tested against seeded
connections + configs — this is the genuinely new logic and deserves its own
test file (pattern: `dispatcher.test.js`).

### Stage 3 — Ingress endpoint + raw-body/HMAC (Notion only)

- `POST /webhooks/notion` mounted with a **raw-body carve-out** so signature
  verification sees the unparsed body. (This is the exact footgun we already
  hit with the Lemon Squeezy webhook — global `express.json()` consumed the
  raw body signatures need. Reuse that lesson.)
- Rate-limited, strict validation — it's a new **public unauthenticated
  attack surface**.
- **Must handle the one-time verification handshake** (see §0 findings): the
  very first request to this endpoint, when the subscription is created in
  the Notion dashboard, has no `X-Notion-Signature` (there's no secret yet)
  and instead carries a `verification_token` in the body. The handler must
  detect this shape and log/surface the token somewhere an admin can read it
  (e.g. `logger.info` + a one-off Firestore doc), so it can be pasted back
  into the Notion dashboard to complete setup. This only ever happens once
  per subscription (initial setup, or if it's ever recreated).
- On a normal (signed) event: verify `X-Notion-Signature` (HMAC-SHA256 over
  the raw body, keyed by the subscription's stored secret) → parse `type` +
  `entity.{id,type}` + `workspace_id` → reverse-lookup (Stage 2) → enqueue for
  debounce (Stage 4). Respond `200` fast; do the work async — Notion retries
  up to 8 times over ~24h on repeated failure, so slow/failing handling is
  self-amplifying if not fixed quickly.
- Every rejection (bad signature, unknown resource, no matching config) is
  logged, never silently dropped.

### Stage 4 — Debounce / coalescing

Notion emits many events per logical edit. Firing `runSync` per event would
hammer both platform APIs and inflate the usage/cost model. Add a short
per-`configId` debounce: "marked dirty → run once within the next ~15–30s,
collapse further events in that window." Must be safe across Cloud Run
instances (a Firestore-backed dirty flag / next-run-at, not just in-memory,
or it breaks when the leader changes). Interacts with the existing lease so a
debounced run and a cron run can't double-execute — they can't today because
of the lease, but this must be re-verified under the new trigger.

### Stage 5 — Subscription lifecycle (simpler than originally scoped — see §0)

Per the Stage 0 findings, Notion webhook subscriptions are **not** created
per-connection via an API call — they're set up **once, manually, in the
Notion integration dashboard**, scoped to Velync's own shared OAuth
integration (the one `client_id` every user authorizes against), not to any
individual user's connection. There is nothing to register or unregister per
user, per connection, or per config.

Consequences for this stage:

- **One-time setup, not per-user code:** an admin visits the Notion
  integration dashboard, adds `https://<prod-domain>/webhooks/notion` as the
  subscription URL, selects the event types from §0 (`page.content_updated`,
  `data_source.content_updated`, `database.content_updated` for
  pre-2025-09-03-version compatibility, plus the `*.created`/`*.deleted`
  variants), and completes the verification-token paste-back (see Stage 3).
  This is a **runbook step**, documented alongside PROMOTION_RUNBOOK.md /
  STAGING_CHECKLIST.md — do it once for staging, once for production.
- **No per-connection register/unregister code needed** — remove that from
  scope entirely. What Stage 5 actually needs instead:
  - A way to map an incoming event's `workspace_id` (Notion's workspace) back
    to the Velync `connected_accounts` doc(s) whose OAuth token can access
    it. Capture the Notion `workspace_id` at OAuth-connect time (already
    available from the OAuth token response / a cheap `/v1/users/me` call)
    and store it on the `connected_accounts` doc if not already captured —
    check `auth.js`'s OAuth exchange for whether this is already stored.
  - Nothing to clean up on disconnect/delete beyond what already happens —
    there's no per-connection subscription to tear down. (If Notion's
    dashboard-registered subscription itself is ever removed/revoked, *all*
    workspaces lose the webhook fast-path simultaneously and silently fall
    back to cron — this is a single shared point of failure worth alerting
    on, not a per-user concern.)
- **Multi-tenancy caveat to flag explicitly:** because it's one shared
  subscription across every Velync user's Notion workspace, the reverse
  lookup (Stage 2) is the *entire* isolation boundary — it must scope
  strictly to the `workspace_id` + `entity.id` in the payload and never
  assume a single tenant. Get this wrong and one user's edit could
  (at minimum) trigger a wasted lookup against another's configs; the
  `sync_configs` query itself is already workspace-scoped data, so a bug here
  fails safe (finds nothing) rather than leaking data — but it's worth a
  dedicated test case.

### Stage 6 — Plan gating + UX

- Real-time (webhook) sync is a natural **paid-tier** capability — gate it
  through the existing plan model rather than hardcoding.
- Surface it honestly in the UI: for a Notion-source config, "updates in
  seconds"; for TickTick/Google-source, "checked every N minutes." Don't
  imply real-time where the platform can't deliver it.

### Stage 7 (de-prioritized) — faster polling for the no-push platforms

Originally proposed as "lower `minSyncIntervalMinutes` on paid tiers." **This
is a pure cost increase in exchange for lower latency, not a cost
optimization** — TickTick and Google can't push, so the only way to make them
feel faster is to poll them more, which means more API calls and more
Firestore reads for every run, changed-or-not. Kept here for the record but
not planned; superseded by Stage 8 below, which is the actual lowest-cost
lever for these two platforms.

### Stage 8 — Adaptive polling for the no-push platforms (replaces Stage 7)

The real lowest-cost lever for TickTick and Google Contacts: **poll less
often when nothing has been changing**, instead of polling every config at a
flat interval forever regardless of activity. There is no such logic today —
`isConfigDue()` (dispatcher.js) only looks at the cron expression and
`lastRunAt`; it has no concept of "this config hasn't found a change in N
runs, back off."

Design:

- Track a rolling **"consecutive empty runs" counter** per config (a config
  is "empty" when a run's diff finds zero creates/updates/deletes on both
  sides).
- While the counter is below a threshold (e.g. 3), poll at the configured
  interval as today.
- Once a config has been empty for several consecutive runs, **stretch its
  effective interval** (e.g. up to some capped multiplier — 2x, 4x, up to a
  ceiling like 30–60 min) rather than continuing to poll every 5 min for a
  config nobody's touched in hours.
- **Any detected change resets the counter and the interval immediately** —
  this only saves cost on genuinely idle configs, never adds latency to an
  active one.
- Store the counter + effective-next-run on the `sync_config` doc itself
  (alongside `lastRunAt`), so it survives leader handover and is visible to
  `isConfigDue()` without new infrastructure.
- Surface the current effective interval in the UI (Exec Logs / config
  detail) so "why didn't this run yet" is never a mystery — ties into the
  project's "no silent behavior" principle.

This is additive and safe: worst case (bug in the backoff) is "polls at the
normal rate," never "misses a real change," because the counter only ever
stretches the interval for runs that found *nothing* last time.

---

## 6. Effort & risk summary

| Stage | Size | Main risk |
|---|---|---|
| 0 — verify capabilities | tiny | Findings invalidate assumptions → re-scope |
| 1 — connector extension | small | Getting the abstraction generic (no platform special-casing) |
| 2 — reverse lookup | medium | Correctly matching resource → config via p1/p2Settings |
| 3 — ingress + HMAC | small-med | Raw-body footgun; new public attack surface |
| 4 — debounce | **medium** | Cross-instance correctness; most subtle piece |
| 5 — lifecycle | medium | Orphaned subscriptions; ties into OAuth refresh + deletion cascade |
| 6 — plan gating + UX | small | Not over-promising real-time |
| 7 — faster polling | ~~tiny~~ | **De-prioritized** — increases cost, doesn't reduce it |
| 8 — adaptive polling | small-med | Correctly detecting "empty run"; resetting promptly on real change |

Highest-value, lowest-architecture-risk first:

- **Stage 8 alone** reduces steady-state cost for TickTick + Google Contacts
  (2 of 3 platforms) without touching latency for anything actually active.
- **Stages 1–5** deliver true near-real-time *and* lower cost for
  Notion-sourced changes (fewer wasted polls on idle configs).

---

## 7. Recommendation

Frame the deliverable as **"an optional webhook fast-path on top of the
existing poll, Notion-only to start, plus adaptive backoff for the platforms
that can't push"** — not "switch Velync to real-time."

- **Phase A (building now):** Stages 0–6 — Notion webhook fast-path. Real
  near-real-time in the one direction the APIs allow, with cron unchanged
  underneath as the reconciliation backstop. Also a net cost reduction, since
  idle Notion-source configs stop polling every 5 min for nothing.
- **Phase B (next):** Stage 8 — adaptive polling for TickTick/Google. Lowest
  actual cost lever available for platforms that will never support push.
- **Not planned:** Stage 7 (faster polling) — the wrong direction if cost is
  the goal.

Cron is never removed. Real-time is additive, capability-gated by what each
platform's API actually supports, and layered on the correctness guarantees
`runSync()` already provides.

---

## 8. Build log

Tracking actual progress against §5 as work lands (updated as stages
complete, not written in advance).

### Stage 0 — done

Researched against Notion's official docs (developers.notion.com) plus
targeted searches, cross-checked where sources conflicted:

- **Signature:** `X-Notion-Signature` header, `sha256=<hex>`, HMAC-SHA256
  over the raw request body, keyed by the subscription's secret. Confirmed
  by the official reference page.
- **Event types (confirmed):** `page.created`, `page.content_updated`,
  `page.properties_updated`, `page.moved`, `page.deleted`, `page.undeleted`,
  `page.locked`, `page.unlocked`; `database.*` (created/content_updated/
  schema_updated/moved/deleted/undeleted — `content_updated`/
  `schema_updated` deprecated as of API version 2025-09-03 in favor of the
  `data_source.*` equivalents); `data_source.*` (created/content_updated/
  schema_updated/moved/deleted/undeleted); `comment.*`
  (created/updated/deleted).
- **Payload shape (confirmed):** top-level `id`, `timestamp`, `workspace_id`,
  `workspace_name`, `subscription_id`, `integration_id`, `type`, `authors`,
  `accessible_by`, and an **`entity` object with `{ id, type }`** identifying
  the specific page/database/data_source/comment that changed. Payloads
  carry IDs and metadata only — no content body; a follow-up API call is
  needed to fetch what actually changed, same shape our diff-based
  `runSync()` already expects.
- **Delivery guarantees:** "at-most-once" intent, retried up to 8 times over
  ~24h on failure to ack; events "within 5 minutes," most within a minute.
  Confirms respond-fast-then-process-async is required (Stage 3).
- **⚠️ Important correction, found by re-fetching the same official page
  twice:** subscriptions are created **manually via the Notion integration
  dashboard UI** (paste-back a `verification_token` to complete setup) — **not**
  via a REST API call. An initial web search surfaced a plausible-looking
  `POST /v1/webhooks` REST endpoint (complete with a fake API version
  `2026-03-01` and example curl command) from third-party/SEO blog sources;
  re-fetching the official docs page directly confirmed **no such endpoint is
  documented there.** Treated as a likely AI-generated fabrication and
  discarded — flagging this explicitly per the project's "verify with real
  evidence" standard, since it's exactly the kind of plausible-but-wrong
  detail that would have derailed Stage 5 if taken at face value. **Stage 5
  has been rewritten around the confirmed dashboard-only, one-subscription-
  per-integration model** (see §5 Stage 5) — this is simpler than originally
  scoped, not harder: no per-connection register/unregister code is needed at
  all, just a one-time manual setup step per environment (staging, prod).
- **TickTick:** re-confirmed no native webhook/push support in its Open API;
  only third-party polling-based workarounds (IFTTT, Pipedream) exist, which
  don't change the underlying constraint.
- **Google Contacts:** not re-searched this pass (long-standing, stable fact
  already high-confidence: the People API has no `watch`/push channel, unlike
  Calendar/Drive/Gmail) — worth a final confirmation immediately before
  Stage 8 (adaptive polling) work, not blocking Stages 1–6.

**Gate check:** no findings invalidate Stages 1–4 or 6. Stage 3 gained one
new requirement (verification-token handling). Stage 5 is re-scoped smaller.
Proceeding to Stage 1.

### Stage 1 — done

Added `supportsWebhooks()` / `verifyWebhookSignature()` / `parseWebhookEvent()`
as static methods on the base `Connector` class (`src/domains/connector/interface.js`),
all defaulting to false/false/throw so every non-Notion connector inherits
safe no-op behavior untouched. Notion implements all three plus
`isVerificationHandshake()` for the one-time setup payload
(`src/domains/connector/notion.js`) — real HMAC-SHA256 verification mirroring
`lemonSqueezy.js`'s pattern, timing-safe compare, `sha256=` prefix per the
Stage 0 findings. Unit-tested in isolation (no emulator needed — pure
functions): `test/notion-webhook.test.js`, 23/23 passing, covering signature
tamper/wrong-secret/malformed-header rejection, handshake detection, and
event-payload normalization/validation. `npm run test:notion-webhook`.

### Stage 2 — done

Built the two-hop reverse lookup (`src/domains/sync/webhookLookup.js`,
`resolveConfigsForWebhookEvent(provider, providerWorkspaceId, entityId)`):

- Denormalized `providerWorkspaceId` onto `connected_accounts` at
  OAuth-connect time (`src/api/routes/auth.js`) — additive field, alongside
  the existing `credentials` copy, so the lookup can actually query it.
- Hop 1: `connected_accounts.where('provider','==',...).where('providerWorkspaceId','==',...)`
  → connectionId(s).
- Hop 2: `collectionGroup('sync_configs')` filtered by
  `platform1ConnectionId`/`platform2ConnectionId` (two queries merged by doc
  path, same workaround `sync-configs.js` already uses for the
  can't-OR-two-fields Firestore limitation), then filtered again to configs
  whose matching side's `p1Settings.database`/`p2Settings.database` equals
  the event's `entityId` — this is what prevents over-firing when a
  connection is reused across configs pointing at different databases.
- Emulator-tested (`test/webhook-lookup.test.js`, 8/8 passing,
  `npm run test:webhook-lookup`): fan-out to multiple configs across
  workspaces, exclusion of a same-connection-different-database config,
  exclusion of an unrelated provider workspace, and the multi-tenancy
  isolation case flagged in this stage's design note (same
  `providerWorkspaceId` string reused by a different `provider` never
  matches). Full existing suite (`connections-fixes`, `firestore-rules`,
  94/94) re-run clean — the new `connected_accounts` field caused no
  regressions.

### Stage 3 — done

Built `POST /api/webhooks/:provider` (`src/api/routes/webhooks.js`), mounted
in `server.js` with the same raw-body carve-out pattern as the Lemon Squeezy
webhook (`express.raw()` on `/api/webhooks`, explicitly skipped by the global
`express.json()` middleware) plus a tighter dedicated rate limiter (60/min)
since this is a new public unauthenticated attack surface.

The route itself is provider-generic — `:provider` from the URL resolves a
connector via the existing registry, and every check (signature
verification, handshake detection, event parsing, dispatch) goes through
that connector's own static methods. The only per-provider data is two tiny
lookup maps (webhook secret, expected signature header name) — adding a
second push-capable platform means adding one line to each, not new control
flow, consistent with the project's no-platform-special-casing rule.

Flow: resolve connector → check `supportsWebhooks()` → check configured
secret → parse JSON → detect the one-time verification handshake (ack
immediately, log + email admins the token, no signature check possible yet)
→ verify HMAC signature → `parseWebhookEvent()` → **respond 200
immediately** → asynchronously run Stage 2's reverse lookup → for each
matched config with `status === 'active'`, call `runSync()` (the same
engine cron already uses — draft/paused configs are skipped, and Stage 6
will layer plan-gating on top of this same check). A run failure is caught,
logged, and emailed to admins (mirroring the existing billing-webhook
pattern) — cron still catches it on the next tick, so this is visible but
non-fatal.

`config.notionWebhookSecret` added (`NOTION_WEBHOOK_SECRET` env var,
documented in `.env.example` — actual value comes from completing the
verification handshake in Stage 5's runbook).

Verified end-to-end against the real Express app + Firestore emulator
(`test/webhooks.test.js`, 9/9 passing, `npm run test:webhooks`): unknown
provider and non-webhook-capable provider both 404; the verification
handshake acks without a signature; missing/tampered signatures and
unrecognized event types are all rejected before any dispatch; a validly
signed event acks immediately and asynchronously dispatches `runSync` only
to the matching **active** config (a matching **paused** config is
correctly skipped, and an event matching no config still acks 200 rather
than surfacing an error to the sender/retrier). Only `runSync` itself is
stubbed (same principle as stubbing `verifyAuth`/Lemon Squeezy elsewhere) —
signature verification, handshake detection, event parsing, and the real
two-hop reverse lookup all run for real. Full `npm run test:all` (29 suites)
re-run clean after this stage — no regressions from the new raw-body route
or rate limiter.

### Stage 4 — done

Built `scheduleDebouncedRun(workspaceId, configId, debounceMs)`
(`src/domains/sync/webhookDebounce.js`) and wired `webhooks.js`'s dispatch
loop to call it instead of `runSync` directly.

Design: a `webhookPendingUntil` timestamp lives on the `sync_config` doc
itself, set inside a Firestore transaction. The transaction result tells the
caller whether it "won" (no window was pending, or it already elapsed —
this caller becomes responsible for firing once the window closes) or just
extended an already-pending window (coalescing — every other event in a
burst is a no-op beyond pushing the fire time out). The winning caller polls
the doc rather than sleeping a fixed duration, so a window that keeps
getting extended by new events keeps deferring correctly instead of firing
mid-burst. Config status is re-read fresh at the moment the window actually
elapses (not cached from scheduling time), so a config paused mid-window
correctly skips its debounced run. If the owning instance dies mid-window
the flag is simply never cleared — no correctness impact, since cron's own
next tick is unconditional and doesn't look at this flag at all; it's purely
a same-instance-or-not scheduling hint for the fast path, exactly the
"missed webhook is non-fatal, cron backstops it" design already established
in §4.

Added `config.webhookDebounceMs` (`WEBHOOK_DEBOUNCE_MS` env var, defaults to
20s per the plan's "~15-30s" target) so the window is overridable — used to
shrink it in tests rather than making every debounce test sleep 20 real
seconds.

Verified: a new dedicated suite (`test/webhook-debounce.test.js`, 5/5
passing, `npm run test:webhook-debounce`) exercises the module directly
against the Firestore emulator (with `runSync` stubbed) — single event
fires exactly once after the window, a burst of 4 overlapping calls
collapses into exactly one run, `webhookPendingUntil` is cleared after
firing, and a config paused mid-window correctly skips. `test/webhooks.test.js`
gained a 10th end-to-end case confirming a burst of 5 real webhook POSTs
collapses to one dispatched run through the full ingress path. Full
`npm run test:all` (30 suites) re-run clean.

### Stage 5 — done

Per the Stage 0 findings, there is no per-connection register/unregister
code to build — Notion subscriptions are dashboard-managed, one per
integration, not one per user connection. The remaining Stage 5 work was
therefore documentation + the one already-satisfied code dependency:

- **`providerWorkspaceId` reverse-lookup dependency** — already built in
  Stage 2 (`connected_accounts` denormalization in `auth.js`). Nothing new
  needed here.
- **Multi-tenancy isolation caveat** — already covered and tested in Stage
  2's `webhook-lookup.test.js` (cross-provider / cross-workspace exclusion
  cases).
- **Fail-closed when unconfigured** — added explicit coverage
  (`test/webhooks-unconfigured.test.js`, `npm run test:webhooks-unconfigured`)
  confirming `POST /api/webhooks/notion` returns 503 (not a crash, not an
  accidental pass-through) when `NOTION_WEBHOOK_SECRET` isn't set yet — the
  expected state for any environment before this stage's runbook has been
  run once.
- **Runbook** — new `NOTION_WEBHOOK_RUNBOOK.md`: the one-time dashboard
  setup (subscription URL, event type selection, verification-token
  paste-back handshake, retrieving the dashboard-issued signing secret,
  storing it in Secret Manager, redeploying, end-to-end verification), plus
  the multi-tenancy single-point-of-failure note (one shared subscription —
  losing it silently degrades every workspace to cron-only, not a per-user
  error). Explicitly flagged as needing verification against Notion's live
  dashboard UI at execution time, consistent with the project's
  verify-don't-assume standard, since a dashboard UI isn't something this
  review can click through itself.
- Wired the (not-yet-existing) secret into the deploy tooling without
  breaking the current working deploy: `infrastructure/staging-env-template.sh`
  documents `NOTION_WEBHOOK_SECRET` as dashboard-issued (not
  self-generated like the other secrets), and `infrastructure/cloudbuild.yaml`'s
  header comment explains it's intentionally **not** yet in the
  `--set-secrets` flag (adding a reference to a Secret Manager secret that
  doesn't exist yet would break the next `npm run deploy:staging`) —
  `NOTION_WEBHOOK_RUNBOOK.md` Step 3 is the actual point where a real
  operator adds it once the secret exists. `STAGING_CHECKLIST.md` gained a
  line noting this secret is optional/deferred, not part of initial
  provisioning.

Full `npm run test:all` (31 suites) re-run clean.

### Stage 6 — done

Added `webhookSyncEnabled` (boolean, default `false`) to the plan schema —
admin-editable via a new toggle in the Plan editor (`dashboard/public/index.html`
+ `admin-plans.js`), validated in `PUT/POST /admin/plans` (`src/api/routes/admin-plans.js`),
and surfaced in `GET /api/plans` (`public-plans.js`, not a secret) so the
Flows page can read it. Defaults to `false` on both create and for any
existing plan doc missing the field — a brand-new capability fails closed
rather than silently granting free access to plans that predate it.

Enforcement lives in `webhooks.js`'s dispatch loop (Stage 3): for each
matched active config, resolve the workspace's plan and skip
(`scheduleDebouncedRun` never called) if `!plan.webhookSyncEnabled` —
logged, not silently dropped. A gated-out workspace is **not** cut off from
sync entirely: cron keeps running at its normal (already plan-gated via
`minSyncIntervalMinutes`) interval, it just never gets the webhook
fast-path. Verified with a new emulator case in `test/webhooks.test.js`
(now 11/11): a config on a plan without `webhookSyncEnabled` still acks 200
but never dispatches `runSync`.

UX honesty (the plan's explicit ask — "don't imply real-time where the
platform can't deliver it"): the Flows page's per-config "Sync Schedule"
cell (`app.js`'s `renderCards()`) now shows "⚡ Real-time" only when BOTH
the config's source platform (`platform1`) is Notion AND the workspace's
plan has `webhookSyncEnabled` — every other case (TickTick/Google source,
regardless of plan; or Notion source on a plan without the capability)
keeps showing the honest "Every N minutes" cron text, since those
configurations genuinely never get push-triggered sync. The current plan is
cached client-side from the existing `GET /api/billing/plan` call
(`loadWorkspaceQuota()`) into `window._currentPlan` so the synchronous
render loop can read it without an extra await; the plan is fetched once at
page load already, so this adds no new network calls per render.

Service worker cache bumped to v13 (shell assets — `index.html`, `app.js`,
`admin-plans.js` — all changed). Full `npm run test:all` (31 suites)
re-run clean.

---

## All six stages (0–6) are now built, verified, and documented.

Nothing in Stages 1-6 has been deployed to staging/production yet or
exercised against a live Notion webhook — that's the next step, following
this project's staging-first discipline: `npm run deploy:staging`, then
`NOTION_WEBHOOK_RUNBOOK.md`'s one-time setup against the staging backend,
then real end-to-end verification with a live Notion edit, before asking
about production. Stage 8 (adaptive polling) remains Phase B, not started.

<div class="anchored-summary">

## Session: 2026-07-05 — Sync engine overhaul (token refresh, pagination, retry, locking, tests)

### Issues addressed

**Issue 1 — OAuth token refresh + credential consolidation**
- `src/domains/connection/resolver.js` rewritten: single `resolveCredentials(uid, connectionId)` function that handles auth checks, decrypts credentials, and auto-refreshes expired tokens via the provider's token-refresh endpoint before returning
- `ensureFreshToken()` checks `expiresAt` with a 5-minute margin; calls `refreshToken()` which POSTs to the platform's `tokenUrl` with the stored refresh token, re-encrypts and persists the new token/expiry to Firestore
- On refresh failure, marks `connected_accounts.needsReauth = true` for UI visibility
- Removed `engine.js`'s duplicate `resolveConnectorCreds()` — engine now calls `resolveCredentials()` from resolver
- `auth.js` now stores `expiresAt` on initial OAuth exchange (computed from `expires_in` response field)
- Exported `resolveCredentials` alongside legacy `resolveConnectionTokens` wrapper

**Issue 2 — Google Contacts pagination**
- `listContacts()` and `listContactGroups()` in `services/google-contacts.js` now loop following `nextPageToken` until it's absent, accumulating results across pages (same pattern as Notion's cursor loop)

**Issue 3 — Removed hardcoded Notion/TickTick assumptions**
- Added `getDisplayTitle(item)` to `Connector` interface; each connector implements it for its own data shape:
  - Notion: iterates `properties` to find the `type: 'title'` field
  - TickTick: reads `item.title || item.name`
  - Google Contacts: reads `names[0].displayName`
- Bidirectional sync branch in `engine.js` now calls `dest.getDisplayTitle(page)` instead of reaching into `page.properties?.Name?.title?.[0]?.plain_text`
- Removed hardcoded `mapped.projectId = filter.listName?.toLowerCase() === 'inbox' ? 'inbox' : undefined` — TickTick's own `createTask` handles default list assignment

**Issue 4 — Retry with backoff + stale mapping cleanup**
- Added `retryWithBackoff(fn, { maxAttempts, baseDelayMs })` helper in `engine.js`: retries on 429, 5xx, 401/403, and network errors; sleeps with exponential delay + jitter between attempts
- Does NOT retry on 400, 404 (404 is propagated specifically for stale-mapping handling)
- Wrapped all per-item API calls (`dest.create`, `dest.update`, `dest.delete`, `source.delete`, `source.create`) with `retryWithBackoff`
- On 404 during `dest.update`, removes the stale mapping entry (logs `"recreating deleted destination item"`) so the item gets recreated next cycle instead of failing forever

**Issue 5 — Distributed lock via Firestore**
- Added `acquireLease(configId)` / `releaseLease(configId)` in `engine.js`: uses a Firestore transaction to write a `sync_locks/{configId}` document with `heldBy` (instance ID = `hostname-pid`) and `expiresAt` (120s TTL)
- Only one instance proceeds if the lease doesn't exist or has expired; if another instance holds a valid lease, the run is skipped
- Lease is released in the `finally` block; crashes auto-expire after the TTL
- `INSTANCE_ID` derived from `os.hostname()` and `process.pid`

**Issue 6/7 — Incremental sync + execution budget**
- Each connector's `fetch()` now accepts an `options.modifiedSince` ISO timestamp
- Notion connector passes it through to the API's `filter.timestamp: 'last_edited_time'` filter
- Engine stores `lastSuccessfulSyncAt` on the config after each successful run and passes it as `modifiedSince` on subsequent runs
- Added `MAX_ITEMS_PER_RUN` cap (default 500, configurable via `config.maxItemsPerRun`)
- Full reconciliation (deletion detection) still runs on every tick; incremental fetch limits the create/update set

**Issue 8 — Unit test coverage**
- Added 10 new tests (32 total, all passing):
  - `retryWithBackoff`: succeeds on first try, retries on 429, does NOT retry on 400, exhausts attempts on persistent 500
  - `getDisplayTitle`: base fallback, Notion title-property extraction, TickTick title/name, Google Contacts `names[0]`
- Existing mapper and conflict tests untouched and passing

**Issue 9 — Acknowledged, no action this round**

## Follow-up (same session): Deletion-detection correctness + TickTick incremental fetch

### Priority fix — deletion-detection correctness

**Bug**: `modifiedSince`-filtered fetches were used both for create/update *and* for
deletion detection. If a source item hadn't been modified since the last sync (absent
from the filtered fetch), but its paired dest item had been touched directly by a user
(present in the filtered dest fetch), the old logic incorrectly deleted the still-valid
dest item.

**Fix**:
- Added `fetchIds(entityType, filter)` to the `Connector` interface (`interface.js:55`)
  — returns just `[{id}]` arrays for deletion-detection, defaulting to `fetch()`
  without `modifiedSince`.
- GoogleContactsConnector overrides `fetchIds` with a minimal `personFields: 'names'`
  query for efficiency (`google-contacts.js:21`).
- Engine now uses two separate fetches:
  - `source.fetch()` / `dest.fetch()` with `modifiedSince` + `MAX_ITEMS_PER_RUN` cap
    for create/update processing (`engine.js:197-199`).
  - `source.fetchIds()` / `dest.fetchIds()` without any filter for building the full
    current ID sets used in the deletion-propagation loop (`engine.js:203-204`).
- `MAX_ITEMS_PER_RUN` is NOT applied to the ID-only fetch — an incomplete ID set
  would reintroduce the same false-positive deletion bug (`engine.js:203-204`).

### Optional — TickTick incremental fetch

- `TickTickConnector.fetch()` now honors `options.modifiedSince` by filtering results
  client-side on `modifiedTime` (TickTick's API doesn't support server-side date
  filtering for incomplete tasks).
- Also passes `modifiedSince` through to `getCompletedTasksFromList()` as the
  `sinceDate` parameter, which already supported server-side filtering.
- Habits are also filtered client-side by `modifiedTime`.

### Google Contacts syncToken-based incremental sync

- Flagged as future work. The People API uses an opaque `syncToken` mechanism rather
  than a simple timestamp filter, requiring state storage and a different API path.
  Not implemented this round.

### Test results

- All 32 existing tests pass (unchanged).
- Syntax check clean on all 5 modified files.

### Files modified (this follow-up)
- `src/domains/connector/interface.js` — added `fetchIds()` default implementation
- `src/domains/connector/google-contacts.js` — `fetchIds()` override with minimal fields
- `src/domains/connector/ticktick.js` — client-side `modifiedSince` filtering
- `src/domains/sync/engine.js` — separated deletion-detection IDs from create/update items
- `services/google-contacts.js` — `listContacts()` accepts optional `personFields` param

</div>

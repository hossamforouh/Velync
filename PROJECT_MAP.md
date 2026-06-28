# PROJECT MAP — Velync SaaS Integration Platform

> Generated: 2026-06-24 | Node v26.3.0 | npm 11.16.0
> State: ACTIVE — M1-M6 complete (MVP core + design overhaul)

---

## [TECH_STACK]

### Current (Audited 2026-06-24, Updated dependencies)
| Dependency | Pinned | Latest Stable | Status |
|---|---|---|---|
| Node.js | v26.3.0 | v26.3.0 | ✅ Current |
| express | ^5.2.1 | 5.2.1 | ✅ Current |
| @google-cloud/firestore | ^8.6.0 | 8.6.0 | ✅ Current |
| firebase-admin | ^14.0.0 | 14.0.0 | ✅ Updated |
| @notionhq/client | ^5.22.0 | 5.22.0 | ✅ Updated |
| axios | ^1.18.1 | 1.18.1 | ✅ Current |
| dotenv | ^17.4.2 | 17.4.2 | ✅ Updated |
| node-cron | ^4.5.0 | 4.5.0 | ✅ Updated |
| cron-parser | ^5.6.0 | 5.6.0 | ✅ Current |
| nodemailer | ^9.0.1 | 9.0.1 | ✅ Current |
| form-data | ^4.0.6 | 4.0.6 | ✅ Current |
| firebase-tools (CLI) | — | latest | ✅ Installed globally |

### Target Stack (MVP)
- **Runtime**: Node.js 26 LTS, Express 5
- **Database**: Firestore (NoSQL, existing)
- **Auth**: Firebase Auth (existing + Google SSO)
- **Hosting**: Firebase Hosting (SPA) + Cloud Run (API)
- **Frontend**: Vanilla JS SPA (no framework — keep zero build step)
- **Encryption**: AES-256-GCM via crypto (existing utils/encryption.js)
- **Scheduler**: node-cron v4.5.0 (dynamic cron per config via Firestore onSnapshot)

---

## [SYSTEM_FLOW]

### User Journey (GUI)
```
Landing → Auth (Email/Google)
  → Workspace (auto-created per user)
    → Marketplace: Browse prebuilt Integrations
      → Select Integration (e.g. TickTick → Notion)
        → Connect Source Account (OAuth / API Key)
        → Connect Destination Account
        → Configure Sync:
            - Direction: one-way / bidirectional
            - Schedule: cron presets
            - Field Mappings: drag-to-match UI
            - Filters: tag-based, status-based
        → Activate Flow
          → Scheduler runs on cron
          → Execution Logs in dashboard
```

### Data Flow (Backend)
```
[Source Connector] → read(entity, filters) → [Mapper] → write(entity, mapping) → [Dest Connector]
       ↓                        ↓                          ↓
[Credential Store]      [Field Mapping Config]      [State Mapping (Firestore)]
  (encrypted)                                          (ticktickID ↔ notionPageID)
```

### Sync Engine Lifecycle
```
1. Scheduler triggers per config (node-cron / Firestore onSnapshot)
2. Resolve credentials (decrypt from Firestore)
3. Source connector.fetch() → raw items
4. Filter by sync tag / modified time
5. Mapper.map(sourceItem, fieldMappings) → generic payload
6. Compare with state mapping (last synced timestamps, checklists)
7. Conflict resolution (bidirectional: last-writer-wins with timestamp)
8. Dest connector.write(payload) → create/update/delete
9. Update state mapping + execution log in Firestore
10. Handle deletion propagation
```

---

## [ARCHITECTURE]

### High-Level Structure
```
velync/
├── src/                          # Backend (Node.js)
│   ├── core/
│   │   ├── config.js             # Env config loader (dotenv)
│   │   ├── errors.js             # Typed errors (ConnectionError, SyncError, AuthError)
│   │   └── logger.js             # Structured async logger (stdout JSON + Firestore fallback)
│   │
│   ├── domains/
│   │   ├── auth/                 # Firebase Auth middleware, RBAC helpers
│   │   ├── workspace/            # Workspace CRUD, member invites
│   │   ├── connection/           # OAuth exchange, credential CRUD, encryption
│   │   ├── integration/          # Platform definitions, marketplace schema registry
│   │   ├── sync/
│   │   │   ├── engine.js         # Sync orchestrator (generic source→dest)
│   │   │   ├── scheduler.js      # Dynamic cron job manager
│   │   │   ├── mapper.js         # Field value transformation
│   │   │   └── conflict.js       # Bidirectional conflict resolution
│   │   └── connector/            # Adapter pattern
│   │       ├── interface.js      # Connector contract (read, write, test, schema)
│   │       ├── registry.js       # Map<platformId, ConnectorClass>
│   │       ├── ticktick.js       # TickTick adapter (refactored from services/ticktick.js)
│   │       ├── notion.js         # Notion adapter (refactored from services/notion.js)
│   │       └── __template.js     # Boilerplate for new connectors
│   │
│   ├── api/
│   │   ├── routes/
│   │   │   ├── auth.js           # OAuth endpoints
│   │   │   ├── connections.js    # Connected accounts CRUD
│   │   │   ├── configs.js        # Sync config CRUD
│   │   │   ├── logs.js           # Execution logs
│   │   │   ├── platform.js       # Platform entities (lists, dbs, etc.)
│   │   │   └── admin.js          # Superadmin: platforms, marketplace, settings
│   │   ├── middleware/
│   │   │   ├── auth.js           # Firebase ID token verification
│   │   │   └── validate.js       # Request validation
│   │   └── server.js             # Express bootstrap (routes, CORS, error handler)
│   │
│   └── index.js                  # Entry point: starts server + scheduler
│
├── dashboard/public/             # SPA (unchanged architecture)
│   ├── index.html                # Shell with auth + platform views
│   ├── app.js                    # App bootstrap, auth, navigation
│   ├── style.css / responsive.css
│   ├── js/
│   │   ├── navigation.js         # View routing
│   │   ├── hub.js                # Marketplace view
│   │   ├── connections.js        # Connected accounts view
│   │   ├── integration-setup.js  # Integration/config creation wizard
│   │   ├── logs.js               # Execution logs view
│   │   ├── admin-platforms.js    # Superadmin: platform editor
│   │   └── admin-integrations.js # Superadmin: marketplace editor
│   └── *.html / *.png / manifest.json / sw.js
│
├── archive/                      # Legacy services + workflows (preserved for reference)
├── scripts/                      # seed-marketplace.js, migration scripts
├── firebase.json                 # Firebase Hosting config
├── .firebaserc                   # Firebase project alias
├── firestore.rules               # Firestore security rules
├── .env.example
└── package.json
```

### Connector Contract (interface.js)
```js
class Connector {
  constructor(credentials)     // encrypted tokens decrypted before passing
  async connect()              // test credentials, init client
  async read(entityType, opts) // fetch items (Tasks, Notes, Habits, etc.)
  async write(entityType, payload) // create/update items
  async delete(entityType, id) // delete/archive items
  getSchema()                  // return available entity types + field definitions
  getDataSource(fieldId)       // for dynamic_select: lists, tags, databases
}
```

### Firestore Data Model
```
workspaces/{workspaceId}
  ├── name, ownerId, members[], invitedEmails[]
  ├── sync_configs/{configId}
  │   ├── enabled, description, syncType, targetEntity
  │   ├── cronSchedule, deleteAfterSync
  │   ├── sourcePlatform, destPlatform
  │   ├── sourceConnectionId, destConnectionId
  │   ├── fieldMappings[{ ticktickField, notionProperty }]
  │   ├── statusMappings{ incomplete[], complete[], incompleteDefault, completeDefault }
  │   └── filterConfig{ syncTag, listName }
  │
  ├── sync_configs/{configId}/sync_mappings/{mappingId}
  │   ├── notionPageId, ticktickEntityId
  │   ├── notionLastEditedTime, ticktickLastModifiedTime
  │   ├── ticktickChecklistState, notionRelationState
  │   └── lastSyncedAt
  │
connected_accounts/{connectionId}
  ├── provider (platformId), label, userId, workspaceId
  ├── authType: 'oauth' | 'manual'
  └── attributes: {} (for manual: apiKey, etc.)
credentials/{userId}
  └── {platformId}: { accessToken(encrypted), refreshToken(encrypted), ... }
platforms/{platformId}
  ├── name, logo(svg), authType
  ├── clientId, clientSecret (oauth) | guideUrl (manual)
  ├── authUrl, tokenUrl (oauth)
  ├── configSchema[{ id, label, type, options, dataSource, dependsOn, visibilityRule }]
  └── attributesSchema[{ key, label, type, required }]
integrations/{integrationId}
  ├── name, description, logo
  ├── sourcePlatform, destPlatform
  ├── syncTypes[]
  └── defaultMappings[]
execution_logs/{logId}
  ├── configId, configName, workspaceId
  ├── startTime, endTime, status, error
  └── syncedCount, deletedCount, failedCount
users/{userId}
  ├── email, name, role, workspaceId, workspaceName
  └── createdAt
app_settings/general
  └── whatsappNumber
```

---

## [LOGGING_STRATEGY] (Protocol 4)

- **Sync execution logs**: Firestore collection `execution_logs` — written by engine.js after each run. Already implemented.
- **System logs**: Structured stdout with JSON prefix `{"level":"INFO","ts":"...","msg":"..."}`. Cloud Run picks up stdout natively. No file I/O.
- **Levels**: DEBUG, INFO, WARN, ERROR only.
- **Async**: Firestore writes are fire-and-forget (no await in hot path for engine run). Use a write queue with periodic flush if needed.
- **No external logging SDK** — keep zero dependencies.

```js
// core/logger.js
const LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const currentLevel = LEVELS[process.env.LOG_LEVEL] || LEVELS.INFO;

function log(level, domain, message, data = null) {
  if (LEVELS[level] < currentLevel) return;
  const entry = { level, ts: new Date().toISOString(), domain, msg: message };
  if (data) entry.data = data;
  console.log(JSON.stringify(entry));
}
```

---

## [ORPHANS & PENDING]

### ✅ Resolved (this session)
| Item | Resolution |
|---|---|
| 46 scratch/test files | Deleted `/scratch/`, archived `services/` & `workflows/` |
| Legacy services → connectors | Adapters created: `connector/ticktick.js`, `connector/notion.js` |
| Legacy workflow decomposition | `engine.js`, `mapper.js`, `conflict.js` extracted |
| Hardcoded API URL | `dashboard/public/index.html` → `window.VELYNC_CONFIG.apiBase` |
| Monolithic index.js | Split into `api/server.js` + routes + cli/test.js |
| `platforms.json` 403 | Removed; dashboard loads from Firestore |
| Dependencies | All updated: firebase-admin 14, dotenv 17, node-cron 4.5, notionhq 5.22 |
| Connector registry + template | `interface.js` + `registry.js` + `__template.js` created |
| Scheduler firestore listener | Uses new engine for configs with `sourcePlatform`, falls back to legacy |
| Seed marketplace data | `node scripts/seed-marketplace.js` executed against live Firestore |
| .gitignore / .dockerignore | `sa-key.json` added, `.dockerignore` updated |
| Dockerfile | Updated to Node 26 + `src/` structure |

### Technical Debt Log
- `connections.js`: Dynamic provider badges from Firestore platforms collection (no hardcoded ticktick/notion colors)
- `integration-setup.js`: Sync type default changed to `Source_to_Dest` (was `TickTick_to_Notion`)
- `app.js`: Table headers generic (List, Sync Tag, Target DB); sort/search uses `p1Settings`/`p2Settings` paths with legacy fallback
- `archive/`: Kept for backward reference; can delete after full migration
- `index.html`: Table column headers now generic (was `ticktick.listName`/`notion.databaseId`)

### Deployment Ready
- `npm start` → `node src/index.js` (server + scheduler)
- `npm run dev` → `node --watch src/index.js`
- Dockerfile: Node 26 + `src/` + `services/` + `workflows/` (for legacy compat)
- CLI flags: `--test-connections`, `--run-sync` (works with both new and legacy configs)
- All HTTP endpoints verified (health, auth, schema, workspace, platform)
- 24 unit tests across 7 domains

### Future (Post-MVP)
| Feature | Priority | Notes |
|---|---|---|
| Conflict resolution UI | P1 | Visual diff + manual resolve option |
| Rate limiting per connector | P2 | Token bucket per platform API limits |
| Webhook triggers | P2 | Real-time sync, no polling |
| Usage quotas/billing | P2 | Monetization |
| Admin activity logs | P2 | Audit trail for enterprise |
| Search across connections | P2 | Unified search bar |
| Drag-to-match field mapping | P2 | Visual connector lines |

---

## [MILESTONES]

### Milestone M1 — Foundation ✅
- [x] Dependency audit complete
- [x] Update: firebase-admin → 14.0.0, dotenv → 17.4.2, node-cron → 4.5.0, @notionhq/client → 5.22.0
- [x] Delete /scratch/ (46 files)
- [x] Archive legacy services/ and workflows/
- [x] Create `src/` directory structure with domain-driven layout
- [x] Create `core/` (config.js, errors.js, logger.js)
- [x] Split `index.js` → `api/server.js` + routes (auth, platform, sync) + cli/test.js
- [x] *Verification:* Backend starts, health check returns 200

### Milestone M2 — Connector & Engine ✅
- [x] Create `connector/interface.js` + `registry.js` + `__template.js`
- [x] Refactor ticktick.js → Connector adapter
- [x] Refactor notion.js → Connector adapter
- [x] Create generic sync engine.js (source→dest agnostic)
- [x] Extract mapper.js + conflict.js from legacy workflow
- [x] Scheduler wired: new engine for `sourcePlatform` configs, legacy fallback
- [x] *Verification:* Connector registry returns [ticktick, notion]; server starts with scheduler

### Milestone M3 — Dynamic Integrations ✅
- [x] Dashboard SPA audit — hardcoded API URLs fixed → `window.VELYNC_CONFIG.apiBase`
- [x] Sync type enums fixed → `Source_to_Dest` / `Dest_to_Source` / `Bidirectional`
- [x] `scripts/seed-marketplace.js` created and executed → 3 platforms + 3 integrations in Firestore
- [x] Platform entity fetching API routes (/api/data-sources, /api/platform-entities, notion/ticktick endpoints)
- [x] Dynamic OAuth flow supporting per-platform clientId/clientSecret
- [x] Connection management UI (list, connect, disconnect)
- [x] *Verification:* Seed data pushed; marketplace ready for UI consumption

### Milestone M4 — Field Mapping & Scheduler ✅
- [x] `/api/schema` endpoint: auto-detect source/destination fields via connector's `getSchema()`
- [x] `/api/schema/suggest` endpoint: name+type matching suggestions (exact, partial, unmatched)
- [x] Notion connector `getSchema()` fetches live DB schema when `databaseId` is available
- [x] Field mapping UI: generic `sourceField`→`destField` (no longer hardcoded TickTick→Notion)
- [x] Source schema dynamically fetched via `fetchSourceSchema()` on panel open
- [x] Fallback presets when suggest API unavailable (backward compat)
- [x] Old class names `.map-ticktick`/`.map-notion` → `.map-source`/`.map-dest` with fallback
- [x] Mapper field normalization in legacy workflow (`ticktickField`/`notionProperty` ← `sourceField`/`destField`)
- [x] Scheduler: new engine for `sourcePlatform` configs, legacy fallback for old configs
- [x] Execution logs view (existing)
- [x] *Verification:* Backend loads all modules; all endpoints return proper auth errors

### Milestone M5 — Polish & Launch ✅
- [x] Admin panel: platform editor, marketplace editor views exist
- [x] Workspace collaborators & invites API (`/api/workspace`, `/workspace/invite`, `/workspace/join`, `/workspace/member`)
- [x] Project structure cleanup (gitignore, dockerignore, Dockerfile updated to Node 26)
- [x] Deprecated legacy runner: scheduler uses new engine by default for marketplace configs
- [x] Integration tests: 24 tests across 7 domains (errors, logger, config, registry, mapper, conflict, interface)
- [x] Dockerfile updated: Node 26, `src/` structure, `archive/` included
- [x] *Verification:* `node --test test/unit.test.js` — 24/24 passing

### Milestone M6 — Design Overhaul ✅
- [x] `:root` palette unified from Nord (#81A1C1/#88C0D0) to vibrant indigo/teal (#818CF8/#06B6D4)
- [x] Deeper background shades (bg: #0F0F1A) for improved contrast
- [x] Animated mesh gradient landing page background (multi-stop gradient + meshShift keyframes)
- [x] Missing `@keyframes card-in` animation added (was referenced but undefined)
- [x] Staggered entrance animations for landing page elements (logo, title, subtitle, feature items)
- [x] Button hover scale effects (translateY + scale(1.02)) with enhanced box-shadow
- [x] Surface card hover glow effects (border-color + box-shadow transition)
- [x] All inline HTML gradient stops updated from Nord to indigo/teal/purple
- [x] auth-callback.html palette updated to match (loader, button, background)
- [x] Stale rgba(129, 161, 193) references in CSS replaced with rgba(129, 140, 248)
- [x] *Verification:* 24/24 unit tests pass; no hardcoded Nord colors remain in HTML/CSS/JS

<div class="anchored-summary">

## Session: 2026-07-05 — Dead code removal, crash fix, mapping refresh

### Issues addressed

**Issue 1 — Removed dead legacy UI code (Notion/TickTick wizard)**
- Removed variable declarations for `fNDbId`, `fNToken`, `btnLoadTt`, `btnLoadNotion`, `notionDbSelect` from `dashboard/public/app.js`
- Removed `fetchNotionDbSchema()` and `fetchNotionDbTemplates()` function definitions and all call sites
- Removed TomSelect init block that managed the legacy Notion database selector
- Removed `btnLoadTt` and `btnLoadNotion` click event listener blocks
- Removed dead backend routes from `src/api/routes/platform.js`:
  - `GET /notion/databases`
  - `GET /ticktick/lists`
  - `POST /notion-databases`
  - `POST /notion-database-schema`
  - `POST /notion-database-templates`
- Removed unused `NotionService` and `TickTickService` imports from `platform.js`

**Issue 2 — Fixed crash in `fillForm` via `cfg.notion?.databaseId`**
- Removed the entire block in `fillForm` that read `cfg.notion?.databaseId` and called `fNDbId.appendChild()` / `notionDbSelect.addOption()`. This was dead code that would crash since `fNDbId` no longer exists.

**Issue 3 — Field mappings now refresh when dest resource `dynamic_select` changes**
- In `renderSchemaForPlatform`, the `change` event listener for `[data-schema-id]` fields now calls `loadDefaultMappingsPreset()` (with `setTimeout(0)`) when `prefix === 'p2'`, so changing a destination resource field re-triggers mapping suggestions.

### Files modified
- `dashboard/public/app.js` — primary frontend cleanup
- `src/api/routes/platform.js` — backend route cleanup

</div>

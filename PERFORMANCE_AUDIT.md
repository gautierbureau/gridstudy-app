# Performance Deep-Dive — gridstudy-app

Audit of the codebase (v2.38.0-SNAPSHOT, ~108k lines / 781 source files) covering bundle & startup,
Redux state management, the spreadsheet/ag-grid layer, visualization components (map, tree, diagrams),
and the data-fetching/notification layer. Findings are ranked by estimated user-facing impact, and all
file/line references were verified against current source.

---

## Executive summary — the five biggest wins

| # | Finding | Area | Impact |
|---|---------|------|--------|
| 1 | **Zero code-splitting**: the whole app (plotly, ag-grid, network-viewer, mathjs, all dialogs) ships in one eager bundle | Bundle | Critical — first load |
| 2 | **Spreadsheet rebuilds and fully replaces its row array** (O(nodes × equipments)) on any single-equipment update | ag-grid | High — biggest table in the app |
| 3 | **1s artificial delay on every result fetch**: `useNodeData` debounces the *initial* fetch, not just notification bursts | Fetching | High — perceived latency on every node/tab switch |
| 4 | **Whole-slice Redux subscriptions** (`spreadsheetNetwork`, `tableFilters`) cause app-wide re-render storms | Redux | High |
| 5 | **SLD/NAD diagram viewers destroyed & rebuilt** (full SVG re-parse) on unrelated reference changes (`theme`, `currentNode`, `loadingState`) | Diagrams | High |

---

## 1. Bundle size & startup (largest absolute wins)

### 1.1 No code-splitting anywhere — CRITICAL
- `src/index.jsx:22` → `src/components/app.jsx:429-443` → `src/components/study-container.jsx:8`
- There is **no `React.lazy`, no dynamic `import()`, no `Suspense`** in the entire `src/` tree. Routes,
  result tabs, the map, diagrams, spreadsheets and dozens of network-modification dialogs are all statically
  reachable from the entry point, so plotly (~1 MB), ag-grid (~1+ MB), `@powsybl/network-viewer` (multiple MB,
  includes the maplibre/deck.gl stack), `@mui/x-charts` and full mathjs all land in the initial download.
- **Fix:** introduce `React.lazy` + `Suspense` boundaries at natural seams:
  - route level (`StudyContainer` in `app.jsx`);
  - panel level: network map panel, SLD/NAD diagram content, dynamic-simulation plot (plotly),
    results tabs (ag-grid), limits chart (x-charts);
  - dialog level: the dozens of dialogs under `src/components/dialogs/network-modifications/`.
- Estimated win: **~1.5–3 MB raw (~0.6–1 MB gzip)** off the initial chunk.

### 1.2 ag-grid `AllCommunityModule` registered eagerly at app root — HIGH
- `src/components/app-wrapper.jsx:119,125` — `ModuleRegistry.registerModules([AllCommunityModule])`
  pulls every community feature (all filters, editing, CSV export, pagination…) into the entry chunk.
  The app is on ag-grid 35, which fully supports selective module registration.
- **Fix:** register only the modules actually used (`ClientSideRowModelModule`, text/number filter modules,
  `CsvExportModule`, …) and move registration into the lazily-loaded grid chunk.

### 1.3 Full mathjs via `create(all)` — HIGH
- `src/components/spreadsheet-view/columns/utils/math.ts:8-11` — `create(all)` instantiates the entire
  mathjs library (~600–700 KB raw) although only `evaluate` + a few overrides are used. Also
  `move-voltage-level-feeder-bays-dialog.tsx:51` imports `isNumber` from mathjs for a trivial check.
- **Fix:** `create()` with only the needed dependency factories (e.g. `evaluateDependencies`), replace
  `isNumber` with a local check, and consider loading this module dynamically (only needed when a
  spreadsheet formula column exists). Typical saving: 70–90 % of the mathjs payload.

### 1.4 `@powsybl/network-viewer` loaded eagerly — HIGH
- Value imports at `network-map-panel.tsx:30`, `gs-map-equipments.ts:10`,
  `network-area-diagram-content.tsx:28`, `single-line-diagram-content.tsx:29`, `position-diagram.tsx:14`.
- **Fix:** lazy-load the map panel and diagram-content components so the viewer chunk loads only when a
  map/diagram is actually opened. (Several other references are already `import type` — good.)

### 1.5 No vendor chunking in Vite config — HIGH (repeat-visit caching)
- `vite.config.ts:68-70` has only `build: { outDir: 'build' }` — no `manualChunks`/`rollupOptions`.
  Any app change busts the entire vendor payload.
- **Fix:** add `build.rollupOptions.output.manualChunks` splitting plotly, ag-grid, network-viewer, mui,
  mathjs into their own long-cached chunks.

### 1.6 Smaller bundle items
- **Plotly type imports not `import type`** (`plotly-series-chart.tsx:15-16`, `plot-config.ts:9`) — works
  today via esbuild elision, but one accidental value use silently drags the full ~1 MB plotly in
  alongside the deliberately-chosen `plotly.js-basic-dist-min`. Make them `import type`.
- **`typeface-roboto` full family** (`src/index.jsx:10`) imports every weight/style 100–900; import only
  the 3–4 weights used (or switch to `@fontsource/roboto`).
- `@mui/icons-material` barrel imports in 54 files — fine for prod tree-shaking but slows dev server;
  prefer deep imports.

Already good: `plotly.js-basic-dist-min` + factory pattern; subpath imports for `@mui/x-charts`;
no duplicate major versions of heavy libs in the lockfile.

---

## 2. Redux state management

### 2.1 `CLEAN_EQUIPMENTS` clones every equipment across every node — HIGH
- `src/redux/reducer.ts:1339-1352` — for each loaded node, rebuilds the whole
  `equipmentsByNodeId[nodeId]` map, shallow-cloning **every** equipment of the type
  (`{...eq, ...propsToClean}`), i.e. O(nodes × equipments) allocations per dispatch. Fired from
  `useSpreadsheetEquipments` effects when optional-loading params change.
- **Fix:** clone only equipments that actually carry the cleaned props, or store optional props in a
  separate side-map keyed by id so cleaning is a reference swap.

### 2.2 Notification hook subscribes to the entire `spreadsheetNetwork` slice — HIGH
- `src/components/spreadsheet-view/hooks/use-update-equipments-on-notification.ts:29,49,98` —
  selects the largest blob in the store but only uses `Object.keys(allEquipments.equipments)`
  (a static list of 18 equipment-type names). Because `allEquipments` is a dep of
  `updateEquipmentsLocal`, **every equipment update re-creates the callback and re-registers the
  websocket listener**. Bonus: a substation impact triggers `resetEquipments()` (line 45), wiping all
  equipment types for all tabs.
- **Fix:** use a module-level constant for the type keys (or a ref), removing the subscription; scope
  resets to only the impacted types.

### 2.3 `CustomAggridFilterReduxProvider` subscribes to the whole `tableFilters` slice — HIGH
- `src/components/custom-aggrid/custom-aggrid-redux-provider.tsx:58,60-65,92-95` — the context `value`
  is memoized on `getFilters`, which depends on the entire `tableFilters` object. Every column-filter
  keystroke in *any* table invalidates the context and re-renders every grid header/filter in the app.
- **Fix:** read filters via `store.getState()` inside `getFilters` (pattern already exists in
  `filter-store-selectors.ts`) so the provider doesn't subscribe, or split context per (type, tab).

### 2.4 Medium/low Redux items
- `use-spreadsheet-equipments.ts:30` selects all 18 equipment types but only branches on
  `isInitialized` — select a derived `{type: isInitialized}` map with `shallowEqual`.
- `spreadsheet-content.tsx:174` — `nodeAliases.find(...)` inside the per-node reduce is O(nodes × aliases);
  build a `Map` once.
- `reducer.ts:789-797` (`INIT_TABLE_DEFINITIONS`) — accumulator-spread reduce is O(n²); mutate the
  accumulator instead. Same file `818-824`: pre-build a `Set` of existing option uuids.
- Reselect (`createSelector`) is used only for the workspace slice; promote hot derived data
  (flattened equipment rows, built-node sets) into shared parameterized selectors so N mounted
  consumers stop redoing identical work.

Positive: `useSelector` usage across the app is otherwise disciplined (narrow primitive selections);
`serializableCheck`/`immutableCheck` are already disabled, which is correct at this data size.

---

## 3. Spreadsheet & results tables (ag-grid)

### 3.1 Full row-model rebuild + full `rowData` replacement on every equipment change — HIGH
- `src/components/spreadsheet-view/spreadsheet/spreadsheet-content/spreadsheet-content.tsx:169-197` —
  `transformedRowData` reduces over every node's every equipment (object spread per equipment) and the
  effect then does `api.setGridOption('rowData', transformedRowData)`. A single-equipment notification
  rebuilds and swaps the entire dataset of the app's largest table.
- **Fix:** apply `api.applyTransaction({ update/add/remove })` keyed by the existing `getRowId`, and
  narrow the selector so only the touched node/type triggers work.

### 3.2 Result tables re-sort/re-format rows on every render — HIGH
- `src/components/results/loadflow/load-flow-result.tsx:95-177` (also
  `limit-violation-result.tsx:76-99`, `state-estimation-quality-result.tsx:84-115`) —
  `renderLoadFlowResult()` is a plain function invoked in JSX each render; it re-runs `toSorted`/`sort`
  formatting even when `result` is unchanged, and fresh arrays defeat grid diffing.
- **Fix:** `useMemo` each formatted array keyed on `result`, render JSX directly.

### 3.3 Medium ag-grid items
- `spreadsheet.tsx:36-44` — column defs memo depends on the whole `currentNode` object but only uses
  `isSecurityModificationNode(currentNode)`; any node reference change rebuilds all columns and
  force-refreshes all cells. Depend on the derived boolean.
- `renderTable-ExportCsv.tsx:65-69,104-110` — `sizeColumnsToFit()` on **every** row-data update (full
  column relayout) + inline `onModelUpdated`; fit once on first data instead.
- `shortcircuit-analysis-result-table.tsx:465-497` — no `getRowId` + full `rowData` replacement on the
  potentially large all-buses table: ag-grid destroys/recreates every row node per update.
- `column-mapper.ts:92-114` — formula `valueGetter` re-parses the mathjs expression per cell; pre-compile
  once per column (`math.parse(...).compile()`) and only `.evaluate(scope)` in the getter.
- `rowindex-cell-renderer.tsx:35-48` — called as a plain function (hooks run in parent's render) and
  subscribes every visible row's index cell to `calculationSelections`; make it a real memoized
  renderer with a narrowed selector.
- `result-cell-renderers.tsx:32-48` — wrap `StatusCellRender`/`NumberCellRenderer` in `React.memo`.

Positive: the core `equipment-table.tsx` grid itself is well-optimized (module-level `getRowId`/
`defaultColDef`, memoized context, `valueCache`) — the problems are in the data/selector layers above it.

---

## 4. Visualization: map, tree, diagrams

### 4.1 SLD viewer destroyed & rebuilt on unstable deps — HIGH
- `src/components/grid-layout/cards/diagrams/singleLineDiagram/single-line-diagram-content.tsx:361-443` —
  the `useLayoutEffect` that runs `new SingleLineDiagramViewer(...)` (heavy SVG parse + DOM build) has a
  19-entry dep array including `theme` (new object on MUI re-renders), `currentNode` (reference changes on
  many unrelated store updates), `loadingState` and several handlers. Identical SVGs get fully rebuilt.
- **Fix:** gate creation on `svg`/`svgMetadata`/`diagramParams.type`; read theme colors, `currentNode.id`
  and callbacks through refs; split "create viewer" from "update interactivity".
- Same pattern in the NAD: `network-area-diagram-content.tsx:470-506` rebuilds
  `new NetworkAreaDiagramViewer(...)` whenever `loadingState` flips, i.e. on every fetch cycle.

### 4.2 Every tree node re-renders on any selection — HIGH
- `src/components/graph/nodes/network-modification-node.tsx:95-99,158-189` — each node selects
  `state.currentTreeNode` and `state.nodeSelectionForCopy` (reference-change on every selection), is not
  `React.memo`-wrapped, and builds a fresh inline `sx` array per render. Clicking one node re-renders and
  re-styles all N nodes (each hosting a relatively expensive MUI `Tooltip`).
- **Fix:** `React.memo` the node; select derived booleans (`isSelected`) so only affected nodes re-render;
  hoist static `sx`/`componentsProps`.

### 4.3 Network map receives fresh props each render — HIGH
- `src/components/network/network-map-panel.tsx:1097-1168` — `updatedLines={[...a, ...b, ...c]}` allocates a
  new array every render and five menu/draw handlers are inline arrows, defeating the deck.gl-based
  `NetworkMap`'s prop diffing and forcing layer recomputation on unrelated parent re-renders.
  Also `getNominalVoltages()` (line 1194) — a full scan+sort of the equipment set — runs unmemoized
  during every render.
- **Fix:** `useMemo` the merged array and nominal voltages, `useCallback` the handlers, extract the
  `renderMap()/renderNominalVoltageFilter()` helpers (lines 1078-1234) into memoized child components.

### 4.4 Medium visualization items
- `network-map-panel.tsx:833-903` — the map-reload orchestration effect depends on `currentNode` (object)
  and callbacks that depend on `mapEquipments`; it can trigger redundant geo-data/equipment reload fetches.
  Compare `currentNode?.id`, split into focused effects.
- `use-nad-diagram.ts:142-185,288-290` — `fetchDiagram` depends on the whole `networkVisuParams` object and
  on `diagram.title` (only used in a log), so unrelated param-object changes re-issue the full NAD SVG POST.
- `network-modification-tree.jsx:89,307-348` + `graph/layout.ts:251-312` — tree layout
  (`compressTreePlacements`) is quadratic in node count and runs on every `treeModel` reference change;
  `defaultEdgeOptions` is a new literal each render (hoist to module constant, like `snapGrid` already is).
- `network-area-diagram-content.tsx:162-187` — hover handler fires four `setState`s per pointer event;
  coalesce into one state object and skip when the hovered id is unchanged.

Positive: `nodeTypes` is a module constant (avoids the classic xyflow trap); the main panels are
`memo`-wrapped; NAD move handlers already use `useEffectEvent`.

---

## 5. Data fetching, websockets, caching

### 5.1 `useNodeData` delays the initial fetch by 1 s — HIGH
- `src/components/use-node-data.tsx:154,185-187` — the mount/dep-change path goes through
  `debouncedUpdate` (1000 ms), so loadflow, security-analysis, dynamic-simulation, state-estimation and
  voltage-init result views all stall a fixed second before the request even leaves the browser on every
  node/tab switch.
- **Fix:** call `update()` directly for the initial/dep-change fetch; keep the debounce only for
  websocket-notification bursts.

### 5.2 Inline `resultConverter` destabilizes the fetch chain — HIGH
- `use-node-data.tsx:151` includes `resultConverter` in `update`'s deps; call sites
  (`dynamic-security-analysis-result-synthesis.tsx:57`, `dynamic-simulation-result-synthesis.tsx:57`,
  `useResultTimeSeries.ts:40`, `dynamic-margin-calculation-result-synthesis.tsx:57`) pass a new arrow
  each render → the listener re-subscribes and refetches on every parent re-render.
- **Fix:** `useCallback` the converters, or read the converter through a ref inside the hook.

### 5.3 Study bootstrap is a serial waterfall — HIGH
- `src/components/study-container.jsx:76-126,299-447` — permission check → fetchStudy → fetchRootNetworks →
  network-existence check → indexation check → loadTree run as 5+ sequential round-trips gating first paint.
- **Fix:** `Promise.all` the independent calls (permission + study; tree concurrently with indexation check).

### 5.4 Every websocket message parsed ~30× — MEDIUM
- 33 `useNotificationsListener(NotificationsUrlKeys.STUDY, ...)` registrations across 27 files, each
  independently `JSON.parse`-ing the same event (`notification-types.ts:818-820`). During build/computation
  bursts, large payloads are parsed 30+ times on the main thread (and
  `use-get-study-impacts.ts:70` + `use-update-equipments-on-notification.ts:114` double-parse the same
  impacts payload).
- **Fix:** parse once in a shared listener/context and fan out the parsed object.

### 5.5 No caching/deduplication layer — MEDIUM (systemic)
- `useVoltageLevelsListInfos` (`src/hooks/use-voltage-levels-list-infos.ts:13-22`) is fetched independently
  by ~14 dialogs — every dialog open re-downloads and re-sorts the full voltage-level list for the same
  `(study, node, rootNetwork)`. It also has **no stale-response guard/AbortController** (unlike
  `useNodeData`, which does this correctly), so rapid node switches can leave the wrong list displayed.
- More broadly, results/status/report data is refetched on every tab/node revisit with no cache.
- **Fix:** introduce a query cache (React Query / RTK Query) keyed by
  `(study, node, rootNetwork, resource)` with notification-driven invalidation; at minimum add an
  abort/request-id guard to `useVoltageLevelsListInfos`.

### 5.6 Smaller fetching items
- `network-modification-tree-pane-event-handlers.ts:108-122` — bulk node updates issue one request per
  node (N parallel `fetchNetworkModificationTreeNode`); batch or coalesce.
- `study-container.jsx:288,492` — two separate STUDY listeners in the same component each parse every event.
- `use-report-fetcher.tsx:28-64,205` — report logs walked twice (prettify + map); fold into one pass.

Positive: `useNodeData`/`useComputingStatus` already guard against stale responses via request-ids;
map geo-data loading parallelizes with `Promise.all`; the batched `useAllComputingStatusAtOnce` initial
fetch avoids duplicate status fetches.

---

## Suggested attack order

1. **Code-splitting + vendor chunks + selective ag-grid modules + mathjs slimming** (§1.1–1.5) — biggest
   absolute win, low regression risk, independent of app logic.
2. **Remove the 1 s initial-fetch debounce and stabilize `resultConverter`** (§5.1–5.2) — tiny diffs,
   immediately visible latency improvement.
3. **Fix the whole-slice subscriptions** (§2.2, §2.3, §3.3-currentNode) — small diffs that stop app-wide
   re-render storms.
4. **Spreadsheet transactions instead of full rowData swaps + `CLEAN_EQUIPMENTS` rewrite** (§3.1, §2.1) —
   the big-network scalability items.
5. **Diagram/tree/map memoization** (§4.1–4.3) — most code-touching; do with profiler verification.

# Card-Level Settings Panel — Implementation Plan

Status: **SHIPPED** (Phases 1–4 complete + test-gated). Builds on the
agency-differentiation work (params/horizon threaded into handlers) and the
existing per-source credential infra (`POST /analyst-config`,
`GET /analyst-config` catalog). See `docs/KNOWN_ISSUES.md` §9 for the current
shipped behavior — including the **single unified gear** that opens a **tabbed**
`AnalystSettingsDialog` (`[Sources]` `[Role & Instructions]` `[Weights]`).

> Note: the original plan's two-gear design (a separate source gear + a settings
> gear) and the standalone `AnalystSourceDialog.tsx` component were **removed**
> during Phase 1 — the tabbed dialog fully supersedes them. `AnalystSourceDialog`
> no longer exists in the codebase.

## 0. Goal (from user)

Clicking an analyst card opens a **settings panel** for that analyst showing ONLY
the items that can actually be adjusted for it:
  - source credentials: one or more **access tokens + their corresponding URI**
    (e.g. Alpha Vantage key + its base URI, Finnhub key + its base URI), and
  - tunable **weights** on input sources that affect the generated output
    (these are the per-analyst `params` threaded in the differentiation work:
    `signalSensitivity`, `maxLookbackDays`, `thresholds`, `maxStopLoss`,
    `baseAllocation`, ...).
If an analyst has nothing adjustable, the settings panel stays **empty** (no
weights AND no credentialed sources → no panel / disabled gear).

Everything is **saved through the interface** (server-side persist) and flows into
the next analysis run for that agency.

## 1. Current State (verified by reading the code)

- `src/server/analyst-config.ts` + `analyst-config-routes.ts`:
  - `POST /analyst-config` stores `{token, extra}` per `(session, analystId, sourceId)`
    in memory. `extra` is a `Record<string,string>` → already the right shape for a
    per-source **URI**.
  - `GET /analyst-config` → `buildSourceCatalog()` returns analysts that declare a
    LIVE+AUTH `DataSourceSpec`. This is exactly "which cards show a settings affordance".
  - `AnalystConfigStore.resolveToken(key, fallback)` already feeds the graph run
    (`generic-analyst.node.ts` → `acquireForAnalyst`).
- Frontend:
  - `AnalystSourceDialog.tsx` collects ONLY `token` (sends `extra: {}`). Needs a URI
    field. It is opened from a gear button on the `AnalystWall` panel.
  - `AnalystWall.tsx` shows the gear only for catalog analysts; clicking the panel
    body opens the **trace drill-down** (`onOpen`). So the settings affordance must
    be DISTINCT from the trace click (gear button already is).
  - `frontend/src/types.ts` has `AnalystSourceConfig` (`{analystId, sourceId, token, extra}`)
    and `AnalystSourceCatalog*` types — reusable.
- `params` (weights):
  - Defined per analyst/agency in `src/registry/agencies.ts` (technical/medium/intraday
    carry `maxLookbackDays`, `signalSensitivity`, `thresholds`; risk carries
    `maxStopLoss`/`baseAllocation`; governance carries `vetoExtreme` etc.).
  - `resolveAnalystDef` copies `ref.params` → `def.params`; `GenericAnalystNode`
    forwards `def.params` as `tuning.params` to handlers (differentiation work).
  - **No endpoint saves/loads params.** `AGENCIES` is a static module object rebuilt
    per request in `server/index.ts → getGraph(agencyId)`. To make saved weights take
    effect, the server must merge saved overrides into the agency def before building
    the graph.

## 2. Design Principles

1. **Schema-driven, not hard-coded UI.** A per-analyst **config descriptor** declares
   adjustable fields (token+URI per credentialed source, and named weight params) and
   which are *required*. The UI renders ONLY declared fields → satisfies "only required
   items; empty if nothing adjustable".
2. **Reuse existing infra.** Tokens/URIs keep using `POST /analyst-config`. We ADD a
   sibling params endpoint rather than disturb the credential contract.
3. **Save server-side, affect the run.** Weights are persisted in a new in-memory
   `AnalystParamsStore` keyed by `${session}:${agencyId}:${analystId}`, merged into the
   agency def inside `getGraph()` before `new AgencyGraph(agency)`.
4. **Defaults live in the registry.** The descriptor's defaults are read from the
   resolved `AnalystDef.params` so the UI shows current values and "reset" works.
5. **Parity-safe.** No change to handler output unless the user actually saves a
   non-default weight. Default (no saved override) → identical to today.

## 3. Config Descriptor Model

```ts
// frontend/src/components/analysts/analystConfigSchema.ts
export interface WeightField {
  kind: 'weight';
  key: string;            // e.g. 'signalSensitivity'
  label: string;
  type: 'number' | 'select';
  min?: number; max?: number; step?: number;
  options?: { value: string|number; label: string }[];
  required: boolean;      // drives "only required items"
  default: number | string;
}
export interface SourceCredField {
  kind: 'source';
  sourceId: string;       // e.g. 'alphaVantage'
  label: string;          // e.g. 'Alpha Vantage'
  auth: 'bearer'|'apikey'|'token';
  uriRequired: boolean;   // most live sources need a base URI
  uriLabel?: string;      // e.g. 'Base URI'
  uriDefault?: string;
}
export interface AnalystConfigSchema {
  analystId: AnalystId;
  weights: WeightField[];
  sources: SourceCredField[];
}
```

`buildAnalystConfigSchema(def, catalogSources)` derives the schema:
- `sources` ← catalog entries for this analyst (so a mock-only analyst has none).
- `weights` ← a STATIC allow-list of tunable `params` keys per analyst id, read with
  their current `def.params[key]` as the default. Allow-list prevents exposing
  internal-only params.

The card settings panel is shown iff `schema.weights.length + schema.sources.length > 0`.

## 4. Backend Additions

- New `src/server/analyst-params.ts`:
  - `AnalystParamsStore` (in-memory Map) keyed by `${session}:${agencyId}:${analystId}`
    → `Record<string, number|string>` (the saved weights). Mirror of
    `AnalystConfigStore` (validate, set, get, has, clear, reset).
  - `validateParams(input)` guarding numeric/allowed keys.
- New routes in `analyst-config-routes.ts` (or a new `analyst-params-routes.ts`):
  - `GET  /analyst-params?sessionId=&agencyId=` → current saved weights for the agency.
  - `POST /analyst-params` body `{ sessionId, agencyId, analystId, params }` → save.
- `server/index.ts → getGraph(agencyId)`:
  - After loading `AGENCIES[agencyId]`, deep-merge any saved `params` overrides into
    each analyst ref's `params` (per session) BEFORE `new AgencyGraph(agency)`. The
    session comes from the socket's `sessionId`. Default (no override) → unchanged.

## 5. Frontend Additions

- `analystConfigSchema.ts` (descriptor above) + `buildAnalystConfigSchema(...)`.
- Extend `AnalystSourceDialog.tsx` (or a new `AnalystSettingsDialog.tsx`) to render:
  - one block per `schema.sources`: token (password) + URI (text) fields;
  - one block per `schema.weights`: number/select input.
  - Save → `POST /analyst-config` (per source, token+URI into `extra.uri`) AND
    `POST /analyst-params` (weights). Show saved/error states.
- `AnalystWall.tsx`: keep trace-click on the body; the gear button opens the settings
  dialog (already does). Hide the gear when `schema` is empty for that analyst.
- `App.tsx`: fetch the params schema/catalog, pass schemas down to the wall; manage the
  open settings dialog state; on save, refresh so the next run uses new weights.

## 6. Phase Breakdown (test-gated; STOP between phases)

- **Phase 1 — Schema + types.** `analystConfigSchema.ts`, `WeightField`/`SourceCredField`/
  `AnalystConfigSchema`, `buildAnalystConfigSchema(def, sources)`, a STATIC tunable-params
  allow-list, and a unit test asserting: long-term technical has weights
  (`signalSensitivity` etc.), a mock-only analyst (none declared) yields empty schema.
  **STOP / verify.**
- **Phase 2 — Backend params store + routes.** `analyst-params.ts` store + validate;
  `GET/POST /analyst-params`; `getGraph()` merge; backend tests (save → get → reflected
  in resolved def; default no-op). **STOP / verify.**
- **Phase 3 — Settings UI.** `AnalystSettingsDialog` rendering sources (token+URI) +
  weights; gear button gated by non-empty schema; save wires both endpoints; frontend
  test (renders only declared fields, empty schema → no gear). **STOP / verify.**
- **Phase 4 — Run wiring + e2e.** App fetches schema/catalog, passes to wall, refreshes
  after save; a backend integration test proves a SAVED weight changes the next run's
  output for that agency. **STOP / verify.**
- **Phase 5 — Docs + cleanup.** Note the feature in KNOWN_ISSUES/ARCHITECTURE; remove the
  now-redundant single-source `AnalystSourceDialog` if fully superseded (keep if not).
  No code behavior change.

## 7. Risk / Rollback

- `getGraph` merge is additive + default-no-op → if the params endpoint is unused, runs
  are byte-identical to today (parity preserved).
- Existing `/analyst-config` token contract is UNCHANGED; we only add a `uri` into the
  existing `extra` map. Old clients (extra:{}) still work.
- Params are validated server-side (numeric range / allow-list) so a bad save can't
  crash a handler.

## 8. Verification Commands

```
npx jest --silent            # backend (expect 158 + new)
npx vitest run               # frontend (expect 92 + new)
npx vite build               # build (expect clean)
```

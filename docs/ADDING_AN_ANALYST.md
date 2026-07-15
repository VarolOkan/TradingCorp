# Adding a New Analyst

This is the canonical recipe for adding an analyst to the registry-driven pipeline.
It is accurate as of the current build (backend `src/registry/`, frontend
`frontend/src/components/analysts/`). Two implementation paths exist:

- **Declarative (recommended for new analysts):** pure-JSON logic, no LLM, no
  TS handler. You write a `logic` block (features → weights → score → verdict)
  and the `declarativeHandler` runs it. The `onchain` analyst is the
  reference example.
- **fn (legacy):** you write a TS handler function and register it in
  `src/registry/logic.ts`. Used by the 7 original analysts.

Both paths produce the SAME artifacts automatically: an `AnalystTrace` (for the
drill-down drawer) and the declared output channels on `state.messages`.

--------------------------------------------------------------------------------
## Worked example: an "Intraday Analyst" for the Intraday agency
--------------------------------------------------------------------------------

Goal: a Stage-2 analyst that scores short-horizon momentum (5m RSI + volume
spike + bid/ask spread) and is part of the `intraday` agency. We make it
**declarative** — no handler code needed.

### 1. Backend: declare the AnalystDef
Add an entry to `src/registry/analysts.ts` (`ANALYST_DEFS`):

```ts
  intraday_momentum: {
    id: 'intraday_momentum',
    kind: 'analyst',
    name: 'Intraday Momentum',
    role: '5m RSI · volume spike · spread',
    stage: 2,
    accent: '#22d3ee',          // pick a distinct hex
    monogram: 'IM',             // two letters
    prompt: [
      'You are the Intraday Momentum analyst. You score short-horizon',
      'tradeability from 5-minute RSI, a volume spike ratio, and the',
      'bid/ask spread. Your verdict is a weighted formula — no LLM.',
    ].join('\n'),
    dependsOn: ['data_ingestion'],
    dataSources: [{
      from: 'data_ingestion',
      fields: ['price_5m', 'volume_5m', 'spread'],
      label: 'Intraday market data',
      sources: ['Yahoo Finance (mock)'],
    }],
    features: [
      { key: 'rsi_5m',  label: '5m RSI',          source: 'dataSources.0', aggregation: 'last' },
      { key: 'vol_spike', label: 'Volume spike', source: 'dataSources.0', aggregation: 'last' },
      { key: 'spread',  label: 'Bid/ask spread', source: 'dataSources.0', aggregation: 'last' },
    ],
    logic: {
      mode: 'declarative',
      weighting: [
        { label: '5m RSI',         inputs: ['rsi_5m'],  weight: 0.5, rationale: 'momentum' },
        { label: 'Volume spike',    inputs: ['vol_spike'], weight: 0.3, rationale: 'participation' },
        { label: 'Tight spread',    inputs: ['spread'],   weight: 0.2, rationale: 'executability', invert: true },
      ],
      score: { from: 'weightedSum', range: [0, 100], round: true },
      verdict: {
        from: 'score',
        mapping: [
          { if: '>=', value: 60, then: 'BULLISH' },
          { if: '<',  value: 40, then: 'BEARISH' },
        ],
        default: 'NEUTRAL',
      },
      summaryTemplate: 'Intraday momentum {score}/100 → {verdict}',
    },
    output: { channels: ['intraday_momentum_analysis'] },
    tasks: ['Reading 5m RSI', 'Measuring volume spike', 'Checking spread'],
    mock: {
      generator: 'seeded', seedFrom: 'ticker',
      ranges: { rsi_5m: [20, 80], vol_spike: [0.5, 4.0], spread: [0.01, 0.5] },
      flags: [],
    },
  },
```

> **PITFALL — mock ranges MUST be keyed by FEATURE, not by `score`.**
> The declarative handler looks up `mock.ranges[feat.key]` for each feature.
> If you only declare `score:[..]`, every feature falls back to `0`, the
> weighted sum is `0`, and the score clamps to the range minimum. Always
> declare one range per feature key (`rsi_5m`, `vol_spike`, `spread`, …).
> See `src/registry/logic/declarative.ts` `resolveFeatureValues`.

> **PITFALL — `summaryTemplate` echo bug.** The handler computes a real
> `summary` per ticker and the trace's `output.summary` uses it
> (`first?.summary ?? logic.summaryTemplate`). Do NOT set
> `output.summary: logic.summaryTemplate` — that shows the raw
> `"{score}/100 → {verdict}"` placeholders in the drawer.

### 2. Backend: add it to an agency
Edit `src/registry/agencies.ts`. Append the id to the agency's `analysts`
array. For the `intraday` agency:

```ts
  intraday: {
    id: 'intraday',
    name: 'Intraday',
    description: 'Short-horizon tuning + intraday momentum analyst.',
    horizon: 'INTRADAY',
    analysts: [
      { id: 'orchestrator' },
      { id: 'data_ingestion' },
      { id: 'fundamental', params: { horizon: 'INTRADAY' } },
      { id: 'technical',   params: { horizon: 'INTRADAY', lookbackBars: 5, rsiThreshold: 55 } },
      { id: 'sentiment',   params: { horizon: 'INTRADAY', sourceMix: 'social-heavy' } },
      { id: 'intraday_momentum' },   // ← new
      { id: 'risk',        params: { horizon: 'INTRADAY' } },
      { id: 'governance' },
    ],
  },
```

If you add a brand-new agency instead, add a whole `AGENCIES` entry and
bump the `should have exactly N agencies` assertion in
`src/tests/registry.test.ts`.

### 3. Backend: bump the registry test counts
`src/tests/registry.test.ts` asserts **hardcoded** counts:
- `exactly 8 analysts` (the `ANALYST_DEF_IDS` length check) → bump to **9**
  and add `'intraday_momentum'` to the expected-id array.
- If you touched an agency's analyst list, re-check its order/integrity
  assertions (`validateDefaultAgencyIntegrity`, `validateIntradayOverrides`, …).
- `validateAllAnalysts()` / `validateAllAgencies()` must still return `[]`.

Run `npx jest --silent` and confirm green before touching the frontend.

### 4. Frontend: mirror the metadata
Edit `frontend/src/components/analysts/analysts.ts`:
- Add `'intraday_momentum'` to the `AnalystId` union.
- Add an `AnalystMeta` entry (id/name/role/accent/monogram/stage/tasks).
  The `accent` and `monogram` should match the backend def.

> **CRITICAL SYNC RULE.** The frontend `analysts.ts` mirror and the frontend
> agency mirror (`agencies.ts`) MUST stay consistent with EACH OTHER, and
> the frontend agency `analysts` arrays should reflect what the backend agency
> actually runs. If the backend `intraday` agency lists 8 analysts, the
> frontend `intraday` agency mirror should list the same 8 (so the wall
> shows 8 cards when that agency is selected). The `analysts.test.ts`
> "defines the N pipeline analysts in order" assertion must match the
> `ANALYSTS` array. **Keep the frontend agency mirrors and the backend
> `AGENCIES` in lockstep** — they are edited by hand and drift easily.

### 5. Frontend: add it to the agency mirror
Edit `frontend/src/components/analysts/agencies.ts`. Append
`'intraday_momentum'` to the `intraday` agency's `analysts` array (in the
same pipeline position as the backend). This is what makes the wall render the
new card when the user picks the Intraday agency.

### 6. Verify
- Backend: `npx jest --silent` → green (analyst count + agency integrity).
- Frontend: `npm run test:ui` → green. Add/adjust a test that selects the
  `intraday` agency and asserts the wall now has the new panel count and the
  "Intraday Momentum" card is present.
- Build: `npx vite build` (NOT bare `tsc` — the frontend tsconfig has a
  `rootDir` quirk that pulls backend files and reports noise; Vite/esbuild is
  what the browser runs). Green build = success.
- Optional live check: `npx tsx src/server/index.ts` (single runtime graph, no
  flag needed), then a socket client emitting `request_analysis` with
  `{ tickers:['AAPL'], agencyId:'intraday' }`, and confirm the
  `analysis_complete` payload's `analystTraces` includes
  `intraday_momentum` with a non-zero `score` and a rendered `summary`.

--------------------------------------------------------------------------------
## The fn path (legacy analysts)
--------------------------------------------------------------------------------

Used when you need real logic (LLM call, HTTP fetch, custom math) that can't be
expressed as a weighted formula.

1. Write a handler `async (state: AgentState, node: NodeSurface) => AgentState`
   under `src/registry/logic/<name>.ts` (a pure function, NO node class).
2. Register it in `src/registry/logic.ts` as
   `yourFnKey: (s) => yourHandler(s, makeNodeSurface())` in `ANALYST_LOGIC_REGISTRY`.
3. In the `AnalystDef`, set `logic: { mode: 'fn', fn: 'yourFnKey' }`.
4. The `GenericAnalystNode` resolves `def.logic.fn` via `getLogicHandler` — so
   the data-driven `AgencyGraph` runs your handler directly. No graph-builder
   change needed. No node class, no `instances` map.
5. Still do steps 2–6 above (agency membership, test-count bumps, frontend
   mirror, build).

> **PITFALL — ONE TRACE PER ANALYST.** Whether fn or declarative, your
> handler must append exactly ONE `AnalystTrace` to `state.analystTraces`
> (inputs array spans all tickers). Pushing a trace per ticker breaks the
> trace-count assertions (e.g. a screener test expecting 1 trace got 2).
> Aggregate across tickers into a single trace.

--------------------------------------------------------------------------------
## Adding an Options Analyst
--------------------------------------------------------------------------------

Options analysts ride the same registry machinery as equity ones, but a few
conventions apply (see `ARCHITECTURE.md › Options agencies & data layer`).

**Instrument / agency.** Options analysts live only inside the two option
agencies (`options-swing`, `options-intraday`), whose `AgencyDef` carries
`instrument: 'OPTION'`. The `instrument` field (added to `AgencyDef` +
`AnalystTuning`) is threaded `AgencyGraph → GenericAnalystNode → handler` and
reaches your handler as `tuning.instrument`. Equity agencies leave it undefined
and run exactly as before.

**The data layer.** Every options analyst reads a deterministic `HistoricalBundle`
built by `options_ingestion` and stashed on `state.optionsData[ticker]` (fallback:
regenerate via `fetchHistoricalBundle`). Use the `runFnOptionsAnalyst(cfg, …)`
helper in `src/registry/logic/options-shared.ts` — it resolves the bundle, calls
your `compute(ticker, bundle, tuning)`, and emits one trace + completion message
with the declared channels, exactly like the equity fn path.

**The options governance veto.** If your analyst feeds the veto (e.g. you emit
`iv_percentile` / `max_loss` / `risk_level` like `options_risk`), it must write
those on `message.data.analyses[ticker].data` so `governance.ts ›
extractOptionsRisk` can read them. The owning agency's `governance` ref carries
`tuning.params.optionsVeto` (`{ maxIvPercentile, requireHedge?, noOvernight? }`),
and the veto REJECTS when IV breaches the cap, an undefined-risk structure is
unhedged (swing), or a HIGH-risk structure survives intraday's no-overnight
strictness. The equity (long-term) path is untouched when no `optionsVeto` is set.

**Steps (in addition to the worked example above):**

1. Declare the `AnalystDef` in `src/registry/analysts.ts` with `stage: 2` and a
   backend `prompt` seeded from `src/prompts/options-instructions.ts` (the §17.2
   Role & Instructions text). For a purely computed analyst use `logic.mode: 'fn'`
   + a handler in `options-handlers.ts`; for a read-only overlay use
   `logic.mode: 'declarative'`.
2. Add the id to `options-swing` and/or `options-intraday` in
   `src/registry/agencies.ts` (in pipeline order).
3. Bump `src/tests/registry.test.ts`: the "exactly 6 agencies" assertion, the
   options agency membership/params assertions, and the analyst-id array.
4. Mirror on the frontend: add the id to the `AnalystId` union + `AnalystMeta`
   in `frontend/src/components/analysts/analysts.ts`, and to the relevant
   agency's `analysts` array in `frontend/src/components/analysts/agencies.ts`.
   Keep `frontend/src/test/agency-mirror.test.ts` green (it fails if the
   backend/frontend registries drift).
5. Verify: `npx jest --silent` (backend), `npm run test:ui` (frontend), and
   `npx vite build`. Optional live check: a socket client emitting
   `request_analysis` with `{ tickers:['AAPL'], agencyId:'options-swing' }`
   should return `analysis_complete` with your analyst present in
   `analystTraces` and a populated `final_decision`.

### Phase F — give the options analyst flavors + (optional) an LLM step
1. **Ship flavors** on the `AnalystDef`: add a `flavors: AnalystFlavor[]` array
   (≥1, exactly one `isDefault: true`). Each flavor is
   `{ id, name, role, instructions, isDefault? }`; `instructions` is the Role &
   Instructions the LLM/analyst runs under. `buildAnalystConfigSchema` +
   `AnalystSettingsDialog` auto-expose a flavor dropdown when `flavors.length > 0`.
2. **LLM step (opt-in)**: add `logic.llm: { enabled: boolean }` to the
   `LogicSpec`. `enabled: false` is the **parity default** — the LLM step never
   fires and the analyzer runs byte-for-byte as before. Set `enabled: true`
   only for analysts that should "let the LLM do the work" (Phase G /
   per-agency model config). With no provider key the step degrades to a
   deterministic fallback, so it never breaks the run.
3. Verify the flavor flow: `GET /analyst-flavors` returns the shipped set;
   `POST /analyst-flavors` (full replace) is rejected if it deletes the last
   flavor. `src/tests/analyst-flavors.test.ts` covers the store, routes,
   `mergeFlavors` prompt override, and the parity-safe LLM fallback.

--------------------------------------------------------------------------------
## New-analyst checklist
--------------------------------------------------------------------------------

- [ ] Backend `AnalystDef` added to `src/registry/analysts.ts`
- [ ] `mock.ranges` keyed by FEATURE (not `score`)
- [ ] Added to the right agency in `src/registry/agencies.ts`
- [ ] `src/tests/registry.test.ts` count assertions bumped (analyst count,
      expected-id array, agency integrity) — `npx jest` green
- [ ] Frontend `AnalystId` union + `AnalystMeta` in `analysts.ts`
- [ ] Frontend agency mirror `agencies.ts` updated to match backend agency
- [ ] Frontend test added/adjusted (wall panel count + new card present)
- [ ] `npm run test:ui` green, `npx vite build` green (639 modules)
- [ ] (Optional) live `GRAPH_MODE=agency` socket check shows the new trace

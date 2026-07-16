# Agency / Analyst Re-Architecture — Implementation Plan

Status: **IMPLEMENTED.** This document was the contract for the re-architecture;
all phases shipped and are verified by the test suite (backend Jest + frontend
Vitest, both green). The single remaining cleanup — removing the per-analyst
`*.node.ts` shim classes and the legacy hardcoded graph — is **also done**:
every analyst is now a single `AnalystDef` (`src/registry/analysts.ts`) + a
handler in `src/registry/logic/*.ts`, run by the one generic
`GenericAnalystNode`. There are no per-analyst node classes and a single runtime
graph (`AgencyGraph` built from the registry; `buildLegacyGraph()` returns the
`long-term` agency). See `ARCHITECTURE.md` for the as-built picture.

---

## 1. Goal & principles

*Before* the cleanup, the pipeline had **7 hardcoded `BaseNode` subclasses** in
`src/nodes/*` and a **hardcoded graph** in `src/orchestration/financial-graph.ts`
that wired them in a fixed order. Adding a new analyst meant: a new class, a new
edge, new trace code, new frontend `AnalystMeta`, new prompt entry. High friction.

That has now been resolved (this doc's contract is fully implemented):

1. **An analyst is data.** Its identity, role, visuals, prompt, data sources,
   features, weighting, and output shape are declared in an `AnalystDef`
   (`src/registry/analysts.ts`).
2. **A generic TS node runs any analyst spec.** `GenericAnalystNode` provides the
   same `process()` contract, same `emitProgress`, same `captureTrace` (via
   `makeNodeSurface()`), so the `analysis_complete` payload and the wall/drawer are
   unchanged.
3. **Logic lives in two places:**
   - **Declarative** for analysts that are "feature → weight → score → verdict"
     (fully expressible in JSON; ideal for new agencies like intraday).
   - **Function-key** (`fn`) for analysts whose scoring is not a clean formula
     (governance veto, orchestrator routing, data ingestion). The `AnalystDef`
     names the function key; the code is a registered TS handler in
     `src/registry/logic/*.ts`. This is how the original analysts keep
     byte-for-byte parity — their old node methods are now handlers.
4. **An agency is a named set of analysts** (ordered) that builds the graph. We ship
   three: `long-term` (the default, 1:1 with the retired hardcoded graph),
   `medium-term` (1–3 month), `intraday`. The UI has an **agency dropdown**.
5. **One runtime graph.** The legacy hardcoded graph is retired; `AgencyGraph`
   (built from the registry) is the only path. `parity.test.ts` now asserts the
   `long-term` agency is well-formed + deterministic.
6. **Equity agencies are now behaviorally distinct.** Beyond dropdown label +
   wall-card count, an `AnalystTuning { horizon, params }` is threaded
   `AgencyGraph → GenericAnalystNode → handler`, so `technical`/`sentiment`/`risk`
   bias output by horizon (intraday hottest, medium mild) and `governance` applies
   a real horizon-dependent preservation veto (intraday strictest). `long-term`
   (no tuning) stays byte-identical to the legacy path. See
   `docs/HISTORY.md`.

---

## 2. Current architecture (ground truth)

| Piece | Location | Role |
|-------|----------|------|
| `AgentState` | `src/types/financial-analysis.ts` | graph state; has `analystTraces?`, `runtimeConfig?`, `progress?` |
| `AnalystDef` | `src/registry/analysts.ts` | declarative spec per analyst (id, kind, name, stage, prompt, dataSources, logic, …) |
| Handlers | `src/registry/logic/{orchestrator,data-ingestion,fundamental,technical,sentiment,risk,governance}.ts` | the real logic, pure `(state, node: NodeSurface) => AgentState` |
| `makeNodeSurface()` | `src/registry/logic/shared.ts` | single `NodeSurface` impl: `updateStep`, `addMessage`, `captureTrace`, `emitProgress`, `executeWithRetry` |
| Generic node | `src/nodes/generic-analyst.node.ts` | runs ANY `AnalystDef`; resolves `logic.fn` via `getLogicHandler` or runs `declarativeHandler`; no subclasses |
| Graph | `src/orchestration/financial-graph.ts` | `buildLegacyGraph()` → `new AgencyGraph(AGENCIES['long-term'])`; the legacy 7-`addNode` graph is retired |
| Prompts | `src/prompts/analyst-instructions.ts` | `ANALYST_INSTRUCTIONS: Record<AnalystPromptId, {id,name,instructions}>`; `instructionFor(id)` |
| Server | `src/server/index.ts` | `request_analysis` → builds `initialState` w/ progress reporter → `graph.execute(state)` |
| Frontend analysts | `frontend/src/components/analysts/analysts.ts` | `ANALYSTS: AnalystMeta[]`, `AnalystId` union, `analystById()` |
| Frontend hooks | `useAnalysis.ts` (start/complete/error + traces), `useAnalystRun.ts` (analyst_start/done → wall) | |
| Frontend view | `AnalysisView.tsx`, `AgencySelect.tsx`, `AnalystWall.tsx`, `AnalystTraceDrawer.tsx` | agency dropdown + wall + 4-tab drill-down, data-driven off `analystTraces` |

**Key invariant to preserve:** `normalizeResult()` and the `analysis_complete`
payload shape (`decision/confidence/reasoning/preservation_rationale/conditions/
tickers/.../analystTraces`) must be IDENTICAL whether the graph was built the old
way or the new way. That is what makes the migration safe.

---

## 3. Target architecture (as built)

```
src/
  types/
    financial-analysis.ts        # AgentState, InvestmentDecision, AnalystTrace, AnalystId
  registry/
    analysts.ts                 # ANALYST_DEFS: Record<analystId, AnalystDef>  (the JSON/TS specs)
    agencies.ts                 # AGENCY_DEFS: Record<agencyId, AgencyDef>
    prompts.ts                  # ANALYST_PROMPTS: Record<analystId, string>
    logic/
      logic.ts                 # ANALYST_LOGIC_REGISTRY: fnKey -> (s)=>handler(s, makeNodeSurface())
      shared.ts                # makeNodeSurface(), NodeSurface, stringToSeed, seededRandom
      declarative.ts           # declarativeHandler (feature -> weighting -> score -> verdict)
      orchestrator.ts          # fn:'orchestrate'
      data-ingestion.ts        # fn:'ingest'
      fundamental.ts           # fn:'fundamentalAnalysis'
      technical.ts             # fn:'technicalAnalysis'
      sentiment.ts             # fn:'sentimentAnalysis'
      risk.ts                  # fn:'riskAssessment'
      governance.ts            # fn:'governanceDecision'
  sources/
    acquire.ts                # acquireSource(source, runtimeConfig): per-source policy (§4.9)
    index.ts                  # registry of source adapters keyed by type
  nodes/
    generic-analyst.node.ts    # the ONLY node: runs ANY AnalystDef; no per-analyst subclasses
  orchestration/
    agency-graph.ts            # AgencyGraph built from an AgencyDef
    financial-graph.ts         # buildLegacyGraph() -> new AgencyGraph(AGENCIES['long-term'])
  utils/
    parse-query.ts             # parseQuery (extracted from the old OrchestratorNode)
```

Frontend:
```
frontend/src/
  components/analysts/analysts.ts   # ANALYSTS derived from AGENCY_DEFS[default] + AnalystMeta
  components/analysts/agencies.ts   # agency list + select dropdown data
  components/AnalysisForm.tsx       # AgencySelect dropdown (above ticker)
  hooks/useAnalysis.ts              # submit(tickers, sessionId, agencyId)
```
Server `request_analysis` payload gains `agencyId?` (defaults to the `default`
agency). The server resolves the `AgencyDef`, builds the graph, runs it.

---

## 4. FULL declarative `AnalystDef` schema (every option)

This is the centerpiece. All fields are optional unless marked **required**. The
generic node reads these to drive behavior, trace, and visuals.

```ts
interface AnalystDef {
  // ---- identity (required) ----
  id: string;                 // stable key, e.g. 'fundamental'. Maps to AnalystId.
                              // KEEP existing ids for parity: 'orchestrator' |
                              // 'data_ingestion' | 'fundamental' | 'technical' |
                              // 'sentiment' | 'risk' | 'governance'.
  kind: 'orchestrator' | 'ingestion' | 'analyst' | 'gatekeeper';
                              // controls generic-node control flow. (required)
  name: string;               // display name (wall header, trace). (required)
  role: string;               // one-line role under the name in the wall.
  stage: 1 | 2 | 3;         // 1=intake, 2=analysis, 3=decision. (required)

  // ---- visuals (consumed by the wall; optional, have defaults) ----
  accent?: string;            // hex, e.g. '#3b82f6' — panel border/glow.
  monogram?: string;          // 2 letters, e.g. 'FA'. Derived from name if absent.
  order?: number;             // explicit sort; else agency array index used.

  // ---- prompt / instructions (trace "Instructions" tab) ----
  prompt?: string | { text: string; key?: string };
                              // inline string, OR { key } referencing registry/prompts.ts,
                              // OR omitted to read ANALYST_PROMPTS[id]. Shown verbatim
                              // in the drawer's Instructions section.

  // ---- dependency graph (data wiring + future parallelism) ----
  dependsOn?: string[];       // analyst ids whose outputs this reads. Drives the
                              // "Data Received" trace inputs and future fan-out.

  // ---- data sources this analyst consumes (trace "Data" tab) ----
  // An analyst may reach out to MULTIPLE EXTERNAL sources to obtain the data
  // for its task. Each source is acquired independently with its own policy, so a
  // partial failure (one source down) does NOT sink the whole analyst. See §4.9.
  dataSources?: DataSourceSpec[];
                              // each: {
                              //   id?: string,            // stable key, e.g. 'yahoo'
                              //   name: string,           // display, e.g. 'Yahoo Finance'
                              //   type: 'rest'|'graphql'|'ws'|'ingestion'|'analyst',
                              //   from?: 'ingestion'|analystId,  // if fed by another node
                              //   endpoint?: string,       // URL / baseUri (omitted for {type:'ingestion'})
                              //   fields: string[],         // fields requested from this source
                              //   auth?: 'none'|'bearer'|'apikey', // how the token is attached
                              //   timeoutMs?: number,      // per-source SLA (default 4000)
                              //   retries?: number,         // local retries (default 2)
                              //   required?: boolean,       // see onError below (default false)
                              //   onError: 'fail'|'degrade'|'skip'|'fallback',
                              //                              // what to do if this source errors
                              //   fallbackSourceId?: string,// used when onError:'fallback'
                              //   label?: string,          // trace row label
                              // }
                              // Resolved at runtime into AnalystTraceInput[] (one row per
                              // SUCCESSFUL source; failed/degraded sources recorded under
                              // trace.notes + a structured `sourceStatus` map).

  // ---- what to do when ALL sources for an analyst fail (analyst-level policy) ----
  onAllSourcesFailed?: {
    action: 'fail' | 'degrade' | 'useMock';
    // 'fail'     → analyst emits an error step (current_step: '<id>_error'),
    //              graph continues to the NEXT analyst but the gatekeeper sees the gap.
    // 'degrade'  → analyst runs with whatever partial data it has (0 sources ok),
    //              marks output.notes = ['degraded: N/M sources unavailable'].
    // 'useMock'  → analyst falls back to the MockSpec generator (parity w/ today),
    //              marks output.notes = ['fallback: mock data; live sources down'].
    // DEFAULT (when omitted): governance-critical analysts (kind:'gatekeeper',
    // 'risk') → 'fail'; others → 'useMock' (so the demo never hard-stops).
  };

  // ---- declarative computed features (optional; used by declarative logic) ----
  features?: FeatureSpec[];    // each: { key, label?, source?:'dataSources.<n>'|'computed',
                              //         formula?:string, aggregation?:'avg'|'sum'|
                              //         'min'|'max'|'last', scale?:{in:[a,b],out:[c,d]} }

  // ---- logic: HOW the output is produced (required) ----
  logic: LogicSpec;           // { mode:'declarative', weighting, score, verdict, summaryTemplate }
                              //  OR { mode:'fn', fn:'<registryKey>', params? }

  // ---- where output lands + how the trace renders ----
  output?: OutputSpec;        // { channels?:string[], traceTab?:'weighting'|'data'|
                              //   'instructions'|'sources', verdictField?, scoreField?,
                              //   storeInMessages?:boolean }

  // ---- wall simulation sub-tasks (client mock run) ----
  tasks?: string[];           // e.g. ['Loading financials','Scoring moat']

  // ---- how to synthesize data when no real source exists (parity w/ today) ----
  mock?: MockSpec;            // { generator:'seeded'|'fn', seedFrom?:'ticker',
                              //   ranges?:Record<field,[min,max]>, flags?:[{if,then}] }

  notes?: string[];           // free-form trace notes.
  enabled?: boolean;          // default true; false excludes from the agency silently.
  parallelizable?: boolean;   // FUTURE hint only (today's graph is serial); ignored now.
}
```

### 4.1 `DataSourceSpec`
```ts
interface DataSourceSpec {
  from: 'ingestion' | string;   // 'ingestion' or another analyst's id
  fields: string[];              // field keys pulled from that source
  label?: string;                // human label for the trace row
  sources?: string[];            // provenance labels, e.g. ['Yahoo Finance','Finnhub (mock)']
}
```

### 4.2 `FeatureSpec`
```ts
interface FeatureSpec {
  key: string;                  // output feature key (referenced by weighting/logic)
  label?: string;
  source?: 'dataSources.0' | 'computed';  // which dataSource row, or computed
  formula?: string;             // tiny expression over resolved fields, e.g. 'roe * 100'
  aggregation?: 'avg' | 'sum' | 'min' | 'max' | 'last';  // across tickers
  scale?: { in: [number, number]; out: [number, number] };  // linear remap
}
```

### 4.3 `LogicSpec` — the two modes

**Declarative** (pure JSON, no TS code — used by new agencies like intraday):
```ts
interface DeclarativeLogic {
  mode: 'declarative';
  weighting: WeightingStepSpec[];   // ordered; rendered in the "Weighting→Output" tab
  score: {
    from: 'weightedSum';            // sum(weight*featureValue) over weighting steps
    range: [number, number];       // clamp/scale the result
    round?: boolean;
  };
  verdict: {
    from: 'score' | 'field';
    mapping: Array<                    // first match wins
      { if: '>=' | '>' | '<=' | '<' | '==' | '!='; value: number | string;
        then: string }                // e.g. { if:'>=', value:75, then:'BULLISH' }
    >;
    default?: string;
  };
  summaryTemplate?: string;           // '{name} scored {score}/100 → {verdict}'
}
```

**Function-key** (logic in TS; used by the 6 current analysts for parity):
```ts
interface FnLogic {
  mode: 'fn';
  fn: string;                       // key registered in AnalystLogicRegistry
  params?: Record<string, any>;     // passed to the handler
}
```

### 4.4 `WeightingStepSpec` (a trace weighting row)
```ts
interface WeightingStepSpec {
  label: string;                   // e.g. 'Leverage & liquidity discipline'
  inputs: string[];                // feature keys this step consumes
  weight: number;                  // 0..1 (or any scale, described by `scale`)
  rationale: string;               // plain-language why
  scale?: string;                  // e.g. '0..100 score weight' (UI hint)
}
```
> The generic node converts each `WeightingStepSpec` into an `AnalystTrace.weighting`
> entry (adding `contribution` = `weight * featureValue`), so the drawer renders
> identically to today.

### 4.5 `OutputSpec`
```ts
interface OutputSpec {
  channels?: string[];             // state keys to write the output into
  traceTab?: 'weighting' | 'data' | 'instructions' | 'sources';  // which tab is primary
  verdictField?: string;           // where verdict lives in the handler result
  scoreField?: string;             // where score lives in the handler result
  storeInMessages?: boolean;       // default true — mirror today's messages[].data behaviour
}
```

### 4.6 `MockSpec` (parity with today's seeded RNG)
```ts
interface MockSpec {
  generator: 'seeded' | 'fn';
  seedFrom?: 'ticker';             // deterministic per-ticker (matches stringToSeed)
  ranges?: Record<string, [number, number]>;  // field -> [min,max] uniform
  flags?: Array<{ if: string; then: string }>; // conditional red/green flags
}
```

### 4.7 Worked example — reusing an EXISTING analyst with new parameters

Per the confirmed decision, agencies **reuse the same 6 analysts**; they are not
given new ids. An intraday agency reuses `technical` (and the others) but passes
intraday `options` + a per-agency `params` override so the same `fn` handler
behaves differently. (The `declarative` mode below is shown for completeness — a
fully JSON-defined analyst — but intraday will ship reusing the `fn` handlers.)

```ts
{
  id: 'technical',            // REUSED id — same fn handler as long-term
  kind: 'analyst',
  name: 'Technical (Intraday)',  // label can differ per agency without a new id
  role: '5m momentum · breakout',
  stage: 2,
  accent: '#22d3ee',          // override the default accent for this agency's view
  dependsOn: ['data_ingestion'],
  dataSources: [{ from:'ingestion', fields:['price_5m','vwap','rsi_5m'],
                 label:'Intraday bars', sources:['Polygon (mock)'] }],
  // Reuse the lifted handler, but give it intraday tuning via params:
  logic: { mode:'fn', fn:'technicalAnalysis',
            params: { horizon:'INTRADAY', lookbackBars: 5, rsiThreshold: 55 } },
  output: { channels:['technical_analysis'], storeInMessages:true },
  // Declarative alternative (no TS code) — shown for reference only:
  // logic: { mode:'declarative',
  //   weighting:[ {label:'VWAP distance', inputs:['vwap_dist'], weight:0.6, ...},
  //               {label:'RSI thrust', inputs:['rsi_norm'], weight:0.4, ...} ],
  //   score:{from:'weightedSum', range:[0,100], round:true},
  //   verdict:{from:'score', mapping:[{if:'>=',value:70,then:'STRONG_BUY'}, ...], default:'HOLD'} }
  tasks: ['Reading 5m bars', 'Computing VWAP', 'Scoring breakout']
}
```
The intraday `AgencyDef` simply omits/replaces fields on the **same** analyst
ids; the `long-term` agency's copy of `technical` keeps its defaults. No new
node class, no new handler, no new frontend panel.

### 4.8 Worked example — current Fundamental analyst as `fn` (parity)
```ts
{
  id: 'fundamental',
  kind: 'analyst',
  name: 'Fundamental',
  role: 'Balance sheet · moat · valuation',
  stage: 2,
  accent: '#3b82f6',
  monogram: 'FA',
  dependsOn: ['data_ingestion'],
  dataSources: [{ from:'ingestion', fields:['fundamental_data'],
                  label:'Fundamental data ingested', sources:['Yahoo Finance','Alpha Vantage','Finnhub (mock)'] }],
  // No `features` — the fn handler owns the math (handler in
  // registry/logic/fundamental.ts). The handler returns the
  // SAME FundamentalAnalysis object + the SAME weighting steps + summary.
  logic: { mode:'fn', fn:'fundamentalAnalysis' },
  output: { channels:['fundamental_analysis'], storeInMessages:true },
  tasks: ['Loading financials','Scoring moat','Deriving fair value'],
  mock: { generator:'seeded', seedFrom:'ticker' }
}
```
The handler `fundamentalAnalysis(state, node)` returns exactly what the old
node returned, so `analysis_complete` for the `long-term` agency is **identical**
to the pre-cleanup build.

---

### 4.9 Multi-source data acquisition, corner cases & recovery

**Principle:** an analyst does not have "a data feed" — it has a **set** of external
sources (Yahoo, Alpha Vantage, Finnhub, a news API, an internal service, …). Each
source is acquired **independently** with its own `timeoutMs` / `retries` / `onError`
policy. A single source failing is a *local* event, not a pipeline failure. Only
when the **analyst-level** policy (`onAllSourcesFailed`) triggers do we escalate.

#### 4.9.1 Runtime acquisition flow (inside `GenericAnalystNode`)

```
for each dataSources[i]:
    acquired[i] = acquireWithPolicy(source)   // timeout + local retries
        on success → store fields under trace input row i (sourceStatus[i]='ok')
        on failure → apply source.onError:
            'skip'     → trace.notes.push(`${name}: skipped`)
                           sourceStatus[i]='skipped'  (analyst continues)
            'degrade'  → same as skip BUT analyst still runs on remaining data
            'fallback' → try fallbackSourceId; if that also fails → treat as 'skip'
            'fail'     → sourceStatus[i]='failed'; if source.required===true
                           → escalate immediately to analyst-level failure
after loop:
    okCount = count(sourceStatus == 'ok')
    if okCount == 0 → apply analyst.onAllSourcesFailed (fail|degrade|useMock)
    else if okCount < dataSources.length → trace.notes.push(
            `degraded: ${okCount}/${dataSources.length} sources available`)
    run logic (fn or declarative) on the merged acquired data
```

Auth/token handling: the source `auth` field tells the acquirer how to attach
`runtimeConfig.accessToken` (bearer header vs `?apikey=`). The token is **never**
logged, echoed, or written into `analystTraces` — only the source *name* and
status are. (Reuses the existing Option-B `runtimeConfig` plumbing.)

#### 4.9.2 Corner cases (exhaustive)

| # | Corner case | Detection | Default behaviour |
|---|-------------|-----------|------------------|
| 1 | Source HTTP 5xx / network reset | acquire times out / throws | local `retries` (default 2) then `onError` |
| 2 | Source HTTP 401/403 (bad/expired token) | non-retryable status | do **not** retry; `onError` immediately (auth won't fix on retry) |
| 3 | Source 429 (rate-limited) | retry-after header / status | backoff using `RetryHandler`; if still limited → `onError` |
| 4 | Source returns 200 but empty / schema-drifted payload | post-fetch validator | treat field as missing → `onError` per field |
| 5 | Source hangs past `timeoutMs` | timer | abort + treat as timeout (case 1) |
| 6 | `required:true` source fails | status flag | escalate to analyst-level **fail** regardless of other sources |
| 7 | ALL sources fail | `okCount===0` | analyst `onAllSourcesFailed` |
| 8 | Partial failure (some ok) | `okCount < len` | `degraded` note; analyst runs on partial data |
| 9 | Two sources disagree on a field value | (future) cross-check | today: last-writer-wins by `dataSources` order; noted in trace |
| 10 | Token missing entirely (no `runtimeConfig`) | pre-check | sources needing auth → `onError`='skip'/'fallback'; mock-only analysts unaffected |
| 11 | Source returns stale data (older than freshness window) | `data_quality.freshness` check | flagged in trace.notes; not auto-dropped unless `required`+stale policy set |
| 12 | Analysts run in serial but one is slow | per-source + per-analyst budget | analyst timeout → `onAllSourcesFailed` path; graph moves on |
| 13 | Downstream analyst depends on a failed upstream's output | `dependsOn` resolution finds gap | dependent analyst gets partial/empty inputs → its own onError policy applies |
| 14 | WebSocket/`ws` source disconnects mid-stream | connection drop | reconnect attempts per `retries`; else `onError` |

#### 4.9.3 Recovery & user notification

Recovery is **automatic and graduated** (per the policies above) so the pipeline
rarely hard-stops. Notification to the user happens at three layers:

1. **Per-analyst trace (always):** every failed/skipped/degraded source is
   recorded in `AnalystTrace.notes` + a structured `trace.sourceStatus: Record<sourceId,
   'ok'|'skipped'|'failed'|'fallback'>`. The drawer's **Data** tab shows a
   red/striped row per unavailable source with the reason — full traceability of
   *why* an analyst's output may be thin.

2. **Run-level status events (real-time):** the generic node emits
   `analyst:done` with an added `degraded: boolean` + `sources: {ok, total }`
   field. The **Analyst Wall** shows a small warning badge (e.g. `⚠ 2/3`)
   on any panel that ran degraded, instead of silently looking healthy.

3. **Final `analysis_complete` (aggregate):** a new top-level field
   `dataHealth: { sourcesOk, sourcesTotal, degradedAnalysts: AnalystId[],
   unavailableSources: string[], usedMockFallback: boolean }`. The **ResultsPanel**
   renders a "data quality" strip: green if all sources ok, amber if any analyst
   degraded (with a "why" expander linking to the trace), red if the
   gatekeeper/risk analyst hard-failed (decision should be treated as provisional).
   If `usedMockFallback` is true, the panel shows: *"Note: N live source(s)
   were unavailable; results for those used mock data — treat as indicative."*

**User intervention points:**
- The Connect button / Settings dialog already lets the user (re)enter credentials
  (`POST /config`). If a 401/403 cascade is detected (case 2 across ≥1 sources),
  the `dataHealth` strip surfaces a **"Check API key"** hint linking to Settings.
- A hard `fail` on a `required` source still lets the graph *continue* (so other
  analysts produce output) — but the gatekeeper receives the gap and is expected to
  REJECT or condition the decision (preservation-first), which is then visible in
  the normal decision UI. No special "dead" screen.

#### 4.9.4 Schema additions for this section

```ts
// extends DataSourceSpec (see §4.1) with the policy fields already shown in
// the dataSources block above (type/endpoint/auth/timeoutMs/retries/required/
// onError/fallbackSourceId).

// AnalystTrace gains a machine-readable status map (UI renders it):
interface AnalystTrace {
  // ... existing fields ...
  sourceStatus?: Record<string, 'ok' | 'skipped' | 'failed' | 'fallback'>;
  degraded?: boolean;   // true if ran on < full source set
}

// analysis_complete gains a pipeline-wide data-health summary:
interface AnalysisResult {
  // ... existing fields ...
  dataHealth?: {
    sourcesOk: number;
    sourcesTotal: number;
    degradedAnalysts: string[];
    unavailableSources: string[];
    usedMockFallback: boolean;
  };
}

// analyst:done event gains:
emit('analyst:done', { analyst, tickers, summary, degraded: boolean,
                        sources: { ok: number; total: number } });
```

#### 4.9.5 Worked example — Fundamental analyst with 3 real sources

```ts
{
  id: 'fundamental', kind: 'analyst', name: 'Fundamental', stage: 2,
  dataSources: [
    { id:'yahoo', name:'Yahoo Finance', type:'rest',
      endpoint:'${baseUri}/v1/yahoo/fundamentals', auth:'bearer',
      fields:['balance_sheet','income','cash_flow'], timeoutMs:4000, retries:2,
      onError:'fallback', fallbackSourceId:'alpha' },
    { id:'alpha', name:'Alpha Vantage', type:'rest',
      endpoint:'${baseUri}/query?function=FUNDAMENTALS', auth:'apikey',
      fields:['ratios'], timeoutMs:4000, retries:1, onError:'skip' },
    { id:'finnhub', name:'Finnhub', type:'rest',
      endpoint:'${baseUri}/company-profile', auth:'bearer',
      fields:['market_cap','sector'], timeoutMs:3000, retries:1,
      required:false, onError:'skip' }
  ],
  onAllSourcesFailed: { action:'useMock' },  // demo never hard-stops; flags mock use
  logic: { mode:'fn', fn:'fundamentalAnalysis' },
  // ... rest of def unchanged ...
}
```
If Yahoo is down → falls back to Alpha; if Alpha also down → skipped; if Finnhub
down → skipped (not required). If all three fail → `useMock` kicks in and the trace
notes `fallback: mock data; live sources down`, with `dataHealth.usedMockFallback=true`
surfaced in the ResultsPanel.

---

## 5. `AgencyDef` schema

```ts
interface AgencyDef {
  id: string;                    // 'long-term' | 'medium-term' | 'intraday'
  name: string;                  // 'Long-Term Investment'
  description: string;
  ```ts
  interface AgencyDef {
    id: string;                    // 'long-term' | 'medium-term' | 'intraday' | <any>
    name: string;                  // 'Long-Term Investment'
    description: string;
    horizon: 'INTRADAY' | 'SHORT_TERM' | 'MEDIUM_TERM' | 'LONG_TERM';
    default?: boolean;              // EXACTLY ONE agency sets this. Confirmed: long-term.

    // ---- THE agency is defined by its NAME + the analyst nodes it uses ----
    // An agency may use ANY NUMBER of analysts (fewer or more than the
    // "default" 6), and ANY ids — including analyst ids NOT in the default
    // set (so a brand-new analyst need only exist as an AnalystDef; the agency
    // just references it). Order = graph order. Each entry is a *reference*
    // to an AnalystDef plus optional per-field overrides.
    analysts: AgencyAnalystRef[];   // see below
  }

  // A reference to one analyst within an agency. `id` MUST exist in ANALYST_DEFS
  // (the defaults). Any field you list here OVERRIDES that analyst's default
  // AnalystDef value for THIS agency only; omitted fields fall back to the
  // default AnalystDef. This is the "user can overwrite any value, else use
  // defaults" rule.
  interface AgencyAnalystRef {
    id: string;                   // AnalystDef id, e.g. 'fundamental'
    // ---- optional overrides (ALL AnalystDef fields are overridable) ----
    name?: string;                // e.g. rename 'Technical' → 'Technical (Intraday)'
    role?: string;
    accent?: string;
    stage?: 1 | 2 | 3;
    prompt?: string | { key: string };
    dependsOn?: string[];
    dataSources?: DataSourceSpec[];     // full replace of the source list
    onAllSourcesFailed?: { action: 'fail' | 'degrade' | 'useMock' };
    features?: FeatureSpec[];
    logic?: LogicSpec;             // e.g. swap to {mode:'declarative',...}
    output?: OutputSpec;
    tasks?: string[];
    mock?: MockSpec;
    params?: Record<string, any>;  // passed to the fn handler (intraday tuning)
  }
  ```

  **Merge semantics.** At graph-build time, for each `AgencyAnalystRef` the
  builder deep-merges: `resolved = { ...ANALYST_DEFS[ref.id], ...refOverrides }`.
  So the `long-term` agency can omit every override (pure defaults, 1:1 with
  today), while `intraday` overrides `params`/`options`/visuals on the *same* ids,
  and a future agency can reference a brand-new `my_custom_analyst` id that has no
  role in `long-term` at all.

  > Note: agency-wide `options` (depth/timeHorizon/riskTolerance) are now carried
  > per-analyst via overrides (or left to the default AnalystDef). There is no
  > single shared `options` block — each analyst's `params`/`logic` carries its own
  > tuning, which is what makes "overwrite any value per agency" clean.

Three shipped agencies (each is `name` + an `analysts: AgencyAnalystRef[]`
list; overrides are per-analyst overrides over the default `AnalystDef`):

- **`long-term`** (default): the full 7-node default set with **no overrides** →
  identical to today. Each analyst uses `fn` keys → byte-parity with the
  current pipeline.
  ```ts
  { id:'long-term', name:'Long-Term Investment', horizon:'LONG_TERM', default:true,
    analysts:[ {id:'orchestrator'}, {id:'data_ingestion'}, {id:'fundamental'},
               {id:'technical'}, {id:'sentiment'}, {id:'risk'}, {id:'governance'} ] }
  ```
- **`medium-term`** (1–3 months): the **same 7 nodes**, but each analyst carries
  an `options.timeHorizon: MEDIUM_TERM` override (and any threshold tweaks) — i.e.
  reuse the same 6 analysts, overwrite per-analyst values, else defaults.
  ```ts
  { id:'medium-term', name:'Medium-Term (1–3 mo)', horizon:'MEDIUM_TERM',
    analysts:[ {id:'orchestrator'}, {id:'data_ingestion'},
               {id:'fundamental', params:{timeHorizon:'MEDIUM_TERM'}},
               {id:'technical', params:{timeHorizon:'MEDIUM_TERM'}},
               {id:'sentiment', params:{timeHorizon:'MEDIUM_TERM'}},
               {id:'risk', params:{timeHorizon:'MEDIUM_TERM'}},
               {id:'governance'} ] }
  ```
- **`intraday`**: the **same 7 nodes**, but `technical` (and others) get a
  `params` override (e.g. `lookbackBars:5, rsiThreshold:55`) so the reused `fn`
  handlers behave for short horizons. Pure config reuse — no new ids, no new
  handlers. (The `declarative` mode in §4.7 is reference only; intraday ships on
  the reused `fn` handlers.)
  ```ts
  { id:'intraday', name:'Intraday', horizon:'INTRADAY',
    analysts:[ {id:'orchestrator'}, {id:'data_ingestion'},
               {id:'fundamental', params:{horizon:'INTRADAY'}},
               {id:'technical', params:{horizon:'INTRADAY', lookbackBars:5, rsiThreshold:55}},
               {id:'sentiment', params:{horizon:'INTRADAY'}},
               {id:'risk', params:{horizon:'INTRADAY'}},
               {id:'governance'} ] }
  ```

#### 5.1 Variable composition — different NODE COUNT and completely DIFFERENT nodes

The three reference agencies above reuse the same 6 analysts with overrides. The
framework ALSO supports an agency with an **arbitrary number of nodes** and a
**totally different set of analyst types**, including nodes that exist in NO other
agency. Two mechanisms make this free:

- **Open analyst ids + per-analyst overrides.** Each `AgencyAnalystRef` references
  an `AnalystDef.id` (any string in `ANALYST_DEFS`) and may override ANY
  field for THAT agency only (§5 `AgencyAnalystRef`). The `long-term` agency
  simply omits every override → pure defaults.
- **Declarative mode needs no TS handler** (§4.3). A brand-new analyst that is
  "features → weighting → score → verdict" is defined in PURE JSON — no new node
  class, no `fn` handler. Only analysts whose scoring isn't a clean formula (e.g.
  a governance veto) need a `fn` key (and even that is one registered function,
  not a graph rewrite).

So: **adding a new analyst = one `AnalystDef` (JSON) + optionally one
`registerLogic(...)` call.** The graph builder attaches a `GenericAnalystNode` per
`AgencyAnalystRef` and wires edges in array order, regardless of count or identity
— the reference 6 are just the *default* content, not a constraint.

**Example — a 4-node "crypto-screener" agency: 2 brand-new analysts + 2 reused, with overrides:**
```ts
// registry/analysts.ts — NEW ids, pure JSON, no handlers:
{ id:'onchain', kind:'analyst', name:'On-Chain Flow', role:'whale / exchange flows',
  stage:2, accent:'#f59e0b', dependsOn:['crypto_ingest'],
  dataSources:[{from:'crypto_ingest', fields:['exchange_netflow','active_addrs'],
               label:'On-chain metrics', sources:['Glassnode (mock)']}],
  logic:{ mode:'declarative',
    weighting:[{label:'Exchange outflow', inputs:['outflow'], weight:0.5, rationale:'outflow=bullish'},
               {label:'Active addresses', inputs:['active'], weight:0.5, rationale:'usage'}],
    score:{from:'weightedSum', range:[0,100], round:true},
    verdict:{from:'score', mapping:[{if:'>=',value:60,then:'BULLISH'},{if:'<',value:40,then:'BEARISH'}], default:'NEUTRAL'} } },
{ id:'crypto_ingest', kind:'ingestion', name:'Crypto Ingest', stage:1, accent:'#64748b',
  logic:{mode:'fn', fn:'ingest'} },  // reuse the lifted ingestion handler

// registry/agencies.ts — 4 nodes, mixed NEW + REUSED ids, with overrides:
{ id:'crypto-screener', name:'Crypto Screener', horizon:'SHORT_TERM',
  analysts:[
    { id:'crypto_ingest' },                       // defaults, as-is
    { id:'onchain' },                               // the new declarative analyst
    { id:'sentiment', params:{ sourceMix:'social-heavy' } },  // REUSED id, overridden param
    { id:'governance', onAllSourcesFailed:{ action:'fail' } }  // REUSED id, stricter policy
  ] }
```
This agency has **4 nodes** (not 7) and **`onchain` is a node type that does
not exist in `long-term`/`medium`/`intraday`** — proving both degrees of
freedom. The generic node runs it identically; the wall renders 4 panels; the
drawer works for `crypto-screener`'s analysts (including the new `onchain`).

---

## 6. `AnalystLogicRegistry` contract (the `fn` half of option 3)

```ts
// src/registry/logic/index.ts
export interface AnalystLogicContext {
  def: AnalystDef;
  state: AgentState;
  ticker: string;
  resolvedInputs: Record<string, any>;   // dataSources already resolved
  features: Record<string, any>;         // computed features (if any)
  rng: () => number;                     // shared seeded RNG (utils/rng.ts)
}
export interface AnalystLogicResult {
  score?: number;
  verdict?: string;
  summary: string;
  details?: Record<string, any>;         // stored under messages[].data
  weighting?: WeightingStep[];            // trace weighting (handlers may return their own)
  inputs?: AnalystTraceInput[];           // override trace inputs if needed
  notes?: string[];
}
export type AnalystLogicHandler = (ctx: AnalystLogicContext) => AnalystLogicResult;
const registry = new Map<string, AnalystLogicHandler>();
export function registerLogic(fnKey: string, h: AnalystLogicHandler) { registry.set(fnKey, h); }
export function runLogic(fnKey: string, ctx: AnalystLogicContext): AnalystLogicResult {
  const h = registry.get(fnKey); if (!h) throw new Error(`Unknown analyst fn: ${fnKey}`);
  return h(ctx);
}
```
Handlers are **lifted verbatim** from the current node methods (fundamental/technical/
sentiment/risk/governance/orchestrator/ingestion), so behaviour is preserved. New
declarative-only analysts need NO handler.

---

## 7. Functionality-preservation strategy (the "keep working" guarantee)

This is the non-negotiable part of the request.

> **Status — fully implemented (single graph).** The "dual graph builders +
> `GRAPH_MODE` fallback" described below was the *migration plan*. It has
> completed: the legacy `FinancialAnalysisGraph` is **retired** (its 7-node
> structure is reproduced 1:1 by the `long-term` agency), `GRAPH_MODE` is gone,
> and `AgencyGraph` is the only runtime. `parity.test.ts` now asserts the
> `long-term` agency is well-formed + deterministic rather than comparing two
> graphs. The RNG helpers live in `src/registry/logic/shared.ts` (not
> `utils/rng.ts`). What follows is kept as the historical design rationale.

1. **Dual graph builders.** `financial-graph.ts` keeps `FinancialAnalysisGraph`
   (legacy, 7 hardcoded nodes) AND gains `buildGraphFromAgency(agency, mode)`.
   A `GRAPH_MODE` env (`legacy` | `generic`, default `legacy` initially) selects
   which the server instantiates. Both share `AgentState`, `normalizeResult`,
   `progress` reporter, and `captureTrace` — so the emitted `analysis_complete`
   is shape-identical.

2. **Shared RNG.** `stringToSeed`/`seededRandom` move to `src/utils/rng.ts`;
   both legacy nodes and generic handlers import it. Guarantees deterministic parity.

3. **Parity test (the gate).** `src/tests/agency.parity.test.ts`:
   - For tickers `['AAPL','MSFT']`, run `request_analysis` through **legacy** and
     through **generic** (default `long-term` agency).
   - Assert `decision`, `confidence`, `preservation_rationale`, and
     `analystTraces.length` + each trace's `output.score`/`verdict` are EQUAL.
   - This must be GREEN before `GRAPH_MODE` defaults to `generic`.
   - **Parity-safety note:** the §4.9 `dataHealth` field and `trace.sourceStatus`
     are **additive** — when no real sources are configured (the default today,
     everything is `MockSpec`), the generic node emits `dataHealth={sourcesOk:0,
     sourcesTotal:0,...usedMockFallback:false}` and `sourceStatus={}` (all-analyst
     mock path), so the parity assertions on `decision/confidence/traces` are
     unaffected. Source-failure behaviour is covered by its OWN phase (2.5), not
     the legacy-parity gate.

4. **Frontend is mode-agnostic.** The wall/drawer already render off
   `analystTraces` + `ANALYSTS`. We change `ANALYSTS` to be derived from the
   selected agency's defs (with a compiled fallback), but the rendering code is
   untouched. So the UI works in both modes.

5. **Rollback.** If generic regresses in prod, flip `GRAPH_MODE=legacy` — zero
   code change, instant fallback. Legacy builder + nodes are only DELETED in the
   final phase, after generic has been the default and green for a full test pass.

---

## 8. Phased plan (test-gated; pause for verification between phases)

### Phase 0 — Schema + registry skeletons (no behavior change)
- Add the `AnalystDef` / `AgencyDef` / `*Spec` types to `src/types/financial-analysis.ts`.
- Create `src/registry/{analysts,agencies,prompts}.ts` and `src/registry/logic/*`
  with the CURRENT 6 analysts expressed as `AnalystDef`s (all using `fn` keys) and
  ONE `long-term` agency. `prompts.ts` re-exports `ANALYST_INSTRUCTIONS`.
- `src/utils/rng.ts` created (empty stubs).
- **Tests:** schema validation unit tests (every required field present; ids unique;
  agency references only known analysts; exactly one `default` agency).
- **Verify:** nothing runs differently yet; legacy graph still the only builder.

### Phase 1 — Extract static metadata; wall/drawer read from registry
- Frontend `ANALYSTS` becomes derived from `AGENCY_DEFS['long-term'].analysts`
  resolved through `ANALYST_DEFS` (compiled at build). Fallback keeps current array
  if a def is missing.
- Move prompt text into `registry/prompts.ts` (delete `analyst-instructions.ts`
  re-export or keep as shim).
- **Tests:** wall renders N panels for N analysts in the agency; trace drawer still
  opens for an analyst id present in the agency.
- **Verify:** UI identical to today, but now data-driven.

### Phase 2 — Generic node + data-driven builder (parallel, behind flag)
- `GenericAnalystNode` implemented: resolves def, runs `logic` (fn → registry;
  declarative → weighting/score/verdict), `emitProgress` start/done, `captureTrace`
  built from def (instructions from prompt, inputs from `dataSources`, weighting from
  `logic.weighting`, output from result). Writes output to `state` channels +
  `messages[].data` like today.
- `buildGraphFromAgency(agency)` wires `addNode`/`addEdge` from `agency.analysts`
  in order, attaching `GenericAnalystNode` per id. `kind` selects control flow
  (orchestrator/ingestion/gatekeeper branches).
- Server: `GRAPH_MODE` selects builder; `request_analysis` accepts `agencyId`.
- **Tests:** `agency.parity.test.ts` (legacy vs generic, default agency) — GREEN
  before proceeding. Unit tests for `GenericAnalystNode` (declarative scoring math;
  trace shape).
- **Verify:** run both modes; confirm identical `analysis_complete`.

### Phase 2.5 — Multi-source acquisition engine (§4.9)

This phase delivers the "reach out to multiple external sources" requirement and its
recovery/notification, **without** breaking the current mock-only behaviour.

- ✅ **DONE (verified: 129 backend jest + 88 frontend vitest green, vite build clean).**

- New `src/registry/sources/acquire.ts`: `acquireSource(source, runtimeConfig)`
  implementing the §4.9.1 flow — per-source `timeoutMs` (abort timer),
  local `retries` (with `RetryHandler` backoff), non-retryable 401/403 fast-fail
  (case 2), 429 backoff (case 3), post-fetch schema validator (case 4),
  and the `onError` policy (`skip`/`degrade`/`fallback`/`fail`). Auth attachment
  (bearer vs apikey) reads `runtimeConfig.accessToken`; token never logged.
- `GenericAnalystNode` calls `acquireSource` per `dataSources[]`, merges
  successes, records `trace.sourceStatus` + `trace.degraded`, and applies
  `onAllSourcesFailed` (`fail`/`degrade`/`useMock`). Emits the augmented
  `analyst:done` (`degraded`, `sources:{ok,total}`).
- `normalizeResult` adds the top-level `dataHealth` summary; `AnalysisResult` +
  `AnalystTrace` types gain the §4.9.4 fields.
- **Parity gate (key decision):** the acquisition engine only activates for
  **live** sources — `type: 'rest'|'graphql'` AND a real `endpoint`. The
  registry's existing `dataSources` are declarative mock/internal metadata
  (internal pipeline handoffs via `from`, mock feeds with no endpoint), so they
  are ignored by `isLiveSource`. This keeps the engine a complete no-op in the
  default mock-only config, so the §7 parity test stays byte-identical (green).
  To exercise the live path, an analyst must declare a `rest`/`graphql` source
  with an `endpoint` (see `acquire.test.ts` integration-style cases).
- Server `analysis_complete` ships `dataHealth`; frontend `ResultsPanel` gains a
  data-quality strip (green/amber/red) + "Check API key" hint on 401 cascade;
  `AnalystWall` gains the `⚠ n/m` degraded badge; `AnalystTraceDrawer`
  Data tab renders a red/striped row per unavailable source with the reason.
- **Default config = no real sources** (`MockSpec` only), so the engine is
  exercised in its "all mock" branch and the §7 parity test stays green.
- **Tests:** `acquire.test.ts` covering every §4.9.2 corner case with a mock
  `fetch` (timeout, 401 fast-fail, 429 backoff, empty payload, fallback
  chain, `required` escalation, partial degradation, `onAllSourcesFailed` for
  each action). Integration: an agency def with 2 real (mocked) sources where
  one is forced down asserts `dataHealth` + `sourceStatus` + the wall badge.

### Phase 3 — Lift real logic into handlers (fn keys)  ✅ DONE
- Moved `performFundamentalAnalysis` / technical / sentiment / risk / governance /
  orchestrator / ingestion logic into `registry/logic/*.ts` handlers. The per-analyst
  `*.node.ts` shim classes were **deleted** (the orchestrator logic + `parseQuery`
  were extracted to `registry/logic/orchestrator.ts` + `utils/parse-query.ts`).
- Declarative path proven with the `onchain` analyst (pure JSON, no handler).
- **Tests:** handlers produce identical objects to the original node methods
  (snapshot/diff). Parity test still green.

### Phase 4 — Add `medium-term` + `intraday` agencies (JSON only)
- `medium-term`: reuses 6 analysts, sets `options.timeHorizon: MEDIUM_TERM`, adjusts
  thresholds (or medium-term `fn` params).
- `intraday`: reuses the same 6 analysts with intraday `options` + per-analyst
  `params` overrides (proves config reuse; no new ids).
- **Also add a 4-node `crypto-screener` agency** (§5.1) with a brand-new
  `onchain` analyst defined purely declaratively — proves the framework supports a
  different node COUNT and completely DIFFERENT nodes.
- **Tests:** each agency builds a valid graph; `intraday` runs end-to-end reusing
  the `fn` handlers and emits well-formed `analysis_complete` + traces; the
  `crypto-screener` agency runs end-to-end with an all-new declarative analyst and
  its 4-panel wall + drawer works.

### Phase 5 — Frontend agency dropdown
- `frontend/src/components/analysts/agencies.ts` + `AgencySelect`.
- `AnalysisForm` gets the dropdown; `useAnalysis.submit(tickers, sessionId, agencyId)`.
- `AnalysisView` derives the wall + drawer analyst set from the **selected** agency
  (not hardcoded `long-term`). Robust when an agency has fewer analysts.
- **Tests:** selecting an agency updates the wall panel count; submit sends
  `agencyId`; trace drawer works for the selected agency's analysts.

### Phase 6 — Flip default + deprecate legacy
- `GRAPH_MODE` defaults to `generic`. Keep `legacy` builder reachable via env for
  rollback.
- Delete dead legacy node classes only after a full green pass in generic mode.
- Sync README + all `docs/*` (new sections: Agency model, declarative schema
  reference, dropdown usage). Update PHASED_DEVELOPMENT.md with Phases 8–13.
- **Tests:** full `npm test` green (backend 70+ with new parity/schema tests,
  frontend ~99+ with agency tests).

---

## 9. Risks & mitigations

| Risk | Mitigation |
|------|------------|
| Generic output diverges from legacy | `agency.parity.test.ts` gates the flip to generic; shared RNG; handlers lifted verbatim |
| LangGraph concurrent-write crash on parallel analysts | Graph stays **serial** within an agency (parity with today); `parallelizable` is a future hint only |
| Trace drawer breaks for new agencies | Drawer is keyed by `analystId` from `analystTraces`; wall/agency derived from same defs |
| Frontend hardcodes 6 analysts | Phase 1 derives `ANALYSTS` from agency defs before any logic change |
| Deleting legacy too early | Legacy builder retained behind `GRAPH_MODE` until Phase 6; one-line rollback |
| Declarative formula engine too weak for real analysts | Those analysts use `fn` keys; declarative is opt-in for new/simple ones |
| `AnalystId` union too narrow | Union widened to `string` in the generic path; existing 6 ids preserved so current traces still map |
| Source failures regress the whole run | Per-source `onError` + `onAllSourcesFailed` (§4.9); graph continues on analyst `fail`; never hard-stops unless a `required` source fails. Covered by `acquire.test.ts` (all 14 corner cases) |
| Token/auth leakage via sources | `acquireSource` attaches `runtimeConfig.accessToken` per `auth` policy and **never** logs/echoes it; only source *name*+status hit traces/events |
| New `dataHealth`/`sourceStatus` breaks legacy parity | They are additive (§7 parity-safety note); absent when no real sources configured, so legacy-parity assertions are untouched |
| UI hides degraded analysts | `AnalystWall` degraded badge + `ResultsPanel` data-quality strip + traceable red rows in the drawer (§4.9.3) make every gap user-visible |
| Downstream analyst depends on failed upstream | `dependsOn` resolution detects the gap; dependent analyst runs under its own `onError` policy (case 13) |

---

## 10. Open decisions — RESOLVED (2026-07-08)

1. **Agency id for the default:** ✅ CONFIRMED — `long-term` is the default and
   maps 1:1 to the pre-rearchitecture pipeline.
2. **Should `medium-term`/`intraday` reuse the same 6 analysts?** ✅ CONFIRMED —
   YES. Both reuse the 6 reference analysts (with `options`/per-agency `params`
   tweaks for horizon/threshold). They do **not** introduce new ids. (The
   `declarative` mode in §4.7 remains available for genuinely *new* analysts, see
   §5.1 — but the three shipped agencies stay on the reused 6.)
3. **Where do agency defs live at runtime?** ✅ CONFIRMED — server-owned. Bundled
   in `registry/` and exposed via a new `GET /agencies` so the server is the
   source of truth; the frontend dropdown reads from that endpoint.
4. **Delete legacy nodes in Phase 6, or keep them behind the flag?** ➡️ DEFAULT
   (not answered): plan uses **delete-on-green** — legacy node classes removed once
   generic is the default and the full suite is green, while `GRAPH_MODE=legacy`
   stays wired through `buildGraphFromAgency`'s legacy branch for one-line rollback
   (no dead class files, just the builder switch).
5. **Can an agency have a different node COUNT and completely DIFFERENT nodes?**
   ✅ CONFIRMED (extension) — YES. `analysts: AgencyAnalystRef[]` accepts any
   registered id (including brand-new ones) with per-analyst overrides; count is
   unrestricted (3, 6, 10, …). See §5.1.

---

## 11. Definition of done

- Adding a NEW analyst = add one `AnalystDef` (JSON) + optionally one `fn` handler.
  No new node class, no graph code, no frontend panel code.
- Adding a NEW agency = add one `AgencyDef` (JSON). Dropdown picks it up
  automatically.
- **An agency may have ANY number of nodes and ANY set of analyst types** (§5.1):
  it can reuse the 6 reference analysts, or define brand-new `declarative` analysts
  with zero TS code, or any mix. The generic node + graph builder handle arbitrary
  counts/ids without modification. A test (§8 Phase 4) proves a 4-node all-new
  agency runs end-to-end.
- `long-term` agency behaves **identically** to the pre-rearchitecture pipeline
  (proven by parity tests).
- All phases test-gated and verified before the next begins.

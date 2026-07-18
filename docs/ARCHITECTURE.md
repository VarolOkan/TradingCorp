# Architecture

The pipeline is a **directed acyclic graph (DAG)** of specialized agents
implemented with LangGraph's `StateGraph`. The shared state object
(`AgentState`, see `src/types/financial-analysis.ts`) is threaded through every
node; each node reads what it needs and returns an updated copy. The backend
graph is adapted from the open-source **TradingAgents** reference design — see
[ARCHITECTURE.md](./ARCHITECTURE.md) (this file) and the root `README.md` for the layer mapping and the
rules that apply at each stage.

## Graph topology

The analysts run **parallel-by-default after data ingestion** (fan-out → fan-in),
with a **serial fallback** for topologies that aren't safe to parallelize. The
long-term equity agency fans its five Stage-2 analysts out concurrently (so a
run takes ~max(analyst latency) instead of ~sum) and fans them back in before the
Stage-3 governance decision. Options agencies (deep, uneven-depth DAGs) fall back
to the strict serial chain. See **[Workflow & Parallel Execution](#workflow--parallel-execution)**
for the exact rules, the `parallelTopologySafe` guard, and the `parallelAnalysts`
flag. A serial chain is still correct and deterministic wherever it is used
(analysts don't depend on one another's output), so the output is identical
either way.

```
        ┌─────────────┐
        │ Orchestrator │  (entry point — parses tickers + options)
        └──────┬──────┘
               │
        ┌──────▼──────┐
        │ DataIngestion│  (Stage 1: gather fundamental/technical/sentiment/market)
        └──────┬──────┘
               │
        ┌──────▼──────┐
        │ Fundamental │  (Stage 2 analyst)
        └──────┬──────┘
               │
        ┌──────▼──────┐
        │  Technical  │  (Stage 2 analyst)
        └──────┬──────┘
               │
        ┌──────▼──────┐
        │  Sentiment  │  (Stage 2 analyst)
        └──────┬──────┘
               │
        ┌──────▼──────┐
        │    Risk     │  (Stage 2 analyst)
        └──────┬──────┘
               │
        ┌──────▼──────┐
        │  Governance │  (Stage 3: Risky/Safe debate + veto + final decision)
        │ Gatekeeper  │
        └──────┬──────┘
               │  conditional edges: continue → END, end → END
               ▼
              END  (normalized analysis_complete emitted to the client)
```

The graph is data-driven: `AgencyGraph` is built from an `AgencyDef` in
`src/registry/agencies.ts` (the `long-term` agency is the 1:1 successor of the
old hardcoded graph). `src/orchestration/financial-graph.ts` now exposes only a
thin `buildLegacyGraph()` → `new AgencyGraph(AGENCIES['long-term'])` shim; the
hardcoded 7-`addNode` graph was retired. Each analyst runs via `GenericAnalystNode`,
which resolves the `AnalystDef.logic.fn` key through `getLogicHandler`
(`src/registry/logic.ts`) to the real handler in `src/registry/logic/*.ts`.

Wiring (for the long-term agency, built from the registry):

- entry point `orchestrator`
- `orchestrator → data_ingestion → fundamental → technical → sentiment → risk → governance`
- conditional edges on `governance`: `continue → END`, `end → END`

> Note: `shouldContinue()` currently returns `'end'` for every state, so the
> conditional edge is effectively fixed. The "continue" branch exists as a hook
> for future iterative refinement loops (e.g. a Bull/Bear re-debate pass).

> The diagram above shows the **logical** node order. Under the parallel wiring,
> the five Stage-2 analysts (Fundamental → Technical → Sentiment → Risk) run as a
> **fan-out** from Data Ingestion and **fan-in** to Governance — they execute
> concurrently, not strictly left-to-right. The serial wiring follows the chain
> exactly.

## Workflow & Parallel Execution

`AgencyGraph` (`src/orchestration/agency-graph.ts`) builds the same graph two ways,
selected per `new AgencyGraph(def, { parallel })`:

- **Serial** — strict chain `entry → a0 → a1 → … → END`. Mirrors the legacy
  graph exactly, so baseline output is unchanged (parity).
- **Parallel** — analysts that don't depend on one another run concurrently after
  data ingestion (fan-out) and fan back in before the Stage-3 decision node
  (governance). Dependency edges come from `AnalystDef.dependsOn`, falling back to
  stage semantics: Stage-2 depends on ingestion, Stage-3 depends on all Stage-2.
  LangGraph runs independent branches at the same depth simultaneously, so a
  5-analyst stage runs in ~`max(latency)` instead of ~`sum(latency)`.

### The `parallelAnalysts` flag

The wiring decision is gated in two places:

1. **Caller opt-in** — `getGraph()` (in `src/server/index.ts`) reads
   `parallelAnalysts` from the active `ConnectionConfigStore` and passes
   `{ parallel }` to the graph. The default is **`true`** (`connection-config.ts →
   defaultConfig()`), so long-term runs parallel unless turned off.
2. **Topology safety** — `this.parallel = opts.parallel === true &&
   this.canRunParallel(resolved)`. Even when requested, parallel is only applied
   when `canRunParallel` returns true.

The resolved `parallel` boolean is recorded on the instance, so the
`analystTraces` payload / tests can assert which wiring was used.

### Why parallel isn't always safe (`canRunParallel` + `parallelTopologySafe`)

Two distinct hazards force a **serial fallback**:

1. **Live-source channel race.** In parallel/fan-out mode, multiple Stage-2
   analysts write shared state in the same super-step. The graph's reducer
   channels (`messages`, `analystTraces`, `investment_thesis`, …) are
   reducer-equipped so concurrent writes are safe (a `LastValue` channel would
   throw `INVALID_CONCURRENT_GRAPH_UPDATE`). The one channel *mutated* (not
   replaced) by a node is `dataHealth`, touched by analysts with **LIVE**
   dataSources (multi-source acquisition). Any LIVE source on a concurrently
   running Stage-2 analyst forces serial so the `dataHealth` aggregation can't
   race. Stage-1 (ingestion) runs *before* the fan-out and Stage-3 (governance)
   fans *in* after it, so their live sources never race the concurrent set and
   don't block parallel. Shipped long-term analysts use derived
   (`from: 'data_ingestion'`) Stage-2 sources → parallel is used.

2. **Mixed-depth fan-in re-execution.** LangGraph's Pregel scheduler
   **re-executes** a node whose predecessors complete in *different* super-steps.
   Under fan-out→fan-in, a decision node with two predecessors at *different*
   depths gets re-run, duplicating its traces and corrupting the result. To
   prevent this, `parallelTopologySafe(resolved)` computes longest-path depth from
   the entry point (single Kahn topological-order pass, **O(V+E)**) and rejects
   any topology where a node has ≥2 predecessors at **different** depths.
   - The **long-term** agency has uniform-depth leaf fan-in → **passes** → parallel.
   - The **options** agencies are a deep DAG with uneven depths (e.g.
     `options_pricing`/`options_risk` depend on `vol_surface`, which depends on
     `options_ingestion`) → **fail** → **serial fallback** (this also avoids the
     empty-decision regression that occurred when options was forced parallel).

`buildEdges()` is the single source of truth for the parallel edge set; both
`canRunParallel` (via `parallelTopologySafe`) and `wireParallel` call it, so the
safety check and the actual wiring can never diverge. The first Stage-1 node is
the entry point and deliberately gets **no incoming edge** (a self-loop there
would create a cycle and fail the topology check).

### Verifying the wiring

- `src/tests/agency-graph-parallel.test.ts` asserts long-term → parallel (5/5)
  and options → serial.
- The streaming integration test asserts the **set** of analyst ids (parity
  invariant), not their order, because parallel runs emit `analyst_done` events
  in completion order.

## Node responsibilities

Each analyst is a single `AnalystDef` (in `src/registry/analysts.ts`) + a handler
in `src/registry/logic/*.ts`, run by the generic `GenericAnalystNode`
(`src/nodes/generic-analyst.node.ts`). There are **no per-analyst node classes** —
the old `orchestrator/data-ingestion/fundamental/technical/sentiment/risk/
governance-gatekeeper` `*.node.ts` shims were deleted; their logic now lives in
the handlers below. `GenericAnalystNode` builds its `NodeSurface` from
`makeNodeSurface()` (`src/registry/logic/shared.ts`) and calls the registered fn
handler for `fn` analysts, or `declarativeHandler` for `declarative` analysts.

| Analyst | Handler file | Responsibility | TradingAgents layer |
|---------|--------------|----------------|---------------------|
| Orchestrator | `registry/logic/orchestrator.ts` | Parses the user query into tickers + options (depth, time horizon, risk tolerance). Entry point. | — |
| Data Ingestion | `registry/logic/data-ingestion.ts` | Gathers fundamental/technical/sentiment/market data. Each domain overrides its seeded block when a live source is reachable (Yahoo price/history, Alpha Vantage `OVERVIEW` fundamentals, Finnhub `company-news` sentiment) via `fetchRealFinancialData`; otherwise falls back to seeded. Reports per-domain provenance (`live`/`seeded`/`yahoo`/`finnhub`/…) in `data_quality.sources`. Wraps calls in `RetryHandler`. | Stage 1 (Information Gathering) |
| Live Quote (Phase 3) | `server/quote.ts` + `server/quote-routes.ts` | `GET /quote?symbol=` proxies **Yahoo Finance** (tokenless) for real company name + market data; surfaced in the unified `MarketDataCard` (Quote tab). Degrades to a `note` on failure. | — |
| Options Historical Layer | `registry/logic/hist.ts` | `fetchHistoricalBundle()` returns `{ price_bars, option_chain, greeks, rfr, expiries, iv_history }`. Backed by real fetchers via `fetchPriceBars` (Yahoo tokenless → `GET /history`) + `fetchOptionChain` (Massive/Polygon `api.massive.com` keyed → `GET /options-history`; on 401/403 or no key, **free CBOE delayed feed** fallback with real bid/ask/iv + greeks), wired into `options_ingestion` through `resolveLiveOptionsBundle`. Parity-safe (no key → identical seeded bundle). Greeks follow the chain's source (CBOE-provided when on CBOE; BS fallback otherwise). See KNOWN_ISSUES §11. | Stage 1 (Options) |
| Fundamental Analyst | `registry/logic/fundamental.ts` | Produces `FundamentalAnalysis` (balance sheet, ratios, moat, flags). | Stage 2 |
| Technical Analyst | `registry/logic/technical.ts` | Produces `TechnicalAnalysis` (trend, indicators, support/resistance, signals). | Stage 2 |
| Sentiment Analyst | `registry/logic/sentiment.ts` | Produces `SentimentAnalysis` (news/social/analyst/institutional sentiment). | Stage 2 |
| Risk Analyst | `registry/logic/risk.ts` | Produces `RiskAssessment` (level, factors, position sizing, stop/take profit). | Stage 2 |
| Governance Gatekeeper | `registry/logic/governance.ts` | Stage 3: Risky/Safe debate, then the final APPROVE/REJECT decision with a preservation-first veto. | Stage 3 (Trading Decision) |
| Options Ingestion | `registry/logic/options-handlers.ts` | Stage 1: builds a deterministic `HistoricalBundle` (OHLCV + expiries + per-expiry option quotes + underlying + rfr) and stashes it on `state.optionsData[ticker]`. | Options Stage 1 |
| Volatility Surface | `registry/logic/vol-surface.ts` | Builds a `VolSurface` (term + skew) from the bundle; emits `call_iv`/`put_iv` channels. | Options Stage 2 |
| Options Pricing | `registry/logic/options-handlers.ts` | Black–Scholes fair value vs market; flags `EDGE`/`THIN_EDGE`/`NO_EDGE`. | Options Stage 2 |
| Options Greeks | `registry/logic/greeks.ts` | Computes the option Greeks (delta/gamma/vega/theta/rho) from the surface. | Options Stage 2 |
| Options Flow | `registry/logic/options-handlers.ts` (declarative) | Option order-flow / OI read — declarative (no fn handler). | Options Stage 2 |
| Options Technical | `registry/logic/options-handlers.ts` (declarative) | Options-timing technical overlay — declarative (intraday agency only). | Options Stage 2 |
| Options Risk | `registry/logic/options-handlers.ts` | Produces `OptionRiskAssessment` (iv_percentile, max_loss, hedge, allocation) consumed by the governance options veto. | Options Stage 2 |

All handlers share one `NodeSurface` implementation (`makeNodeSurface()` in
`src/registry/logic/shared.ts`), which provides `addMessage`, `updateStep`,
`captureTrace`, `emitProgress`, and `executeWithRetry`.

### Stage rules (summary)

The full rule set is in
[root `README.md` phased plan, Phase 2](./README.md#frontend-rewrite--phased-plan) for the stage rules.
In brief:

- **Stage 1 (gathering):** Bull/Bear balance, neutral synthesis, separate
  news/social streams, date-stamped freshness. (Bull/Bear researchers are a
  planned enhancement; today Data Ingestion is the single collection node.)
- **Stage 2 (analysis):** each analyst returns a structured object + direction +
  confidence; no silent `null` passes; independence between analysts.
- **Stage 3 (decision):** Risky vs. Safe debate with a preservation-first
  tie-breaker; gatekeeper veto; approval conditions (≤5% size, 15–20% stop-loss,
  monitor fundamentals); every decision ships `confidence` + `reasoning` +
  `preservation_rationale`.

## State contract

`AgentState` is the currency of the graph:

```ts
interface AgentState {
  messages: Array<any>;        // running log (system/user/error + optional .data)
  current_date: string;        // YYYY-MM-DD
  tickers: string[];
  company_name: string;
  investment_thesis: string;   // built up by analysts + governance
  final_decision: string;      // APPROVE | REJECT | '' | 'ERROR: ...'
  error: string | null;
  current_step: string;        // e.g. 'orchestrator_processing', 'data_ingestion_error'
}
```

Richer per-domain result shapes (`FundamentalAnalysis`, `TechnicalAnalysis`,
`SentimentAnalysis`, `RiskAssessment`, `InvestmentDecision`) are defined in
`src/types/financial-analysis.ts` and are attached to `messages[].data` rather
than stored as top-level state fields.

On `request_analysis` the server builds an initial `AgentState` and runs the
data-driven graph (`buildLegacyGraph()` → `new AgencyGraph(AGENCIES['long-term'])`),
then emits a **normalized** `analysis_complete` payload (real
`decision`/`confidence`/`reasoning`, never `undefined`) back over the socket.

## Real-time server

`src/server/index.ts` exposes:

- `GET /health` — liveness probe
- `GET /config` — returns `config.analysis` + version
- `POST /config` — **(Phase 2)** accepts runtime `ConnectionSettings` (baseUri,
  accessToken, extra); stored in-memory per session, read at analysis time.
- `GET /analyst-config` — catalog of analysts that declare a `LIVE`+`AUTH`
  `DataSourceSpec` (drives which cards show a settings gear).
- `POST /analyst-config` — stores per-source `{token, extra}` per
  `(session, analystId, sourceId)`; `extra.uri` carries the source base URI;
  the token is never echoed back.
- `GET /analyst-params?sessionId=&agencyId=` — all saved weight overrides for an
  agency (so the UI can repopulate every card's panel at once).
- `POST /analyst-params` — stores one analyst's weight overrides
  (`signalSensitivity`/`maxLookbackDays`/`maxStopLoss`/`baseAllocation`),
  validated server-side against an allow-list + numeric range. Saved weights are
  merged into the agency def inside `getGraph()` before `new AgencyGraph(agency)`,
  so they affect the next run for that session (default = no-op, parity-safe).
- `Socket.IO` events:
  - client → server: `request_analysis` `{ tickers, options?, sessionId?, agencyId? }`
    — `agencyId` selects which `AgencyDef` to run (`long-term`, `medium-term`,
    `intraday`, `crypto-screener`, **`options-swing`**, **`options-intraday`**);
    the server builds/returns a cached `AgencyGraph` per `agencyId`.
  - server → client: `welcome`, `analysis_start`, `analyst_start`,
    `analyst_done`, `analysis_complete`, `analysis_error`

> Note: `analysis_progress` / `agent_thought` are referenced in the legacy
> `socket.ts` (now removed) but are **not** emitted by the active server
> (`src/server/index.ts`). The live stream is `analysis_start` →
> `analyst_start` / `analyst_done` (per-analyst) → `analysis_complete` (or
> `analysis_error`).

The `analysis_complete` payload is normalized and additionally carries an
`analystTraces: AnalystTrace[]` array (see below) used by the drill-down drawer.

CORS origins are configured via `SOCKET_ORIGIN` (default
`http://localhost:3000,http://localhost:3001,http://localhost:5173` — a
comma-separated list; `*` allows any). The Vite dev origin `:5173` is included
by default. When no `frontend/dist` build exists, the static-serving middleware
is a no-op rather than a crash.

## Front-end

The front-end is a **React + Vite SPA** under `frontend/` (replacing the old
Next.js pages and the vanilla `public/index.html`, both removed). In dev, Vite
proxies `/socket.io`, `/config` and `/api` to the backend on `:3001`, so the
browser only ever talks to the Vite origin. In production the backend serves the
built `frontend/dist`.

Components:
- `App.tsx` shell + `SettingsDialog` (Phase 2) + `api/configClient`. `App.tsx`
  auto-connects to the server on mount (Socket.IO internal reconnection
  disabled; a single background retry keeps trying silently). The top bar shows
  a green `🟢 Connected` / `🟡 Connecting…` chip — there is **no manual Connect
  button** (auto-connect is reliable). Next to the chip is the **`🗓 Reports`**
  button (see *Report export & viewer* below).
- `AnalysisView` composes `AnalysisForm`, `ResultsPanel`, `RelationsGraphView`
  (Phase 3–4), the **Analyst Wall** (`components/analysts/AnalystWall.tsx`)
  plus the **drill-down `AnalystTraceDrawer`**, the unified **`MarketDataCard`**
  (Phase M — one tabbed card per submitted ticker below the form: a D3
  `PriceChart` candle/volume chart on the Chart tab, plus Quote/History/Options
  tabs), and the per-analyst **`AnalystSettingsDialog`** (Phase 5, extended in Phase 8 to a
  **tabbed** `[Sources]`/`[Role & Instructions]`/`[Weights]` dialog opened by a
  single card gear). The dialog renders only what the analyst declares
  (`buildAnalystConfigSchema`); flavor saves also POST to `/analyst-flavors` and
  reload live so the drawer's Instructions tab updates immediately. Saving posts
  weights to `/analyst-params` and sends each source token + URI to
  `/analyst-config`; the next run for that agency picks the overrides up via
  `getGraph()`'s merge.
  `useAnalystRun` consumes the `analyst_start` / `analyst_done` events to drive
  the per-analyst wall state.
- `visualizations/` (Phase 4): `Visualization` base class, D3 `RelationsGraph`
  (real node/edge render), and a `registry` factory; `relationsFromResult`
  maps an `AnalysisResult` into the graph model.

### Analyst Wall & drill-down traceability

The Analyst Wall renders one panel per analyst. While a run streams, the backend
emits `analyst_start` / `analyst_done`; `useAnalystRun` updates each panel's
shimmer/progress. Once a run completes, `useAnalysis` exposes `analystTraces` and
each panel becomes clickable, opening `AnalystTraceDrawer` — a right-side slide-in
(not a modal) with four tabs (Instructions / Data Received / Weighting→Output /
Sources) and a breadcrumb (`analyst › ticker › field`) that lets you jump from any
weighting input back to its source datum.

The `AnalystTrace` model (shared, `frontend/src/types.ts` mirrors
`src/types/financial-analysis.ts`):

```ts
interface AnalystTrace {
  analyst: AnalystId;   // 'orchestrator'|'fundamental'|'technical'|'sentiment'|'risk'|'governance'
                      //  | 'options_ingestion'|'vol_surface'|'options_pricing'|'options_greeks'
                      //  | 'options_flow'|'options_technical'|'options_risk' (options agencies)
  name: string;
  instructions: string; // TradingAgents-style role prompt (src/prompts/analyst-instructions.ts)
  inputs:  { ticker: string; label?: string; data: Record<string, any>; sources: string[] }[];
  weighting: { label: string; weight: number; inputs: string[]; contribution?: number; scale?: string; rationale: string }[];
  output: { verdict?: string; score?: number; summary: string; details?: any };
  notes?: string[];
  timestamp: string;
}
```

Backend: each analyst handler calls `captureTrace(state, trace)` (the
`makeNodeSurface()` implementation in `src/registry/logic/shared.ts`); the
`analystTraces` channel is declared on the LangGraph `AgentState` so it survives
the run, and `normalizeResult` ships it on `analysis_complete`.

See the root `README.md` [phased plan](./README.md#frontend-rewrite--phased-plan) for the schedule.

## Options agencies & data layer

The options agencies (see `docs/EXTENDING_ANALYSTS.md §8` and the design in `docs/archive/OPTIONS_AND_AGENCY_EXPANSION.md`) add a
**deterministic-by-default options data layer** with **live option-chain sourcing**. The option chain is pulled live from **Massive/Polygon** (`api.massive.com`, keyed) when entitled, or the **free CBOE delayed feed** when not — with a seeded deterministic fallback used **only** when both live sources fail (or `DISABLE_MOCK_DATA` is off and no key). All randomness in the fallback is seeded from the ticker string (`stringToSeed` + `seededRandom`), so a given `(ticker, agency)` is byte-reproducible — the same parity guarantee as the equity path.

### Data layer (`src/registry/logic/`)

- **`hist.ts`** — `fetchHistoricalBundle(ticker, profile)` returns a
  `HistoricalBundle`: daily OHLCV, a set of expiries, and per-expiry option
  quotes (strike / right / bid / ask / IV / greeks / oi / volume). When a live
  chain is available it carries **real** quotes (Massive/CBOE) and feed-provided
  greeks (CBOE supplies Δ/Γ/ν/Θ/ρ directly; BS `computeGreeks` is the fallback
  for derived fields and for seeded builds). The `makeRng` wrapper normalizes
  `seededRandom` into `[0,1)` so the seeded fallback's every draw is positive.
  This is the single source of truth for every options analyst.
- **`vol-surface.ts`** — `buildVolSurface(bundle)` → `VolSurface` (term +
  moneyness skew), also emitted as `call_iv`/`put_iv` channels.
- **`greeks.ts`** — Black–Scholes `computeGreeks` (delta/gamma/vega/theta/rho)
  used by pricing + the greeks analyst.
- **`options-shared.ts`** — `runFnOptionsAnalyst(cfg, …)` runs a fn options
  analyst: resolves each ticker's `HistoricalBundle` (preferring the one
  `options_ingestion` stashed on `state.optionsData`), emits one trace + one
  completion message with the declared channels, and appends to the thesis.

### Two options agencies (`src/registry/agencies.ts`)

| Agency | `instrument` | Horizon | Nodes (in order) | Veto |
|--------|-------------|---------|------------------|------|
| `options-swing` | `OPTION` | `MEDIUM_TERM` | orchestrator, options_ingestion, vol_surface, options_pricing, options_greeks, options_flow, options_risk, governance | IV cap **90**, `requireHedge: true` |
| `options-intraday` | `OPTION` | `INTRADAY` | + options_technical (9 nodes) | IV cap **80**, `noOvernight: true` |

The `instrument` field (added to `AgencyDef` + `AnalystTuning`, optional,
defaults `EQUITY`) is threaded `AgencyGraph → GenericAnalystNode → handler` and
forwarded to each handler as `tuning.instrument`, so equity agencies run exactly
as before with `instrument` undefined.

### Options governance veto (`registry/logic/governance.ts`)

When the owning agency is `instrument: 'OPTION'` **and** `tuning.params.optionsVeto`
is supplied, governance's `performGovernanceReview` reads the upstream
`options_risk` output (off `state.messages`) and applies the gatekeeper's
last-word veto instead of the equity preservation gate:

- **REJECT** if `iv_percentile` exceeds the agency cap (90 swing / 80 intraday).
- **REJECT** if `requireHedge` is set and the structure is undefined-risk /
  unhedged (no defined `max_loss`).
- Intraday is **stricter** (`noOvernight`): also rejects `HIGH`-risk structures.
- A clean structure (IV ≤ cap, defined risk, LOW/MEDIUM) passes to the base
  decision. The equity (long-term) path is untouched when no `optionsVeto` is
  present.

The frontend keeps a **hardcoded mirror** of the backend registry
(`frontend/src/components/analysts/{agencies,analysts}.ts`) — adding a backend
analyst/agency must be mirrored there, and `agency-mirror.test.ts` (vitest)
fails if the two drift.

### Multi-flavor Role & Instructions (Phase F)

Every analyst ships one or more `AnalystFlavor`s on `AnalystDef.flavors`
(`src/types/registry.ts`). A flavor is a named Role & Instructions bundle
(`{ id, name, role, instructions, isDefault? }`). The user picks one per
analyst (stored server-side in `AnalystFlavorStore`,
`src/server/analyst-flavors.ts`); on the next run `getGraph → mergeFlavors`
(`src/server/index.ts`) overrides the resolved `AnalystDef.prompt` (and `role`)
with the selected flavor's `instructions` and tags `def.flavorId`.

- **REST**: `GET /analyst-flavors` returns the resolved set (shipped defaults
  overlaid with any user override); `POST /analyst-flavors` does a full replace
  of the user's flavor set + selection. The store refuses to delete the last
  remaining flavor (≥1 rule).
- **Trace**: the selected `flavorId` (and, when the LLM step runs, the `llm`
  result) is attached to the analyst's `AnalystTrace` so the drill-down drawer
  shows which Role & Instructions drove the run.
- **LLM step** (`src/registry/logic/llm.ts`, wired in
  `src/nodes/generic-analyst.node.ts` step 1.5): when `logic.llm.enabled` is
  true AND a flavor is selected, the node calls the LLM with the selected
  flavor's instructions as the system prompt and a summary of the just-computed
  output as the user message. The client is OpenAI-compatible (env
  `OPENAI_API_KEY`/`OPENAI_BASE_URL`/`OPENAI_MODEL`); **with no key it degrades
  to a deterministic fallback** (neutral verdict, instructions echoed) so the
  pipeline still completes with the same shape — parity preserved.
- **Long-term parity guard**: the equity (long-term) agency and all seeded
  options analysts ship `logic.llm.enabled: false`, so the LLM step never fires
  unless an analyst is explicitly enabled (Phase G / per-agency model config).

### LLM provider/model configuration (Phase G, §12)
Three preconfigured **model roles** ship empty-token
(`src/server/llm-config.ts`): `deep-thought`, `scanner`, `flexible` — all
default to OpenRouter / `anthropic/claude-opus-4-8`. Each role is an
independent provider/baseUrl/model/token slot (so a user can point
`deep-thought` at Opus while `scanner` uses a fast model).

- **REST**: `GET /llm-config` returns the public configs (token → `hasToken`,
  never echoed) plus the resolved `agencyModelRole`; `POST /llm-config` does a
  full replace of the three role configs (plus an optional per-agency default
  role via `agencyId`/`agencyModelRole`); `GET /llm-config/status` returns a
  per-role `{ provider, model, configured }` summary.
- **Resolution** (`resolveModelRole`): `flavor.modelRole` → agency override →
  `AnalystDef.modelRole` (def default) → `deep-thought`. "Assign a model to an
  agency" therefore makes every flavor in that agency inherit it unless the
  flavor sets its own.
- **Wiring**: `getGraph → mergeFlavors` injects the resolved `modelRole` into
  each analyst ref; `generic-analyst.node.ts` step 1.5 calls
  `runAnalystLLM({ role: def.modelRole })` which resolves the
  provider/baseUrl/model/token from the `LlmConfigStore` by role. No token →
  deterministic fallback (parity preserved).
- **Frontend**: `SettingsDialog` is now tabbed — *Connection* (backend URI) and
  *LLM Models* (three role rows + per-agency default dropdown). Tokens render as
  password inputs and as `configured`/`not configured` chips only.

## Report export & viewer

After a run, `ResultsPanel` exposes a **"View"** action that POSTs the current
`result` to `POST /reports` and renders the three on-disk formats (**PDF**,
**Markdown**, **HTML** slide deck) so the user can review/present the retrieved +
calculated data later without re-running. The report is a **pure transform** of
the `analysis_complete` payload (`buildReportModel` → `renderMarkdown` /
`renderHtml` / `renderPdf` in `src/server/report.ts`); all three render from the
same `ReportModel`, so they never diverge.

### On-disk layout & filename

Reports are written under `reports/` organized by **user → date**, with **all
three formats for a run sharing one date dir** (no per-format subdirs):

```
reports/
  <userId>/                       # tenant dir; today always 'default'
    <YYYY-MM-DD>/
      report-<Agency>-<Ticker>-<HH-MM-SS>.<ext>   # ext ∈ {md, html, pdf, json}
```

A fourth sibling — **`report-<id>.json`** — is the **raw-data dump**
(the root `README.md` phased table, Phase 11.1): it persists all data collected by the ingestion
analysts (`state.ingested` for equity, `state.optionsData` for options) plus a
per-analyst `dataReceived` annotation (which ticker/domain/interval/source/asOf
each analyst consumed). It enables traceability and a future per-analyst UI
re-view, and is a valid replay seed (mock data is deterministic per
ticker+profile). The JSON is a pure transform of the same payload, so the
pdf/md/html outputs are unchanged.

- `userId` is the session tenant (`default` today; structure is multi-tenant
  ready).
- The filename carries the **agency id** (e.g. `long-term`), the **first
  ticker** of the run, and the **time** (`HH-MM-SS`). Multi-ticker runs are still
  saved in full; the name shows the first ticker.
- Listing is by day (`GET /reports` → `{ byDay: { 'YYYY-MM-DD': ReportSummary[] } }`)
  where each summary carries `id`, `agencyId`, `tickers`, `companyName`,
  `generatedAt`, and per-format `files` paths.

### Viewing (not downloading) + the Reports calendar

The `GET /reports/:id?format=pdf|md|html&inline=1` route serves the file **inline**
(`Content-Disposition: inline`) so the browser displays it in a new tab instead of
downloading. The top-bar **`🗓 Reports`** button (`ReportsCalendar.tsx`) opens a
custom dark **calendar popover**:

- Days that have saved reports are **highlighted + clickable**; selecting a day
  lists that day's runs (`agency` • `ticker` • `time`).
- Clicking a run opens a **modal that renders the Markdown report properly** via
  `react-markdown` + `remark-gfm` (`ReportModal.tsx`) — headers, tables, bold,
  etc., not raw text. A **"Open full deck ↗"** link opens the server-rendered
  HTML deck in a new tab.

The viewer pulls raw markdown with `fetchReportMarkdown(id)` (served inline at
`?format=md&inline=1`); the HTML deck is linked via `reportHtmlUrl(id)`.

### Endpoints (`src/server/report-routes.ts`)

- `POST /reports` — body `{ result, meta? }`; builds the model, writes
  `md`/`html`/`pdf` into the date dir, returns `{ id, day, files, meta }`.
  PDF is best-effort: if `pdfkit` is unavailable it is skipped (`pdf: null`).
- `GET /reports` — list grouped by day (`byDay`), newest first.
- `GET /reports/:id` — `?format=pdf|md|html` (default `pdf` if present else `md`);
  `?inline=1` serves inline (browser view) instead of `attachment` (download).

Registered in `src/server/index.ts` via `registerReportRoutes(this.app)`.

> The two pre-implementation specs for this feature
> (`docs/phase-c-report-export.md`, `docs/REPORT_EXPORT_IMPLEMENTATION.md`) are
> now superseded by the shipped code above and have been removed; this section is
> the current contract.



## Multi-Source Data Architecture (vendor-agnostic fan-in)

Status: P0–P4 SHIPPED + tested (refreshed 2026-07-18). The detailed design notes
below were consolidated here from the retired `MULTI_SOURCE_ARCHITECTURE.md`.

Goal: stop hard-coding *which provider* each analyst calls. Instead, let each
data **domain** (e.g. `news_sentiment`, `option_chain`) be served by one-or-many
pluggable **sources** in different layouts, and let an analyst **weigh all
candidate sources** instead of trusting a single one. This kills vendor lock-in
and widens the evidence base (Sentiment reads Yahoo + Finnhub; Options reads
Massive/Polygon + CBOE; Fundamentals reads Alpha Vantage + a second provider).

### Hard-wiring audit (what the code did before the rework)

Every provider call was a bespoke function with the endpoint URL + provider-
specific parse inlined at the call site, bypassing the `acquire()` engine.

| Data needed by analyst        | Old call site (hard-wired)                                  | Endpoint (inlined)                                  | Fallback (old)                          |
|-------------------------------|-------------------------------------------------------------|-----------------------------------------------------|-----------------------------------------|
| Price bars (technical/options)| `hist.fetchPriceBars` `src/registry/logic/hist.ts`          | `YAHOO_CHART(...)` (Yahoo chart API)                | deterministic mock (`source:'mock'`)    |
| Option chain (options/greeks) | `resolveLiveOptionsBundle` → `acquireOptionChain` (`adapters/option-chain.ts`) | `api.massive.com/v3/snapshot/options/{ticker}` | `fetchCboeOptionChain` (CDN, keyless), then mock |
| Fundamentals (fundamental)    | `fetchRealFinancialData` → `fetchAlphaVantageOverview` (`adapters/alphavantage-fundamentals.ts`) | `alphavantage.co/query?function=OVERVIEW` | seeded random balance sheet |
| News/sentiment (sentiment)    | `news.fetchCompanyNews` `src/registry/logic/news.ts`        | Finnhub `finnhub.io/api/v1/company-news`            | Yahoo → Google News RSS → synthetic mock (already fan-in!) |
| Risk-free rate (options)      | Treasury feed (keyless)                                     | `api.fiscaldata.treasury.gov/...avg_interest_rates` | n/a (auth:'none')                       |

The one bright spot: `news.ts` already fans out Finnhub → Yahoo → Google → mock
and merges — the exact pattern this rework generalizes into a first-class layer.

### Provider-agnostic primitives that already existed (and were reused)

- **`DataSourceSpec`** (`src/types/registry.ts`) — one source entry: `id`,
  `endpoint`, `auth` (`none|bearer|apikey|finnhub`), `fields`, `okPath`,
  `healthQuery`/`healthFields`, `timeoutMs`, `retries`, `required`,
  `onError` (`skip|degrade|fallback|fail`), `fallbackSourceId`.
- **`acquireSource()`** (`src/registry/sources/acquire.ts`) — fetches ONE source
  with timeout/retry/non-retryable 401-403 fast-fail/429 backoff/schema
  validation; returns `AcquireResult { id, ok, status, data, reason, authError }`.
- **`acquireForAnalyst()`** (`src/registry/sources/index.ts`) — runs ALL of an
  analyst's declared `dataSources`, applies per-source `onError` policy, resolves
  `fallbackSourceId` chains, and returns `merged` keyed by **source id**, plus
  `sourceStatus`, `degraded`, `usedMockFallback`, `hardFailed`, `authError`. Already
  supports multiple sources per analyst.
- **`aggregateDataHealth()`** (`src/registry/sources/index.ts`) — pipeline summary
  (`sourcesOk`, `sourcesTotal`, `degradedAnalysts`, `unavailableSources`).
- **`DEFAULT_SOURCE_URIS`** (`src/registry/analyst-config-schema.ts`) — canonical
  base-URI catalog (alphaVantage, finnhub, polygonOptions, polygonHist,
  treasuryRfr). Add a source → add a row here.
- **Settings UI / [Test] probe** — already source-driven off `DataSourceSpec`
  (base URI + token), so a new source is configurable in the UI for free.

Conclusion: the transport was swappable *before* the rework. The gap was that
call sites still called providers directly, and acquisition output was **not
normalized or weighed** before an analyst consumed it.

### Target architecture (3 layers)

```
   Analyst handler (sentiment/technical/fundamental/risk/options)
        │  declares: needs DOMAIN "sentiment"  (NOT "finnhub")
        ▼
   ┌───────────────────────────────────────────────────────────┐
   │ FAN-IN / WEIGHTING layer  (NEW)                            │
   │  for each required domain:                                │
   │   1. select candidate sources for (domain, ticker)        │
   │   2. acquire each via existing acquireSource()            │
   │   3. run each source payload through its Adapter → canonical│
   │   4. collect N normalized records                         │
   │   5. pass ALL records to the analyst, which WEIGHS them   │
   └───────────────────────────────────────────────────────────┘
        ▼                      ▼                      ▼
   ┌─────────────┐      ┌─────────────┐       ┌─────────────┐
   │ Adapter:    │      │ Adapter:    │       │ Adapter:    │
   │ Yahoo       │      │ Finnhub     │       │ AlphaVantage│   (NEW, one per provider)
   └──────┬──────┘      └──────┬──────┘       └──────┬──────┘
          ▼                    ▼                     ▼
   ┌───────────────────────────────────────────────────────────┐
   │ EXISTING acquisition engine  (acquireSource / acquireFor…) │
   │ endpoint + auth + timeout + retry + validate + fallback    │
   └───────────────────────────────────────────────────────────┘
```

**Data domains (the contract).** A `DataDomain` is a *typed need*, independent of
any provider. Each analyst **requires** a set of domains; the config maps each
domain to ≥1 source. Canonical shapes live in `src/registry/types/domains.ts`
(`NormalizedRecord<T>` envelope, `DomainShapes`). Handler signature:
`resolveDomain('sentiment', ticker, ctx) → NormalizedRecord[]` (a list, so it can
weigh several).

| Domain            | Canonical shape                       | Consumed by            | Candidate sources (today)                          |
|-------------------|---------------------------------------|------------------------|----------------------------------------------------|
| `price_bars`      | `PriceBar[]`                          | technical, options     | Yahoo → + Polygon aggregates, + AlphaVantage, IEX   |
| `fundamentals`    | `KeyRatios`                           | fundamental            | AlphaVantage OVERVIEW → + FMP, Finnhub profile, SEC|
| `news_sentiment`  | `NewsHeadline[]` + `sentiment_score`  | sentiment              | Finnhub → + Yahoo, Google, + social (P6)            |
| `option_chain`    | `OptionQuote[]` + expiries + spot     | options, risk          | Massive/Polygon → + CBOE (fallback), Tradier, IEX   |
| `risk_free_rate`  | `number` (annualized)                 | options (pricing)      | Treasury fiscaldata (keyless)                       |
| `market_meta`     | beta, realized vol, mkt cap           | risk, fundamental      | derived from `price_bars`; provider-supplied opt.  |

**Adapter (the swappable unit).** One `Adapter` per provider, registered in a
catalog. It knows ONLY which `DataSourceSpec`(s) it fulfils and how to map that
provider's response layout → the domain's canonical shape.

```ts
interface DomainAdapter {
  sourceId: string;                 // matches DataSourceSpec.id
  domain: DataDomain;
  normalize(raw: any, ctx: AdaptCtx): NormalizedRecord;  // layout A → canonical
  confidence?(raw: any): number;    // 0..1, used by weighting
}
```

Moving the inline parse out of `hist.ts`/`data-ingestion.ts`/`news.ts` into
adapters is what makes parse fixture-testable in isolation.

**Fan-in + weighting (the analyst-facing change).** `resolveDomain(domain,
ticker, sources, ctx)`: (1) acquire each candidate source via `acquireSource`,
(2) run each ok payload through its adapter's `normalize`, (3) return
`NormalizedRecord[]` (each tagged `sourceId`, `status`, `confidence`). The analyst
then **weighs** the records: `score = Σ w_i·s_i` where `w_i` derives from
`confidence × (1 + agreementBonus)`. Divergent sources emit a `low_consensus` note
(honest provenance — matches the semantic-honesty bar in AGENT.md). Fusion core:
`src/registry/logic/fuse.ts` (`fuseNumeric`, `fuseSentiment`).

### Phased delivery status (all shipped, test-gated)

| Phase | What it delivered | Status |
|-------|-------------------|--------|
| P0 | Domain contracts + typed `resolveDomain` (no behavior change); `src/registry/types/domains.ts`, `domains.p0.test.ts` (9 parity tests) | DONE — 65 suites / 570 pass |
| P1 | Adapter registry + extract inline parse (Yahoo/Finnhub/AlphaVantage); `src/registry/sources/adapters/*`; `adapters.test.ts` (13) | DONE — 66 suites / 583 pass |
| P2 | Multi-source per domain + config-driven weighting. P2a fusion core `fuse.ts` (12 tests); P2b backend fan-in (5 tests); P2b-2 frontend trace drawer (`MarketDataCard` consensus readout) | DONE — 68 suites / 600 pass; 39 FE files / 323 pass |
| P3 | Swappable source config, no code change to switch providers. P3a backend `DOMAIN_SOURCES` + `enabledSources`; P3b Settings → **Data Sources** tab (`DomainSourcesTab.tsx`) + persistence (`domain-source-config.ts`) + routes | DONE — 68 suites / 610 pass |
| P4 | Delete legacy hard-wired fetchers; relocate to `adapters/` (price-bars, option-chain, alphavantage-fundamentals). grep-guard satisfied (no provider URL outside `adapters/` + `DEFAULT_SOURCE_URIS`) | DONE — backend 616 pass / 1 skip; frontend 330 pass |

P5 (docs) absorbed this section into the main architecture doc; P6 (social-domain
sentiment) deferred — it falls out of the same adapter interface as a pure
config + adapter addition.

### Behavioral notes (lock-in contracts)

- **CBOE fallback after a failed Massive/Polygon key (401).** When a
  Massive/Polygon key is set but the live call returns a non-OK status (e.g. 401
  entitlement-not-authorised), `acquireOptionChain` / `resolveLiveOptionsBundle`
  MUST still fall back to the **free, keyless CBOE delayed feed** and return
  `source === 'cboe'` — NOT a silent mock. Deterministic test:
  `src/tests/options-cboe-fallback.test.ts` (3); live proof (gated by
  `SKIP_NETWORK_TESTS=1`): `src/tests/options-cboe-fallback.repro.test.ts`.
- **Sources tab: Massive/Polygon share ONE combined `[Test]` button.** In the
  shared `SourcesTab` (`frontend/src/components/analysts/SourcesTab.tsx`), a key
  group (`keyGroup: 'massive'`, `polygonOptions` + `polygonHist`) renders a SINGLE
  shared token field + ONE combined `[Test Massive/Polygon Options endpoints]`
  button at the bottom; the two endpoint inputs stay grouped (not split by a
  per-endpoint Test button). The grouping is centralized in
  `buildAnalystConfigSchema` (`analystConfigSchema.ts`, `withKeyGroups`), so **both**
  the General Settings → Sources tab AND the **Data Ingestion analyst's** Settings
  dialog render the identical layout. Tests: `SourcesTab.test.tsx` +
  `sourceGearOpensDialog.test.tsx`.

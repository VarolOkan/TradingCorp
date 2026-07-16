# Extending the System — Adding Analysts & Agencies

A practical guide to extending TradingCorp. Read §0–§1 for the mental model,
the field reference (§5) and the data contract (§3) for *why* things fit, then
the recipes (§6 declarative, §7 fn, §8 options) for the *exact* steps. Together
they replace the former `CREATING_AN_ANALYST.md` (concept) and
`ADDING_AN_ANALYST.md` (recipe).

> All registry machinery is **registry-driven**: you declare a data object
> (`AnalystDef` / `AgencyDef`) and `AgencyGraph` wires it into the agency
> automatically. No graph-builder code. See `ARCHITECTURE.md` for the as-built
> picture and `docs/archive/AGENCY-REARCHITECTURE.md` for the original
> re-architecture contract.

--------------------------------------------------------------------------------
## 0. The 10-second mental model
--------------------------------------------------------------------------------

    kind   -> 'orchestrator' | 'ingestion' | 'analyst' | 'gatekeeper'
    stage  -> 1 (gather) · 2 (analyze) · 3 (decide)

An agency is just an **ordered list of analyst ids**. The graph derives the
edges from `stage` + `dependsOn`:

    ┌───────────────────────── AGENCY = ORDERED ANALYST LIST ─────────────────────┐
    │         ( Stage 1 )                   ( Stage 2 )       ( Stage 3 )         │
    │                                                                             │
    │ orchestrator ─▶ data_ingestion ──┬──▶ fundamental ──┐                       │
    │                                  ├──▶ technical     ├─▶ risk ──┐            │
    │                                  ├──▶ sentiment     │          │            │
    │                                  ├──▶ contrarian    │          │            │
    │                                  └──▶ ...           ┘          ▼            │
    │                                                           governance        │
    │                                                                │            │
    │                                                                ▼            │
    │                                                          final_decision     │
    └─────────────────────────────────────────────────────────────────────────────┘

        Stage 1  chained in order, starting from the entry point
        Stage 2  FANS OUT from the last Stage-1 node (data ingestion)  ← runs in parallel
        Stage 3  FANS IN  from ALL Stage-2 analysts (the decision gate)

Rule of thumb: **an analyst that needs data does Stage 2 and depends on
`data_ingestion`**; **the one that decides is Stage 3**; **the one that gathers
is Stage 1 (ingestion)**.

--------------------------------------------------------------------------------
## 1. QUICK START — add a "Contrarian" analyst (declarative, ~no code)
--------------------------------------------------------------------------------

Goal: a Stage-2 analyst that reads the *consensus* gathered by Data Ingestion
(news/social/analyst/institutional sentiment + RSI) and **inverts** it — when
the crowd is unanimously bearish and the chart is oversold, that is a bullish
contrarian setup (and vice-versa). No LLM, no TypeScript handler — pure JSON
logic that the declarative engine runs.

### Step 1 — Declare the AnalystDef (backend, `src/registry/analysts.ts`)

```ts
  contrarian: {
    id: 'contrarian',
    kind: 'analyst',
    name: 'Contrarian Signal',
    role: 'Invert crowd sentiment + RSI extremes',
    stage: 2,                                   // ← it ANALYZES, after ingestion
    accent: '#a855f7',                          // distinct hex for the wall card
    monogram: 'CX',                             // two letters shown on the card
    prompt: [
      'You are the Contrarian analyst. You FADE the consensus: extreme',
      'bearish sentiment with an oversold RSI is a bullish setup, and',
      'vice-versa. Your verdict is a weighted formula — no LLM.',
    ].join('\n'),
    dependsOn: ['data_ingestion'],              // ← it reads what Stage 1 gathered
    dataSources: [{
      from: 'data_ingestion',
      // These are REAL fields Data Ingestion emits (see §3).
      fields: ['sentiment_score', 'news_sentiment', 'social_sentiment',
               'analyst_sentiment', 'institutional_sentiment', 'rsi', 'volatility_30d'],
      label: 'Crowd consensus + momentum',
      sources: ['Yahoo Finance (mock)'],
    }],
    features: [
      // map each input field to a named feature the scoring math can use
      { key: 'crowd_bearish', label: 'Crowd bearishness',  source: 'dataSources.0', aggregation: 'last' },
      { key: 'oversold',      label: 'Oversold RSI',       source: 'dataSources.0', aggregation: 'last' },
      { key: 'calm_vol',      label: 'Low volatility',     source: 'dataSources.0', aggregation: 'last' },
    ],
    logic: {
      mode: 'declarative',
      // How the score is built. Higher score = stronger contrarian edge.
      weighting: [
        { label: 'Crowd is extreme',   inputs: ['crowd_bearish'], weight: 0.5, rationale: 'unanimous mood = fade' },
        { label: 'Chart oversold',     inputs: ['oversold'],      weight: 0.35, rationale: 'mean-reversion fuel' },
        { label: 'Volatility compress',inputs: ['calm_vol'],      weight: 0.15, rationale: 'coiled spring' },
      ],
      score: { from: 'weightedSum', range: [0, 100], round: true },
      verdict: {
        from: 'score',
        mapping: [
          { if: '>=', value: 60, then: 'CONTRARIAN_BULLISH' },   // crowd bearish + oversold
          { if: '<',  value: 40, then: 'CONTRARIAN_BEARISH' },   // crowd bullish + overbought
        ],
        default: 'NEUTRAL',
      },
      summaryTemplate: 'Contrarian edge {score}/100 → {verdict}',
    },
    output: { channels: ['contrarian_analysis'] },   // ← the channel it writes
    tasks: ['Measuring crowd sentiment', 'Checking RSI extreme', 'Scoring fade setup'],
    mock: {
      generator: 'seeded', seedFrom: 'ticker',
      // KEYED BY FEATURE, not by score (see Pitfall §5).
      ranges: { crowd_bearish: [20, 90], oversold: [10, 80], calm_vol: [10, 60] },
      flags: [],
    },
  },
```

### Step 2 — Add it to an agency (`src/registry/agencies.ts`)

```ts
  long-term: {
    id: 'long-term',
    name: 'Long-Term Investment',
    horizon: 'LONG_TERM',
    analysts: [
      { id: 'orchestrator' },
      { id: 'data_ingestion' },
      { id: 'fundamental' },
      { id: 'technical' },
      { id: 'sentiment' },
      { id: 'contrarian' },            // ← new, sits in Stage 2 with the others
      { id: 'risk' },
      { id: 'governance' },
    ],
  },
```

### Step 3 — Mirror on the frontend (so the wall renders the card)

In `frontend/src/components/analysts/agencies.ts` add `'contrarian'` to the
`long-term` agency's `analysts` array (same position as the backend). Add an
`AnalystMeta` entry (id/name/role/accent/monogram/stage/tasks) in
`frontend/src/components/analysts/analysts.ts`. **Keep the frontend agency
mirror and the backend `AGENCIES` array in lockstep** — they are edited by hand
and drift easily (a test, `agency-mirror.test.ts`, fails if they disagree).

### Step 4 — Bump the registry test counts (`src/tests/registry.test.ts`)

The test asserts a **hardcoded analyst count** and an expected-id array. Add
`'contrarian'` to the expected ids and bump the count. Run `npx jest --silent`
→ green.

That is it. The declarative engine runs your `logic` block, writes one
`AnalystTrace` (used by the drill-down drawer) and the `contrarian_analysis`
channel. No graph code, no handler.

--------------------------------------------------------------------------------
## 2. The two implementation paths
--------------------------------------------------------------------------------

         ┌───────────────────────────┐      ┌─────────────────────────────┐
         │  DECLARATIVE  (preferred) │      │  fn  (legacy / powerful)    │
         ├───────────────────────────┤      ├─────────────────────────────┤
         │ Pure-JSON logic block:    │      │ You write a TS handler:     │
         │  features → weights →     │      │  async (state, node) =>     │
         │  score → verdict          │      │    state                    │
         │ Engine runs it. NO code.  │      │ Register in logic.ts.       │
         ├───────────────────────────┤      ├─────────────────────────────┤
         │ Use for: scoring formulas,│      │ Use for: LLM calls, HTTP    │
         │ weighted signals, anything│      │ fetches, custom math, state │
         │ expressible as a sum.     │      │ mutation beyond the schema. │
         ├───────────────────────────┤      ├─────────────────────────────┤
         │ Reference: `onchain`      │      │ Reference: the 7 original   │
         │ analyst.                  │      │ equity analysts.            │
         └───────────────────────────┘      └─────────────────────────────┘

Choose declarative unless you need real logic (an LLM step, a live HTTP call, or
arbitrary code). The `onchain` analyst is the canonical declarative example.

--------------------------------------------------------------------------------
## 3. The data contract — what Data Ingestion FETCHES and what your analyst READS
--------------------------------------------------------------------------------

Every Stage-2 analyst reads what the **Data Ingestion** analyst gathered in
Stage 1. Data Ingestion writes a single `state.ingested` object AND emits
per-domain message channels. The honest `source` field tells you whether the
value is live (Yahoo) or deterministic mock.

    DATA INGESTION (Stage 1)                         CONTRARIAN (Stage 2)
    ─────────────────────────                        ─────────────────────
    fetches → normalizes → writes `state.ingested`   reads `dataSources` (points at
                                                       data_ingestion) → features →
    ingested = {                                      score → verdict → channel
      bars:        { [ticker]: PriceBarSeries[] }
      market:      { [ticker]: { price, day_high,
                    day_low, volume, beta,
                    volatility_30d, short_interest, … } }
      fundamental: { [ticker]: { balance_sheet,
                    income_statement, cash_flow,
                    key_ratios { pe, pb, de, roe, … } } }
      sentiment:   { [ticker]: {                       ← THE CONTRARIAN READS THIS
                    news_sentiment,        // VERY_POS..VERY_NEG
                    social_sentiment,
                    analyst_sentiment,
                    institutional_sentiment,
                    sentiment_score,        // -100..+100  ← "crowd_bearish" source
                    news_count, social_mentions } }
      source:      'yahoo' | 'mock' | 'mixed'
    }
    + message channels:
        fundamental_data, technical_data,
        sentiment_data, market_data

### Required input data for the Contrarian analyst

Declared in `dataSources[].fields`. These are the exact keys Data Ingestion
emits (verified against `data-ingestion.ts`):

    FIELD                  ORIGIN DOMAIN     MEANING
    ─────────────────────────────────────────────────────────────────────────
    sentiment_score        sentiment         -100..+100 crowd mood (aggregate)
    news_sentiment         sentiment         VERY_POSITIVE … VERY_NEGATIVE
    social_sentiment       sentiment         same scale, social layer
    analyst_sentiment      sentiment         same scale, sell-side
    institutional_sentiment sentiment         same scale, funds/desks
    rsi                    technical         Yahoo 14-period RSI (live) / mock
    volatility_30d         market/technical   normalized vol (for "calm_vol")

### Output data the Contrarian PRODUCES

    OUTPUT (written to state + drill-down trace)
    ─────────────────────────────────────────────────────────────────────────
    channel:        contrarian_analysis
    trace.verdict:  CONTRARIAN_BULLISH | CONTRARIAN_BEARISH | NEUTRAL
    trace.score:    0..100  (higher = stronger fade edge)
    trace.summary:  "Contrarian edge 73/100 → CONTRARIAN_BULLISH"

This channel is then visible to anything downstream (e.g. a governance override
or a UI panel). If your analyst should influence the *final decision*, you wire
its output into a Stage-3 reader (see §4).

--------------------------------------------------------------------------------
## 4. Integrating into Stage 1 / Stage 2 / Stage 3
--------------------------------------------------------------------------------

### Stage 1 — Information Gathering (ingestion)
You rarely add a Stage-1 node unless you are fetching a *new kind of raw data*
that no existing ingestion node collects. Example: a `crypto_ingest` node that
fetches on-chain metrics (exchange netflow, active addresses) — that is what the
`onchain` analyst's `dependsOn: ['crypto_ingest']` points at.

### Stage 2 — Analysis (the common case)
This is where almost every new analyst lives. Rules enforced by `AgencyGraph`:

    • stage: 2
    • dependsOn: ['data_ingestion']   (or your custom Stage-1 node)
    • dataSources[].from must match a Stage-1 node id
    • runs in PARALLEL with the other Stage-2 analysts (fan-out)
    • writes its own output channel; does not need the others' output

### Stage 3 — Decision (gatekeeper)
Only ONE analyst should be Stage 3 per agency: the governance gatekeeper. It
**fans in from all Stage-2 analysts** and issues the final verdict. You do NOT
usually add a second Stage-3 node.

If your new Stage-2 analyst should *influence the decision*, you do not make it
Stage 3 — you make the governance node read your channel.

--------------------------------------------------------------------------------
## 5. Anatomy of an AnalystDef (every field)
--------------------------------------------------------------------------------

    field            type        meaning / notes
    ───────────────────────────────────────────────────────────────────────────
    id               string      unique key; referenced by agencies + tests
    kind             enum        'orchestrator'|'ingestion'|'analyst'|'gatekeeper'
    name             string      human label (wall + drawer)
    role             string      one-line description
    stage            number      1 | 2 | 3  (drives graph wiring)
    accent           string      hex color for the wall card
    monogram         string      2 letters shown on the card
    prompt           string      Role & Instructions text (LLM step if enabled)
    dependsOn        string[]    predecessor node ids (else stage semantics)
    dataSources      {from,fields,label,sources}[]
                                 which Stage-1 output this analyst consumes
    features         {key,label,source,aggregation}[]
                                 named inputs the scoring math uses
    logic            {mode, weighting, score, verdict, summaryTemplate}
                                 declarative engine config (or {mode:'fn',fn})
    output           {channels, storeInMessages?}
                                 the channel(s) this analyst writes
    tasks            string[]    steps shown in the wall "working" state
    mock             {generator, seedFrom, ranges, flags}
                                 deterministic fallback so default runs are
                                 parity-safe (no live keys needed)

### PITFALLS

1. **mock.ranges are keyed by FEATURE, not by `score`.** The declarative handler
   looks up `mock.ranges[feat.key]` per feature. If you only declare
   `score:[..]`, every feature defaults to `0`, the weighted sum is `0`, and the
   score clamps to the range minimum. Always declare one range per feature key.
2. **summaryTemplate echo bug.** The trace's `output.summary` uses the *computed*
   summary (`first?.summary ?? logic.summaryTemplate`). Do NOT set
   `output.summary: logic.summaryTemplate` — that prints the raw
   `"{score}/100 → {verdict}"` placeholders in the drawer.
3. **ONE trace per analyst.** Declarative or fn, your analyst must append exactly
   ONE `AnalystTrace` to `state.analystTraces` (inputs array spans all tickers).
   Pushing a trace per ticker breaks trace-count assertions.
4. **Frontend/backend mirror drift.** The frontend `analysts.ts` and
   `agencies.ts` mirrors MUST match the backend. A test (`agency-mirror.test.ts`)
   fails on drift. Keep them in lockstep every time you touch a registry.
5. **Don't add a 2nd Stage-3 node.** Governance is the single decision node. To
   make a Stage-2 analyst influence the call, have governance READ its channel.

--------------------------------------------------------------------------------
## 6. Recipe — declarative analyst (worked "Intraday Momentum")
--------------------------------------------------------------------------------

Goal: a Stage-2 analyst that scores short-horizon momentum (5m RSI + volume
spike + bid/ask spread) and is part of the `intraday` agency.

### 1. Backend: declare the AnalystDef (`src/registry/analysts.ts`)

```ts
  intraday_momentum: {
    id: 'intraday_momentum',
    kind: 'analyst',
    name: 'Intraday Momentum',
    role: '5m RSI · volume spike · spread',
    stage: 2,
    accent: '#22d3ee',
    monogram: 'IM',
    prompt: [
      'You are the Intraday Momentum analyst. You score short-horizon',
      'tradeability from 5-minute RSI, a volume spike ratio, and the',
      'bid/ask spread. Your verdict is a weighted formula — no LLM.',
    ].join('\n'),
    dependsOn: ['data_ingestion'],
    dataSources: [{ from: 'data_ingestion', fields: ['price_5m', 'volume_5m', 'spread'], label: 'Intraday market data', sources: ['Yahoo Finance (mock)'] }],
    features: [
      { key: 'rsi_5m',  label: '5m RSI',          source: 'dataSources.0', aggregation: 'last' },
      { key: 'vol_spike', label: 'Volume spike', source: 'dataSources.0', aggregation: 'last' },
      { key: 'spread',  label: 'Bid/ask spread', source: 'dataSources.0', aggregation: 'last' },
    ],
    logic: {
      mode: 'declarative',
      weighting: [
        { label: '5m RSI',      inputs: ['rsi_5m'],   weight: 0.5, rationale: 'momentum' },
        { label: 'Volume spike', inputs: ['vol_spike'], weight: 0.3, rationale: 'participation' },
        { label: 'Tight spread', inputs: ['spread'],   weight: 0.2, rationale: 'executability', invert: true },
      ],
      score: { from: 'weightedSum', range: [0, 100], round: true },
      verdict: { from: 'score', mapping: [ { if: '>=', value: 60, then: 'BULLISH' }, { if: '<', value: 40, then: 'BEARISH' } ], default: 'NEUTRAL' },
      summaryTemplate: 'Intraday momentum {score}/100 → {verdict}',
    },
    output: { channels: ['intraday_momentum_analysis'] },
    tasks: ['Reading 5m RSI', 'Measuring volume spike', 'Checking spread'],
    mock: { generator: 'seeded', seedFrom: 'ticker', ranges: { rsi_5m: [20, 80], vol_spike: [0.5, 4.0], spread: [0.01, 0.5] }, flags: [] },
  },
```

### 2. Backend: add it to the agency (`src/registry/agencies.ts`)

```ts
  intraday: {
    id: 'intraday', name: 'Intraday', description: 'Short-horizon tuning + intraday momentum analyst.',
    horizon: 'INTRADAY',
    analysts: [
      { id: 'orchestrator' }, { id: 'data_ingestion' },
      { id: 'fundamental', params: { horizon: 'INTRADAY' } },
      { id: 'technical',   params: { horizon: 'INTRADAY', lookbackBars: 5, rsiThreshold: 55 } },
      { id: 'sentiment',   params: { horizon: 'INTRADAY', sourceMix: 'social-heavy' } },
      { id: 'intraday_momentum' },
      { id: 'risk',        params: { horizon: 'INTRADAY' } },
      { id: 'governance' },
    ],
  },
```

If you add a brand-new agency, add a whole `AGENCIES` entry and bump the
`should have exactly N agencies` assertion in `src/tests/registry.test.ts`.

### 3. Backend: bump registry test counts
`src/tests/registry.test.ts` asserts **hardcoded** counts (`exactly 8 analysts`,
agency integrity). Bump them and add the new id to the expected-id array. Run
`npx jest --silent` → green before touching the frontend.

### 4–5. Frontend: mirror metadata + agency
Edit `frontend/src/components/analysts/analysts.ts` (add to `AnalystId` union +
`AnalystMeta`) and `agencies.ts` (append to the agency's `analysts` array, same
position as backend). The `analysts.test.ts` "defines the N pipeline analysts in
order" assertion must match the `ANALYSTS` array. Keep the frontend agency
mirrors and the backend `AGENCIES` in lockstep.

### 6. Verify
- Backend: `npx jest --silent` → green.
- Frontend: `npm run test:ui` → green.
- Build: `npx vite build` (NOT bare `tsc` — the frontend tsconfig has a
  `rootDir` quirk that pulls backend files and reports noise).
- Optional live: `npx tsx src/server/index.ts`, then a socket client emitting
  `request_analysis` with `{ tickers:['AAPL'], agencyId:'intraday' }` and
  confirm `analystTraces` includes `intraday_momentum`.

--------------------------------------------------------------------------------
## 7. Recipe — the fn path (legacy analysts)
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
5. Still do steps 2–6 of §6 (agency membership, test-count bumps, frontend
   mirror, build).

> **PITFALL — ONE TRACE PER ANALYST.** Whether fn or declarative, your handler
> must append exactly ONE `AnalystTrace` to `state.analystTraces` (inputs array
> spans all tickers). Pushing a trace per ticker breaks the trace-count
> assertions. Aggregate across tickers into a single trace.

--------------------------------------------------------------------------------
## 8. Recipe — adding an Options analyst
--------------------------------------------------------------------------------

Options analysts ride the same registry machinery as equity ones, but a few
conventions apply (see `ARCHITECTURE.md › Options agencies & data layer`; the
original design is in `docs/archive/OPTIONS_AND_AGENCY_EXPANSION.md`).

**Instrument / agency.** Options analysts live only inside the two option
agencies (`options-swing`, `options-intraday`), whose `AgencyDef` carries
`instrument: 'OPTION'`. The `instrument` field is threaded
`AgencyGraph → GenericAnalystNode → handler` and reaches your handler as
`tuning.instrument`. Equity agencies leave it undefined and run exactly as
before.

**The data layer.** Every options analyst reads a deterministic `HistoricalBundle`
built by `options_ingestion` and stashed on `state.optionsData[ticker]` (fallback:
regenerate via `fetchHistoricalBundle`). Use the `runFnOptionsAnalyst(cfg, …)`
helper in `src/registry/logic/options-shared.ts` — it resolves the bundle, calls
your `compute(ticker, bundle, tuning)`, and emits one trace + completion message
with the declared channels.

**The options governance veto.** If your analyst feeds the veto (e.g. you emit
`iv_percentile` / `max_loss` / `risk_level` like `options_risk`), it must write
those on `message.data.analyses[ticker].data` so `governance.ts ›
extractOptionsRisk` can read them. The owning agency's `governance` ref carries
`tuning.params.optionsVeto` (`{ maxIvPercentile, requireHedge?, noOvernight? }`),
and the veto REJECTS when IV breaches the cap, an undefined-risk structure is
unhedged (swing), or a HIGH-risk structure survives intraday's no-overnight
strictness.

**Steps (in addition to §6):**

1. Declare the `AnalystDef` in `src/registry/analysts.ts` with `stage: 2` and a
   backend `prompt` seeded from `src/prompts/options-instructions.ts`. For a
   purely computed analyst use `logic.mode: 'fn'` + a handler in
   `options-handlers.ts`; for a read-only overlay use `logic.mode: 'declarative'`.
2. Add the id to `options-swing` and/or `options-intraday` in
   `src/registry/agencies.ts` (in pipeline order).
3. Bump `src/tests/registry.test.ts`: the "exactly 6 agencies" assertion, the
   options agency membership/params assertions, and the analyst-id array.
4. Mirror on the frontend: add the id to the `AnalystId` union + `AnalystMeta`
   in `frontend/src/components/analysts/analysts.ts`, and to the relevant
   agency's `analysts` array in `frontend/src/components/analysts/agencies.ts`.
   Keep `frontend/src/test/agency-mirror.test.ts` green.
5. Verify: `npx jest --silent` (backend), `npm run test:ui` (frontend),
   `npx vite build`. Optional live check: `request_analysis` with
   `{ tickers:['AAPL'], agencyId:'options-swing' }` should return
   `analysis_complete` with your analyst present in `analystTraces`.

### Give the options analyst flavors + (optional) an LLM step
1. **Ship flavors** on the `AnalystDef`: add a `flavors: AnalystFlavor[]` array
   (≥1, exactly one `isDefault: true`). Each flavor is
   `{ id, name, role, instructions, isDefault? }`; `instructions` is the Role &
   Instructions the LLM/analyst runs under.
2. **LLM step (opt-in)**: add `logic.llm: { enabled: boolean }`. `enabled: false`
   is the **parity default** — the LLM step never fires and the analyzer runs
   byte-for-byte as before. Set `enabled: true` only for analysts that should
   "let the LLM do the work". With no provider key the step degrades to a
   deterministic fallback, so it never breaks the run.
3. Verify the flavor flow: `GET /analyst-flavors` returns the shipped set;
   `POST /analyst-flavors` (full replace) is rejected if it deletes the last
   flavor.

--------------------------------------------------------------------------------
## 9. New-analyst checklist
--------------------------------------------------------------------------------

- [ ] Backend `AnalystDef` added to `src/registry/analysts.ts`
- [ ] `mock.ranges` keyed by FEATURE (not `score`)
- [ ] Added to the right agency in `src/registry/agencies.ts`
- [ ] `src/tests/registry.test.ts` count assertions bumped (analyst count,
      expected-id array, agency integrity) — `npx jest` green
- [ ] Frontend `AnalystId` union + `AnalystMeta` in `analysts.ts`
- [ ] Frontend agency mirror `agencies.ts` updated to match backend agency
- [ ] Frontend test added/adjusted (wall panel count + new card present)
- [ ] `npm run test:ui` green, `npx vite build` green
- [ ] (Optional) live `GRAPH_MODE=agency` socket check shows the new trace

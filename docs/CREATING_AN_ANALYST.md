# Creating a New Analyst & Assigning It to an Agency

A practical, illustrated guide to extending the analysis pipeline. It covers the
30-second mental model, a copy-paste quick start, and a deep reference for every
field, the data contract, and how a new analyst plugs into Stage 1 / Stage 2 /
Stage 3 of an agency's workflow.

> Companion file: `docs/ADDING_AN_ANALYST.md` (the terse, line-by-line recipe
> with the exact test-count bumps). This document explains *why* and *how the
> pieces fit*, with diagrams. Read this first, then the recipe for the exact
> diffs.

--------------------------------------------------------------------------------
## 0. The 10-second mental model
--------------------------------------------------------------------------------

The pipeline is **registry-driven**. You do not write graph-builder code to add
an analyst. You declare a data object (`AnalystDef`) and the orchestrator
(`AgencyGraph`) wires it into the agency automatically based on two fields:

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
→ green. (Exact diffs in `docs/ADDING_AN_ANALYST.md`.)

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
arbitrary code). The `onchain` analyst is the canonical declarative example; the
Contrarian above follows the same shape.

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
      bars:        { [ticker]: PriceBarSeries[] }  ────────────────────────────────
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

The Contrarian maps these into 3 features:
    crowd_bearish = how extreme the crowd's bearishness is
    oversold      = RSI extreme (low RSI = oversold = mean-reversion fuel)
    calm_vol      = volatility compression (a coiled spring)

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

    When to use Stage 1: you need NEW raw inputs that Data Ingestion does not
    already gather. You write a handler that builds + writes a shared channel
    (e.g. `state.ingested` or `state.optionsData[ticker]`), then Stage-2
    analysts `dependsOn` your node.

### Stage 2 — Analysis (the common case)
This is where almost every new analyst lives. Rules enforced by `AgencyGraph`:

    • stage: 2
    • dependsOn: ['data_ingestion']   (or your custom Stage-1 node)
    • dataSources[].from must match a Stage-1 node id
    • runs in PARALLEL with the other Stage-2 analysts (fan-out)
    • writes its own output channel; does not need the others' output

    Stage 2 fan-out (all run concurrently after ingestion):
        data_ingestion ──┬──▶ fundamental
                         ├──▶ technical
                         ├──▶ sentiment
                         ├──▶ contrarian   ← runs alongside, independently
                         └──▶ (any others)

### Stage 3 — Decision (gatekeeper)
Only ONE analyst should be Stage 3 per agency: the governance gatekeeper. It
**fans in from all Stage-2 analysts** and issues the final verdict. You do NOT
usually add a second Stage-3 node.

If your new Stage-2 analyst should *influence the decision*, you do not make it
Stage 3 — you make the governance node read your channel. Concretely:
    • your Stage-2 analyst writes `contrarian_analysis` (a channel)
    • governance's handler reads `state.messages` / the shared channels and
      factors your score into its final APPROVE/REJECT (preservation-first veto)
This keeps the single-decision-node invariant intact.

    Stage 3 fan-in:
        fundamental ─┐
        technical    ├──▶ governance (Stage 3) ─▶ final_decision
        sentiment    │
        contrarian  ─┘

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

### PITFALLS (learned the hard way — see `ADDING_AN_ANALYST.md` for more)

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
## 6. Verify your new analyst end-to-end
--------------------------------------------------------------------------------

    BACKEND
      npx jest --silent
        → analyst count + agency-integrity assertions green
        → (optional) a screener/trace test shows 1 contrarian trace, non-zero score

    FRONTEND
      npm run test:ui        → green (wall panel count + "Contrarian Signal" card)
      npx vite build         → green (639 modules; do NOT use bare `tsc` here —
                               the frontend tsconfig has a rootDir quirk that
                               reports unrelated backend-file noise)

    LIVE (optional)
      npx tsx src/server/index.ts
      socket client → request_analysis { tickers:['AAPL'], agencyId:'long-term' }
      → analysis_complete.payload.analystTraces includes `contrarian`
        with a non-zero score and a rendered summary.

--------------------------------------------------------------------------------
## 7. One-page recap
--------------------------------------------------------------------------------

    TO ADD AN ANALYST:
      1. Declare AnalystDef in src/registry/analysts.ts
         (kind + stage + dependsOn + dataSources + features + logic + output)
      2. Append its id to the agency in src/registry/agencies.ts
      3. Mirror on frontend (analysts.ts meta + agencies.ts array)
      4. Bump hardcoded counts in src/tests/registry.test.ts
      5. jest + test:ui + vite build green

    THE CONTRARIAN EXAMPLE IN ONE LINE:
      Stage-2 analyst, dependsOn data_ingestion, reads consensus sentiment + RSI,
      inverts the crowd via a weighted formula, writes `contrarian_analysis`.

    STAGE RULES:
      1 = gather (new raw data)   2 = analyze (parallel fan-out)   3 = decide (fan-in)
      Only ONE Stage-3 node per agency (governance). To influence the call,
      have governance read your output channel — don't add a 2nd decision node.

--------------------------------------------------------------------------------
## 8. How this differs from `docs/ADDING_AN_ANALYST.md`
--------------------------------------------------------------------------------

`ADDING_AN_ANALYST.md` is the **line-by-line recipe** (exact diffs, test-count
numbers, the `fn` path, options analysts, flavors/LLM). This document is the
**concept + architecture guide** (the mental model, the stage-wiring diagrams,
the data contract, and a fully worked contrarian example). Use both: this one
to understand, the recipe one to implement.

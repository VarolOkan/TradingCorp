# Options Trading Agencies + Historical Data Layer — Phased Design

Status: **DESIGN ONLY (not yet implemented).** This document proposes the new
analysts, the new data layer (historical price + options chains + greeks), and
two new options agencies, before any code is written. It is the agreement to
implement against — once approved, the work splits into the phases at the end
and is built test-gated, one phase at a time, stopping between phases.

## 0. Context & hard constraints

- **Long-Term agency is frozen.** Per instruction, `long-term` (the default) is
  left byte-for-byte as-is. No analyst id, param, or stage changes anywhere in
  `src/registry/agencies.ts`/`analysts.ts` may touch it. All new work adds
  *new* analysts + *new* agencies + *new* data machinery; it does not mutate the
  existing 7-node equity pipeline.
- **Registry model (already in place, reuse it):**
  - An `AnalystDef` (`src/types/registry.ts`) is pure JSON: `kind`, `stage`
    (1 intake / 2 analysis / 3 decision), `dataSources`, `features`, `logic`
    (`declarative` weighted-formula or `fn` handler key), `output.channels`,
    `mock`.
  - A `DataSourceSpec` can be `{ from: '<upstream analyst>' }` (internal
    pipeline handoff, ignored by the live fetcher) or a `type:'rest'|'graphql'`
    with `endpoint`/`auth` (live-fetched; falls back to mock via
    `onAllSourcesFailed`). New historical/options sources follow this exact
    shape — they are just new REST endpoints.
  - `AgencyDef.analysts` is an ordered `AgencyAnalystRef[]`; per-analyst
    `params` are layered onto `AnalystDef.params` and forwarded to handlers as
    `AnalystTuning { horizon, params }`.
  - **Parity rule (do not break):** a mock-only run (no API tokens) must stay
    deterministic and unchanged in shape. New sources must use
    `onError:'degrade'`/`onAllSourcesFailed:{action:'useMock'}` so absent keys
    degrade to mock exactly like the existing `yahoo`/`alphaVantage`/`finnhub`
    sources.
- **Horizon vocabulary:** `AnalysisHorizon = 'INTRADAY' | 'SHORT_TERM' |
  'MEDIUM_TERM' | 'LONG_TERM'`. The two new agencies both need an *intraday*
  profile for execution, but they are **options** agencies — a distinct
  `kind`/flavor, not a rename of the existing equity `intraday`. We keep the
  existing equity `intraday` untouched and add two new ids (see §4).
- **No options/greeks code exists today.** Current `fetchFinancialData` returns
  only mock fundamental/technical/sentiment/market for equities. Everything in
  §3 is additive.
- **`AnalysisHorizon` does not yet encode instrument class.** Options agencies
  need to know they trade *derivatives*, not just a horizon. We add an
  `instrument: 'EQUITY' | 'OPTION'` field to `AgencyDef` (and thread it into
  `AnalystTuning`) so handlers/ingestion can branch on instrument, not guess
  from the agency id string.

---

## 1. Required data — what the new agencies MUST be able to fetch

The instruction calls out three specific historical series. We model them as a
single, reusable **Historical & Derivatives Data Layer** (`hist.ts` provider
family) behind the existing retry handler, plus mock generators that are
deterministic (same `seededRandom(stringToSeed(ticker))` contract as today).

### 1.1 Historical stock price (OHLCV, daily + intraday bars)

- **Need:** daily bars for trend/volatility/mean-reversion over a configurable
  lookback; intraday bars (1m/5m) for the options-intraday agency's underlying
  move. The existing mock only returns a *single* `price_data` snapshot.
- **Fields:** `bars[]` with `{ t, open, high, low, close, volume, vwap? }`,
  `interval` (`1d`/`1m`/`5m`), `lookback_days`.
- **Live source:** Polygon `/v2/aggs/ticker/{ticker}/range/{multiplier}/{timespan}/{from}/{to}`,
  Tiingo, or Yahoo chart with `range=1mo&interval=1d`. Declared as a `rest`
  source with `auth:'bearer'`, `onError:'degrade'`.

### 1.2 Historical + live options price (the option chain)

- **Need:** for each expiry, the full chain of strikes with bid/ask/last/volume/
  open-interest/implied-volatility (IV) + the underlying spot at chain time.
- **Fields:** `chain[]` = `{ expiry, strike, type:'C'|'P', bid, ask, last,
  volume, open_interest, iv, underlying_price, underlying_ts }`.
- **Live source:** Polygon `/v3/reference/options/chains/{ticker}` +
  `/v2/aggs/ticker/{optionTicker}/range/...`; or ORATS/DeltaNeutral. Declared
  `rest`, `auth:'bearer'`, `onError:'degrade'`. **Auth is the gating blocker**
  (Issue #2 still open) — so the *mock* chain generator is the default path and
  MUST be realistic enough to drive the analysts (see §3.2 mock contract).

### 1.3 Options greeks (per strike)

- **Need:** delta, gamma, vega, theta, rho — at minimum delta/gamma/vega/theta —
  so the options analysts can reason about directional exposure, convexity,
  time-decay, and vol sensitivity. Greeks are derivable from (spot, strike,
  expiry, rfr, iv, type) via Black–Scholes; we expose a **GreeksEngine**
  (`greeks.ts`) used BOTH by the mock path (to synthesize realistic greeks from
  the mock chain) AND, optionally, to validate/repair live greeks.
- **Fields:** `greeks[]` = `{ expiry, strike, type, delta, gamma, vega, theta,
  rho, iv_in, underlying_price, ttm_years, rfr }`.
- **Live source:** some providers return greeks inline (Polygon does not for
  aggs; ORATS/Tradier do). Where absent, compute from the chain via GreeksEngine.

### 1.4 Supporting reference data (new, required for option math)

- **Risk-free rate (rfr):** needed for Black–Scholes. `mock` = 0.043 (current
  ~4.3%); live = Treasury yield endpoint. Field `rfr`.
- **Dividend yield:** already in mock `market_data`; reuse for continuous-div
  adjusted BS (optional, can be ignored in v1).
- **Expiry calendar:** list of tradeable expiries for the ticker. Mock = next 4
  monthly + next 4 weekly Fridays.

> Design choice: the **Historical & Derivatives layer is one provider module**
> (`src/registry/logic/hist.ts`) returning `{ price_bars, option_chain, greeks,
> rfr, expiries }` for a ticker + profile. Equity agencies (long/medium/intraday)
> ignore the option fields; options agencies consume them. This keeps the data
> contract in ONE place and makes the parity fallback uniform.

---

## 2. Analysts — design principles

- Reuse the **declarative** path wherever the verdict is a weighted formula
  (no LLM). That is the cheapest, most testable, parity-safe route and is the
  established pattern (`onchain`, `intraday_momentum` example).
- Use the **fn** path only where real math or cross-ticker aggregation is
  needed (greeks engine, vol-surface fitting, multi-leg payoff — these are
  genuinely algorithmic, not formula-from-features-over-a-single-input).
- Every new analyst declares `dependsOn` correctly so the trace drawer wires
  its inputs, and declares `mock.ranges` keyed by *feature* (the documented
  pitfall — never key by `score`).
- Stages stay 1/2/3 so the wall + gatekeeper contract is unchanged.

### 2.1 New analysts (catalog)

| id | stage | kind | purpose | consumes |
|----|-------|------|---------|----------|
| `options_ingestion` | 1 | ingestion | Fetch/normalize historical price + option chain + greeks + rfr for the underlying(s). New node (does NOT reuse equity `data_ingestion` because the *shapes* differ — but it reuses `hist.ts`). | orchestrator |
| `vol_surface` | 2 | analyst (fn) | Build/summarize the IV surface (term structure + skew), fit a smooth surface, flag skew/kurtosis anomalies. | options_ingestion |
| `options_pricing` | 2 | analyst (fn) | Per-strike fair-value vs market (BS model price vs bid/ask mid), identify cheap/expensive options, surface edge. | options_ingestion, vol_surface |
| `options_greeks` | 2 | analyst (fn) | Per-strike greek exposures + portfolio greek roll-up; delta/gamma/vega/theta budget vs a target. | options_ingestion |
| `options_flow` | 2 | analyst (declarative) | Option-volume + open-interest + gamma-wall / dealer-positioning signals (where is the market "pinned"?). | options_ingestion |
| `options_technical` | 2 | analyst (declarative) | Underlying short-horizon technical (5m/1m) for timing entries — the options-aware twin of equity `technical`. | options_ingestion |
| `options_risk` | 2 | analyst (fn) | Options-specific risk: max loss per structure, gamma/vega blow-up, assignment/early-exercise, IV-crush, liquidity of the chosen strikes. | options_pricing, options_greeks, options_flow |
| (gatekeeper) | 3 | gatekeeper | Reuse existing `governance` but with **options-tuned params** (`vetoExtreme` tighter; an options-specific veto: reject if net-theta ≤ 0 on a debit spread, or if IV-percentile > threshold and not hedged). | all stage-2 |

> Why `options_ingestion` is a *new* node and not a param on the equity
> `data_ingestion`: the output channels (`option_chain`, `greeks`, `vol_surface`
> inputs) do not exist in the equity `fundamental_data/technical_data/...`
> contract. Reusing the equity ingestion would force options fields into
> equity state and break the long-term parity guarantee. New node = clean.

### 2.2 Greeks engine (shared, fn)

`src/registry/logic/greeks.ts` — pure functions, unit-tested independently:
- `bsPrice(type, S, K, T, r, sigma, q=0)` → theoretical price
- `bsGreeks(type, S, K, T, r, sigma, q=0)` → `{ delta, gamma, vega, theta, rho }`
  (vega per 1.00 vol, theta per year — document units)
- `yearsToExpiry(expiry, now)` and an `rfr` resolver.
This module is the single source of truth for greeks in both mock and live
paths, and is trivially unit-testable (known inputs → known greeks).

### 2.3 Volatility surface (fn)

`src/registry/logic/vol-surface.ts`:
- From the chain, build IV-by-strike (per expiry) → fit a simple skew
  (parabola/SSVI-lite) → expose term structure (IV vs expiry) and skew
  (IV vs moneyness). Output: `atm_iv`, `skew_slope`, `term_slope`, `iv_percentile`
  (vs the historical IV range we also generate), plus an `iv_rank`.
Used by `options_pricing` (edge) and `options_risk` (IV-crush).

---

## 3. Mock contracts (parity-safe defaults)

Because live keys are absent by default, the mock must produce *structurally
valid* options objects so the analysts and the UI render correctly with zero
external dependencies.

- `hist.ts` mock:
  - `price_bars`: N daily bars (N = lookback, default 90) + (for intraday
    agency) M 5m bars, seeded per ticker, with a believable random walk around a
    base price. Deterministic.
  - `option_chain`: for the next 4 monthly + 4 weekly expiries, strikes around
    spot at ±10 strikes × $5 spacing; for each: mid price from a BS price using a
    seeded IV (e.g. 0.25–0.6 by moneyness/skew), volume/OI seeded, `iv` stored.
  - `greeks`: computed from the chain via `bsGreeks` (real math, just fed mock
    S/K/T/iv) — so greeks are *internally consistent* with the mock chain (no
    fake-number drift).
  - `rfr`: 0.043; `expiries`: list above.
- Each options analyst's `mock.ranges` keyed by its *features* (e.g.
  `vol_surface`: `atm_iv`, `skew_slope`, `iv_percentile`; `options_flow`:
  `gamma_wall`, `call_put_ratio`; etc.), never by `score`.

---

## 4. Two new agencies

Both are `instrument:'OPTION'`. Both keep the **same stage shape** (intake →
analysis → decision) so the generic node + gatekeeper need no structural change;
only *membership* and *params* differ.

### 4.1 `options-swing` — Options Swing (days–weeks)

- `horizon: 'MEDIUM_TERM'`, `instrument:'OPTION'`.
- `description`: Calendar/diagonal/simple vertical structures on a multi-day to
  multi-week horizon. Emphasizes IV rank/skew edge + thematic direction; slower
  greeks (theta is a slow bleed, vega matters).
- Pipeline (8 nodes):
  1. `orchestrator`
  2. `options_ingestion`  (params: `{ lookbackDays: 90, intervals:['1d'], expiries:'monthly+weekly' }`)
  3. `vol_surface`        (params: `{ horizon:'MEDIUM_TERM' }`)
  4. `options_pricing`    (params: `{ targetStructures:['vertical','calendar'] }`)
  5. `options_greeks`     (params: `{ focus:'vega/theta' }`)
  6. `options_flow`       (params: `{ horizon:'MEDIUM_TERM' }`)
  7. `options_risk`       (params: `{ maxThetaBurnPct: 1.5, ivCrushGuard: true }`)
  8. `governance`         (params: `{ vetoExtreme:true, instrument:'OPTION',
                                  optionsVeto:{ maxIvPercentile: 90, requireHedge:true } }`)

### 4.2 `options-intraday` — Options Intraday (minutes–hours)

- `horizon: 'INTRADAY'`, `instrument:'OPTION'`.
- `description`: 0DTE / same-day structures, gamma scalping, fast underlying
  technical timing. Emphasizes tight liquidity, fast theta, intraday vol
  expansion; strict risk (no overnight gap, strict stop).
- Pipeline (9 nodes — adds the timing technician):
  1. `orchestrator`
  2. `options_ingestion`  (params: `{ lookbackDays: 5, intervals:['5m','1m'], expiries:'weekly+0dte' }`)
  3. `options_technical`  (params: `{ horizon:'INTRADAY', lookbackBars:5 }`)  ← underlying timing
  4. `vol_surface`        (params: `{ horizon:'INTRADAY', useFrontMonth:true }`)
  5. `options_pricing`    (params: `{ targetStructures:['0dte','vertical'], minLiquidity:true }`)
  6. `options_greeks`     (params: `{ focus:'gamma/delta', rollUp:'net' }`)
  7. `options_flow`       (params: `{ horizon:'INTRADAY' }`)
  8. `options_risk`       (params: `{ maxThetaBurnPct: 0.5, strictLiquidity:true, noOvernight:true }`)
  9. `governance`         (params: `{ vetoExtreme:true, instrument:'OPTION',
                                  optionsVeto:{ maxIvPercentile: 80, maxStopLoss:0.03, requireHedge:false } }`)

> Note: `options-intraday` adds `options_technical` (the 9th node) because
> intraday option timing is dominated by the *underlying's* micro-structure;
> the swing agency lets `vol_surface`/`options_pricing` carry timing instead.

---

## 5. Type / schema additions (minimal, backward-compatible)

- `AgencyDef.instrument?: 'EQUITY' | 'OPTION'` (optional → existing agencies
  default to `'EQUITY'`, no change to their behavior).
- `AnalystTuning` gains `instrument?: 'EQUITY' | 'OPTION'` (threaded from the
  agency in `AgencyGraph`/`GenericAnalystNode`, same pattern as `horizon`).
- New runtime result interfaces in `src/types/financial-analysis.ts`
  (`OptionChain`, `Greeks`, `VolSurface`, `OptionPricingResult`,
  `OptionRiskAssessment`) — all optional-on-state so equity path is untouched.
- New `DataSourceSpec` entries referenced only by `options_ingestion`
  (`polygonOptions`, `polygonHist`, `treasuryRfr`) — same REST/auth shape;
  catalog shows them in the per-card Settings panel (reuses the shipped
  card-settings feature automatically).

---

## 6. What is deliberately OUT of scope (v1)

- **Live keys / real providers** (Issue #2) — the design is live-ready but ships
  mock-first; enabling real data is a token-in-Settings-panel + provider swap,
  not a rewrite.
- **Multi-leg execution / brokerage** — we produce a *recommended structure* and
  its greeks/risk, not orders.
- **American-exercise early-exercise nuance, dividends, borrow** — BS with
  continuous-div assumption; good enough for the demo, noted as a KNOWN_ISSUE.
- **Futures/vol futures, crypto options** — equity options only in v1.

---

## 7. Phase plan (test-gated; STOP between phases for review)

- **Phase A — Data layer (no UI, no agencies).**
  - `src/registry/logic/greeks.ts` (BS price + greeks) + `greeks.test.ts`
    (known-value cases: ATM call delta≈0.5, etc.).
  - `src/registry/logic/hist.ts` provider returning `{ price_bars,
    option_chain, greeks, rfr, expiries }`; mock generators seeded; a
    `hist.test.ts` asserting deterministic, structurally-valid output and that
    greeks are consistent with the chain (BS(price) ≈ mid).
  - `src/registry/logic/vol-surface.ts` + `vol-surface.test.ts` (skew/term
    slopes from a synthetic chain).
  - **STOP / verify** (backend jest green, new units pass).

- **Phase B — Analyst defs + handlers.**
  - Add `options_ingestion`, `vol_surface`, `options_pricing`, `options_greeks`,
    `options_flow`, `options_technical`, `options_risk` to `ANALYST_DEFS`
    (declarative where possible; fn for the three algorithmic ones). Register fn
    handlers in `logic.ts`. Each with correct `dependsOn`, `features`,
    `mock.ranges` (keyed by feature), `output.channels`.
  - Bump `registry.test.ts` analyst-count + id assertions.
  - **STOP / verify** (jest green; each analyst emits exactly one trace; parity:
    long-term unchanged).

- **Phase C — New agencies + instrument threading.**
  - Add `options-swing` and `options-intraday` to `AGENCIES`; add
    `instrument` to `AgencyDef` + thread into `AnalystTuning`; extend
    `AgencyGraph`/`GenericAnalystNode` to forward `instrument`. Frontend mirror
    (`analysts.ts` `AnalystId` union + `AnalystMeta`, `agencies.ts` agency
    mirrors) updated in lockstep.
  - Agency-integrity tests; frontend wall shows the new cards per agency.
  - **STOP / verify** (jest + vitest green; `vite build` clean).

- **Phase D — Options-aware governance veto + types.**
  - Extend `governance` handler to read `tuning.instrument==='OPTION'` and apply
    the `optionsVeto` (IV-percentile cap, theta/hedge rules). New
    `governance-options.test.ts`.
  - Add the runtime result interfaces; ensure normalization ships them on
    `analysis_complete` for options agencies.
  - **STOP / verify** (jest + vitest green; a `request_analysis` with
    `agencyId:'options-intraday'` returns a populated `final_decision` + option
    traces).

- **Phase E — Docs + verification + cleanup.**
  - Update `ARCHITECTURE.md` (new data layer + 2 agencies + option channels),
    `KNOWN_ISSUES.md` (new §: options agencies shipped; note BS assumptions as a
    known limitation), and add an `ADDING_AN_OPTIONS_ANALYST` note to
    `ADDING_AN_ANALYST.md`.
  - Full gate: `npm test` (backend + frontend), `npm run build`, server boot +
    socket handshake, one live `request_analysis` per options agency.
  - **STOP / verify** → done.

---

## 10. Multi-Flavor Role & Instructions (LLM-driven analysis)

### 10.1 What this adds and why

Today every analyst has exactly ONE `prompt` (a static string) that is shown
only in the trace "Instructions" tab. No handler actually calls an LLM for the
analysis — the declared `prompt` is documentation, not execution. The instruction
here is explicit: **the LLM should perform the analytical work**, guided by each
analyst's Role & Instructions. And the user must be able to choose, edit, add,
and delete *flavors* of that Role & Instructions per analyst, stored server-side,
selected via a dropdown in the Settings panel.

This is a real new capability (an LLM execution step) plus a new
**per-analyst flavor registry** layered on top of the existing settings
infrastructure. It applies to ALL analysts — the new options analysts (§2) and,
by the same machinery, the existing equity ones. Long-Term is still frozen in
*behavior*: its shipped default flavor is the existing static prompt, and the
LLM step is **off by default for long-term** (see §10.7), so its output is
unchanged until a user explicitly enables a flavor.

### 10.2 Data model

A **flavor** is one named Role & Instructions bundle for an analyst:

```ts
interface AnalystFlavor {
  id: string;            // stable flavor id, e.g. 'default' | 'conservative' | uuid
  name: string;          // display label, e.g. 'Balanced', 'Momentum-leaning'
  role: string;          // one-line role line (replaces def.role in the trace header)
  instructions: string;  // the full system prompt the LLM runs under
  isDefault?: boolean;   // exactly one flavor per analyst is the default
}
```

An analyst's flavor set lives in two layers:

1. **Shipped defaults (code):** `AnalystDef.flavors: AnalystFlavor[]` — seeded in
   `src/registry/analysts.ts`. Every analyst MUST ship ≥ 1 flavor (the legacy
   `prompt` becomes `flavors[0]` = `{ id:'default', name:'Default', role,
   instructions: <old prompt> }`). At least one `isDefault:true`.
2. **User overrides (server, per session):** a new in-memory
   `AnalystFlavorStore`, keyed by `${sessionId}:${agencyId}:${analystId}`,
   holding the user's *current flavor set* for that analyst (may be the shipped
   set, or an edited/added/deleted variant). Pattern mirrors `AnalystParamsStore`
   / `AnalystConfigStore` (in-memory, never on disk, never echoed verbatim).

The **selected** flavor id is stored separately per
`${sessionId}:${agencyId}:${analystId}` (defaults to the flavor with
`isDefault:true`). It is merged into the resolved `AnalystDef.prompt` inside
`getGraph()` (same merge hook as `mergeSavedParams`), so the selected flavor
flows into BOTH the trace AND the LLM call.

### 10.3 LLM execution step (the "LLM does the work" part)

A new `src/registry/logic/llm.ts` provides a single, provider-agnostic call:

```ts
runAnalystLLM({ system: string /*selected flavor.instructions*/,
                user: string /*analyst-specific data summary*/,
                model?: string, temperature?: number }): Promise<LLMResult>
```

- **Provider:** behind an env-swappable client (OpenAI-compatible chat
  completions). If no key is configured, it **degrades** to a deterministic
  structured fallback (the existing declarative/fn scoring) so the pipeline
  still completes — parity preserved (no key = no behavior change).
- **Where it runs:** a new leaf in the handler contract. Declarative analysts
  gain an optional `logic.llm?: { enabled: boolean; model?: string;
  temperature?: number; summarizeField?: string }`. When `enabled` and a key
  is present, the declarative handler calls `runAnalystLLM` with the selected
  flavor's instructions + the resolved feature/input summary, and uses the
  LLM's returned verdict/score/summary in place of (or blended with) the
  weighted formula. Fn analysts (fundamental/technical/etc.) are refactored so
  they read `def.prompt` (the selected flavor) and pass it to `runAnalystLLM`
  instead of the hardcoded `instructionFor(id)` — **this is the one breaking
  change for fn analysts**, gated so that with no flavor selected / no key, they
  fall back to the legacy `instructionFor` path byte-for-byte.
- **Trace:** the "Instructions" tab already renders `def.prompt`; with flavors
  it renders the *selected flavor's* `instructions` + a `flavorId` tag, so the
  user can see which flavor ran. The LLM's raw output is captured in
  `trace.notes` (truncated) for auditability.

### 10.4 Flavor lifecycle & rules (the hard constraints)

- **MUST ship ≥ 1 flavor** per analyst. The store refuses to delete the last
  remaining flavor (`DELETE` on a set of size 1 → 400
  `cannot delete the last flavor`).
- **Add:** user supplies `{ name, role, instructions }`; server assigns a stable
  `id` (e.g. `uuid` or `custom-N`), marks it non-default unless it is the only
  one. New flavor is immediately selectable.
- **Edit:** user edits an existing flavor's `name`/`role`/`instructions`
  (including the shipped `default` — edits to a shipped flavor are stored as an
  override, the shipped definition is never mutated on disk). Edits apply to the
  next run for that session.
- **Delete:** allowed for any flavor EXCEPT the last one. Deleting the
  *selected* flavor resets the selection to the default flavor.
- **Select:** a dropdown in the Settings panel lists the analyst's current
  flavor set (name + id); choosing one stores the selected `flavorId`. The
  selection is per-analyst-per-agency-per-session (so e.g. the same analyst can
  run a conservative flavor in `options-swing` and an aggressive one in
  `options-intraday`).

### 10.5 New backend endpoints (extend the settings surface)

Reuse the shipped settings pattern; add a sibling to `/analyst-params`:

- `GET  /analyst-flavors?sessionId=&agencyId=&analystId=` →
  `{ flavors: AnalystFlavor[], selectedId: string }` (the resolved set =
  shipped defaults overlaid with the user's saved overrides).
- `POST /analyst-flavors` body `{ sessionId, agencyId, analystId, flavors:
  AnalystFlavor[], selectedId }` → full replace of the user's flavor set +
  selection (validated: ≥1 flavor, exactly one `isDefault` or implicit default,
  `selectedId` ∈ set). This single endpoint covers add/edit/delete/select —
  the client computes the new set locally and PUTs it.
- `GET /analyst-flavors/:analystId/catalog` (optional) → the shipped default
  flavors so the client can offer a "reset to shipped" action.

Server-side `AnalystFlavorStore.validate()` enforces: ≥1 flavor, no duplicate
ids, `selectedId` present in the set, every flavor has non-empty `instructions`.

### 10.6 Frontend changes (extend the shipped Settings dialog)

- `analystConfigSchema.ts` gains a `flavors: AnalystFlavor[]` + `selectedFlavorId`
  field (read-only catalog from `GET /analyst-flavors`). The Settings dialog
  renders a **Flavors** section (distinct from Weights/Sources) when
  `schema.flavors.length > 0`:
  - a **dropdown** to select the active flavor,
  - for the selected flavor: editable `name` / `role` / `instructions` (textarea),
  - **Add flavor** button (creates a new editable draft),
  - **Delete flavor** button (disabled when only one remains — enforces the
    "≥1" rule in the UI as well as the server),
  - **Save** posts the full set + selection to `POST /analyst-flavors`.
- A thin `api/analystFlavorsClient.ts` (same shape as `analystParamsClient.ts`).
- Editing an existing flavor and saving replaces that flavor in the set; the
  server stores it as an override. **The shipped default flavor can be edited
  but is never deleted from the code** — only the user's override of it.

### 10.7 Long-Term parity guard (critical)

- For `long-term`, the shipped `default` flavor is the existing static prompt and
  **`logic.llm.enabled` is `false`** for every long-term analyst. So with no
  config, long-term runs exactly as today: the LLM step is skipped, the
  declarative/fn scoring is used, and the trace shows the legacy instructions.
- Turning on LLM analysis for long-term requires the user to (a) select a flavor
  with `llm.enabled` and (b) supply a provider key — an explicit, opt-in action
  that cannot happen by accident. The long-term registry entries themselves are
  not modified; only the *user's saved flavor override* can enable it.

### 10.8 Seeded flavors for the new options analysts (examples)

Each new options analyst ships 2–3 flavors so the dropdown is meaningful from
day one (these are starting points the user can edit/extend):

- `sentiment` (existing equity analyst — flavor system covers it too):
  `['Default', 'Contrarian']`
- `vol_surface`: `['Default (skew-focused)', 'Term-structure-focused',
  'Earnings-vol aware']`
- `options_pricing`: `['Default (edge-hunter)', 'Income (premium-collector)',
  'Cheap-vol scanner', 'Earnings-play']`
- `options_greeks`: `['Default (net-greek budget)', 'Gamma-scalp',
  'Vega-neutral']`
- `options_flow`: `['Default (gamma-wall)', 'Dealer-positioning',
  'Retail-flow contrarian']`
- `options_technical`: `['Default (5m momentum)', 'VWAP-bounce', 'Breakout']`
- `options_risk`: `['Default (preservation-first)', 'Defined-risk only',
  'Aggressive-size guard']`
- `options_ingestion`: `['Default']` (single flavor — ingestion has no analytic
  judgment to vary; still satisfies "≥1".)

### 10.9 Phase plan addition (insert before §7 Phase E)

- **Phase F — Flavor system + LLM step.**
  - Types: `AnalystFlavor`, extend `AnalystDef.flavors`, `AgencyAnalystRef`
    carries no flavor (selection is runtime/server-side).
  - `AnalystFlavorStore` (+ validate, ≥1 rule) in `src/server/analyst-flavors.ts`;
    `registerAnalystFlavorsRoutes` (GET/POST) in `analyst-flavors-routes.ts`.
  - `mergeFlavors()` in `getGraph()` (sibling to `mergeSavedParams`) overrides
    `def.prompt` with the selected flavor's instructions + tags `def.flavorId`.
  - `src/registry/logic/llm.ts` provider client + deterministic fallback.
  - Refactor fn handlers to read `def.prompt` (+ optional `def.flavorId`) and
    call `runAnalystLLM` when `logic.llm.enabled`; declarative handlers gain the
    optional `logic.llm` branch. Long-term ships `llm.enabled:false`.
  - Frontend: `analystConfigSchema.ts` flavors field, `AnalystSettingsDialog`
    Flavors section (dropdown + add/edit/delete with ≥1 guard),
    `api/analystFlavorsClient.ts`, and a `flavors` test (add/edit/delete-select,
    cannot delete last).
  - **STOP / verify** (jest + vitest green; backend test proves selected flavor
    overrides `def.prompt` and that deleting the last flavor is rejected; a
    `request_analysis` with a flavor selected shows the flavor id in the trace
    and, with a key, an LLM-derived verdict; without a key, parity fallback).

The original phases A–E are unchanged; Phase F is prepended into the sequence so
flavors exist before the options agencies lean on them. Final order:
**A data → B analysts → C agencies → D governance veto → F flavors+LLM → E
docs/verify.**

---

## 11. Risk / rollback

- Long-term agency is never referenced by any new code path; its tests
  (`registry.test.ts` default-agency integrity, parity) continue to guard it.
- New analysts/agencies are additive keys in `AGENCIES`/`ANALYST_DEFS`; a bad
  phase is isolated to new ids and can be reverted file-locally.
- `instrument` is optional; equity agencies run exactly as today with
  `instrument` undefined.
- All live sources use `onError:'degrade'` + `onAllSourcesFailed:'useMock'` so
  the default (no token) run is deterministic and unchanged in shape — parity
  preserved end-to-end.

---

## 12. LLM Provider / Model Configuration

### 12.1 What this adds and why

The flavor system (§10) defines *what* the LLM should think; this section
defines *which LLM* executes it. Before any flavor can call `runAnalystLLM`
(§10.3), the server must know the provider, model, and auth token to use — and
the user must be able to configure **multiple** LLM models across **multiple
API providers**, not a single global key. This is a distinct concern from the
market-data credentials (`runtimeConfig.accessToken` / `/analyst-config`): data
keys talk to Yahoo/AlphaVantage/Polygon; LLM keys talk to OpenAI/Anthropic/
OpenRouter. They are stored and surfaced separately.

**Preconfigured defaults (shipped, no user action required):** three model
profiles, all defaulting to the **Anthropic `claude-opus-4-8`** model routed
through **OpenRouter**, each with an empty token (so the pipeline degrades to
the deterministic fallback until a key is supplied). The three roles:

| role id | name | intended use | default model | default provider | default token |
|---------|------|--------------|---------------|------------------|---------------|
| `deep-thought` | Deep Thought | heavy reasoning / final synthesis (governance, fundamental deep-dive) | `claude-opus-4-8` | `openrouter` | `''` |
| `scanner` | Scanner | fast, high-volume triage (flow scans, screening, sentiment) | `claude-opus-4-8` | `openrouter` | `''` |
| `flexible` | Flexible | general-purpose middle ground (technical, pricing, greeks) | `claude-opus-4-8` | `openrouter` | `''` |

Because all three default to the same model/provider, the only thing a user must
supply to "turn on" LLM analysis is a single OpenRouter token (applied to all
three, or overridden per role). Until then, every `runAnalystLLM` call hits the
no-key deterministic fallback and the pipeline output is unchanged (parity).

### 12.2 Data model

```ts
type LlmProvider = 'openrouter' | 'openai' | 'anthropic' | 'azure' | 'ollama' | string;

interface LlmModelConfig {
  role: 'deep-thought' | 'scanner' | 'flexible'; // the fixed role id
  name: string;                 // display label, e.g. 'Deep Thought'
  provider: LlmProvider;        // e.g. 'openrouter'
  baseUrl: string;              // provider base URL (openrouter → https://openrouter.ai/api/v1)
  model: string;                // model id, e.g. 'anthropic/claude-opus-4-8'
  token: string;                // API key; '' = unconfigured → fallback
  temperature?: number;         // optional per-role default
}

// The server-side store holds one LlmModelConfig per role (3 slots).
```

- **Roles are fixed** (`deep-thought` / `scanner` / `flexible`) — the user
  edits each role's provider/model/token but cannot add/delete roles. This keeps
  the flavor→model mapping stable (see §12.4).
- **Multiple providers / multiple models** = the three roles can each point at a
  *different* provider and model. So "multiple LLM models / tokens / API
  providers" is satisfied by configuring the three roles independently (e.g.
  deep-thought → OpenRouter/claude-opus-4-8, scanner → OpenAI/gpt-4o-mini,
  flexible → a local Ollama/llama3). The architecture also permits a future
  N-slot store, but 3 fixed roles is the v1 contract (matches the instruction).
- A `resolveLlmConfig(role)` returns the effective config; unknown/empty token →
  signals `runAnalystLLM` to use the deterministic fallback.

### 12.3 Backend storage + endpoints (separate from data credentials)

New `src/server/llm-config.ts` — `LlmConfigStore`, in-memory, per-session,
mirroring `connectionConfigStore` / `analystConfigStore` (never on disk, token
never logged/echoed). Seeded at construction with the three default
`LlmModelConfig` entries above (openrouter / claude-opus-4-8 / empty token).

Endpoints (sibling to `/config` and `/analyst-config`):
- `GET  /llm-config?sessionId=` → `{ models: LlmModelConfig[] }` (the three
  roles with their current provider/model/token-present flag).
- `POST /llm-config` body `{ sessionId, models: LlmModelConfig[] }` → validate
  (exactly the three role ids present, each with a non-empty `model`, provider in
  the allowed set, `baseUrl` valid http(s) when provider needs one) and store.
  `token` is accepted but **never echoed back** in the GET response (only a
  `hasToken` boolean per role, like `/analyst-config`).
- `GET  /llm-config/status` → `{ deep-thought:{provider,model,configured:bool},
  scanner:{…}, flexible:{…} }` for the UI to show which roles are live.

`runAnalystLLM` (§10.3) reads the resolved config from this store (via
`state.runtimeConfig.llm` or a dedicated inject), NOT from `accessToken`. This
keeps data-auth and LLM-auth on separate channels (no accidental leakage of a
market-data key into an LLM call, or vice-versa).

### 12.4 Wiring flavors → LLM roles (default ALL = deep-thought; model assigned to an Agency)

Each `AnalystFlavor` (§10.2) gains an optional `modelRole`:
`'deep-thought' | 'scanner' | 'flexible' | undefined`.

**Initial-start default — everything is deep-thought.** Every shipped flavor
(including all the new options-analyst flavors and the long-term default flavor)
seeds `modelRole: 'deep-thought'`. No agency sets a different default. Therefore,
out of the box, every analyst runs on the `deep-thought` role regardless of which
agency or flavor is selected. The user escalates to `scanner` / `flexible` only
by explicitly editing a flavor (or assigning a model to an agency — see below).

**Resolution order — which role a flavor actually uses:**
1. `flavor.modelRole` — explicit, per-analyst, editable in the Settings dropdown
   (highest priority).
2. `agencyModelRole` — a *per-agency* override the user assigns through the
   Settings UI (see §12.4.1). Applies to every flavor in that agency that does
   not set its own `modelRole`.
3. `AgencyDef.llmModelRole` — the agency's code-level default (initially unset
   for all agencies → falls through).
4. Global fallback `'deep-thought'`.

So "a model can be assigned to an Agency" is implemented at layers (2)/(3): the
user picks a model role for the whole agency in Settings, and every analyst in
that agency inherits it unless the analyst's own flavor overrides it.

When a flavor is selected (§10) and `logic.llm.enabled`, the handler calls
`runAnalystLLM({ ..., role: resolveModelRole(flavor, agency) })`, where
`resolveModelRole` applies the order above. This is how the architecture
"accounts for the selected flavor" end-to-end:
- the dropdown picks the flavor →
- the flavor carries `instructions` (WHAT to think) + resolved `modelRole`
  (WHICH LLM) →
- `mergeFlavors()` (§10.2) injects both into the resolved `AnalystDef` →
- the handler runs `runAnalystLLM` against the configured provider for that role.

**§12.4.1 Per-agency model assignment (server-side).** Extend the settings
surface with a per-agency `agencyModelRole` override, stored in-memory keyed by
`${sessionId}:${agencyId}` (mirrors the flavor/params stores). Exposed via:
- `GET  /llm-config?agencyId=` → includes the agency's current `agencyModelRole`
  (or null).
- `POST /llm-config` body gains `{ agencyId, agencyModelRole? }` → stores the
  agency-level assignment (validated: must be one of the three roles or null).
The Settings "LLM Models" section gets a small **"Default model for this
agency"** control (dropdown of the three roles + "inherit (deep-thought)").

**Seeded mapping (initial start).** All flavors seed `modelRole:'deep-thought'`.
The earlier per-analyst split (governance→deep-thought, pricing→flexible,
flow→scanner, …) is NOT applied at seed time — it is offered only as *example
reassignments* a user may make later via the flavor dropdown. Long-term keeps
`logic.llm.enabled:false` (§10.7), so its `modelRole` is moot until a user opts
in; when they do, it too defaults to `deep-thought`.

### 12.5 Frontend (the 3 LLM models live in the main top-right Settings dialog)

The three LLM model configs are configured through the **main [⚙ Settings]
button in the top-right corner** of the page (the same `SettingsDialog` that
holds the connection settings — `App.tsx` topbar `⚙ Settings` →
`SettingsDialog`). They are NOT a separate panel.

The `SettingsDialog` becomes **tabbed** (one modal, two tabs) so the existing
connection config and the new LLM config coexist in the one dialog the user
already opens from the top-right:

- **Tab "Connection"** — the existing backend URI / access token / extra
  params (unchanged behavior, still POSTs to `/config`).
- **Tab "LLM Models"** — the three preconfigured roles as editable rows:
  - role name (read-only label: Deep Thought / Scanner / Flexible),
  - provider (dropdown of allowed providers: openrouter | openai | anthropic |
    azure | ollama),
  - base URL (auto-filled from the provider default, editable),
  - model (text, default `anthropic/claude-opus-4-8` shown),
  - token (password input; never shown back — UI shows a `configured`/`not
    configured` chip per role, matching the `/analyst-config` never-echo-token
    pattern).
  - a **"Default model for this agency"** control (§12.4.1) — a dropdown of the
    three roles + "inherit (deep-thought)" — which POSTs the per-agency
    `agencyModelRole` with the LLM config.

Both tabs share the single dialog's Save/Cancel. The LLM Models tab fetches
`GET /llm-config` on open (to populate the three roles + their `hasToken`
status) and POSTs the full `LlmModelConfig[]` (+ optional `agencyModelRole`) to
`POST /llm-config` on save. The connection tab continues to POST `/config`
independently.

This reuses the existing `SettingsDialog` overlay/markup, the existing top-right
button, and the same never-echo-token pattern as the data-source credentials.
No new top-level button is added.

### 12.6 Parity & safety

- All three roles ship with empty tokens → `runAnalystLLM` always hits the
  deterministic fallback when unconfigured → zero behavior change vs today.
- Tokens are in-memory per session, never logged (logger strips them), never in
  the client bundle after POST (GET returns `hasToken` only).
- The three roles are independent slots, so a bad/missing token on one role
  degrades only the analysts mapped to that role; other roles keep working.
- No change to `long-term` registry entries; the LLM step there stays opt-in.

### 12.7 Phase plan addition

- **Phase G — LLM provider/model configuration.**
  - `LlmModelConfig` type + `LlmConfigStore` (seeded with the 3 OpenRouter/
    claude-opus-4-8 defaults, empty tokens) in `src/server/llm-config.ts`;
    `registerLlmConfigRoutes` (GET/POST/status) in `llm-config-routes.ts`.
  - `config.ts` gains default `llm` base-URLs per provider (openrouter →
    `https://openrouter.ai/api/v1`, openai → `https://api.openai.com/v1`,
    anthropic → `https://api.anthropic.com/v1`, ollama → `http://localhost:11434/v1`).
  - `runAnalystLLM` (§10.3) extended to accept a `role` and resolve provider/
    model/token from `LlmConfigStore`; no-key → fallback.
  - `AnalystFlavor.modelRole` added; `mergeFlavors` injects `modelRole` with
    `instructions`; handlers pass `role` to `runAnalystLLM`.
  - Frontend: `SettingsDialog` gains an "LLM Models" tab (the 3 role rows +
    per-agency model control) + `api/llmConfigClient.ts`; the top-right `⚙
    Settings` button already opens this dialog (no new button). Backend test
    proves the 3 defaults seed correctly, a POST overrides a role, and GET never
    echoes tokens; a `runAnalystLLM` unit test proves role→config resolution +
    no-key fallback. `SettingsDialog.llm.test.tsx` (vitest) drives the tab:
    opens LLM Models, shows three role rows, token inputs are password + show
    configured chips (never raw token), per-agency dropdown posts
    `agencyModelRole`, Save POSTs `/llm-config`.
  - **STOP / verify** (jest + vitest green; the three preconfigured models are
    present on a fresh server with empty tokens; supplying a token for one role
    flips only that role's `configured` flag).

Final phase order:
**A data → B analysts → C agencies → D governance veto → F flavors+LLM →
G LLM provider config → E docs/verify.** (G can run before F's LLM wiring is
exercised, but the 3 defaults must exist before any flavor selects a role.)

---

## 14. Unit test plan for new functionality

All new backend logic gets **jest** tests (mirroring the existing `*.test.ts`
colocation); all new React gets **vitest + Testing-Library** (mirroring
`frontend/src/test/*`). A phase is NOT marked done until its tests below are
green. The long-term parity tests in `registry.test.ts` / `agencies.test.ts`
must stay green throughout (they enforce "leave Long-Term as is").

### Phase A — historical data + greeks (jest)
- `hist.test.ts`: daily + intraday bars build correct OHLCV arrays; `intraday`
  yields more rows than `daily` for the same lookback; `buildOptionChain`
  returns strikes around spot, each with bid/ask/last/vol/OI/IV; **greeks on
  every strike are BS-consistent with the chain's IV** (round-trip: recovered IV
  ≈ input IV within ε); rfr defaults 4.3% when absent and honors a supplied rfr;
  **no-key determinism** (stable seeded mock, parity-safe); `onError:'degrade'`
  + `onAllSourcesFailed:'useMock'` return the mock shape without throwing.
- `greeks.test.ts`: delta/gamma/vega/theta/rho match closed-form values for
  known (S,K,r,σ,t) inputs within tolerance.

### Phase B — new analyst defs (jest, extends `registry.test.ts`)
- Each new options analyst validates: required id/name/stage/role, `features`/
  `logic` present, **≥1 flavor with a `default`**, non-empty `instructions` on
  the default flavor, `modelRole` present (all seed `'deep-thought'`).
- **Long-term parity guard**: long-term def is byte-identical to today — assert
  its analyst ids, params, and `logic.llm.enabled===false`.

### Phase C — new agencies (jest, extends `agencies.test.ts`)
- `options-swing` (MEDIUM_TERM, instrument OPTION, 8 nodes) and `options-intraday`
  (INTRADAY, instrument OPTION, 9 nodes) exist; node counts + stages correct;
  `instrument:'OPTION'` set; every analyst ref resolves; `defaultAgency()` still
  returns long-term (exactly one `default:true`).
- `resolveModelRole` returns `'deep-thought'` when nothing is set (covers
  "default ALL to deep-thought").

### Phase D — options governance veto (jest)
- governance with `instrument:OPTION` + `optionsVeto` REJECTS a structure whose
  IV percentile > cap (90 swing / 80 intraday) and (swing) one lacking a hedge;
  intraday veto is stricter (no-overnight) and still APPROVES a clean structure;
  long-term governance path unchanged (equity veto only).

### Phase F — flavors + LLM step (jest + vitest)
- `AnalystFlavorStore.test.ts`: seeds ≥1 flavor; `get` returns the set; `put`
  replaces set + selection; **`delete` on a set of size 1 is rejected**
  (`cannot delete the last flavor`); `validate` rejects empty `instructions`,
  duplicate ids, `selectedId` not in set; deleting the selected flavor resets
  selection to default.
- `mergeFlavors.test.ts`: with a selected flavor, resolved `AnalystDef.prompt`
  equals the flavor's `instructions`, `def.flavorId` is set, and `modelRole`
  resolves per §12.4 order; no selection → falls back to default flavor.
- `runAnalystLLM.test.ts`: no token → deterministic fallback (no network); token
  set → calls the configured provider for the resolved role.
- `AnalystSettingsDialog.flavors.test.tsx` (vitest): dropdown lists flavor names;
  selecting stores `selectedFlavorId`; **Add** creates a draft; editing updates
  the flavor; **Delete** disabled when only one flavor remains, enabled otherwise;
  **Save** POSTs full set + selection to `/analyst-flavors`.

### Phase G — LLM provider/model config (jest + vitest)
- `LlmConfigStore.test.ts`: constructs with the **three preconfigured roles**
  (`deep-thought`/`scanner`/`flexible`), each `provider:'openrouter'`,
  `model:'claude-opus-4-8'`, `token:''`; `put` overrides a role; `get` **never
  echoes `token`** (returns `hasToken` only); `status` reports `configured:false`
  for all three on a fresh store.
- `resolveLlmConfig.test.ts`: each role maps to its provider/baseUrl/model; empty
  token signals fallback; a POSTed OpenAI role resolves to the OpenAI base URL.
- `resolveModelRole.test.ts`: flavor → agency override → agency def →
  `'deep-thought'` precedence; "assign a model to an agency" makes every flavor
  in that agency inherit it unless overridden.
- `SettingsDialog.llm.test.tsx` (vitest): LLM Models section shows three role
  rows; token inputs are password-type and show `configured` chips (never raw
  token); saving POSTs to `/llm-config`.

### Agency dropdown (frontend, vitest) — see §15
- `AgencySelect.test.tsx`: renders one `<option>` per agency (including the new
  `options-swing`/`options-intraday` once added), shows the agency name, reflects
  the selected value, fires `onChange` with the agency id, and carries the accent
  styling class so the restyled pill renders.

---

## 15. Agency dropdown restyle (UX)

The current `AgencySelect` is a bare native `<select>` with only a
`.agency-select` class and **no CSS rule** — it renders with browser defaults
("too bland"). Restyle it to match the app's dark/slate + vibrant-accent theme
(consistent with `.topbar-actions button` and the `.analyst-panel` frames) while
keeping it a **native `<select>`** for accessibility (no custom listbox that
breaks keyboard/screen-reader support).

**Markup change (`AgencySelect.tsx`):** wrap the select in a styled pill; show the
agency name as the select label and a muted description sub-line; add an accent
left-border and a custom chevron (CSS, `appearance:none`).

```tsx
<label className="agency-select" title={current?.description ?? ''}>
  <span className="agency-select-label">Agency</span>
  <span className="agency-select-field">
    <select
      className="agency-select-input"
      value={value}
      onChange={(e) => onChange(e.target.value as AgencyId)}
      aria-label="Select analysis agency"
    >
      {AGENCY_IDS.map((id) => (
        <option key={id} value={id}>{AGENCIES[id].name}</option>
      ))}
    </select>
    <span className="agency-select-chevron" aria-hidden>▾</span>
  </span>
  <span className="agency-select-meta">{current?.description}</span>
</label>
```

**CSS (add to `frontend/src/index.css`):**

```css
.agency-select {
  display: inline-flex;
  flex-direction: column;
  gap: 0.25rem;
  padding: 0.45rem 0.7rem;
  border: 1px solid rgba(148, 163, 184, 0.3);
  border-left: 3px solid var(--accent, #6366f1);
  border-radius: 10px;
  background: linear-gradient(160deg, rgba(15,23,42,0.95), rgba(2,6,23,0.95));
  color: #e2e8f0;
  box-shadow: 0 6px 18px rgba(0,0,0,0.3);
}
.agency-select-label {
  font-size: 0.68rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: #94a3b8;
}
.agency-select-field { position: relative; display: inline-flex; align-items: center; }
.agency-select-input {
  appearance: none; -webkit-appearance: none;
  background: transparent; border: none;
  color: #f8fafc; font-size: 0.95rem; font-weight: 600;
  padding: 0.2rem 1.6rem 0.2rem 0.2rem; cursor: pointer; min-width: 200px;
}
.agency-select-input:focus-visible { outline: 2px solid var(--accent, #6366f1); outline-offset: 2px; border-radius: 6px; }
.agency-select-input option { background: #0f172a; color: #e2e8f0; }
.agency-select-chevron { position: absolute; right: 0.4rem; pointer-events: none; color: var(--accent, #6366f1); font-size: 0.8rem; }
.agency-select-meta { font-size: 0.7rem; color: #64748b; max-width: 320px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
```

This yields a dark pill with an accent left-bar, a custom chevron, a muted
description line, and a focus ring — consistent with the rest of the UI. It is a
standalone, low-risk change implementable immediately and independent of the
phased build; spec'd here per the "document first" rule.

---

## 17. ROLE & INSTRUCTIONS CATALOG (canonical seed text for flavors)

This section is the **canonical, verbose Role & Instructions** for every analyst
— both the 6 existing equity analysts (expanded far beyond their current short
prompts) and the 7 new options analysts. Phase B seeds each analyst's
`flavors[0]` (`default`) with the `role` + `instructions` below. The structure is
fixed so an LLM receives consistent, machine-actionable guidance:

```
ROLE            — one-line mandate (the "who you are")
OBJECTIVE       — the single decision the analyst must drive
SCOPE & INPUTS  — exactly which pipeline fields it may read (maps to the
                  analyst's dataSources/features), so the LLM never invents data
METHOD          — ordered reasoning steps the LLM must follow
OUTPUT CONTRACT — the exact shape it must emit (score/verdict/summary + channels)
SCORING RUBRIC  — how to derive the 0–100 score / verdict (so results are auditable)
GUARDRAILS      — hard limits and what triggers a RED flag or veto referral
EXAMPLE         — a short worked illustration
```

All instructions are written in second person, imperative, and explicitly tell
the LLM to (a) only use supplied inputs, (b) show its derivation, and (c) output
the verdict in the mandated format. Every new options analyst seeds
`modelRole: 'deep-thought'` (§12.4).

### 17.1 Existing equity analysts (expanded)

#### orchestrator
- ROLE: Orchestrator — the routing and sequencing controller of the pipeline.
- OBJECTIVE: Turn a raw user request into a clean, complete, normalized brief
  and guarantee correct pipeline ordering, with Governance last.
- SCOPE & INPUTS: `query`, `tickers[]`, `options` (depth, horizon, risk tolerance).
  You do NOT read market data; you read only the user's intent and the options.
- METHOD:
  1. Normalize the ticker universe (uppercase, de-dup, drop empty). If zero
     valid tickers, halt and return a clear error — do not fabricate symbols.
  2. Resolve analysis options with sane defaults: depth ∈ {QUICK, STANDARD,
     DEEP}; horizon from the agency; risk tolerance ∈ {CONSERVATIVE, MODERATE,
     AGGRESSIVE}. If the user request implies a horizon, prefer it but never
     contradict the agency's allowed horizon set.
  3. Emit a per-ticker task list and route each ticker in parallel to
     Fundamental, Technical, Sentiment (and Risk after they complete).
  4. Enforce ordering: ingestion → the three stage-2 analysts → risk →
     governance. Governance MUST be the final node.
  5. Attach the resolved `options` to every downstream message so each analyst
     applies the same depth/horizon/risk lens.
- OUTPUT CONTRACT: `tasks`, `workflow_control`. No verdict — your product is a
  correct, complete brief.
- SCORING RUBRIC: N/A (control node). Success = every ticker routed with options
  attached and no downstream agent starved of inputs.
- GUARDRAILS: Never emit a buy/sell. Never alter the analyst set. If the request
  is ambiguous, pick the conservative default and note the assumption.
- EXAMPLE: Input `{"tickers":["aapl","tsla"],"options":{}}` → you normalize to
  AAPL, TSLA; set depth=STANDARD, horizon=agency default, risk=MODERATE; emit
  tasks for both; stamp `workflow_control` so ingestion runs first.

#### data_ingestion
- ROLE: Data Ingestion — collector and standardizer of all upstream data.
- OBJECTIVE: Deliver a complete, quality-checked dataset to every downstream
  analyst; flag gaps instead of hiding them.
- SCOPE & INPUTS: from orchestrator `tickers`, `options`; live sources Yahoo /
  Alpha Vantage / Finnhub (degrade to mock on failure). Fields: `balance_sheet`,
  `income_statement`, `cash_flow`, `key_ratios`, `price`, `volume`, `indicators`,
  `news_sentiment`, `social_sentiment`, `analyst_sentiment`, `market` context.
- METHOD:
  1. For each ticker, fetch fundamental, technical, sentiment, and market context
     in parallel; respect per-source `onError:'degrade'`.
  2. Normalize to a common schema (dates ISO, currencies USD, splits adjusted).
  3. Run completeness + freshness checks; record per-source status
     (ok/skipped/failed/fallback).
  4. If ALL sources fail for a ticker, use the deterministic mock so the pipeline
     still completes, and mark `usedMockFallback`.
  5. Attach `sourceStatus` and `dataHealth` so the Risk and Governance nodes can
     weight confidence.
- OUTPUT CONTRACT: `fundamental_data`, `technical_data`, `sentiment_data`,
  `market_data` (storeInMessages). Never emit a score.
- SCORING RUBRIC: N/A. Success = every requested ticker has all four channels
  populated (real or mock) with source status recorded.
- GUARDRAILS: Never fabricate a value you did not receive or mock — if a field is
  absent, emit `null` and flag it. Never log tokens. Never mutate the user's
  tickers.
- EXAMPLE: AAPL requested; Yahoo times out → degrade, Alpha Vantage returns
  fundamentals → `sourceStatus.yahoo='failed'`, `alphaVantage='ok'`,
  `dataHealth.degradedAnalysts` notes the gap.

#### fundamental
- ROLE: Fundamental Analyst — judge of intrinsic business quality and valuation.
- OBJECTIVE: Produce a per-ticker financial-health score (0–100) and a clear
  bull/bear verdict grounded in statements and ratios.
- SCOPE & INPUTS (read only these): `balance_sheet` (assets, liabilities, equity,
  cash, total debt), `income_statement` (revenue, margins, EPS, operating income),
  `cash_flow` (operating/investing/financing/FCF), `key_ratios` (P/E, P/B,
  D/E, current ratio, ROE, ROA, profit margin). Plus `debt_to_equity`,
  `current_ratio`, `roe`, `profit_margin`, `free_cash_flow_yield` as the
  precomputed features.
- METHOD:
  1. Quality first: liquidity (current ratio) and leverage (D/E) — penalize low
     liquidity and high leverage hard; these are survival conditions.
  2. Profitability: ROE, profit margin, FCF yield — reward durable,
     cash-generative businesses.
  3. Valuation sanity: P/E and P/B vs sector norm; flag extremes (over- or
     under-valued) but do not let valuation alone flip the verdict.
  4. Red/green flags: enumerate 2–4 concrete flags with the metric that drove
     them (e.g. "RED: D/E 3.1 vs sector 1.4").
  5. Combine into a 0–100 health score; higher = healthier.
- OUTPUT CONTRACT: `fundamental_analysis` with `financial_health_score`,
  `red_flags[]`, `green_flags[]`, per-ticker verdict.
- SCORING RUBRIC: start 50; +liquidity (+0..15), +leverage discipline
  (+0..15), +profitability (+0..15), +cash generation (+0..15), −valuation
  extremes (−0..10). Clamp 0–100. Verdict: ≥70 STRONG, 50–69 OK, 35–49 WEAK,
  <35 AVOID.
- GUARDRAILS: Only use supplied ratios — never estimate a ratio you weren't
  given. A missing critical field (e.g. no balance sheet) → cap score ≤ 40 and
  flag "insufficient data".
- EXAMPLE: ticker with D/E 0.9, current ratio 2.1, ROE 24%, margin 18%, FCF
  yield 5% → flags green on leverage/liquidity/profitability; score ~82 STRONG.

#### technical
- ROLE: Technical Analyst — reader of price, trend, momentum, and volatility.
- OBJECTIVE: Produce a per-ticker technical score (0–100) and a trend verdict
  from price structure and indicators.
- SCOPE & INPUTS (read only these): `price` OHLCV, `volume`, `indicators`
  (SMA20/50/200, EMA12/26, RSI, MACD[macd/signal/histogram], Bollinger bands,
  beta, 30d volatility), `support/resistance` levels. Precomputed features:
  `rsi`, `sma_20`, `sma_50`, `volatility_30d`.
- METHOD:
  1. Trend: SMA stack (price > SMA20 > SMA50 > SMA200 = strongest), slope of
     each; EMA cross direction.
  2. Momentum: RSI zone (50–70 constructive, >70 overbought, <30 oversold),
     MACD histogram sign and crossover.
  3. Volatility & levels: position vs Bollinger bands; distance to nearest
     support/resistance; beta vs market; 30d volatility regime.
  4. Synthesis: trend alignment + bullish momentum lift score; broken support or
     overbought RSI apply penalty; falling wedges/accumulation noted as context.
- OUTPUT CONTRACT: `technical_analysis` with `technical_score`, `trend`,
  `momentum_read`, `key_levels`, per-ticker verdict.
- SCORING RUBRIC: start 50; +trend alignment (+0..25), +momentum (+0..20),
  −overbought/breakdown (−0..20), +volume confirmation (+0..5). Clamp 0–100.
  Verdict: ≥65 BULLISH, 45–64 NEUTRAL, <45 BEARISH.
- GUARDRAILS: Do not predict price targets you cannot derive from levels. If
  price data is mock/empty, note "structure inferred from proxy" and cap
  confidence.
- EXAMPLE: price above all SMAs, RSI 62, MACD histogram positive, volume rising →
  score ~74 BULLISH, note "no overbought".

#### sentiment
- ROLE: Sentiment Analyst — gauge of the narrative and crowd positioning.
- OBJECTIVE: Produce a per-ticker sentiment score (−100..+100) and flag
  source divergences.
- SCOPE & INPUTS (read only these): `news_sentiment` (items: title, summary,
  source, timestamp), `social_sentiment` (mention volume + score), `analyst_`
  `sentiment` (rating posture, revisions). Precomputed: `news_score`,
  `social_score`.
- METHOD:
  1. Weight: news substance + analyst posture dominate (each ~35%); social is a
     confirmation/divergence signal (~30%).
  2. Recency: weight last 7 days more than older items; decay stale news.
  3. Divergence detection: if |news − social| > 40, flag "narrative split" and do
     not let one channel dominate.
  4. Net into −100..+100; label BULLISH/NEUTRAL/BEARISH.
- OUTPUT CONTRACT: `sentiment_analysis` with `sentiment_score`, `news_score`,
  `social_score`, `divergence_flag`, `key_news[]`.
- SCORING RUBRIC: weighted net of channel scores, clamped −100..+100. Verdict:
  ≥30 BULLISH, −29..29 NEUTRAL, <−29 BEARISH.
- GUARDRAILS: Never treat volume of posts as conviction — weight credibility.
  If all channels mock, mark low confidence.
- EXAMPLE: news +60, analyst +40, social −10 → net +42 BULLISH but flag
  "social divergence (bearish retail)".

#### sentiment — flavor `Contrarian`
- ROLE: Contrarian Sentiment Analyst — you deliberately fade crowded, one-sided
  narratives and hunt for unrecognized opportunity where the crowd is wrong.
- OBJECTIVE: Produce a per-ticker contrarian sentiment score (−100..+100) that
  inverts extreme crowd positioning and flags when wholesale bearishness (or
  euphoria) is likely mispriced.
- SCOPE & INPUTS (read only these): same fields as the Default sentiment flavor —
  `news_sentiment`, `social_sentiment` (volume + score), `analyst_sentiment`
  (posture, revisions), with `news_score`, `social_score` precomputed. You also
  read the `risk_level` and `technical_score` from downstream context so you can
  confirm a contrarian thesis with a non-crowded technical setup.
- METHOD:
  1. Measure crowd extremity: compute the crowd net via the same weighting as
     Default, but record how close it sits to the ±100 rails (|net| > 70 = highly
     crowded).
  2. Apply the contrarian inversion: a highly crowded BULLISH crowd (net ≥ 70)
     biases your score BEARISH (fade the euphoria); a highly crowded BEARISH
     crowd (net ≤ −70) biases your score BULLISH (fade the panic). Moderate
     crowds (|net| < 40) are taken at face value — do NOT force a contrarian
     tilt where none is warranted.
  3. Confirm with a second leg: a contrarian BULLISH call requires either
     improving analyst revisions or a stabilizing/oversold technical read; a
     contrarian BEARISH call requires deteriorating fundamentals/risk or an
     overbought technical read. If the second leg contradicts, soften the call
     (label "weak contrarian").
  4. Divergence still matters: if social is extreme but news/analyst are not,
     fade social only — partial inversion, not full.
  5. Output the contrarian score and an explicit "faded crowd" annotation so the
     trace is auditable.
- OUTPUT CONTRACT: same channels as Default — `sentiment_analysis` with
  `sentiment_score`, `news_score`, `social_score`, `divergence_flag`,
  `key_news[]` — plus a `contrarian_note` field ("faded bullish crowd" /
  "faded bearish crowd" / "none").
- SCORING RUBRIC: start from the crowd net; if |net| > 70, multiply the sign by
  −1 and tag `faded`; clamp −100..+100. Verdict bands same as Default. A "weak
  contrarian" call is down-weighted (label appended).
- GUARDRAILS: Never force a contrarian stance on a non-extreme crowd — that is
  the most common error and produces worse-than-Default calls. Never ignore a
  genuinely fundamental red flag just to be contrarian (risk/governance still
  veto). If all channels mock, mark low confidence.
- EXAMPLE: crowd net +78 (euphoric retail + bullish news), but analyst revisions
  turning negative and RSI 78 → contrarian score −55 "faded bullish crowd",
  note "weak contrarian: fundamentals deteriorating".

#### risk
- ROLE: Risk Analyst — capital preservation specialist.
- OBJECTIVE: Classify overall risk and recommend position sizing + hard stops.
- SCOPE & INPUTS (read only these): fundamental `financial_health_score`,
  `red_flags`; technical `technical_score`, `volatility_30d`, `beta`; sentiment
  `sentiment_score`; market context (vol index, trend, sector, beta).
- METHOD:
  1. Aggregate: combine the three scores with market regime; high vol index or
     bearish market raises the risk level.
  2. Classify LOW / MEDIUM / HIGH / EXTREME with explicit factors + severity.
  3. Sizing: max allocation % inversely proportional to risk level and volatility
     (EXTREME ≤ 5%, HIGH ≤ 10%, MEDIUM ≤ 20%, LOW ≤ 35%).
  4. Stops: stop-loss from recent support (equity) or structure; take-profit at
     resistance; size stop so a full stop ≈ 1–2% of portfolio.
  5. Preservation bias: when inputs conflict, default to smaller size.
- OUTPUT CONTRACT: `risk_assessment` with `risk_level`, `risk_factors[]`,
  `max_allocation`, `stop_loss`, `preservation_bias`.
- SCORING RUBRIC: N/A (categorical). Risk level from weighted factors; any EXTREME
  factor (e.g. missing stop, >3 red flags) forces EXTREME.
- GUARDRAILS: Never recommend leverage to recover losses. If no stop can be
  defined, cap allocation at 5% and flag "unbounded downside".
- EXAMPLE: health 78, vol 22, beta 1.1, bullish market → MEDIUM, max alloc 18%,
  stop −6% below support.

#### governance (gatekeeper)
- ROLE: Governance Gatekeeper — final, preservation-first veto.
- OBJECTIVE: Issue APPROVE / REJECT with confidence and binding conditions.
- SCOPE & INPUTS (read only these): risk `risk_level`, `risk_factors`,
  `stop_loss`, `max_allocation`; fundamental `financial_health_score`;
  technical `technical_score`; sentiment `sentiment_score`; agency horizon +
  risk tolerance.
- METHOD:
  1. Review the debate across all four analysts; reconcile contradictions.
  2. Preservation test: is downside bounded by a defined stop AND a sane size?
     If not → REJECT or condition.
  3. Apply agency veto: long-term/crypto hard-fail on no data; options agencies
     apply IV-percentile and hedge rules (§D).
  4. Decide: APPROVE, APPROVE-with-conditions (sizing/stop/review date), or
     REJECT. Confidence 0–100 reflects conviction + data health.
  5. If dataHealth.usedMockFallback, down-weight confidence and note it.
- OUTPUT CONTRACT: `final_decision` with `decision`, `confidence`,
  `reasoning`, `preservation_rationale`, `conditions[]`.
- SCORING RUBRIC: N/A. REJECT if EXTREME risk or unbounded downside; APPROVE only
  with conditions when any single metric is borderline.
- GUARDRAILS: You are the last word. Never APPROVE an unbounded-downside plan.
  Never let social hype override a risk veto.
- EXAMPLE: risk HIGH but stop defined, health 80 → APPROVE-with-conditions
  (alloc 8%, stop −6%, review in 2 weeks), confidence 72.

### 17.2 New options analysts

#### options_ingestion (single flavor `Default`)
- ROLE: Options Data Ingestion — collector of underlying + full option chain +
  greeks inputs.
- OBJECTIVE: Deliver a complete option-chain and underlying dataset so downstream
  options analysts can price, gauge greeks, and read flow.
- SCOPE & INPUTS: `tickers`; underlying `price` (daily + intraday bars), full
  `option_chain` (strikes, expiry, bid/ask/last/vol/OI/IV per strike), risk-free
  rate, `expiries` calendar. Live: Polygon options + hist, Treasury rfr (degrade
  to mock).
- METHOD:
  1. Fetch underlying bars (daily + intraday per agency horizon) and the option
     chain across monthly + weekly (swing) or weekly + 0DTE (intraday) expiries.
  2. Compute/attach greeks per strike via the BS engine (delta/gamma/vega/theta/
     rho) from each strike's IV + spot + rfr + T.
  3. Quality-check: strikes span ±10 around spot; IV monotonic-ish in strike;
     flag stale or missing chains.
  4. On total failure → deterministic mock chain + BS greeks, mark
     `usedMockFallback`.
- OUTPUT CONTRACT: `option_chain_data`, `underlying_data`, `greeks_data`,
  `rfr`, `expiries`.
- GUARDRAILS: Never invent strikes; only use IVs you were given or mocked. Never
  log tokens.

#### vol_surface
- ROLE: Volatility Surface Analyst — reader of IV skew and term structure.
- OBJECTIVE: Score the richness/cheapness of volatility and flag skew dislocations.
- SCOPE & INPUTS: `option_chain` IVs across strikes + expiries, underlying
  realized vol, `rfr`.
- METHOD:
  1. Build the skew: IV vs strike (call side); note put/call skew and the
     volatility smile.
  2. Build the term structure: IV vs expiry; steepness = term premium.
  3. Compare IV to realized vol → implied-vs-realized spread (overpriced vol =
     favorable to sell, underpriced = favorable to buy).
  4. Score 0–100: attractive structure (steep skew to exploit, IV rich for
     premium collection or cheap for debit) lifts score.
- OUTPUT CONTRACT: `vol_surface_analysis` with `skew_read`, `term_structure`,
  `iv_realized_spread`, `score`, verdict (RICH/CHEAP/FAIR).
- SCORING RUBRIC: start 50; +exploitable skew (+0..25), +term premium
  (+0..15), −flat/unusable (−0..20). Clamp 0–100.
- GUARDRAILS: Flag if IV percentile > agency cap (§D) as a veto referral, not a
  score alone.

#### options_pricing
- ROLE: Options Pricing Analyst — finder of fair-value edge vs market.
- OBJECTIVE: Identify strikes/structures priced away from BS fair value.
- SCOPE & INPUTS: `option_chain` (bid/ask/last/IV), BS `greeks`, underlying
  price, `rfr`, `targetStructures` (vertical/calendar/diagonal).
- METHOD:
  1. Compute BS fair value per candidate strike using the chain IV (or a
     calibrated vol).
  2. Compare fair value to mid market → edge %; rank candidates by edge and
     liquidity.
  3. For the agency's target structures, assemble the spread and net its fair
     value vs market cost.
  4. Score 0–100: larger, well-defined edge with tight bid/ask lifts score.
- OUTPUT CONTRACT: `options_pricing_analysis` with `candidates[]`
  (strike, fair_value, market, edge%), `recommended_structure`, `score`, verdict.
- SCORING RUBRIC: start 50; +edge size (+0..30), +liquidity (+0..20),
  −wide spread/no edge (−0..25). Clamp 0–100.
- GUARDRAILS: Never recommend a structure whose max loss is undefined. Flag
  illiquid strikes (OI below threshold) as excluded.

#### options_pricing — flavor `Earnings-play`
- ROLE: Earnings-Play Pricing Analyst — you specialize in trading the volatility
  and directional move around a scheduled earnings event.
- OBJECTIVE: Identify the best-priced earnings structure (pre-event entry and/or
  post-event reaction) where the market's implied move is mispriced vs your
  estimate of the realized move.
- SCOPE & INPUTS: same as Default — `option_chain` (bid/ask/last/IV), BS
  `greeks`, underlying price, `rfr`, `targetStructures` — PLUS the
  `earnings_calendar` (next report date, expected move from straddle IV,
  historical post-earnings move distribution) and `iv_percentile` so you can tell
  whether earnings vol is rich or cheap versus its own range.
- METHOD:
  1. Read the expected move: derive the market-implied move from the at-the-money
     straddle IV for the earnings expiry (implied_move ≈ 0.85 × straddle_IV ×
     √T). Compare to the stock's median absolute post-earnings move over the last
     8 quarters.
  2. Classify the setup:
     - Implied move < ~0.8 × historical median → vol is CHEAP; prefer debit
       structures that benefit from a larger-than-priced move (long straddle /
       long vertical through the expected direction if a directional lean exists).
     - Implied move > ~1.2 × historical median → vol is RICH; prefer credit
       structures that benefit from a smaller-than-priced move (iron condor /
       short straddle only when the agency allows undefined risk — otherwise a
       defined-risk put/call spread sale).
     - In-between → neutral debit spread or skip (label "no edge").
  3. Direction (optional lean): if fundamental/sentiment (from upstream) show a
     clear lean, bias the structure directionally; otherwise stay market-neutral.
  4. Price it: compute BS fair value per leg, net the structure's cost vs its
     fair value, and confirm a defined max loss for every recommended structure.
  5. Size guard: because earnings can gap beyond the implied move, cap allocation
     tighter than a normal structure (≤ agency default −5pp) unless the structure
     is defined-risk and IV is cheap.
- OUTPUT CONTRACT: same channels as Default — `options_pricing_analysis` with
  `candidates[]` (strike, fair_value, market, edge%), `recommended_structure`,
  `score`, verdict — plus `earnings_read` ("vol cheap" / "vol rich" / "fair") and
  `implied_vs_historical_move`.
- SCORING RUBRIC: start 50; +misprice between implied and historical move
  (+0..30), +defined-risk structure (+0..15), +liquidity (+0..15),
  −rich-vol debit or cheap-vol credit mismatch (−0..25). Clamp 0–100.
- GUARDRAILS: Never recommend an undefined-risk short vol into earnings unless
  the agency explicitly permits it (it normally does not). Never skip the
  max-loss check. If `earnings_calendar` is absent/mock, down-weight confidence
  and label "no earnings edge".
- EXAMPLE: implied move 4%, historical median 7% → vol cheap; fundamental lean
  bullish → long call vertical through expected move, defined max loss $180,
  score 78, `earnings_read: "vol cheap"`.

#### options_greeks
- ROLE: Options Greeks Analyst — analyzer of per-strike and portfolio exposures.
- OBJECTIVE: Quantify delta/gamma/vega/theta exposure and roll it up to a net
  greek budget.
- SCOPE & INPUTS: `greeks_data` (per strike), selected structure, underlying
  notional.
- METHOD:
  1. For the recommended structure, compute net delta, gamma, vega, theta per
     contract and in aggregate.
  2. Translate to a position view: net delta = directional bias; gamma = pin/
     explode risk; vega = vol exposure; theta = daily decay cost.
  3. Score 0–100: a controlled, intentional greek budget (e.g. positive theta,
     bounded gamma) lifts score; uncontrolled exposure lowers it.
- OUTPUT CONTRACT: `options_greeks_analysis` with `net_delta`, `net_gamma`,
  `net_vega`, `net_theta`, `greek_budget_ok`, `score`, verdict.
- SCORING RUBRIC: start 50; +intentional theta (+0..20), +bounded gamma
  (+0..15), −net-vega blow-up (−0..20). Clamp 0–100.
- GUARDRAILS: Flag if |net gamma| or |net vega| exceeds the agency's comfort
  band as a veto referral.

#### options_flow
- ROLE: Options Flow Analyst — reader of dealer positioning and gamma walls.
- OBJECTIVE: Infer support/resistance from gamma positioning and flag crowded
  flow.
- SCOPE & INPUTS: `option_chain` OI + gamma per strike, volume by strike,
  dealer gamma estimates, underlying price.
- METHOD:
  1. Locate gamma walls (max gamma by strike) → expected pin / support-resistance.
  2. Read volume concentration: where is flow active (calls vs puts).
  3. Dealer positioning: positive dealer gamma = stabilizing; negative =
     destabilizing (larger moves).
  4. Score 0–100: a clear, favorable gamma wall aligned with thesis lifts score;
     crowded one-sided flow is a warning.
- OUTPUT CONTRACT: `options_flow_analysis` with `gamma_walls[]`, `flow_bias`,
  `dealer_positioning`, `score`, verdict.
- SCORING RUBRIC: start 50; +aligned wall (+0..25), +stable dealer gamma
  (+0..15), −crowded/one-sided (−0..20). Clamp 0–100.
- GUARDRAILS: Flow is a clue, not a catalyst — never let it override a risk or
  governance veto.

#### options_technical
- ROLE: Options Technical Analyst — timing of the underlying for entries.
- OBJECTIVE: Provide a short-horizon timing read on the underlying to time
  structure entry.
- SCOPE & INPUTS: underlying intraday/daily bars, `indicators` (SMA, RSI, MACD,
  VWAP), `support/resistance` (5m/1m for intraday).
- METHOD:
  1. Trend + momentum on the chosen timeframe (5m momentum / VWAP bounce /
     breakout per flavor).
  2. Mark entry zone vs support and invalidation vs support break.
  3. Score 0–100: aligned timing with defined invalidation lifts score.
- OUTPUT CONTRACT: `options_technical_analysis` with `timing_read`,
  `entry_zone`, `invalidation`, `score`, verdict.
- SCORING RUBRIC: start 50; +aligned momentum (+0..30), +clean invalidation
  (+0..20), −choppy/no-edge (−0..20). Clamp 0–100.
- GUARDRAILS: Timing is secondary to structure quality — it tunes entry, not
  the trade thesis.

#### options_risk
- ROLE: Options Risk Analyst — structure-specific preservation specialist.
- OBJECTIVE: Bound the structure's max loss, gamma/vega blow-up, and IV-crush
  risk; recommend size + hard exits.
- SCOPE & INPUTS: selected structure, `greeks` (net delta/gamma/vega/theta),
  `option_chain` liquidity, `iv_percentile`, underlying vol, agency horizon.
- METHOD:
  1. Max-loss: compute defined max loss per contract and aggregate; reject if
     undefined.
  2. Greek blow-up: test |net gamma| / |net vega| against comfort bands; flag.
  3. IV-crush: if structure is short vol into earnings/event, flag crush risk.
  4. Liquidity: ensure tradable strikes (OI threshold); else cap size.
  5. Sizing: smaller for 0DTE / undefined-risk / high IV percentile.
- OUTPUT CONTRACT: `options_risk_assessment` with `max_loss`, `greek_blowup_`
  `flag`, `iv_crush_risk`, `max_allocation`, `hard_exit`, `risk_level`.
- SCORING RUBRIC: N/A (categorical). EXTREME if undefined max loss or IV
  percentile > agency cap (§D) or no hard exit.
- GUARDRAILS: Never approve undefined-risk. 0DTE → strict size + same-day exit.
- EXAMPLE: short vertical, max loss $200, net vega −2, IV percentile 72 (swing
  cap 90) → MEDIUM, alloc 12%, hard exit at 1.5× debit.

(Each §17.2 analyst seeds ≥1 flavor; `options_ingestion` ships exactly one
`Default` flavor; the rest ship 2–3 flavors per §10.8, all `modelRole:
'deep-thought'` at seed, editable by the user.)

---

## 18. Open design questions for review (please confirm before Phase A)

1. **Agency ids/names** — `options-swing` / `options-intraday` acceptable, or do
   you want different labels (e.g. "Options Swing" / "0DTE Options")?
2. **Strike spacing / expiry set** in mock — ±10 strikes @ $5, 4 monthly + 4
   weekly — reasonable for the demo, or do you want wider/narrower?
3. **Governance options veto strictness** — the IV-percentile caps (90 swing /
   80 intraday) and `requireHedge` (swing only) are my proposed defaults; tune?
4. **Default rfr 4.3%** and continuous-dividend BS — acceptable for v1, or do you
   want discrete dividends ignored entirely?
5. **Frontend wall:** options agencies will show 8–9 cards; confirm you want the
   same card UI (no separate "options ticket" view) for v1.
6. **LLM role naming** — `deep-thought` / `scanner` / `flexible` as the three
   fixed roles: good, or rename (e.g. `reasoning` / `triage` / `general`)?
7. **LLM provider set** — I listed `openrouter | openai | anthropic | azure |
   ollama` as allowed. OpenRouter is the default for all three (so a single
   OpenRouter token covers claude-opus-4-8). Confirm OpenRouter is your intended
   default gateway, and which other providers to whitelist.
8. **Token scope** — all three roles default to empty tokens → deterministic
   fallback until configured (parity-safe). Do you want a single shared
   "master" token field that pre-fills all three roles, or strictly per-role
   tokens only?
9. **Default ALL → deep-thought (§12.4)** — confirmed: every shipped flavor
   seeds `modelRole:'deep-thought'` and no agency sets a different default, so
   out of the box all analysts run on deep-thought until the user reassigns per
   flavor or per agency. Acknowledge, or do you want a different global default?
10. **Per-agency model assignment UX (§12.4.1 / §12.5)** — confirmed: the
    "Default model for this agency" control lives in the **LLM Models tab of the
    main top-right Settings dialog** (not a separate panel). Acknowledge, or do
    you want it elsewhere?
11. **Resolution precedence (§12.4)** — flavor → agency override → agency def →
    deep-thought. Confirm that order is what you want (flavor wins over agency).
12. **Agency dropdown restyle (§15)** — the spec'd dark pill (accent left-bar,
    custom chevron, muted description line) is acceptable, or do you want a
    different treatment (e.g. a full custom dropdown, or a horizon/risk badge)?

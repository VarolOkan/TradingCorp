# Known Issues

Genuine, current limitations in the codebase — what is still seeded/synthetic,
what is mock-gated, and what is a known external gap. Fixed/resolved work has
been removed; the full history lives in `docs/archive/`. Run `npm test` for the
current pass/fail state.

## 0. Session switcher UI removed (backend plumbing retained)

The frontend no longer exposes any session-control UI. The "Session ID"
text input that sat under the Ticker symbols form (`AnalysisForm`) was
removed, and the `onSessionChange` prop was dropped from `AnalysisForm`,
`AnalysisView`, and `App`. The `sessionId` **value** plumbing is
intact and still hardcoded to `'default'` everywhere:

- `App.tsx` keeps `useState('default')` for `sessionId` and still
  threads it into `AnalysisView` and `SettingsDialog`.
- The backend (`src/server/analyst-config.ts`) still keys source
  credentials as `sessionId:analystId:sourceId`, and the encrypted
  vault deliberately ignores the session (single-tenant per server).
- `AnalysisView` still uses `sessionId` for analyst-flavor loads and the
  agency run.

**Why:** multi-session is out of scope right now. The wiring exists for a
future session switcher, but with only one session (`'default'`) the
input was dead weight (nothing ever set a non-default id). If session
switching is added later, restore the `onSessionChange` prop chain and
re-add the `AnalysisForm` "Session ID" input that was removed here.

## Recently fixed (this session) — options ingestion resilience

**Symptom:** running the `options-intraday` (or `options-swing`) agency with no
live option chain reachable (no Polygon key AND the CBOE/Yahoo fallback also
failing) showed *most analysts didn't run* and *most data mocked*.

**Root cause:** `optionsIngestionHandler` (`src/registry/logic/options-handlers.ts`)
wrapped its fetch in a `try`, but on total failure the `catch` returned an error
state **without setting `state.optionsData`**. Every downstream options analyst
(`vol_surface`, `options_pricing`, `options_greeks`, `options_flow`,
`options_technical`, `options_risk`) reads `state.optionsData[ticker]` via
`resolveBundle`, so `bundle` came back `undefined` and each `compute(ticker,
undefined)` threw — cascading into a pipeline-wide abort. The live network path
(`resolveLiveOptionsBundle`/`acquirePriceBars`/`acquireOptionChain` throwing
instead of degrading to mock) triggered exactly this.

**Fix:** the `catch` now emits a deterministic seeded `optionsData` bundle per
ticker (same parity mock as the no-key path) **and** leaves an
`options_ingestion` trace flagged `seeded-parity`/`DEGRADED`, so the pipeline
completes on honest mock data instead of aborting. Regression test:
`RESILIENCE: a total ingestion failure must NOT abort the pipeline`
(`src/tests/options-agency-e2e.test.ts`).

**Honest behaviour after fix:** with no live chain, the run still completes and
all analysts report `seeded-parity` (never claimed as `live`). To get real data,
configure a Polygon key / live option source.

## 1. Scoring/verdicts remain deterministic (seeded) models

The per-analyst *scoring* verdicts are produced by deterministic handlers that
**consume the live inputs** but whose score/weighting logic is the seeded model.
The vol-surface (`vol-surface.ts`) is a **pure fitter** that reads the real
per-strike IVs from the acquired chain (CBOE/Polygon/Massive) and fits
skew/term/atm_iv via OLS. `iv_history` is **now calibrated from the REAL chain's
per-tenor ATM IVs** when a live chain is present (`ivHistorySource: 'real-chain'`),
so `iv_percentile`/`iv_rank` are market-calibrated — see `option-chain.ts`
`resolveLiveOptionsBundle` + `atmIvPerTenor`. When no live chain is available the
IV history stays seeded and is flagged `seeded` (vol-surface analyst reports
`seeded-parity` with a human description). CBOE occasionally reports `iv: 0` for
illiquid deep-ITM contracts — treated as missing (not fed downstream as 0).

**Provenance is honest:** `data-ingestion.ts` emits a `data_quality.sources` list
and per-domain `source` (`live`/`seeded`/`mock`/`yahoo`/`cboe`/`polygon`). The UI
(banner, RawDataDrawer side-panes, Options tab badge) renders from that
provenance — never a hardcoded label. A `MOCK` banner shows only when
`dataHealth.sourcesOk === 0`.

## 2. Live data coverage (current state)

Analysis **inputs** are largely live, not seeded:

- **Price / History / Quote**: Yahoo Finance tokenless delayed feed
  (`fetchPriceBars`, `GET /quote`, `GET /history`). Seeded `generateBars` is only a
  no-network fallback (parity-safe).
- **Fundamentals**: Alpha Vantage `OVERVIEW` (keyed) overrides the seeded block
  when a key is present.
- **Sentiment / News**: Finnhub `company-news` (free key) overrides the seeded
  sentiment verdict via the `realSent` hook.
- **Options chain**: Massive/Polygon (`/v3/snapshot/options/{ticker}`, Bearer) when
  entitled; **CBOE free delayed feed** when Massive 401/403s; seeded only as last
  resort. Greeks come from CBOE directly (its `iv` is already a decimal — do NOT
  /100); spot is read from CBOE `current_price`.
- **Risk-free rate**: `api.fiscaldata.treasury.gov` (tokenless).

> **Screener is live.** It pulls a real ~13k-symbol universe from NasdaqTrader (or
> S&P 500 via `UNIVERSE_PROVIDER=sp500`) and fetches real Yahoo price bars. The
> `dataSource` badge is `DELAYED` in the normal live case, `LIVE` when every row is
> on live bars, `MOCK` only when the universe itself fell back. A `DELAYED`/`MOCK`
> badge is a semantically honest statement of the data source — not a UI bug.

## 3. `package.json` `main` points at the TypeScript entry

`"main": "src/server/index.ts"` is the TypeScript source (run via `tsx`). There is
no compiled JS `main`. **Mitigated:** `npm run server` runs
`tsx src/server/index.ts` directly, so the backend starts correctly. Do **not**
`require` the package `main` after a plain build — use `npm run server`.

## 4. Options agencies — known limitations

- **Option pricing model — American binomial (default).** Per-strike greeks are
  derived by a **Cox–Ross–Rubinstein binomial tree** (`src/registry/logic/greeks.ts`,
  `binomialAmerican` / `americanGreeks`) using the per-expiry IV from the bundle as
  a **constant per-contract volatility**, with continuous dividend yield `q`. The
  model prices **American** exercise (early-exercise allowed), which is correct for
  US-listed single-stock options. A closed-form Black–Scholes engine remains as the
  European reference and is selectable by experts via `TC_OPTION_STYLE=european`
  (no UI toggle). Known limits: constant σ per contract (no stochastic/local vol, so
  far-from-ATM / earnings-smile greeks are approximate), and American exercise is
  irrelevant for European-index options (SPX) — switch `TC_OPTION_STYLE=european`
  for those if needed. The per-strike IVs come from the REAL acquired chain when
  live (CBOE/Polygon/Massive), and the vol-surface `iv_history` is
  **market-calibrated** from the real per-tenor ATM IVs (`ivHistorySource:
  'real-chain'`). When no live chain is present the IV history is seeded and the
  vol-surface analyst reports `seeded-parity` with a description.
- **`options_risk` / governance veto are mock-gated.** The governance options veto
  acts on `iv_percentile`, `max_loss`, `risk_level` emitted by the `options_risk`
  handler. Those signals are synthetic (seeded), so the veto is a faithful
  *mechanism* exercised by tests, not a market-risk engine. No live risk feed backs
  it.
- **Frontend mirror is now build-time hydrated (CLOSED).** Agencies/analysts are
  no longer hand-duplicated. `scripts/gen-frontend-registry.ts` projects the
  backend `src/registry/{analysts,agencies}.ts` (the single source of truth) into
  `frontend/src/components/analysts/{analysts,agencies}.generated.ts`, wired into
  `prebuild` + `predev` (`npm run gen:registry`). Adding an analyst/agency to the
  backend now requires **zero** frontend edits. `agency-mirror.test.ts` still
  guards against drift (compares the generated files to the backend) in case the
  generator mapping regresses.

## 5. Massive options-entitlement gap

The options path targets **Massive/Polygon** (`api.massive.com`, Bearer) when a key
is configured; without a key it uses the free **CBOE** delayed feed automatically.

- **The `[Test]` probe is now honest.** It probes the REAL options snapshot
  endpoint `/v3/snapshot/options/AAPL` (with a liquid reference ticker) on the
  stored host with the Bearer token. A **green** result now means the *options
  snapshot* entitlement actually works — not (as before) merely the *dividends*
  entitlement. A **401** there is the known Massive options-entitlement gap → the
  live run falls back to CBOE (real delayed bid/ask/IV + greeks), and the data
  badge honestly reflects `DELAYED`/fallback rather than a false `LIVE`.
- **Pricing is American by default.** Per-strike greeks use a CRR binomial tree
  (American exercise) rather than European Black–Scholes, so puts on dividend
  names are priced correctly. `TC_OPTION_STYLE=european` reverts to BS for
  European-index underlyings (see §4).

## 6. Query parser can misclassify English-word tickers

Without a ticker dictionary, the regex + denylist parser can misclassify an English
word that is also a valid ticker (e.g. `IRON`, `NOW`, `CAT`). This is inherent to
regex + denylist parsing — acceptable for a demo pipeline; a real deployment should
validate tickers against a symbol API.

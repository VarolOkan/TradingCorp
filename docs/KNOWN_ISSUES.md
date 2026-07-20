# Known Issues

Genuine, current limitations in the codebase — what is still seeded/synthetic,
what is mock-gated, and what is a known external gap. Fixed/resolved work has
been removed; the full history lives in `docs/archive/`. Run `npm test` for the
current pass/fail state.

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

- **Black–Scholes assumptions.** Pricing/greeks use a textbook Black–Scholes model
  (`src/registry/logic/greeks.ts`) with **constant volatility** (per-expiry IV from
  the bundle), no dividend, no early-exercise/American feature. The per-strike IVs
  come from the REAL acquired chain when live (CBOE/Polygon/Massive), and the
  vol-surface `iv_history` is **market-calibrated** from the real per-tenor ATM IVs
  (`ivHistorySource: 'real-chain'`). When no live chain is present the IV history is
  seeded and the vol-surface analyst reports `seeded-parity` with a description.
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
The Settings `[Test]` probe checks `/v3/reference/dividends` (ticker-independent,
Bearer) — a passing probe means the *dividends* entitlement works, **not** the
options snapshot (a separate entitlement). A 401 there is the known Massive
options-entitlement gap → CBOE fallback.

## 6. Query parser can misclassify English-word tickers

Without a ticker dictionary, the regex + denylist parser can misclassify an English
word that is also a valid ticker (e.g. `IRON`, `NOW`, `CAT`). This is inherent to
regex + denylist parsing — acceptable for a demo pipeline; a real deployment should
validate tickers against a symbol API.

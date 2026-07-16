# Stock Screener — Selection Standards & Traceability

**Status:** Authoritative spec for *how the screener picks tickers*. Every standard
below is derived directly from the implementation (`src/registry/logic/screener.ts`,
`src/registry/logic/universe/*`, `src/registry/agencies.ts`). Line references are
anchors for traceability — if the code changes, update this doc.

**One-line summary:** The screener is an **LLM-free, fast pre-screen**. It never calls
an LLM. It scores a candidate universe with cheap signals (price bars + news sentiment),
blends them with weights derived from the **selected agency's analyst composition**, and
returns the top-N by blended *promise* score. It narrows the field; the full
multi-analyst pipeline (with LLMs) runs only on what you pick.

---

## 1. Where the picking happens (code map)

| Concern | File | Notes |
|---|---|---|
| Orchestration / top-N | `src/registry/logic/screener.ts` → `screenTickers()` | entry point; sorts by promise desc, slices to `limit` |
| Universe acquisition | `src/registry/logic/universe/index.ts` → `getUniverse()` | provider chain → quote batch → pre-filter |
| Universe pre-filter | `src/registry/logic/universe/preFilter.ts` | free-file gates + price/cap/ADV gates |
| Per-ticker scoring | `src/registry/logic/screener.ts` → `evaluateTicker()` | bars + news → axis scores → blended promise |
| Agency → axis weights | `src/registry/logic/screener.ts` → `resolveAgencyWeights()` | which analysts an agency has ⇒ which axes count |
| Agency → bar horizon | `src/registry/logic/screener.ts` → `resolveScreenerProfile()` | intraday ⇒ 5m/5d, else 1d/90d |
| Agency membership | `src/registry/agencies.ts` → `AGENCIES` | the source of truth for "which analysts" |
| HTTP surface | `src/server/screener-routes.ts` → `GET /screener` | `agencyId` query param selects the agency |

---

## 2. The universe — what pool gets screened

1. **If the caller passes `universe=`** (comma/space list or array), that exact list is
   used. (Frontend ScreenerPanel lets you type a custom list.)
2. **Otherwise** `getUniverse()` builds the broad pool:
   - **Provider chain** (first that returns symbols wins):
     `UNIVERSE_PROVIDER` env (default `nasdaqtrader`) → `nasdaqtrader` → `sec` →
     `wikipedia-sp500`.
   - **Quote batch** (`makeYahooQuoteProvider.batchQuotes`) attaches price / market-cap /
     ADV so the pre-filter can trim.
   - **Pre-filter** (`preFilterUniverseDetailed`) keeps names that pass:
     - not a test issue, not an ETF (unless allowed),
     - exchange ∈ {NYSE, NASDAQ, NYSE_AMERICAN, NYSE_ARCA, CBOE},
     - `price ≥ $10`, `marketCap ≥ $2B`, `ADV ≥ $20M/day`.
   - **If the quote batch is unavailable** (Yahoo v7 blocked / IP 429 — the common
     case with limited egress), the **raw live symbol pool is kept unpriced** and the
     price/cap/ADV gates are skipped. This is reported truthfully in `universeTrace`
     (the "Data lineage" block) — it is **NOT** the 25-ticker hardcoded fallback.
   - **Only if every provider fails entirely** does it fall back to the hardcoded
     `DEFAULT_UNIVERSE` (25 mega-caps: AAPL, MSFT, NVDA, GOOGL, …).
3. **Bounded screen set:** the raw universe can be ~13k symbols. Without priced quotes
   we cannot pre-trim, so the pool is **deterministically de-biased (seeded shuffle)
   and capped at `maxScreenUniverse` (default 400)** before scoring. The seeded shuffle
   prevents the old bug where a naive `slice(0,400)` screened only `A…` tickers.
   With priced quotes the pre-filtered pool is already small and the cap is a no-op.

---

## 3. The scoring rubric (per ticker)

All signals are **LLM-free** and derived from two cheap inputs:

- **Price bars** → via `fetchPriceBars(ticker, {interval, lookbackDays})`
- **News headlines** → via `fetchCompanyNews` (Yahoo RSS keyless path) → `scoreHeadline`

### Axis scores (0–100 unless noted)

| Axis | How it's computed (`screener.ts`) | Inputs |
|---|---|---|
| **technical** | `technicalPromiseScore(closes)` — trend (price vs SMA20/SMA50) 45% + momentum (RSI-14 band 45–70 ideal) 35% + volatility-quality (penalize high vol) 20% | price bars |
| **momentum** | `momentumScore(closes)` — trailing return over window, +20%⇒100 / −20%⇒0 | price bars |
| **stability** | `stabilityScore(closes)` — inverse of normalized daily-return stdev | price bars |
| **sentiment** | `newsSentimentScore(headlines)` — avg `scoreHeadline`, −100..+100 | news |
| **fundamental** | *proxy* = `technical` (a sound technical setup reads as fundamentally intact in this LLM-free screen) | derived |
| **risk** | *proxy* = `stability` (lower vol = better risk-adjusted) | derived |
| **onchain** | *proxy* = `sentiment` (crypto agencies lean on sentiment/on-chain flow proxy) | derived |

### Blended promise (0–100)

```
promise = Σ_axis  w(axis) · axisValue
  where axisValue = (sentiment+100)/2 and (onchain+100)/2  [map −100..100 → 0..100]
                    technical / fundamental / risk / momentum / stability already 0..100
w(axis) = agency weight from §4, normalized to sum 1
```

### Verdict

`promise ≥ 62` ⇒ **STRONG** · `48–61` ⇒ **WATCH** · `< 48` ⇒ **WEAK**

### topAxis

The axis with the highest agency weight — surfaced in the UI as "why this ranked."

---

## 4. Per-agency standards (the part you asked for)

The agency **selects the weights** and the **bar horizon**. The mapping is mechanical:
each analyst an agency contains contributes to its axis; axes are normalized to sum 1.

| Agency | Members (from `agencies.ts`) | Screen horizon | Weights (normalized) | What it favors |
|---|---|---|---|---|
| **long-term** (default) | orchestrator, data_ingestion, fundamental, technical, sentiment, risk, governance | **1d / 90d** | technical .2, sentiment .2, fundamental .2, risk .2, onchain 0 *(balanced 4-axis)* | broad, fundamentally-sound, low-vol equities |
| **medium-term** | same 7, each `timeHorizon=MEDIUM_TERM` | 1d / 90d | identical to long-term | same blend, medium horizon tuning |
| **intraday** | orchestrator, data_ingestion, fundamental(INTRADAY), technical(INTRADAY, lookbackBars=5, rsiThreshold=55), sentiment(INTRADAY, social-heavy), risk(INTRADAY), governance | **5m / 5d** | technical .2, sentiment .2, fundamental .2, risk .2, onchain 0 | fast, high-frequency technical + social sentiment |
| **crypto-screener** | data_ingestion, onchain, sentiment(social-heavy), governance(fail on all-failed) | 1d / 90d | sentiment .5, onchain .5, fundamental 0, risk 0, technical 0 | sentiment + on-chain flow only |
| **options-swing** | orchestrator, options_ingestion(90d), vol_surface, options_pricing, options_greeks, options_flow, options_risk, governance | 1d / 90d | no equity axes present ⇒ **balanced default** (technical .5 / sentiment .3 / fundamental .1 / risk .1) | option-structure triage (screen is equity-axis-blind here) |
| **options-intraday** | orchestrator, options_ingestion(5d,5m/1m), options_technical, vol_surface, options_pricing, options_greeks, options_flow, options_risk, governance | **5m / 5d** | no equity axes ⇒ **balanced default** | 0DTE / gamma-scalp triage |

> **Note on weights:** `resolveAgencyWeights()` counts an axis as "present" if the agency
> contains *any* analyst mapped to it (`AXIS_ANALYSTS` in `screener.ts`). The equity
> agencies contain technical/sentiment/fundamental/risk ⇒ balanced 4-way. The crypto
> agency contains sentiment + onchain ⇒ 2-way. The *options* agencies contain none of the
> equity axes ⇒ they fall back to a fixed balanced default. This is intentional: the
> options screen is driven by the options-specific pipeline, not the equity technical
> heuristic.

---

## 5. Why intraday and long-term differed before (and now don't collapse)

`resolveScreenerProfile()` is the single source of truth for horizon. Without it, every
agency screened on identical 1d/90d bars and returned the **same ranking** (the old bug).
Now intraday/options-intraday pull **5m / 5d** bars while everyone else pulls **1d / 90d**,
so the two horizons produce genuinely different promise scores.

---

## 6. Traceability contract (what the UI must show)

The `/screener` response already carries everything needed to audit a screen:

- `agencyId` + `weights` — exactly which blend was applied.
- `universeSize` + `universeTrace` — the full universe pipeline (which provider won,
  listed→parsed→pre-filtered counts, `usedFallback` flag, and a human note). **This is the
  "Data lineage" block** — it must warn when the universe fell back (MOCK) vs. was live.
- `rows[].barsSource` / `newsSource` — per-row LIVE/DELAYED/MOCK provenance.
- `dataSource` — headline badge: `LIVE` (real universe + real bars), `DELAYED` (real
  universe, some rows mock bars), `MOCK` (universe itself fell back AND no live rows).
- `note` — fixed string: *"LLM-free screen: technical/momentum/volatility from price bars
  + news sentiment. Weights reflect the selected agency."*

**Rule for the UI:** never stamp `MOCK` on a screen whose universe was live. Stamp the
headline truth (the universe source), and let the per-row `barsSource` tell the
sub-story. If you change any threshold in §3, bump this doc's version and the `note`.

---

## 7. Tuning knobs (caller / env)

| Knob | Where | Default | Effect |
|---|---|---|---|
| `limit` | `screenTickers` opt | 15 | top-N returned |
| `maxScreenUniverse` | `screenTickers` opt | 400 | cap on symbols actually scored |
| `interval` / `lookbackDays` | opt (else from profile) | per §5 | bar horizon |
| `concurrency` | opt | 6 | in-flight ticker evals |
| `UNIVERSE_PROVIDER` | env | `nasdaqtrader` | which broad-pool source |
| `finnhubKey` | opt/env | none | enables Finnhub news branch (else Yahoo RSS) |
| pre-filter floors | `preFilter.ts` `DEFAULTS` | $10 / $2B / $20M | quality gates (skipped when quotes unavailable) |

---

*Doc version 1.0 — generated to close the "which document specifies screener standards"
gap. Source of truth remains the code; this file is the human-readable mirror.*

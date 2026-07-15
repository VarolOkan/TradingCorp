# Known Issues

These are limitations and defects present in the current codebase. They are real and observable, not theoretical.

## 1. ~~Orchestrator `parseQuery()` uses hardcoded test-case matching (correctness bug)~~ — FIXED

`src/utils/parse-query.ts` **previously** contained a chain of literal-string
comparisons (`if (query === 'Check AAPL and MSFT stocks') …`). Those exact-match
branches *overrode* the regex scanner's output, so any query that wasn't one of
the hardcoded strings fell through to a denylisted regex path that silently
dropped valid tickers and misclassified depth/horizon/risk.

**Fix (see `parseQuery` history / `orchestrator.node.test.ts`):** the
whole-query equality block is gone. Options (depth/horizon/risk) are now detected
by **keyword matching** (`/quick/`, `/deep|dive/`, `/short term/`,
`/long term/`, `/conservative/`, `/aggressive/`, …) and tickers come from the
single regex scanner minus an expanded English-word denylist + dedup. The 9
original tests still pass (parity) and 6 new free-form tests prove arbitrary
queries parse correctly.

**Residual limitation (by design):** without a ticker dictionary, the regex +
denylist can still misclassify an English word that happens to be a valid ticker
(e.g. `IRON`, `NOW`, `CAT`). This is an inherent limitation of regex + denylist
parsing — acceptable for a mock/demo pipeline; a real deployment should
validate tickers against a symbol API.

## 2. Most analysis data is mocked — but live quotes now ship (Phase 3)

`fetchFinancialData()` in `src/registry/logic/data-ingestion.ts` still returns
RNG-generated numbers (seeded from the joined tickers via `stringToSeed`, so runs
are deterministic). The fundamental/technical/sentiment/risk analysts and the
governance gatekeeper therefore still operate on mock data.

**What IS now live (Phase 3):** a tokenless `GET /quote?symbol=<TICKER>` endpoint
(`src/server/quote.ts` + `quote-routes.ts`) proxies **Yahoo Finance**'
tokenless chart endpoint and normalizes it to `{ symbol, name, price, dayHigh,
dayLow, week52High, week52Low, previousClose, volume, currency, marketTime,
source, note? }`. It is surfaced in the UI by the unified `MarketDataCard`
(Quote tab) after a symbol is entered. Verified live:
`/quote?AAPL` → "Apple Inc." $314.81, day 312.17–316.39, 52w 201.50–317.40,
vol 16.5M. The endpoint degrades gracefully (returns a `note` instead of throwing)
if Yahoo is unreachable, so the panel shows "Market data unavailable" rather than
crashing.

**Still mock (by design):** the per-analyst *analysis inputs* (the data the
analysts score) are still seeded. The options historical/derivatives layer
(`src/registry/logic/hist.ts` → `fetchHistoricalBundle`) is mock-first; the live
Polygon/Treasury `DataSourceSpec`s (`polygonOptions`, `polygonHist`, `treasuryRfr`)
are declared on `options_ingestion` with `onError:'degrade'` but are **not yet
wired to the acquisition layer** — see §11 / the external-data integration work.
`config.dataSources.alphaVantage.apiKey` is still reserved/unused.

**Fix direction:** wire the `polygonHist`/`polygonOptions`/`treasuryRfr` sources
into `acquireForAnalyst` (behind the existing retry + `onError:'degrade'` policy)
so the options `options_ingestion` node consumes real historical price + option
chains + risk-free rate when a key is present, degrading to the `hist.ts` mock
otherwise. This keeps the parity guarantee (no key = no behavior change) intact.

## 3. `package.json` `main` points at the TypeScript entry

`"main": "src/server/index.ts"` is the TypeScript source (run via `tsx`). There
is no compiled JS `main`. **Mitigated:** `npm run server` runs
`tsx src/server/index.ts` directly, so the backend starts correctly. Do **not**
`require` the package `main` after a plain build — use `npm run server`.

## 4. LangGraph `StateGraph` constructed without a state schema — FIXED

**Was:** `financial-graph.ts` did `new StateGraph({})` with an empty object and a comment "In a real implementation, we would define the state schema properly." On modern `@langchain/langgraph` (0.2.x) this throws `Error: Invalid StateGraph input.` at construction time, so `npm run server` crashed on startup.

**Fixed:** the graph now uses a real `Annotation.Root({...})` schema covering every `AgentState` field (`messages` with a `concat` reducer so node outputs accumulate, plus the scalar channels). Server boots and runs end-to-end.

## 4b. Concurrent graph update crash — FIXED

After the schema fix, the graph fanned the 4 analysts out **in parallel** from `data_ingestion`. Each analyst writes the shared `investment_thesis`, `current_step`, and `messages` channels, so LangGraph's pregel engine rejected the superstep with `INVALID_CONCURRENT_GRAPH_UPDATE` (the analysis returned `decision= ERROR: Workflow execution failed`).

**Fixed:** the analysts now run **sequentially** (`data_ingestion → fundamental → technical → sentiment → risk → governance_gatekeeper`). They don't depend on each other's output, so serializing is correct and deterministic. The analysis now completes and returns a real `final_decision`.

## 6. Jest could not resolve `@langchain/core` — FIXED

`npm test` (jest) failed with `Cannot find module '@langchain/core/singletons'`
because `@langchain/core` was only a *peer* dependency of `langgraph`, hoisted in
a parent `node_modules`, and jest's resolver is scoped to the project root.

**Fixed:** added `@langchain/core: ^0.3.40` to `dependencies` (within langgraph's
allowed range) and ran `npm install`. `tsc --noEmit` now shows zero langchain
errors and jest resolves the full `AnalysisServer` → `financial-graph` →
`langgraph` chain.

## 8. Equity agencies are now behaviorally distinct — RESOLVED

The three equity agencies (`long-term`, `medium-term`, `intraday`) previously
differed only by dropdown label + wall card count; the streamed scores/verdicts
were byte-identical because the mock handlers seeded purely from the ticker and
never read `params`/`horizon`.

**Resolved (see `docs/HISTORY.md`):** an `AnalystTuning`
`{ horizon, params }` carrier is threaded `AgencyGraph → GenericAnalystNode →
handler`. Handlers bias output by horizon/params: technical score runs hotter for
intraday; sentiment amplifies social volume for intraday; risk clamps stop-loss
and max-allocation tighter for shorter horizons (intraday strictest); governance
applies a real horizon-dependent preservation veto (intraday REJECTs a stop-loss
> 0.05 or HIGH/EXTREME risk; long-term keeps the legacy random decision).
Long-term output with no tuning is **byte-identical** to the pre-change path, so
all 149 legacy backend tests stay green. New `agency-differentiation.test.ts`
(9 tests) proves the divergence + determinism.

**Incidental fix:** `generateSocialTrends` (sentiment) could emit empty arrays
because `seededRandom` returns values in `[-1, 1)` (JS `%` preserves sign), so
`Math.floor(rng()*3)+1` could go negative. Fixed locally with `Math.abs()`
(same draw count → parity-safe). `seededRandom` itself was **not** changed to
avoid perturbing every handler's output.

## 9. Card-level Settings Panel + unified tabbed gear — SHIPPED

Per-analyst settings are implemented (docs/CARD_SETTINGS_PANEL.md) across Phases
1–4 and fully test-gated. A user can click ONE gear on an analyst card and adjust
only what that analyst actually supports:

- **Credentialed sources**: a token + base URI per `LIVE`+`AUTH` `DataSourceSpec`
  (e.g. Alpha Vantage key + URI), saved via `POST /analyst-config`
  (`extra.uri` carries the URI; the token contract is unchanged).
- **Tunable weights** (`signalSensitivity`/`maxLookbackDays` for technical;
  `maxStopLoss`/`baseAllocation` for risk) saved via `POST /analyst-params` and
  merged into the agency def inside `getGraph()` before `new AgencyGraph(agency)`.
- **Role & Instructions flavors** (multi-flavor Role & Instructions per analyst):
  full CRUD + a Default selector, saved via `POST /analyst-flavors`.

**One gear, tabbed dialog.** As of Phase 1, each analyst card shows a **single**
gear (`⚙`, turns to `✓` when fully configured) that opens `AnalystSettingsDialog`
— a **tabbed** dialog (`[Sources]` `[Role & Instructions]` `[Weights]`) mirroring
the main Settings dialog's `[Connection]` / `[LLM Models]` pattern. The older
two-gear design (separate source gear + settings gear) and the standalone
`AnalystSourceDialog.tsx` component were **removed** — the tabs fully supersede
them. `AnalystSettingsDialog` is 680px wide; the Role & Instructions textarea is
scrollable.

**Live update after a flavor save (the "still not updated" fix).** The trace
drawer's *Instructions* tab previously rendered only `trace.instructions` — the
last run's stored text — so an edited flavor was invisible until a re-run. Now
`AnalysisView` keeps the full live flavor set (`liveFlavorsById`, reloaded via
`onFlavorSaved` → `reloadFlavors` immediately after a save) and the drawer renders
the **live saved flavor**, tagged with a green "● live" badge when it is showing
the saved (not stale) version. So: edit a flavor → Save → open that analyst's card
→ the Instructions tab shows the edit immediately.

The UI is **schema-driven**: `buildAnalystConfigSchema()` derives exactly the
fields declared for each analyst, so the panel renders only adjustable items and
stays empty when there is nothing to configure. Saving affects the **next** run
for that agency; default (no override) is byte-identical to the pre-feature path
(parity preserved).

Backend: `src/server/analyst-params.ts` (`AnalystParamsStore` + validate) and
`src/server/analyst-params-routes.ts` (`GET`/`POST /analyst-params`);
`src/server/analyst-flavors.ts` + `analyst-flavors-routes.ts`
(`GET`/`POST /analyst-flavors`). Frontend: `AnalystSettingsDialog.tsx`,
`api/analystParamsClient.ts`, `api/analystFlavorsClient.ts`, wired through
`AnalysisView.tsx` / `AnalystWall.tsx` / `App.tsx`. New tests: backend
`analyst-params.test.ts` and `analyst-flavors.test.ts`; frontend
`analystGear.test.tsx`, `sourceGearOpensDialog.test.tsx`, and
`AnalystTraceDrawer.test.tsx` (incl. a test proving the live flavor shows
immediately after a save).

**Not done (by design):** the saved weights/credentials/flavors are in-memory
only (no persistence across server restarts) and — except for the Phase 3
`/quote` endpoint — there is **no real data provider** behind a credential
(Issue #2 still applies to analysis inputs; see §11 for the options
historical-data work).

## 10. Options agencies shipped (Phase A–D) — design notes & limitations

Two new option-trading agencies (`options-swing`, `options-intraday`) and a
deterministic options data layer are implemented (see
`docs/OPTIONS_AND_AGENCY_EXPANSION.md` and `ARCHITECTURE.md › Options agencies &
data layer`). All tests are green (jest + vitest) and a live `request_analysis`
with `agencyId:'options-intraday'` / `'options-swing'` returns a populated
`final_decision` + per-analyst option traces.

**Known limitation — Black–Scholes assumptions.** The pricing and greeks are
produced by a textbook Black–Scholes model (`src/registry/logic/greeks.ts`)
with **constant volatility** (the per-expiry IV from the bundle) and no dividend,
no early-exercise / American-feature, and no volatility skew term-structure
dynamics. The vol surface (`vol-surface.ts`) is a deterministic mock, not a
calibrated market surface. These are acceptable for the demo pipeline's parity
guarantee; a real deployment must replace `fetchHistoricalBundle` and the BS
engine with a market data provider + a proper pricer (e.g. binomial / stochastic
vol). The option quotes in the bundle are themselves RNG-seeded, so every
"edge" / "IV percentile" figure is synthetic.

**Known limitation — options_risk / governance veto are mock-gated.** The
governance options veto (§D) acts on `iv_percentile`, `max_loss`, and
`risk_level` emitted by the `options_risk` fn handler. Those signals are
synthetic (seeded), so the veto is a faithful *mechanism* (caps, hedge
requirement, no-overnight strictness) exercised by tests, not a market-risk
engine. No live risk feed backs the veto.

**Known limitation — frontend mirror is hardcoded.** The new agencies/analysts
are duplicated in `frontend/src/components/analysts/{agencies,analysts}.ts` (the
backend registry is not imported at runtime). `agency-mirror.test.ts` guards
against drift, but adding an analyst still requires a manual frontend edit.

## 11. External data integration — Phase 3 (quotes live) + options historical (in progress)

**Phase 3 — live quotes (SHIPPED).** `GET /quote?symbol=<TICKER>` (`src/server/quote.ts`,
`src/server/quote-routes.ts`) proxies Yahoo Finance's tokenless chart endpoint
and normalizes it to `{ symbol, name, price, dayHigh, dayLow, week52High,
week52Low, previousClose, volume, currency, marketTime, source:'yahoo', note? }`.
The unified `MarketDataCard` (Quote tab) renders the company name + price + day
range + 52-week range + volume immediately after a symbol is entered; it fetches
via `api/quoteClient.ts` and degrades to "Market data unavailable" on a `note`.
Vite proxies `/quote` → `:3001`. Verified live against Yahoo (AAPL, MSFT).
Tests: `src/tests/quote.test.ts` (7 backend cases) +
`frontend/src/test/MarketDataCard.test.tsx` (7 frontend cases).

**Options + historical quotes (SHIPPED).** The `fetchHistoricalBundle` contract
in `src/registry/logic/hist.ts` returns `{ price_bars, option_chain, greeks,
rfr, expiries, iv_history }`; it is now backed by real fetchers (mock-first +
parity-safe):

1. **Historical quotes — `GET /history?symbol=&interval=&lookback=`** (SHIPPED).
   `fetchPriceBars(ticker, {interval, lookbackDays, fetchFn})` calls Yahoo
   Finance's tokenless chart endpoint and maps it to `PriceBar[]`; falls back to
   the deterministic `generateBars` mock when the source is unavailable. The
   frontend `MarketDataCard` (History tab) shows a summary (first/last/period
   hi/lo/avg vol) + a recent-bars table, with a `live`/`mock` badge. Vite proxies
   `/history`. Verified live against Yahoo (AAPL, MSFT). Tests:
   `src/tests/history.test.ts` (8) + `frontend/src/test/MarketDataCard.test.tsx` (7).
2. **Options historical chains — `GET /options-history?symbol=`** (SHIPPED).
   `fetchOptionChain(ticker, {apiKey, fetchFn})` calls Polygon's options
   snapshot (`/v3/snapshot/options/{ticker}`) and maps it to `OptionQuote[]`;
   greeks are re-derived via `bsGreeks` for consistency. Mock fallback when no
   `POLYGON_API_KEY` (parity: no key = mock bundle, unchanged). The frontend
   frontend `MarketDataCard` (Options tab) shows an expiry selector +
   ATM-highlighted call/put table. Vite proxies `/options-history`. Tests:
   `src/tests/options-history.test.ts` (7) + `frontend/src/test/MarketDataCard.test.tsx` (7).
3. **Wired into `options_ingestion`** (SHIPPED). `resolveLiveOptionsBundle(ticker,
   profile, {apiKey, fetchFn})` upgrades the base mock bundle with live Yahoo
   bars + Polygon chain when a key/transport is present; the `options_ingestion`
   handler reports the real `source` in its trace inputs + a conditional note
   ("set POLYGON_API_KEY to wire live" vs "Live Polygon… wired in"). Parity
   preserved: no key = identical mock behavior. Tests:
   `src/tests/live-bundle.test.ts` (2).

To enable live options: set `POLYGON_API_KEY` in the server environment (e.g.
`.env`); quotes need no key (Yahoo tokenless).

### 11.1 Raw per-analyst data dump ships as `report-<id>.json`
A new export sibling persists **all raw collected data** with a per-analyst
annotation, for traceability and a future UI re-view (see `docs/HISTORY.md`).
Equity runs dump `state.ingested` (bars/market/fundamental/sentiment); options
runs dump `state.optionsData` (underlying bars + option_chain + Black–Scholes
greeks). Each consuming analyst records a `dataReceived` entry
(ticker/domain/interval/source/asOf) so the UI can later show exactly what that
analyst saw. Additive + parity-safe: pdf/md/html output unchanged; existing
suites stay green. Replay is a deferred follow-up (mock data is deterministic
per ticker+profile, so the JSON is already a valid replay seed).

## Verification

- Type-check clean: `npx tsc --noEmit` → only the pre-existing
  `generic-analyst.node.ts:164` (`payload: never`) baseline error remains
  (unrelated to Phases A–G; all Phase files clean)
- Tests green: `npm test` → backend jest (**296 passed, 31 suites**) +
  front-end vitest (**127 passed, 24 files**)
- Front-end build: `npm run build` → `frontend/dist` produced, Vite compiled
- **§10.6 + §12.4.1 UI complete** (this round): `AnalystSettingsDialog` now
  offers full flavor CRUD (editable name/role/instructions textarea, **+ Add
  flavor**, **Delete flavor** disabled at the last remaining flavor, a
  per-flavor **Default** checkbox) and posts the real full flavor set
  (instructions preserved, ≥1 / unique-id / exactly-one-default validated by
  the server). The top-right ⚙ Settings → **LLM Models** tab's "Default model
  for this agency" dropdown now targets the **currently selected** agency
  (agency selection lifted into `App` so `SettingsDialog` and `AnalysisView`
  share it) and POSTs `agencyModelRole` for that agency via `POST /llm-config`.
- Server boots: `npm run server` → logs `Server running on http://localhost:3001`
- Socket.IO handshake (from `:5173`): `curl -H "Origin: http://localhost:5173"
  "http://localhost:3001/socket.io/?EIO=4&transport=polling"` → HTTP 200 with
  `Access-Control-Allow-Origin: http://localhost:5173`
- End-to-end analysis: a Socket.IO client emitting `request_analysis` returns a
  normalized `analysis_complete` with a populated `final_decision`,
  `confidence`, and `reasoning` (no more `undefined%`); verified for BOTH
  `options-intraday` and `options-swing` agencies (see
  `src/tests/options-streaming.integration.test.ts`)

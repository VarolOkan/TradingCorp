# Multi-Source Data Architecture (vendor-agnostic fan-in)

Status: P0–P3 SHIPPED + tested; P4 PARTIAL (call-site consolidation done, legacy-fetcher deletion BLOCKED on missing option_chain/fundamentals adapters); P5–P6 pending.
hard-coded provider, let each data *domain* be served by one-or-many pluggable
sources in different layouts, and let an analyst **weigh all candidate sources**
instead of trusting a single one. Goal: kill vendor lock-in and widen the
evidence base (e.g. Sentiment reads Yahoo + Finnhub, Options reads
Massive/Polygon + CBOE, Fundamentals reads Alpha Vantage + a second provider).

> This is a *major rework* but it is **not greenfield**. A provider-agnostic
> acquisition layer already exists (§4.9). The missing pieces are (1) a typed
> **data-domain** contract per analyst, (2) per-provider **adapters** that move
> today's inline URL+parse out of the call sites, and (3) a **fan-in / weighting**
> layer above acquisition. See "What already exists" before estimating.

---

## 1. What the code does TODAY (hard-wiring audit)

Every provider call is a bespoke function with the endpoint URL and the
provider-specific parse **inlined** at the call site. They bypass the existing
`acquire()` engine and hard-code both *which* provider and *how* to read it.

| Data needed by analyst        | Current call site (hard-wired)                                  | Endpoint (inlined)                                  | Fallback today                         |
|-------------------------------|----------------------------------------------------------------|-----------------------------------------------------|----------------------------------------|
| Price bars (technical/options)| `hist.fetchPriceBars` `src/registry/logic/hist.ts:401`         | `YAHOO_CHART(...)` (Yahoo chart API)                 | deterministic mock (`source:'mock'`)   |
| Option chain (options/greeks) | `hist.fetchOptionChain` `hist.ts:917`; `resolveLiveOptionsBundle` `hist.ts:1134` | `api.massive.com/v3/snapshot/options/{ticker}` | `fetchCboeOptionChain` `hist.ts:683` (CDN, keyless), then mock |
| Fundamentals (fundamental)    | `data-ingestion.fetchRealFinancialData` `data-ingestion.ts:399` (AlphaVantage branch `:433`) | `alphavantage.co/query?function=OVERVIEW` | seeded random balance sheet (`data-ingestion.ts:468`) |
| News/sentiment (sentiment)    | `news.fetchCompanyNews` `news.ts:278`                          | Finnhub `finnhub.io/api/v1/company-news`            | Yahoo → Google News RSS → synthetic mock (already fan-in!) |
| Risk-free rate (options)      | Treasury feed (keyless)                                         | `api.fiscaldata.treasury.gov/...avg_interest_rates` | n/a (auth:'none')                      |

The one bright spot: `news.ts` **already** fans out Finnhub → Yahoo → Google →
mock and merges. That is the exact pattern this rework generalizes into a
first-class layer.

## 2. What ALREADY EXISTS (do not rebuild)

The provider-agnostic primitives are present and tested:

- **`DataSourceSpec`** (`src/types/registry.ts:28`) — one source entry: `id`,
  `endpoint`, `auth` (`none|bearer|apikey|finnhub`), `fields`, `okPath`,
  `healthQuery`/`healthFields`, `timeoutMs`, `retries`, `required`,
  `onError` (`skip|degrade|fallback|fail`), `fallbackSourceId`.
- **`acquireSource()`** (`src/registry/sources/acquire.ts:195`) — fetches ONE
  source with timeout/retry/non-retryable 401-403 fast-fail/429 backoff/schema
  validation, returns `AcquireResult { id, ok, status, data, reason, authError }`.
- **`acquireForAnalyst()`** (`src/registry/sources/index.ts:69`) — runs ALL of
  an analyst's declared `dataSources`, applies per-source `onError` policy,
  resolves `fallbackSourceId` chains, and returns `merged` keyed by **source id**
  (`merged[sourceId]`), plus `sourceStatus`, `degraded`, `usedMockFallback`,
  `hardFailed`, `authError`. It already supports **multiple sources per analyst**.
- **`aggregateDataHealth()`** (`src/registry/sources/index.ts:152`) — pipeline
  summary (`sourcesOk`, `sourcesTotal`, `degradedAnalysts`, `unavailableSources`).
- **`DEFAULT_SOURCE_URIS`** (`src/registry/analyst-config-schema.ts:25`) — the
  canonical base URIs catalog (alphaVantage, finnhub, polygonOptions,
  polygonHist, treasuryRfr). Add a source → add a row here.
- **Settings UI / [Test] probe** — already source-driven off `DataSourceSpec`
  (base URI + token), so a new source is configurable in the UI for free.

**Conclusion:** the transport is swappable *today*. The gap is that the
*call sites still call providers directly* and that acquisition output is **not
normalized or weighed** before an analyst consumes it.

---

## 3. Target architecture (3 layers)

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
   │ (layout A)  │      │ (layout B)  │       │ (layout C)  │
   └──────┬──────┘      └──────┬──────┘       └──────┬──────┘
          ▼                    ▼                     ▼
   ┌───────────────────────────────────────────────────────────┐
   │ EXISTING acquisition engine  (acquireSource / acquireFor…) │
   │ endpoint + auth + timeout + retry + validate + fallback    │
   └───────────────────────────────────────────────────────────┘
```

### 3.1 Data domains (the new contract)

A `DataDomain` is a *typed need*, independent of any provider. Each analyst
**requires** a set of domains; the config maps each domain to ≥1 source.

| Domain            | Canonical shape (interface)        | Consumed by            | Candidate sources (today → add)                          |
|-------------------|------------------------------------|------------------------|----------------------------------------------------------|
| `price_bars`      | `PriceBar[]` (t,o,h,l,c,v,vwap)    | technical, options     | Yahoo (now) → + Polygon aggregates, + AlphaVantage, IEX  |
| `fundamentals`    | `KeyRatios` (de/roe/roa/margin/fcfy) | fundamental          | AlphaVantage OVERVIEW (now) → + FMP, Finnhub profile, SEC|
| `news_sentiment`  | `NewsHeadline[]` + `sentiment_score` | sentiment            | Finnhub (now) → + Yahoo, Google, **+ social (P6)**       |
| `option_chain`    | `OptionQuote[]` + expiries + spot   | options, risk          | Massive/Polygon (now) → + CBOE (fallback), Tradier, IEX  |
| `risk_free_rate`  | `number` (annualized)               | options (pricing)      | Treasury fiscaldata (now, keyless)                       |
| `market_meta`     | beta, realized vol, mkt cap         | risk, fundamental      | derived from `price_bars`; provider-supplied optional    |

Each canonical shape lives in `src/registry/types/domains.ts` (NEW). The analyst
handler signature changes from "call yahoo/alphavantage/finnhub" to
`resolveDomain('sentiment', ticker, ctx) → NormalizedSentiment[]` (a list, not
a single value — so it can weigh several).

### 3.2 Adapter (the swappable unit)

One `Adapter` per provider, registered in a catalog. It knows ONLY:
- which `DataSourceSpec`(s) it fulfils (by `id`),
- how to map that provider's response layout → the domain's canonical shape.

```ts
interface DomainAdapter {
  sourceId: string;                 // matches DataSourceSpec.id
  domain: DataDomain;
  normalize(raw: any, ctx: AdaptCtx): NormalizedRecord;  // layout A → canonical
  /** optional freshness/coverage self-score used by weighting */
  confidence?(raw: any): number;    // 0..1
}
```

Moving the inline parse out of `hist.ts`/`data-ingestion.ts`/`news.ts` into
adapters is the bulk of the mechanical work and is **highly testable** (fixture
in → canonical out).

### 3.3 Fan-in + weighting (the analyst-facing change)

`resolveDomain(domain, ticker, sources, ctx)`:
1. acquire each candidate source via `acquireSource` (existing),
2. run each ok payload through its adapter's `normalize`,
3. return `NormalizedRecord[]` (each tagged `sourceId`, `status`, `confidence`).

The analyst handler then **weighs** the records. Two weighting modes:
- **Config-driven** (today's `WeightingStepSpec`, `src/types/registry.ts:79`):
  per-source weight + agreement bonus (sources that agree get a boost).
- **Agreement-weighted**: `score = Σ w_i·s_i` where `w_i` derived from
  `confidence × (1 + agreementBonus)`. If sources diverge sharply, the analyst
  records a `low_consensus` note (honest provenance — matches the semantic-
  honesty bar in AGENT.md).

This is exactly the user's "Sentiment weighs Yahoo AND Finnhub" requirement, and
it applies uniformly to every analyst because it sits above the domain layer.

---

## 4. Phased plan (each phase test-gated; stop for verify between phases)

### P0 — Domain contracts + typed resolveDomain (no behavior change)
**STATUS: DONE — executed + tested (65 suites / 570 pass, 0 regressions).** Files:
- `src/registry/types/domains.ts` — `DataDomain` union, `NormalizedRecord<T>`
  envelope, `DomainShapes` canonical interfaces (§3.1), `ResolveDomainCtx`
  (fetchFn/finnhubKey/alphaVantageKey/apiKey/profile), `mkRecord` constructor.
  PURE types, no provider URLs.
- `src/registry/logic/domains.ts` — `resolveDomain(domain, ticker, ctx)` wraps
  the EXISTING single-source functions (fetchPriceBars, fetchOptionChain,
  fetchCompanyNews, fetchRealFinancialData, acquireSource+parseTreasuryRfr) and
  returns a **single-element** `NormalizedRecord[]`. `risk_free_rate` is wired
  for real through the §4.9 engine; `market_meta` derives realized vol from
  price_bars.
- `src/tests/domains.p0.test.ts` — 9 parity tests. Each asserts `resolveDomain(d)`
  returns `sourceId` + data byte-equal to the legacy call (option_chain compares
  structural chain since greeks re-derive from ambient rfr and float-differ
  <1e-4). Proves the result is always a LIST (so P2 extends to N sources with no
  signature change).

**Executed flip (recursion-safe, leaf call sites only):**
- `data-ingestion.ts` `fetchEquityBars` → `resolveDomain('price_bars')`.
- `data-ingestion.ts` sentiment upgrade → `resolveDomain('news_sentiment')`.
- `hist.ts` `resolveLiveOptionsBundle` → `resolveDomain('price_bars')` +
  `resolveDomain('option_chain')` (apiKey threaded via ctx).
- `AnalystDef.requiredDomains?: DataDomain[]` added + populated on fundamental
  (`fundamentals,price_bars,market_meta`), technical (`price_bars,market_meta`),
  sentiment (`news_sentiment`), risk (`price_bars,option_chain,risk_free_rate,
  market_meta`). This is the vendor-agnostic contract each analyst declares.
- NOT flipped: `fetchRealFinancialData` (the fundamentals orchestrator) keeps
  calling `fetchCompanyNews`/AlphaVantage directly, because
  `resolveDomain('fundamentals')` calls IT — flipping would recurse. P1 extracts
  the AlphaVantage leaf into an adapter so `resolveDomain('fundamentals')` wraps
  the leaf and this orchestrator flips cleanly.
- Verified: `npx jest --runInBand` → 65 suites / 570 pass / 1 skip; tsc adds 0
  new errors (73 pre-existing, unrelated); frontend untouched.

### P1 — Adapter registry + extract inline parse
**STATUS: DONE (Yahoo/Finnhub/AlphaVantage) — 66 suites / 583 pass, 0 regressions.**
An ADAPTER is the *pure parse half* of a source: `normalize(raw, ctx) -> canonical
domain shape | null`. No fetch, no throw (returns null on drift). This makes parse
fixture-testable in isolation, reusable by both the legacy fetch wrappers (now) and
the P2 fan-in (next), and free of provider URLs at the analyst layer.

Landed:
- `src/registry/sources/adapters/types.ts` — `SourceAdapter<D>` + `AdapterContext`.
- `src/registry/sources/adapters/yahoo-price.ts` — `normalizeYahooChart` (extracted
  from `hist.ts` fetchPriceBars). The clean extraction also FIXED 2 long-standing
  strict-mode errors the inline block carried (exactOptionalPropertyTypes vwap +
  possibly-undefined timestamp) — project tsc error count 73 → 71.
- `src/registry/sources/adapters/finnhub-news.ts` — `normalizeFinnhubNews`
  (extracted from `news.ts`; the async `enrichSummaries` fetch stays in the wrapper).
- `src/registry/sources/adapters/alphavantage-fundamentals.ts` — `normalizeAvOverview`
  + `scoreFromAvOverview` (extracted from `data-ingestion.ts`).
- `src/registry/sources/adapters/index.ts` — registry: `getAdapter(domain, id)` +
  `adaptersFor(domain)` (the latter is the P2 fan-in enumeration seam).
- Call sites now DELEGATE parse to the adapter (fetch still in the legacy wrapper):
  `hist.ts` fetchPriceBars, `news.ts` fetchCompanyNews (Finnhub branch),
  `data-ingestion.ts` AlphaVantage OVERVIEW branch.
- `src/tests/adapters.test.ts` — 13 fixture tests (shape + null-on-drift + registry).

Deferred to when P2 needs them (not blocking): dedicated adapters for CBOE, Massive
option-chain, Treasury RFR — their parse already lives in tested helpers
(`parseCboeOptions`, `parsePolygonAggregates`, `parseTreasuryRfr`); wrapping them as
formal `SourceAdapter`s is mechanical and will land alongside the P2 multi-source
option_chain (polygon + cboe) work.

Verify: full backend suite `npx jest --runInBand` → 66 suites / 583 pass / 1 skip
(570 P0 baseline + 13 adapter tests); parity suites (domains.p0, hist, news,
data-ingestion) all still green ⇒ delegation is behavior-identical.

### P2 — Multi-source per domain + config-driven weighting
Split into P2a (fusion engine — DONE) and P2b (multi-source fetch + analyst
wiring + trace UI — NEXT).

**P2a — STATUS: DONE. The pure "weigh ALL sources" core. 67 suites / 595 pass.**
- `src/registry/logic/fuse.ts`:
  - `fuseNumeric(records, {extract, weights, defaultWeight, consensusThreshold, scale})`
    — domain-agnostic weighted blend of a numeric signal across
    `NormalizedRecord[]`. Effective weight = configuredWeight × confidence, so a
    live source dominates a degraded one and a mock (confidence 0) contributes
    NOTHING even if weighted. Returns value + `agreement` (1 − normalized
    dispersion) + `low_consensus` flag + per-source `contributions[]` (for the
    trace drawer) + an honest `note`.
  - `fuseSentiment(records)` — domain wrapper: blends ≥2 `news_sentiment`
    records into one `NewsResult` (headlines unioned, score = weighted blend,
    `source:'mixed'`, note shows each source's score + the consensus verdict).
    Single/all-mock inputs pass through unchanged (parity invariant).
- INVARIANTS (so P2b can wire it under `resolveDomain` without breaking P0/P1):
  one live source in ⇒ value passes through unchanged; zero usable ⇒ `ok:false`
  and the caller keeps its existing fallback.
- `src/tests/fuse.test.ts` — 12 tests incl. the CORE acceptance test: divergent
  Finnhub(+80) + Yahoo(−60) ⇒ blended 10 + `low_consensus` + honest note.
- fuse.ts is STANDALONE (imported by nothing yet) ⇒ zero runtime paths changed;
  full backend suite still green.

**P2b — STATUS: DONE (backend end-to-end fusion). 68 suites / 600 pass, 0 regressions.**
Split into P2b-1 (backend — DONE) and P2b-2 (frontend trace drawer — NEXT).
- `resolveDomain('news_sentiment')` now performs a GENUINE multi-source fan-in:
  record[0] is the legacy primary (finnhub when keyed, else the keyless
  yahoo/google chain) — byte-equal to `fetchCompanyNews`, so P0 parity holds; a
  SECOND record is appended only when the primary is live finnhub AND a keyless
  re-fetch yields an independent live source (yahoo/google). The no-key path and
  the parity-mock path (secondary degrades to mock) are unchanged.
  **Honesty fix:** record[0].sourceId now reflects the REAL primary provenance
  (was hard-coded 'finnhub' even on the keyless path — a mislabel).
- `data-ingestion.ts` consumes the records list: when ≥2 live sources, it fuses
  them via `fuseSentiment` (P2a), writes `data_source='mixed:finnhub+yahoo'`, and
  carries the `consensus` breakdown onto the ingested sentiment; `liveSentimentSources`
  now lists BOTH providers. Single-live still uses the primary unchanged.
- `NewsResult.consensus` (agreement / low_consensus / contributors / contributions)
  is populated on blended `mixed` results, ready for the UI.
- `src/tests/resolve-domain-multisource.test.ts` — 5 tests: 2 live records when
  both live; blend + divergent + flag-consistency; no-key single record with
  HONEST sourceId; parity-mock degrades to single record (P0 parity preserved).

**P2b-2 — STATUS: DONE (frontend trace drawer). 39 FE files / 323 pass (+1).**
- `MarketDataCard.tsx` Sentiment Analyst read now renders the fusion readout
  when `sentiment.consensus` is present: BOTH source badges (finnhub / yahoo /
  google, colour-coded via `.fusion-badge-*`), a `⚠ low consensus` flag when the
  sources disagree, and per-source contribution shares (e.g. `finnhub 60% ·
  yahoo 40%`). When consensus is absent it falls back to the legacy single
  `data_source` string — so single-source runs are unchanged.
- CSS added in `index.css` (`.fusion-badge*`, `.fusion-low-consensus`,
  `.quote-stat-sub`, `.quote-stat-wide`).
- `frontend/src/test/MarketDataCard.test.tsx` — new test asserts both badges,
  the low_consensus flag, and the contribution shares render, and that the legacy
  `mixed:finnhub+yahoo` string is NOT shown when consensus is present.
- NOTE: `agreementBonus` in the sentiment analyst verdict is DEFERRED — the
  consensus data is surfaced honestly for the user, but the analyst's own score
  weighting does not yet mechanically add a bonus for source agreement. Left for
  a follow-up (low-risk; the data pipeline already carries agreement).

P2 is COMPLETE: genuine multi-source fan-in + weighted fusion + honest UI,
parity-safe (P0 tests still green).

### P3 — Swappable source configuration (no code change to switch providers)
**P3a DONE (backend). 68 suites / 605 pass (+5).** Split into P3a (backend engine)
+ P3b (Settings UI wiring — NEXT).
- Added `DOMAIN_SOURCES` in `analyst-config-schema.ts`: the default per-domain
  ordered source list (the SWAPPABLE mapping). `news_sentiment:
  ['finnhub','yahoo','google']` already carries >1 genuinely-live source; the
  rest are single-source today and become multi-source later by appending ids.
- `ResolveDomainCtx.enabledSources?: Partial<Record<DataDomain,string[]>>`
  (types/domains.ts) lets a caller restrict fan-in per domain. When the list is
  explicitly EMPTY, `resolveDomain` returns ONE honest `skipped` record with note
  `all sources disabled for domain '<d>'` — degrading THAT domain, not the
  pipeline. When omitted, behaviour is byte-for-byte the legacy default (P0
  parity holds).
- `resolveDomain` news branch honors the enabled set: primary is finnhub (with
  key) IFF 'finnhub' is enabled, else the keyless yahoo/google chain; a keyless
  secondary is appended only when finnhub is primary AND a keyless source is
  enabled. So disabling finnhub → yahoo-only; disabling all → honest skip.
- `src/tests/resolve-domain-swappable.test.ts` (5 tests): default parity (finnhub
  primary); disable finnhub → yahoo/google only; disable all → honest skipped +
  no false live; disable price_bars source → that domain skips, news unaffected;
  reorder [yahoo,finnhub] still yields live data.
- tsc: 71 (0 new). P0 parity (9/9) + P2b multisource (5/5) still green.

**P3b DONE (frontend + wiring + persistence).** A persisted per-domain source config
a user can edit from Settings → **Data Sources** tab — no code change to switch
providers.
- `src/server/domain-source-config.ts`: `DomainSourceConfigStore` (in-memory +
  JSON file under DATA_DIR `domain-sources.json`, survives restart). `get(domain)`
  resolves UI-override → compile-time `DOMAIN_SOURCES` default; `isOverridden`
  distinguishes a real override from the default.
- `resolveDomain` (P3a already added `enabledSources`) now ALSO auto-reads the
  store when the caller passes no explicit override. So every `resolveDomain`
  call site (data-ingestion, hist) honours the UI config automatically — parity
  is preserved because an unconfigured server returns `undefined` (old path).
  Resolution order: **ctx override > UI config > compile-time default**.
- `src/server/domain-source-routes.ts`: `GET /domain-sources` (effective view
  per domain: available / override / enabled / overridden), `POST
  /domain-sources` (set one domain's ordered enabled list; validates ids against
  `DOMAIN_SOURCES`; empty list = all disabled → that domain degrades), `POST
  /domain-sources/reset` (revert all to defaults). Registered in `server/index.ts`;
  proxied in `vite.config.ts`.
- Frontend: `api/domainSourceClient.ts`, `components/analysts/DomainSourcesTab.tsx`
  (per-domain toggle chips + reorder ↑/↓ + honest "degraded" chip when a domain
  has zero sources enabled — never a false live badge), wired into
  `SettingsDialog.tsx` as the **Data Sources** tab (+ CSS in `index.css`).
- Tests: `src/tests/domain-source-routes.test.ts` (5: GET/POST/validate/reset/
  disk-persist + ctx-override-wins) + `frontend/src/test/DomainSourcesTab.test.tsx`
  (4: load/toggle-degrade/save-POSTs/reset).
- Verified: backend 68 suites / 610 pass (+5); frontend 40 files / 327 pass (+4);
  tsc 71 (zero new); P0 9/9 + P2b 5/5 parity intact.
- NOTE (untested end-to-end in this container): the running XAss copy is not in
  the sandbox, so the live click-through (toggle → next run shows new provenance)
  was NOT exercised in a browser here. The store→resolveDomain wiring is unit-
  proven; deploy + manual UI verify still required (see P3b deploy note).

### P4 — Consolidate call sites onto `resolveDomain` (PARTIAL — deletion BLOCKED)
**Goal:** every external consumer of raw provider data goes through `resolveDomain`
so the multi-source layer (swappable sources, honest degrade, fan-in) is the single
funnel. The originally-intended *deletion* of the legacy fetchers turned out to be
blocked by missing infrastructure (see "Blocked" below) — so P4 delivered the
safe consolidation and explicitly did NOT delete live code.

**Done (verified, zero regressions — backend 610 pass / 1 skip, tsc 70):**
- P4.1 `GET /history` (history-routes.ts) → `resolveDomain('price_bars')`;
  returns `record[0].data` (== the raw `fetchPriceBars` payload) so the frontend
  contract is byte-identical. 19 route tests pass.
- P4.2 `GET /options-history` (options-history-routes.ts) → `resolveDomain('option_chain')`;
  vault key still resolved + passed as `ctx.apiKey`; returns `record[0].data`.
- P4.4 screener `evaluateTicker` `fetchPriceBars` → `resolveDomain('price_bars')`;
  `barsRes` typed back to `PriceBarsResult` so `barsRes.bars` shape is preserved.
  22 screener tests pass.

**Blocked / NOT done (deliberately, to avoid breaking the running app):**
- P4.3 data-ingestion fundamentals repoint: `fetchRealFinancialData`
  (data-ingestion.ts:402) is a **multi-domain orchestrator** (fundamental +
  technical + sentiment + market + bars), not just fundamentals. `resolveDomain('fundamentals')`
  only extracts its `fundamental_data[ticker]` slice. Repointing the ingestion
  handler would require re-plumbing the whole 4-domain object — high regression
  risk for a cleanup phase. Left as-is (handler still calls `fetchFinancialData`).
- P4.5/P4.6 literal deletion of `fetchPriceBars`/`fetchOptionChain`/`fetchRealFinancialData`:
  **NOT safe, because `resolveDomain` itself still calls all three** (domains.ts:91/101/146/186).
  The doc's premise ("everything flows through resolveDomain → adapters →
  `acquireSource`") was never reached — the `adapters/` layer was built in P1 but
  never switched onto the hot path. Two hard gaps:
  1. **No `option_chain` adapter exists.** `adapters/` only has yahoo-price,
     finnhub-news, alphaVantage-fundamentals. The entire Massive→CBOE→mock
     fallback + `parseCboeOptions` greeks logic lives ONLY in `fetchOptionChain`
     (hist.ts:891). Deleting it would delete the FREE CBOE delayed options feed
     + greeks the product depends on. `acquireSource`'s `fallbackSourceId` is a
     field-projection fallback, not a shape-transform (CBOE needs `parseCboeOptions`
     to become an `OptionChainResult`) — so it cannot replace `fetchOptionChain`.
  2. `fetchRealFinancialData` is the orchestrator backing `fundamentals` +
     technical + market, with no adapter equivalent.

**To actually complete the deletion (future work, NOT a cleanup):** build the
missing `option_chain` adapter (Massive + CBOE fallback + mock, preserving
`parseCboeOptions` greeks) + a `fundamentals`/technical/market adapter set, then
rewrite `resolveDomain`'s branches to use `acquireSource` + adapters. Only then do
the legacy fetchers become dead. Until that lands, the fetchers remain as
`resolveDomain`'s backing implementation and the grep-guard acceptance test
(§P4 old spec) cannot pass without breaking the credentials UI / options feed.

- Keep `acquireSource`/`acquireForAnalyst` (they are the engine).
- Verify (for the parts that shipped): full backend suite + frontend 327 + the
  earlier parity tests (P0 9/9, P2b 5/5, P3a 5/5, P3b 5/5) all still green.

### P5 — Docs + migration guide
- Update `docs/ARCHITECTURE.md` (ingestion/options rows → domain layer),
  `docs/SETUP.md` (add a source = add a `DataSourceSpec` + an adapter + a
  `DEFAULT_SOURCE_URIS` row), `README.md` Graphify section cross-link.
- Add `docs/EXTENDING_SOURCES.md`: "to add provider X for domain Y: 1) spec,
  2) adapter.normalize, 3) register, 4) map in AnalystConfigStore".
- Verify: docs reflect reality (the standing rule from AGENT.md).

### P6 — DEFERRED (future): social-network sentiment domain
- NOT this iteration. Once P0–P3 exist, a social source is just another adapter
  feeding `news_sentiment`: add `twitter`, `linkedin`, `facebook`, `news_agency`
  `DataSourceSpec`s (each with its own auth/rate-limit policy) + adapters that
  normalize posts/threads into `NewsHeadline[]`/`sentiment_score`. The fan-in
  layer weighs them alongside Yahoo/Finnhub automatically — **zero analyst-code
  change**. This is the payoff of the abstraction: the user's "future social
  analyst compiles down to sentiment values fed into Sentiment" becomes a pure
  config + adapter addition.

---

## 5. Why this prevents vendor lock-in (the user's stated goal)

- **Provider is a config row, not a code path.** Switching Polygon→IEX for
  options = swap one `DataSourceSpec` + one adapter, no analyst edits.
- **Multiple layouts tolerated.** Each adapter owns its layout; the canonical
  shape is the only contract analysts depend on. A provider changing its JSON
  breaks *one* adapter's test, not the pipeline.
- **Broader evidence by default.** `resolveDomain` returns N records; analysts
  weigh them. More sources = wider, cross-checked signal (and `low_consensus`
  flags disagreement honestly).
- **Free social extension** (P6) falls out of the same interface.

## 6. Risks / guardrails
- **Parity is the contract.** Every phase keeps `resolveDomain` output byte-equal
  to today for single-source configs; parity tests gate each phase.
- **Token safety.** Adapters never log tokens; rely on existing `acquireSource`
  header logic (verified: token attached, never echoed).
- **Semantic honesty preserved.** Degraded/missing domains emit honest
  `seeded`/`unavailable` notes — no false "live" badge (per AGENT.md bar).
- **No new credential UI for keyless sources.** Treasury/CBOE stay hardcoded
  backend config, excluded from the token-entry Settings (per user rule).
- **Performance.** Fan-in multiplies outbound calls; lean on existing per-source
  `timeoutMs`/`retries` and run domains in parallel (`Promise.all`).

## 7. Acceptance criteria (definition of done for the rework)
1. No provider endpoint literal exists outside `adapters/` + `DEFAULT_SOURCE_URIS`.
2. Every analyst consumes `NormalizedRecord[]` per domain and weights them.
3. Sentiment result demonstrably blends ≥2 providers (test in P2).
4. A provider can be disabled/reordered in Settings with the UI provenance flipping
   accordingly (test in P3).
5. Full backend + frontend suites green; docs updated.

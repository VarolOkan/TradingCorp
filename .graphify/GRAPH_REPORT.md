# Graph Report - .  (2026-07-18)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 1806 nodes · 3957 edges · 99 communities (74 shown, 25 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 25 edges (avg confidence: 0.74)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `163ae32b`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- hist.ts
- ResultsPanel.tsx
- index.ts
- logger.ts
- registry.ts
- index.ts
- financial-analysis.ts
- registry.ts
- SettingsDialog.tsx
- compilerOptions
- report-routes.ts
- LlmRole
- fundamental.ts
- screener.ts
- llm-config.ts
- CompareView.tsx
- registry-routes.ts
- AgentState
- logic.ts
- options-ingestion-live.test.ts
- AnalystConfigStore
- dependencies
- domains.ts
- index.ts
- TokenVault
- registryClient.ts
- AnalystWall.tsx
- RegistrySqliteStore
- news.ts
- technical.ts
- react
- data-ingestion.ts
- governance.ts
- shared.ts
- llm-vault.ts
- domains.ts
- RegistryJsonStore
- greeks-cboe-parity.test.ts
- AnalystFlavorStore
- RetryHandler
- ScreenerPanel.tsx
- watchlist.ts
- AnalystTraceDrawer.tsx
- analyst-params.test.ts
- AnalystSettingsDialog.tsx
- DomainSourcesTab.tsx
- MarketDataCard.tsx
- PriceChart.tsx
- compilerOptions
- risk.ts
- registry-store.ts
- types.ts
- scripts
- devDependencies
- JsonLlmStore
- keywords
- AnalysisView.tsx
- orchestrator.ts
- agency-differentiation.test.ts
- AgencySettingsDialog.tsx
- AnalystDef
- thesis-summary.ts
- Logger
- rebuild.sh
- SettingsDialog.agencies.test.tsx
- package.json
- newsClient.ts
- optionsHistoryClient.ts
- ResizeObserverStub
- buildLegacyGraph
- lib
- include
- options-instructions.ts
- graphify
- autoprefixer
- eslint
- jest
- jsdom
- next-env.d.ts
- postcss
- tailwindcss
- @testing-library/user-event
- ts-jest
- @types/d3
- @types/jest
- @types/react-dom
- @types/supertest
- @typescript-eslint/parser
- @vitejs/plugin-react
- vitest
- @vitest/coverage-v8
- ANALYST_DEF_BY_ID

## God Nodes (most connected - your core abstractions)
1. `AgentState` - 53 edges
2. `LlmRole` - 33 edges
3. `compilerOptions` - 33 edges
4. `AnalystDef` - 32 edges
5. `react` - 30 edges
6. `RegistrySqliteStore` - 26 edges
7. `TokenVault` - 25 edges
8. `RegistryJsonStore` - 25 edges
9. `Logger` - 25 edges
10. `RegistryStore` - 22 edges

## Surprising Connections (you probably didn't know these)
- `CatalogAnalyst` --inherits--> `AnalystDef`  [EXTRACTED]
  frontend/src/api/registryClient.ts → src/types/registry.ts
- `ReportModal()` --indirect_call--> `text()`  [INFERRED]
  frontend/src/components/ReportModal.tsx → src/tests/llm-config.test.ts
- `AgencySettingsDialogProps` --references--> `LlmRole`  [EXTRACTED]
  frontend/src/components/analysts/AgencySettingsDialog.tsx → src/server/llm-config.ts
- `LlmConfigResponse` --references--> `LlmRole`  [EXTRACTED]
  frontend/src/api/llmConfigClient.ts → src/server/llm-config.ts
- `LlmConfigStatusResponse` --references--> `LlmProvider`  [EXTRACTED]
  frontend/src/api/llmConfigClient.ts → src/server/llm-config.ts

## Import Cycles
- 4-file cycle: `src/registry/logic/news.ts -> src/registry/sources/adapters/finnhub-news.ts -> src/registry/sources/adapters/types.ts -> src/registry/types/domains.ts -> src/registry/logic/news.ts`
- 4-file cycle: `src/registry/sources/adapters/price-bars.ts -> src/registry/sources/adapters/yahoo-price.ts -> src/registry/sources/adapters/types.ts -> src/registry/types/domains.ts -> src/registry/sources/adapters/price-bars.ts`
- 5-file cycle: `src/registry/sources/adapters/option-chain.ts -> src/registry/sources/adapters/price-bars.ts -> src/registry/sources/adapters/yahoo-price.ts -> src/registry/sources/adapters/types.ts -> src/registry/types/domains.ts -> src/registry/sources/adapters/option-chain.ts`

## Communities (99 total, 25 thin omitted)

### Community 0 - "hist.ts"
Cohesion: 0.06
Nodes (48): basePrice(), chainToGreeksRows(), deriveStrikeSpacing(), fetchHistoricalBundle(), generateBars(), generateExpiries(), generateMockBundle(), HistProfile (+40 more)

### Community 1 - "ResultsPanel.tsx"
Cohesion: 0.05
Nodes (47): apiBase(), deleteReport(), fetchReportMarkdown(), fetchReportRawData(), listReports(), postReport(), reportDownloadUrl(), ReportFiles (+39 more)

### Community 2 - "index.ts"
Cohesion: 0.05
Nodes (28): AnalystConfigSchema, AnalystId, buildAnalystConfigSchema(), DEFAULT_SOURCE_URIS, DOMAIN_SOURCES, fallbackFor(), HORIZON_PARAM_KEYS, num() (+20 more)

### Community 3 - "logger.ts"
Cohesion: 0.06
Nodes (36): express, getConfig(), postSettings(), PostSettingsResponse, StaticConfigResponse, ConnectionSettings, express, config (+28 more)

### Community 4 - "registry.ts"
Cohesion: 0.07
Nodes (26): GraphState, AnalysisGraph, AGENCIES, ANALYST_DEF_IDS, ANALYST_DEFS, defaultAnalystIds(), optionsAnalystIds(), deriveAnalystMetaFromDefs() (+18 more)

### Community 5 - "index.ts"
Cohesion: 0.08
Nodes (37): buildRegistry(), DEFAULT_UNIVERSE, getUniverse(), GetUniverseOpts, UniverseCache, EXCH, isPlainEquitySymbol(), makeNasdaqTraderProvider() (+29 more)

### Community 6 - "financial-analysis.ts"
Cohesion: 0.04
Nodes (36): bar(), node, series(), node, AnalystId, AnalystTraceInput, BarInterval, DataIngestionInput (+28 more)

### Community 7 - "registry.ts"
Cohesion: 0.10
Nodes (17): RelationsGraphView(), FakeViz, StubViz, createVisualization(), Ctor, getVisualizationTypes(), registerVisualization(), registry (+9 more)

### Community 8 - "SettingsDialog.tsx"
Cohesion: 0.07
Nodes (29): AnalystFlavorField, buildAnalystConfigSchema(), DEFAULT_SOURCE_URIS, SourceCredField, TUNABLE_WEIGHTS, WEIGHT_DEFAULTS, WeightField, withKeyGroups() (+21 more)

### Community 9 - "compilerOptions"
Cohesion: 0.05
Nodes (41): *.config.ts, dist, node_modules, src/**/*, compilerOptions, allowJs, allowSyntheticDefaultImports, allowUnreachableCode (+33 more)

### Community 10 - "report-routes.ts"
Cohesion: 0.10
Nodes (37): AGENCY_IDS, AnalystSlide, buildRawDataDump(), buildReportModel(), DataHealth, drawDeck(), escapeHtml(), inline() (+29 more)

### Community 11 - "LlmRole"
Cohesion: 0.10
Nodes (18): LlmConfigPost, LlmConfigResponse, LlmConfigStatusResponse, LlmConfigTestResponse, LlmModelConfigPublic, dataDir(), dataFilePath(), LlmProvider (+10 more)

### Community 12 - "fundamental.ts"
Cohesion: 0.15
Nodes (29): instructionFor(), annualizedVol(), assessMoat(), avgHealthScore(), buildFundamental(), fundamentalHandler(), generateAnalysisSummary(), numOr() (+21 more)

### Community 13 - "screener.ts"
Cohesion: 0.11
Nodes (31): NewsFetchFn, AXIS_ANALYSTS, DataSourceBadge, DEFAULT_UNIVERSE, evaluateTicker(), INTRADAY_SCREENER_AGENCIES, mapPool(), momentumScore() (+23 more)

### Community 14 - "llm-config.ts"
Cohesion: 0.11
Nodes (27): model(), extractScore(), extractVerdict(), isLLMConfigured(), llmConfigStoreOrNull(), LLMRequest, LLMResult, resolveRequestConfig() (+19 more)

### Community 15 - "CompareView.tsx"
Cohesion: 0.12
Nodes (25): getPriceHistory(), PriceBar, PriceBarsResult, alignTail(), ClosePoint, correlationMatrix(), dailyReturns(), normalizeToBase() (+17 more)

### Community 16 - "registry-routes.ts"
Cohesion: 0.10
Nodes (13): defaultAgency(), resolveVaultUserId(), AgencySummary, isValidAgencyDef(), isValidAnalystDef(), isValidAnalystRef(), registerRegistryRoutes(), resolveUserId() (+5 more)

### Community 17 - "AgentState"
Cohesion: 0.11
Nodes (13): GenericAnalystNode, NOTE: fn handlers are registered as `(state) => handler(state, surface)` in, IMPORTANT: `analystTraces` has a *concat* reducer on the graph channel., summarizeAnalystOutput(), getLogicHandler(), AnalystHelpers, makeNodeSurface(), AnalysisSocketServer (+5 more)

### Community 18 - "logic.ts"
Cohesion: 0.17
Nodes (22): ANALYST_LOGIC_REGISTRY, AnalystFn, numOrRate(), optionsGreeksHandler(), optionsIngestionHandler(), optionsPricingHandler(), optionsRiskHandler(), AnyTrace (+14 more)

### Community 19 - "options-ingestion-live.test.ts"
Cohesion: 0.14
Nodes (24): AcquireContext, AcquireResult, acquireSource(), applySourcePolicy(), buildHeaders(), delay(), expandUrl(), FetchFn (+16 more)

### Community 20 - "AnalystConfigStore"
Cohesion: 0.12
Nodes (12): AnalystConfigStore, AnalystConfigValidation, composeKey(), CredentialKey, buildSourceCatalog(), isCredentialedSource(), originOf(), probeSource() (+4 more)

### Community 21 - "dependencies"
Cohesion: 0.07
Nodes (28): better-sqlite3, dotenv, @langchain/core, @langchain/langgraph, dependencies, better-sqlite3, dotenv, @langchain/core (+20 more)

### Community 22 - "domains.ts"
Cohesion: 0.12
Nodes (17): getDomainEnabledSources(), isLiveSource(), LEGACY_SOURCE_ID, resolveDomain(), acquirePriceBars(), acquireYahooChartRaw(), NOTE: we deliberately call `doFetch` directly + feed the FULL payload to the, YAHOO_CHART() (+9 more)

### Community 23 - "index.ts"
Cohesion: 0.18
Nodes (21): NewsHeadline, alphaVantageFundamentalsAdapter, normalizeAvOverview(), num(), scoreFromAvOverview(), finnhubNewsAdapter, FinnhubNormalized, normalizeFinnhubNews() (+13 more)

### Community 24 - "TokenVault"
Cohesion: 0.13
Nodes (5): defaultLlmConfigs(), LlmConfigStore, TokenVault, vaultedStore(), aesVault()

### Community 25 - "registryClient.ts"
Cohesion: 0.10
Nodes (14): AgencySummary, CatalogAnalyst, deleteAgency(), postAgency(), putAgencyAnalysts(), RegistryCatalog, AgencyReorgDialog(), AgencyReorgDialogProps (+6 more)

### Community 26 - "AnalystWall.tsx"
Cohesion: 0.17
Nodes (17): AnalystConfigSchema, analystById(), AnalystId, AnalystMeta, ANALYSTS, IMPORTANT: this list is the UNION of analysts across ALL agencies (it includes, AnalystWall(), AnalystWallProps (+9 more)

### Community 27 - "RegistrySqliteStore"
Cohesion: 0.17
Nodes (3): applyAllOverridesToRegistry(), applyOverridesToRegistry(), RegistrySqliteStore

### Community 28 - "news.ts"
Cohesion: 0.17
Nodes (21): enrichSummaries(), escapeRegExp(), extractLead(), fetchArticleLead(), fetchCompanyNews(), mergeHeadlines(), mockHeadlines(), NEGATIVE_TERMS (+13 more)

### Community 29 - "technical.ts"
Cohesion: 0.17
Nodes (23): analyzeMomentum(), assessVolatility(), atr(), avgTechnicalScore(), bollinger(), computeIndicatorsFromBars(), computeMaxDrawdown(), computeSupportResistance() (+15 more)

### Community 30 - "react"
Cohesion: 0.19
Nodes (15): getAnalystSourceCatalog(), getRegistry(), App(), AGENCIES, AGENCY_IDS, agencyById(), AgencyId, AgencyMeta (+7 more)

### Community 31 - "data-ingestion.ts"
Cohesion: 0.16
Nodes (15): dataIngestionHandler(), EquityProfile, equityProfileFromTuning(), fetchEquityBars(), fetchFinancialData(), fetchRealFinancialData(), getDateDaysAgo(), IngestionFetchFn (+7 more)

### Community 32 - "governance.ts"
Cohesion: 0.14
Nodes (16): createApprovalDecision(), createOptionsRejectionDecision(), createRejectionDecision(), extractOptionsRisk(), extractRiskAssessments(), generateDecisionSummary(), governanceHandler(), performGovernanceReview() (+8 more)

### Community 33 - "shared.ts"
Cohesion: 0.19
Nodes (13): applyVerdict(), declarativeHandler(), resolveFeatureValues(), isMockDisabled(), setMockDisabled(), shouldShowMockDisabledBanner(), mergeDataReceived(), seededRandom() (+5 more)

### Community 34 - "llm-vault.ts"
Cohesion: 0.13
Nodes (9): AesCipher, Cipher, createVault(), getSharedVault(), GpgCipher, WHY: LlmConfigStore is in-memory, so every server restart wiped all LLM, selectCipher(), SourceTokenDTO (+1 more)

### Community 35 - "domains.ts"
Cohesion: 0.16
Nodes (17): FuseContribution, fuseNumeric(), FuseOptions, FuseResult, fuseSentiment(), FuseSentimentResult, FuseWeights, NewsResult (+9 more)

### Community 37 - "greeks-cboe-parity.test.ts"
Cohesion: 0.20
Nodes (17): bsGreeks(), bsPrice(), d1(), Greeks, normCdf(), normPdf(), OptionType, resolveRfr() (+9 more)

### Community 38 - "AnalystFlavorStore"
Cohesion: 0.17
Nodes (9): AnalystFlavorStore, composeKey(), FlavorKey, FlavorSet, FlavorValidation, key, set, tmp (+1 more)

### Community 39 - "RetryHandler"
Cohesion: 0.15
Nodes (5): AnalysisRetryHandler, CircuitBreakerState, DataIngestionRetryHandler, RetryConfig, RetryHandler

### Community 40 - "ScreenerPanel.tsx"
Cohesion: 0.17
Nodes (13): DataSourceBadge, getScreener(), ScreenerResult, ScreenerRow, UniverseTrace, UniverseTraceStep, resolveAssetClass(), axisLabel() (+5 more)

### Community 41 - "watchlist.ts"
Cohesion: 0.32
Nodes (15): WatchlistBar(), WatchlistBarProps, addWatch(), emit(), getWatchlist(), isBrowser(), isWatched(), listeners (+7 more)

### Community 42 - "AnalystTraceDrawer.tsx"
Cohesion: 0.18
Nodes (12): GetAnalystFlavorsResponse, AnalystTraceDrawer(), AnalystTraceDrawerProps, formatValue(), Tab, TABS, TraceBreadcrumb, verdictClass() (+4 more)

### Community 43 - "analyst-params.test.ts"
Cohesion: 0.20
Nodes (9): ALLOWED_PARAM_KEYS, AnalystParams, AnalystParamsStore, AnalystParamsValidation, composeKey(), ParamsKey, registerAnalystParamsRoutes(), sessionOf() (+1 more)

### Community 44 - "AnalystSettingsDialog.tsx"
Cohesion: 0.18
Nodes (13): AgencyFlavorSummaryResponse, AnalystFlavorDTO, BulkEnableLlmResponse, getAnalystFlavors(), postAnalystFlavors(), PostAnalystFlavorsResponse, getAnalystParams(), GetAnalystParamsResponse (+5 more)

### Community 45 - "DomainSourcesTab.tsx"
Cohesion: 0.18
Nodes (12): DomainSourcesResponse, DomainSourceView, getDomainSources(), resetDomainSources(), setDomainSources(), SetDomainSourcesResponse, DOMAIN_LABELS, DomainSourcesTab (+4 more)

### Community 46 - "MarketDataCard.tsx"
Cohesion: 0.18
Nodes (15): fmt(), fmtBig(), fmtDate(), fmtIv(), fmtPct(), fmtVol(), Interval, INTERVALS (+7 more)

### Community 47 - "PriceChart.tsx"
Cohesion: 0.19
Nodes (14): bollinger(), ChartBar, cumVolVwap(), ema(), fmtAxis(), fmtDate(), fmtNum(), linePath() (+6 more)

### Community 48 - "compilerOptions"
Cohesion: 0.12
Nodes (17): vitest/globals, compilerOptions, allowImportingTsExtensions, isolatedModules, jsx, module, moduleResolution, noEmit (+9 more)

### Community 49 - "risk.ts"
Cohesion: 0.19
Nodes (15): assessPortfolioImpact(), calculateMaxAllocation(), calculateStopLoss(), calculateTakeProfit(), determineRiskLevel(), determineSeverity(), dominantRiskLevel(), escalate() (+7 more)

### Community 50 - "registry-store.ts"
Cohesion: 0.13
Nodes (11): COMPILED_AGENCIES, COMPILED_ANALYST_DEFS, createRegistryStore(), DEFAULT_JSON_DIR(), OverrideKind, RegistryDriverName, resolveDriverName(), buildFor() (+3 more)

### Community 51 - "types.ts"
Cohesion: 0.13
Nodes (12): PostAnalystConfigResponse, SourceTestResult, AgentThought, AnalystSourceCatalogEntry, AnalystSourceConfig, AnalystTraceInput, DataHealth, Decision (+4 more)

### Community 52 - "scripts"
Cohesion: 0.12
Nodes (16): scripts, build, dev, dev:all, graphify, graphify:docs, lint, server (+8 more)

### Community 53 - "devDependencies"
Cohesion: 0.15
Nodes (15): concurrently, devDependencies, concurrently, supertest, @testing-library/dom, @testing-library/jest-dom, @testing-library/react, tsx (+7 more)

### Community 54 - "JsonLlmStore"
Cohesion: 0.25
Nodes (3): JsonLlmStore, file, tmp

### Community 55 - "keywords"
Cohesion: 0.17
Nodes (12): d3, d3, socket.io, vite, keywords, analysis, financial, langgraph (+4 more)

### Community 56 - "AnalysisView.tsx"
Cohesion: 0.23
Nodes (8): getQuote(), QuoteResult, AnalysisForm(), AnalysisFormProps, AnalysisView(), AnalysisViewProps, NOTE: depend only on agencyId + sessionId — `agencyAnalysts` is a fresh, AnalystSourceCatalog

### Community 57 - "orchestrator.ts"
Cohesion: 0.26
Nodes (7): ANALYST_INSTRUCTIONS, AnalystInstruction, AnalystPromptId, NOTE: TradingAgents' literal upstream prompt strings are not copied here, surface, ParsedQuery, parseQuery()

### Community 58 - "agency-differentiation.test.ts"
Cohesion: 0.17
Nodes (5): intraday, longTerm, medium, surface, tickers

### Community 59 - "AgencySettingsDialog.tsx"
Cohesion: 0.29
Nodes (8): enableLlmForAllAnalysts(), getAgencyFlavorSummary(), getLlmConfig(), postLlmConfig(), AgencySettingsDialog(), AgencySettingsDialogProps, enableMock, summaryMock

### Community 61 - "thesis-summary.ts"
Cohesion: 0.31
Nodes (6): buildThesisSummary(), prettifyAnalyst(), THESIS_NON_VERDICT, ThesisSummary, ThesisSummaryRow, TRACES

### Community 63 - "rebuild.sh"
Cohesion: 0.25
Nodes (7): DATA_DIR, DISABLE_MOCK_DATA, ENABLE_CRYPTO_AGENCY, HOST, PORT, REGISTRY_STORE_DRIVER, rebuild.sh script

### Community 64 - "SettingsDialog.agencies.test.tsx"
Cohesion: 0.29
Nodes (5): AGENCIES, applyMock, deleteMock, getMock, postMock

### Community 65 - "package.json"
Cohesion: 0.29
Nodes (6): author, description, license, main, name, version

### Community 66 - "newsClient.ts"
Cohesion: 0.40
Nodes (4): NewsHeadline, NewsResult, NewsSentimentLabel, sentimentClass()

### Community 67 - "optionsHistoryClient.ts"
Cohesion: 0.33
Nodes (4): GreeksRow, OptionChainResult, OptionQuote, OptionRight

### Community 70 - "lib"
Cohesion: 0.50
Nodes (4): DOM.Iterable, lib, DOM, ES2020

### Community 71 - "include"
Cohesion: 0.50
Nodes (3): frontend/src, vite.config.ts, include

## Knowledge Gaps
- **423 isolated node(s):** `PostAnalystConfigResponse`, `SourceTestResult`, `PostAnalystFlavorsResponse`, `AgencyFlavorSummaryResponse`, `BulkEnableLlmResponse` (+418 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **25 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `react` connect `react` to `ResultsPanel.tsx`, `registry.ts`, `SettingsDialog.tsx`, `ScreenerPanel.tsx`, `AnalystTraceDrawer.tsx`, `watchlist.ts`, `AnalystSettingsDialog.tsx`, `DomainSourcesTab.tsx`, `MarketDataCard.tsx`, `CompareView.tsx`, `PriceChart.tsx`, `dependencies`, `keywords`, `AnalysisView.tsx`, `registryClient.ts`, `AnalystWall.tsx`, `AgencySettingsDialog.tsx`?**
  _High betweenness centrality (0.201) - this node is a cross-community bridge._
- **Why does `keywords` connect `keywords` to `package.json`, `react`?**
  _High betweenness centrality (0.074) - this node is a cross-community bridge._
- **Why does `devDependencies` connect `devDependencies` to `@vitejs/plugin-react`, `package.json`, `autoprefixer`, `eslint`, `jest`, `jsdom`, `postcss`, `tailwindcss`, `@testing-library/user-event`, `ts-jest`, `@types/d3`, `@types/jest`, `@types/react-dom`, `@types/supertest`, `@typescript-eslint/parser`, `keywords`, `vitest`, `@vitest/coverage-v8`?**
  _High betweenness centrality (0.072) - this node is a cross-community bridge._
- **What connects `PostAnalystConfigResponse`, `SourceTestResult`, `PostAnalystFlavorsResponse` to the rest of the system?**
  _423 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `hist.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.06386946386946386 - nodes in this community are weakly interconnected._
- **Should `ResultsPanel.tsx` be split into smaller, more focused modules?**
  _Cohesion score 0.054563492063492064 - nodes in this community are weakly interconnected._
- **Should `index.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.053410893707033315 - nodes in this community are weakly interconnected._
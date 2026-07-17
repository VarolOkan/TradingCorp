# Graph Report - .  (2026-07-17)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 1684 nodes · 3994 edges · 82 communities (59 shown, 23 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 34 edges (avg confidence: 0.76)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `b4520bcd`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- MarketDataCard.tsx
- hist.ts
- screener.ts
- generic-analyst.node.ts
- ResultsPanel.tsx
- index.ts
- financial-analysis.ts
- PriceChart.tsx
- registry.ts
- risk.ts
- compilerOptions
- LlmRole
- AnalysisServer
- report-routes.ts
- SettingsDialog.tsx
- AgentState
- agency-graph.ts
- options-handlers.ts
- analysts.ts
- react
- AnalysisView.tsx
- types.ts
- AnalystConfigStore
- SourcesTab.tsx
- index.ts
- llm-vault.ts
- compilerOptions
- data-ingestion.ts
- TokenVault
- technical.ts
- AnalystWall.tsx
- fundamental.ts
- governance.ts
- llm-config.ts
- devDependencies
- registry-routes.ts
- RegistryJsonStore
- RegistryStore
- RetryHandler
- ScreenerPanel.tsx
- AnalystFlavorStore
- RegistrySqliteStore
- scripts
- registry.ts
- JsonLlmStore
- AnalysisSocketServer
- agency-differentiation.test.ts
- AgencySettingsDialog.tsx
- AnalystDef
- registry-store.ts
- thesis-summary.ts
- Logger
- express
- keywords
- rebuild.sh
- SettingsDialog.agencies.test.tsx
- package.json
- applyAllOverridesToRegistry
- ResizeObserverStub
- AnalysisForm.tsx
- autoprefixer
- jest
- jsdom
- next-env.d.ts
- supertest
- tailwindcss
- @testing-library/jest-dom
- @types/d3
- @types/react
- @types/react-dom
- @typescript-eslint/eslint-plugin
- @typescript-eslint/parser
- @vitejs/plugin-react
- vitest
- @vitest/coverage-v8
- ANALYST_DEF_BY_ID

## God Nodes (most connected - your core abstractions)
1. `AgentState` - 60 edges
2. `LlmRole` - 34 edges
3. `compilerOptions` - 33 edges
4. `AnalystDef` - 32 edges
5. `react` - 29 edges
6. `Logger` - 27 edges
7. `RegistrySqliteStore` - 26 edges
8. `TokenVault` - 25 edges
9. `RegistryJsonStore` - 25 edges
10. `governanceHandler()` - 22 edges

## Surprising Connections (you probably didn't know these)
- `ReportModal()` --indirect_call--> `text()`  [INFERRED]
  frontend/src/components/ReportModal.tsx → src/tests/llm-config.test.ts
- `SettingsDialog()` --indirect_call--> `text()`  [INFERRED]
  frontend/src/components/SettingsDialog.tsx → src/tests/llm-config.test.ts
- `AgencySettingsDialogProps` --references--> `LlmRole`  [EXTRACTED]
  frontend/src/components/analysts/AgencySettingsDialog.tsx → src/server/llm-config.ts
- `LlmConfigResponse` --references--> `LlmRole`  [EXTRACTED]
  frontend/src/api/llmConfigClient.ts → src/server/llm-config.ts
- `LlmConfigStatusResponse` --references--> `LlmProvider`  [EXTRACTED]
  frontend/src/api/llmConfigClient.ts → src/server/llm-config.ts

## Import Cycles
- None detected.

## Communities (82 total, 23 thin omitted)

### Community 0 - "MarketDataCard.tsx"
Cohesion: 0.05
Nodes (67): getPriceHistory(), PriceBar, PriceBarsResult, getNews(), NewsHeadline, NewsResult, NewsSentimentLabel, sentimentClass() (+59 more)

### Community 1 - "hist.ts"
Cohesion: 0.07
Nodes (55): bsGreeks(), bsPrice(), d1(), Greeks, normCdf(), normPdf(), OptionType, resolveRfr() (+47 more)

### Community 2 - "screener.ts"
Cohesion: 0.07
Nodes (53): PriceBarsFetchFn, enrichSummaries(), escapeRegExp(), extractLead(), fetchArticleLead(), fetchCompanyNews(), finnhubUrl(), googleNewsRssUrl() (+45 more)

### Community 3 - "generic-analyst.node.ts"
Cohesion: 0.07
Nodes (45): GenericAnalystNode, NOTE: fn handlers are registered as `(state) => handler(state, surface)` in, IMPORTANT: `analystTraces` has a *concat* reducer on the graph channel., summarizeAnalystOutput(), AnalystConfigSchema, AnalystId, buildAnalystConfigSchema(), DEFAULT_SOURCE_URIS (+37 more)

### Community 4 - "ResultsPanel.tsx"
Cohesion: 0.07
Nodes (42): apiBase(), deleteReport(), fetchReportMarkdown(), fetchReportRawData(), listReports(), postReport(), reportDownloadUrl(), ReportFiles (+34 more)

### Community 5 - "index.ts"
Cohesion: 0.10
Nodes (37): buildRegistry(), DEFAULT_UNIVERSE, getUniverse(), GetUniverseOpts, UniverseCache, EXCH, isPlainEquitySymbol(), makeNasdaqTraderProvider() (+29 more)

### Community 6 - "financial-analysis.ts"
Cohesion: 0.05
Nodes (42): EquityProfile, HistProfile, PriceBarsResult, atmIvForExpiry(), buildVolSurface(), olsSlope(), percentileOf(), rankOf() (+34 more)

### Community 7 - "PriceChart.tsx"
Cohesion: 0.05
Nodes (45): better-sqlite3, d3, dotenv, bollinger(), ChartBar, cumVolVwap(), ema(), fmtAxis() (+37 more)

### Community 8 - "registry.ts"
Cohesion: 0.09
Nodes (20): RelationsGraphView(), RelationsGraphViewProps, ResultsPanelProps, FakeViz, StubViz, AnalysisResult, createVisualization(), Ctor (+12 more)

### Community 9 - "risk.ts"
Cohesion: 0.08
Nodes (34): ANALYST_INSTRUCTIONS, AnalystInstruction, AnalystPromptId, instructionFor(), NOTE: TradingAgents' literal upstream prompt strings are not copied here, assessPortfolioImpact(), calculateMaxAllocation(), calculateStopLoss() (+26 more)

### Community 10 - "compilerOptions"
Cohesion: 0.05
Nodes (41): *.config.ts, dist, node_modules, src/**/*, compilerOptions, allowJs, allowSyntheticDefaultImports, allowUnreachableCode (+33 more)

### Community 11 - "LlmRole"
Cohesion: 0.09
Nodes (19): LlmConfigPost, LlmConfigResponse, LlmConfigStatusResponse, LlmConfigTestResponse, LlmModelConfigPublic, dataDir(), dataFilePath(), LlmProvider (+11 more)

### Community 12 - "AnalysisServer"
Cohesion: 0.09
Nodes (21): AnalysisServer, execute(), FetchFn, fetchFundamentals(), fetchQuote(), Fundamentals, FundFetchFn, makeYahooFundFetch() (+13 more)

### Community 13 - "report-routes.ts"
Cohesion: 0.10
Nodes (36): AnalystSlide, buildRawDataDump(), buildReportModel(), DataHealth, drawDeck(), escapeHtml(), inline(), miniMarkdown() (+28 more)

### Community 14 - "SettingsDialog.tsx"
Cohesion: 0.10
Nodes (28): getConfig(), postSettings(), PostSettingsResponse, StaticConfigResponse, postLlmConfigTest(), AgencySummary, CatalogAnalyst, deleteAgency() (+20 more)

### Community 15 - "AgentState"
Cohesion: 0.12
Nodes (17): orchestratorHandler(), AnalystHelpers, makeNodeSurface(), mergeDataReceived(), NodeSurface, recordDataReceived(), THESIS_LABELS, surface (+9 more)

### Community 16 - "agency-graph.ts"
Cohesion: 0.10
Nodes (14): GraphState, AnalysisGraph, AGENCIES, AGENCY_IDS, ALLOWED_PARAM_KEYS, AnalystParams, AnalystParamsStore, AnalystParamsValidation (+6 more)

### Community 17 - "options-handlers.ts"
Cohesion: 0.15
Nodes (26): ANALYST_LOGIC_REGISTRY, AnalystFn, LiveOptionsResult, parseTreasuryRfr(), numOrRate(), optionsGreeksHandler(), optionsIngestionHandler(), optionsPricingHandler() (+18 more)

### Community 18 - "analysts.ts"
Cohesion: 0.10
Nodes (15): OPTIONS_INSTRUCTIONS, OptionsAnalystPromptId, ANALYST_DEF_IDS, ANALYST_DEFS, defaultAnalystIds(), optionsAnalystIds(), prompter(), deriveAnalystMetaFromDefs() (+7 more)

### Community 19 - "react"
Cohesion: 0.13
Nodes (22): getAnalystSourceCatalog(), getRegistry(), putAgencyAnalysts(), App(), AGENCIES, AGENCY_IDS, agencyById(), AgencyId (+14 more)

### Community 20 - "AnalysisView.tsx"
Cohesion: 0.11
Nodes (20): AgencyFlavorSummaryResponse, AnalystFlavorDTO, BulkEnableLlmResponse, getAnalystFlavors(), GetAnalystFlavorsResponse, postAnalystFlavors(), PostAnalystFlavorsResponse, getAnalystParams() (+12 more)

### Community 21 - "types.ts"
Cohesion: 0.11
Nodes (23): AnalystId, AnalystTraceDrawer(), AnalystTraceDrawerProps, formatValue(), Tab, TABS, TraceBreadcrumb, verdictClass() (+15 more)

### Community 22 - "AnalystConfigStore"
Cohesion: 0.10
Nodes (12): AnalystConfigStore, AnalystConfigValidation, composeKey(), CredentialKey, SourceCredential, getSharedVault(), MASSIVE_SNAPSHOT(), registerOptionsDebugRoutes() (+4 more)

### Community 23 - "SourcesTab.tsx"
Cohesion: 0.10
Nodes (21): postAnalystConfig(), PostAnalystConfigResponse, SourceTestResult, testAnalystConfig(), AnalystFlavorField, buildAnalystConfigSchema(), DEFAULT_SOURCE_URIS, SourceCredField (+13 more)

### Community 24 - "index.ts"
Cohesion: 0.14
Nodes (10): socket.io, config, setMockDisabled(), shouldShowMockDisabledBanner(), registerConfigRoutes(), ConnectionConfigStore, ResolvedConfig, ValidationResult (+2 more)

### Community 25 - "llm-vault.ts"
Cohesion: 0.11
Nodes (10): AesCipher, Cipher, createVault(), GpgCipher, WHY: LlmConfigStore is in-memory, so every server restart wiped all LLM, selectCipher(), SourceTokenDTO, VaultData (+2 more)

### Community 26 - "compilerOptions"
Cohesion: 0.08
Nodes (24): DOM.Iterable, frontend/src, vite.config.ts, vitest/globals, compilerOptions, allowImportingTsExtensions, isolatedModules, jsx (+16 more)

### Community 27 - "data-ingestion.ts"
Cohesion: 0.16
Nodes (15): dataIngestionHandler(), equityProfileFromTuning(), fetchEquityBars(), fetchFinancialData(), fetchRealFinancialData(), getDateDaysAgo(), IngestionFetchFn, num() (+7 more)

### Community 28 - "TokenVault"
Cohesion: 0.15
Nodes (3): defaultLlmConfigs(), LlmConfigStore, TokenVault

### Community 29 - "technical.ts"
Cohesion: 0.18
Nodes (23): analyzeMomentum(), assessVolatility(), atr(), avgTechnicalScore(), bollinger(), computeIndicatorsFromBars(), computeMaxDrawdown(), computeSupportResistance() (+15 more)

### Community 30 - "AnalystWall.tsx"
Cohesion: 0.17
Nodes (15): AnalystConfigSchema, analystById(), AnalystMeta, ANALYSTS, IMPORTANT: this list is the UNION of analysts across ALL agencies (it includes, AnalystWall(), AnalystWallProps, AnalystSettingsDialogProps (+7 more)

### Community 31 - "fundamental.ts"
Cohesion: 0.18
Nodes (19): applyVerdict(), declarativeHandler(), resolveFeatureValues(), annualizedVol(), assessMoat(), avgHealthScore(), buildFundamental(), fundamentalHandler() (+11 more)

### Community 32 - "governance.ts"
Cohesion: 0.14
Nodes (16): createApprovalDecision(), createOptionsRejectionDecision(), createRejectionDecision(), extractOptionsRisk(), extractRiskAssessments(), generateDecisionSummary(), governanceHandler(), performGovernanceReview() (+8 more)

### Community 33 - "llm-config.ts"
Cohesion: 0.11
Nodes (27): model(), extractScore(), extractVerdict(), isLLMConfigured(), llmConfigStoreOrNull(), LLMRequest, LLMResult, resolveRequestConfig() (+19 more)

### Community 34 - "devDependencies"
Cohesion: 0.11
Nodes (20): concurrently, eslint, devDependencies, concurrently, eslint, postcss, @testing-library/dom, @testing-library/react (+12 more)

### Community 35 - "registry-routes.ts"
Cohesion: 0.15
Nodes (13): defaultAgency(), resolveVaultUserId(), AgencySummary, isValidAgencyDef(), isValidAnalystDef(), isValidAnalystRef(), registerRegistryRoutes(), resolveUserId() (+5 more)

### Community 37 - "RegistryStore"
Cohesion: 0.13
Nodes (4): RegistryBlob, RegistryStore, AgencyAnalystRef, AgencyDef

### Community 38 - "RetryHandler"
Cohesion: 0.15
Nodes (5): AnalysisRetryHandler, CircuitBreakerState, DataIngestionRetryHandler, RetryConfig, RetryHandler

### Community 39 - "ScreenerPanel.tsx"
Cohesion: 0.17
Nodes (13): DataSourceBadge, getScreener(), ScreenerResult, ScreenerRow, UniverseTrace, UniverseTraceStep, resolveAssetClass(), axisLabel() (+5 more)

### Community 40 - "AnalystFlavorStore"
Cohesion: 0.20
Nodes (5): AnalystFlavorStore, composeKey(), registerAnalystFlavorsRoutes(), sessionOf(), shippedFlavors()

### Community 42 - "scripts"
Cohesion: 0.12
Nodes (16): scripts, build, dev, dev:all, graphify, graphify:docs, lint, server (+8 more)

### Community 43 - "registry.ts"
Cohesion: 0.15
Nodes (14): FlavorKey, FlavorSet, FlavorValidation, defFor(), key, set, tmp, AnalystFlavor (+6 more)

### Community 44 - "JsonLlmStore"
Cohesion: 0.25
Nodes (3): JsonLlmStore, file, tmp

### Community 45 - "AnalysisSocketServer"
Cohesion: 0.19
Nodes (3): buildLegacyGraph(), FinancialAnalysisGraph, AnalysisSocketServer

### Community 47 - "agency-differentiation.test.ts"
Cohesion: 0.17
Nodes (5): intraday, longTerm, medium, surface, tickers

### Community 48 - "AgencySettingsDialog.tsx"
Cohesion: 0.29
Nodes (8): enableLlmForAllAnalysts(), getAgencyFlavorSummary(), getLlmConfig(), postLlmConfig(), AgencySettingsDialog(), AgencySettingsDialogProps, enableMock, summaryMock

### Community 50 - "registry-store.ts"
Cohesion: 0.25
Nodes (6): COMPILED_AGENCIES, COMPILED_ANALYST_DEFS, createRegistryStore(), OverrideKind, RegistryDriverName, resolveDriverName()

### Community 51 - "thesis-summary.ts"
Cohesion: 0.31
Nodes (6): buildThesisSummary(), prettifyAnalyst(), THESIS_NON_VERDICT, ThesisSummary, ThesisSummaryRow, TRACES

### Community 53 - "express"
Cohesion: 0.21
Nodes (10): express, express, registerApiDocsRoutes(), resolveServers(), specPath(), start(), registerServerLogRoutes(), tailFile() (+2 more)

### Community 54 - "keywords"
Cohesion: 0.25
Nodes (8): vite, keywords, analysis, financial, langgraph, multi-agent, preservation, vite

### Community 55 - "rebuild.sh"
Cohesion: 0.25
Nodes (7): DATA_DIR, DISABLE_MOCK_DATA, ENABLE_CRYPTO_AGENCY, HOST, PORT, REGISTRY_STORE_DRIVER, rebuild.sh script

### Community 56 - "SettingsDialog.agencies.test.tsx"
Cohesion: 0.29
Nodes (5): AGENCIES, applyMock, deleteMock, getMock, postMock

### Community 57 - "package.json"
Cohesion: 0.29
Nodes (6): author, description, license, main, name, version

## Knowledge Gaps
- **378 isolated node(s):** `PostAnalystConfigResponse`, `PostAnalystFlavorsResponse`, `AgencyFlavorSummaryResponse`, `BulkEnableLlmResponse`, `PostAnalystParamsResponse` (+373 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **23 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `react` connect `react` to `MarketDataCard.tsx`, `ResultsPanel.tsx`, `PriceChart.tsx`, `registry.ts`, `ScreenerPanel.tsx`, `SettingsDialog.tsx`, `AgencySettingsDialog.tsx`, `AnalysisView.tsx`, `types.ts`, `keywords`, `SourcesTab.tsx`, `AnalysisForm.tsx`, `AnalystWall.tsx`?**
  _High betweenness centrality (0.174) - this node is a cross-community bridge._
- **Why does `keywords` connect `keywords` to `index.ts`, `package.json`, `react`, `PriceChart.tsx`?**
  _High betweenness centrality (0.104) - this node is a cross-community bridge._
- **Why does `devDependencies` connect `devDependencies` to `jest`, `jsdom`, `supertest`, `tailwindcss`, `@testing-library/jest-dom`, `@types/d3`, `@types/react`, `@types/react-dom`, `@typescript-eslint/eslint-plugin`, `@typescript-eslint/parser`, `@vitejs/plugin-react`, `vitest`, `@vitest/coverage-v8`, `keywords`, `package.json`, `autoprefixer`?**
  _High betweenness centrality (0.095) - this node is a cross-community bridge._
- **What connects `PostAnalystConfigResponse`, `PostAnalystFlavorsResponse`, `AgencyFlavorSummaryResponse` to the rest of the system?**
  _378 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `MarketDataCard.tsx` be split into smaller, more focused modules?**
  _Cohesion score 0.05266106442577031 - nodes in this community are weakly interconnected._
- **Should `hist.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.0733162830349531 - nodes in this community are weakly interconnected._
- **Should `screener.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.06821787414066631 - nodes in this community are weakly interconnected._
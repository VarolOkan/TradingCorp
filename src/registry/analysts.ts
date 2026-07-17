// src/registry/analysts.ts
// Default 7 analyst definitions. These are the canonical defaults;
// agencies can override any field per AgencyAnalystRef.
// This file is the source of truth — all other code reads from here.

import type { AnalystDef } from '../types/registry';
import { instructionFor } from '../prompts/analyst-instructions';
import { OPTIONS_INSTRUCTIONS } from '../prompts/options-instructions';

const prompter = (id: Parameters<typeof instructionFor>[0]) => instructionFor(id);

export const ANALYST_DEFS: Record<string, AnalystDef> = {
  orchestrator: {
    id: 'orchestrator',
    kind: 'orchestrator',
    name: 'Orchestrator',
    role: 'Parses query · routes tickers',
    stage: 1,
    accent: '#64748b',
    monogram: 'OR',
    prompt: prompter('orchestrator'),
    dependsOn: [],
    dataSources: [{
      fields: ['query', 'tickers', 'options'],
      label: 'User input & options',
      sources: ['HTTP request payload'],
    }],
    logic: { mode: 'fn', fn: 'orchestrate' },
    output: { channels: ['tasks', 'workflow_control'] },
    tasks: ['Parsing tickers', 'Resolving options', 'Seeding pipeline'],
    mock: { generator: 'seeded', seedFrom: 'ticker' },
  },

  data_ingestion: {
    id: 'data_ingestion',
    kind: 'ingestion',
    name: 'Data Ingestion',
    role: 'Fetches · standardizes · loads',
    stage: 1,
    accent: '#475569',
    monogram: 'DI',
    prompt: [
      'You are the Data Ingestion node. Your role is to collect and standardize',
      'all financial data needed by downstream analysts.',
      'For each ticker, fetch: fundamental (financials), technical (price/volume),',
      'sentiment (news/social), and market context data.',
      'Ensure data quality: check completeness, freshness, and known sources.',
      'Flag any errors or missing data for the Risk and Governance nodes to consider.',
    ].join('\n'),
    dependsOn: ['orchestrator'],
    dataSources: [{
      from: 'orchestrator',
      fields: ['tickers', 'options'],
      label: 'Orchestrator routing',
      sources: ['(pipeline internal)'],
    },
    // §Card-settings: three credentialed LIVE providers. Each declares an
    // endpoint + auth so it shows up in the GET /analyst-config catalog (the
    // per-card Settings panel collects a token + base URI for each). At runtime
    // with no token they fail fast and degrade to mock (onError:'degrade'), so
    // analysis output is unchanged from the legacy mock-only run.
    {
      id: 'yahoo',
      type: 'rest',
      endpoint: 'https://query1.finance.yahoo.com/v8/finance/chart/{ticker}',
      // Yahoo's chart endpoint is tokenless — fetches work with NO api key
      // (used by GET /quote and GET /history). Declared auth:'none' so the
      // §4.9 engine treats it as live with no credential requirement.
      auth: 'none',
      fields: ['price', 'volume', 'market', 'technical'],
      // Yahoo wraps data in { chart: { result: [{ meta, indicators, ... }] } },
      // so validate the envelope exists rather than top-level fields.
      okPath: 'chart.result[0].meta.symbol',
      label: 'Yahoo Finance',
      sources: ['Yahoo Finance'],
      timeoutMs: 8000,
      retries: 1,
      onError: 'degrade',
    },
    {
      id: 'alphaVantage',
      type: 'rest',
      endpoint: 'https://www.alphavantage.co/query',
      // Alpha Vantage authenticates via an `apikey=` query parameter, NOT a
      // Bearer header. Declaring it 'apikey' makes both the runtime acquisition
      // engine (acquire.ts) and the [Test] health probe (probeSource) attach the
      // token correctly. Declaring 'bearer' sent the key as a header the provider
      // ignores and produced a spurious "Authentication failed — check the token".
      auth: 'apikey',
      fields: ['fundamental', 'technical'],
      // Self-contained health probe so the §4.9 engine and the [Test] button
      // exercise the SAME endpoint + auth (GLOBAL_QUOTE needs no {ticker} and is
      // enough to confirm the key is valid). Mirrors the [Test] probeSource map.
      healthQuery: '?function=GLOBAL_QUOTE&symbol=IBM&apikey=__TOKEN__',
      healthFields: ['Global Quote'],
      label: 'Alpha Vantage',
      sources: ['Alpha Vantage'],
      timeoutMs: 8000,
      retries: 1,
      onError: 'degrade',
    },
    {
      id: 'finnhub',
      type: 'rest',
      endpoint: 'https://finnhub.io/api/v1',
      // Finnhub authenticates via the `X-Finnhub-Token` header (or a
      // `token=` query param) — NOT `Authorization: Bearer`. Declaring
      // 'finnhub' makes both the runtime engine (buildHeaders) and the [Test]
      // probe (probeSource) attach `X-Finnhub-Token`, which is what the
      // provider actually accepts.
      auth: 'finnhub',
      fields: ['sentiment', 'market'],
      // Self-contained health probe: /quote?symbol=AAPL needs no {ticker} and is
      // enough to confirm the bearer key is valid. Mirrors the [Test] probeSource map.
      healthQuery: '/quote?symbol=AAPL',
      healthFields: ['c', 'h', 'l', 'o', 'pc'],
      label: 'Finnhub',
      sources: ['Finnhub'],
      timeoutMs: 8000,
      retries: 1,
      onError: 'degrade',
    }],
    logic: { mode: 'fn', fn: 'ingest' },
    output: { channels: ['fundamental_data', 'technical_data', 'sentiment_data', 'market_data'], storeInMessages: true },
    tasks: ['Fetching financials', 'Polling price feeds', 'Scanning news', 'Loading market context'],
    mock: { generator: 'seeded', seedFrom: 'ticker' },
    onAllSourcesFailed: { action: 'useMock' },
  },

  fundamental: {
    id: 'fundamental',
    kind: 'analyst',
    name: 'Fundamental',
    role: 'Balance sheet · moat · valuation',
    stage: 2,
    accent: '#3b82f6',
    monogram: 'FA',
    prompt: prompter('fundamental'),
    dependsOn: ['data_ingestion'],
    dataSources: [{
      from: 'data_ingestion',
      fields: ['balance_sheet', 'income_statement', 'cash_flow', 'key_ratios'],
      label: 'Fundamental data',
      sources: ['Yahoo Finance (mock)', 'Alpha Vantage (mock)'],
    }],
    features: [
      { key: 'debt_to_equity', label: 'Debt-to-Equity', source: 'dataSources.0', aggregation: 'last' },
      { key: 'current_ratio', label: 'Current Ratio', source: 'dataSources.0', aggregation: 'last' },
      { key: 'roe', label: 'ROE', source: 'dataSources.0', aggregation: 'last' },
      { key: 'profit_margin', label: 'Profit Margin', source: 'dataSources.0', aggregation: 'last' },
      { key: 'free_cash_flow_yield', label: 'FCF Yield', source: 'dataSources.0', aggregation: 'last' },
    ],
    logic: { mode: 'fn', fn: 'fundamentalAnalysis' },
    output: { channels: ['fundamental_analysis'], storeInMessages: true },
    tasks: ['Loading financials', 'Scoring moat', 'Deriving fair value'],
    mock: { generator: 'seeded', seedFrom: 'ticker',
      ranges: { financial_health_score: [35, 92], debt_to_equity: [0.2, 3.0], current_ratio: [0.8, 3.5],
                roe: [5, 35], profit_margin: [3, 30], free_cash_flow_yield: [0.5, 8] },
      flags: [{ if: 'debt_to_equity > 2.5', then: 'RED: high leverage' },
              { if: 'current_ratio < 1.2', then: 'RED: low liquidity' }] },
  },

  technical: {
    id: 'technical',
    kind: 'analyst',
    name: 'Technical',
    role: 'Trend · indicators · levels',
    stage: 2,
    accent: '#8b5cf6',
    monogram: 'TA',
    prompt: prompter('technical'),
    dependsOn: ['data_ingestion'],
    dataSources: [{
      from: 'data_ingestion',
      fields: ['price', 'volume', 'indicators'],
      label: 'Price & volume data',
      sources: ['Yahoo Finance (mock)'],
    }],
    features: [
      { key: 'rsi', label: 'RSI', source: 'dataSources.0', aggregation: 'last' },
      { key: 'sma_20', label: 'SMA 20', source: 'dataSources.0', aggregation: 'last' },
      { key: 'sma_50', label: 'SMA 50', source: 'dataSources.0', aggregation: 'last' },
      { key: 'volatility_30d', label: '30d Volatility', source: 'dataSources.0', aggregation: 'last' },
    ],
    logic: { mode: 'fn', fn: 'technicalAnalysis' },
    output: { channels: ['technical_analysis'], storeInMessages: true },
    tasks: ['Reading trend', 'Computing RSI/MACD', 'Marking support/resistance'],
    mock: { generator: 'seeded', seedFrom: 'ticker',
      ranges: { technical_score: [25, 88], rsi: [25, 75], sma_20: [100, 500], sma_50: [95, 490], volatility_30d: [15, 55] },
      flags: [{ if: 'rsi > 70', then: 'WARN: overbought' },
              { if: 'rsi < 30', then: 'WARN: oversold' }] },
  },

  sentiment: {
    id: 'sentiment',
    kind: 'analyst',
    name: 'Sentiment',
    role: 'News · social · positioning',
    stage: 2,
    accent: '#ec4899',
    monogram: 'SA',
    prompt: prompter('sentiment'),
    dependsOn: ['data_ingestion'],
    dataSources: [{
      from: 'data_ingestion',
      fields: ['news_sentiment', 'social_sentiment', 'analyst_sentiment'],
      label: 'Sentiment data',
      sources: ['News API (mock)', 'Social feed (mock)'],
    }],
    features: [
      { key: 'news_score', label: 'News Sentiment', source: 'dataSources.0', aggregation: 'last' },
      { key: 'social_score', label: 'Social Sentiment', source: 'dataSources.0', aggregation: 'last' },
    ],
    logic: { mode: 'fn', fn: 'sentimentAnalysis' },
    output: { channels: ['sentiment_analysis'], storeInMessages: true },
    tasks: ['Scanning headlines', 'Weighing social', 'Netting positioning'],
    mock: { generator: 'seeded', seedFrom: 'ticker',
      ranges: { sentiment_score: [-60, 75], news_score: [-80, 80], social_score: [-50, 60] },
      flags: [{ if: 'Math.abs(news_score - social_score) > 40', then: 'WARN: source divergence' }] },
  },

  risk: {
    id: 'risk',
    kind: 'analyst',
    name: 'Risk',
    role: 'Exposure · sizing · stop',
    stage: 2,
    accent: '#f59e0b',
    monogram: 'RA',
    prompt: prompter('risk'),
    dependsOn: ['fundamental', 'technical', 'sentiment'],
    dataSources: [
      { from: 'fundamental', fields: ['financial_health_score', 'red_flags'], label: 'Fundamental risk input', sources: ['(pipeline)'] },
      { from: 'technical', fields: ['technical_score', 'volatility', 'beta'], label: 'Technical risk input', sources: ['(pipeline)'] },
      { from: 'sentiment', fields: ['sentiment_score', 'key_news'], label: 'Sentiment risk input', sources: ['(pipeline)'] },
    ],
    logic: { mode: 'fn', fn: 'riskAssessment' },
    output: { channels: ['risk_assessment'] },
    tasks: ['Sizing exposure', 'Stress testing', 'Setting stop-loss'],
    mock: { generator: 'seeded', seedFrom: 'ticker',
      ranges: { risk_level: [1, 4], max_allocation: [5, 40] } },
  },

  governance: {
    id: 'governance',
    kind: 'gatekeeper',
    name: 'Governance',
    role: 'Preservation-first veto',
    stage: 3,
    accent: '#10b981',
    monogram: 'GV',
    prompt: prompter('governance'),
    dependsOn: ['risk'],
    dataSources: [
      { from: 'risk', fields: ['risk_level', 'risk_factors', 'stop_loss'], label: 'Risk assessment', sources: ['(pipeline)'] },
      { from: 'fundamental', fields: ['financial_health_score'], label: 'Fundamental outcome', sources: ['(pipeline)'] },
      { from: 'technical', fields: ['technical_score'], label: 'Technical outcome', sources: ['(pipeline)'] },
      { from: 'sentiment', fields: ['sentiment_score'], label: 'Sentiment outcome', sources: ['(pipeline)'] },
    ],
    logic: { mode: 'fn', fn: 'governanceDecision' },
    output: { channels: ['final_decision'] },
    tasks: ['Reviewing debate', 'Applying veto test', 'Issuing decision'],
    mock: { generator: 'seeded', seedFrom: 'ticker',
      ranges: { confidence: [55, 98] },
      flags: [{ if: 'confidence < 60', then: 'REJECT: insufficient conviction' }] },
    onAllSourcesFailed: { action: 'fail' },  // gatekeeper hard-fails if no data
  },

  onchain: {
    id: 'onchain',
    kind: 'analyst',
    name: 'On-Chain Flow',
    role: 'Whale / exchange flows',
    stage: 2,
    accent: '#f59e0b',
    monogram: 'OC',
    prompt: [
      'You are the On-Chain Flow analyst. You score an asset by combining',
      'exchange net-flow (outflow = bullish accumulation) and active address',
      'growth (usage = conviction). You require NO LLM — your verdict is a pure',
      'weighted formula over the on-chain features.',
    ].join('\n'),
    dependsOn: ['crypto_ingest'],
    dataSources: [{
      from: 'crypto_ingest',
      fields: ['exchange_netflow', 'active_addrs'],
      label: 'On-chain metrics',
      sources: ['Glassnode (mock)'],
    }],
    features: [
      { key: 'outflow', label: 'Exchange outflow', source: 'dataSources.0', aggregation: 'last' },
      { key: 'active', label: 'Active addresses', source: 'dataSources.0', aggregation: 'last' },
    ],
    logic: {
      mode: 'declarative',
      weighting: [
        { label: 'Exchange outflow', inputs: ['outflow'], weight: 0.5, rationale: 'outflow = bullish accumulation' },
        { label: 'Active addresses', inputs: ['active'], weight: 0.5, rationale: 'active usage = conviction' },
      ],
      score: { from: 'weightedSum', range: [0, 100], round: true },
      verdict: {
        from: 'score',
        mapping: [
          { if: '>=', value: 60, then: 'BULLISH' },
          { if: '<', value: 40, then: 'BEARISH' },
        ],
        default: 'NEUTRAL',
      },
      summaryTemplate: 'On-chain flow {score}/100 → {verdict}',
    },
    output: { channels: ['onchain_analysis'] },
    tasks: ['Reading exchange netflow', 'Counting active addresses', 'Scoring on-chain'],
    // Pure-JSON declarative analyst — deterministic mock so the default run
    // (no live sources) stays parity-safe and produces well-formed output.
    // The mock ranges are keyed by FEATURE (not just `score`) so the
    // declarative weighted-sum has non-zero inputs to score.
    mock: { generator: 'seeded', seedFrom: 'ticker',
      ranges: { outflow: [30, 85], active: [25, 80] },
      flags: [] },
  },

  // ============================ Phase B: Options analysts ============================
  // Instrument: OPTION. Consumed by options-swing / options-intraday agencies
  // (Phase C). All optional-on-state → the equity agencies never reference these
  // ids, so the equity path is byte-for-byte untouched.

  options_ingestion: {
    id: 'options_ingestion',
    kind: 'ingestion',
    name: 'Options Data Ingestion',
    role: 'Chain · greeks · rfr · bars',
    stage: 1,
    accent: '#0ea5e9',
    monogram: 'OI',
    prompt: OPTIONS_INSTRUCTIONS.options_ingestion,
    dependsOn: ['orchestrator'],
    dataSources: [
      { from: 'orchestrator', fields: ['tickers', 'options'], label: 'Orchestrator routing', sources: ['(pipeline internal)'] },
      // §4.9 LIVE sources. The engine fetches these with per-source timeout +
      // retries + onError:'degrade'. With NO key injected, resolveToken returns
      // '' → auth header absent → Polygon 401 / Treasury 401 → 'degraded'
      // (skipped). The options_ingestion handler consumes sourceStatus to decide
      // live-vs-mock (parity: no key = deterministic mock, unchanged behaviour).
      // `fields:['results']`/`okPath` let the engine validate the real envelope
      // and carry the raw payload in `merged` for the handler's parser.
      { id: 'polygonOptions', type: 'rest', endpoint: 'https://api.polygon.io/v3/snapshot/options/{ticker}', auth: 'bearer', fields: ['options_results'], okPath: 'options_results.options', label: 'Polygon Options', sources: ['Polygon Options'], timeoutMs: 8000, retries: 1, onError: 'degrade' },
      { id: 'polygonHist', type: 'rest', endpoint: 'https://api.polygon.io/v2/aggs/ticker/{ticker}/range/1/day/2025-01-01/2026-07-10', auth: 'bearer', fields: ['agg_results'], okPath: 'agg_results[0]', label: 'Polygon Aggregates', sources: ['Polygon Aggregates'], timeoutMs: 8000, retries: 1, onError: 'degrade' },
      { id: 'treasuryRfr', type: 'rest', endpoint: 'https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v2/accounting/od/avg_interest_rates?filter=security_desc:eq:Marketable&field=avg_interest_rate_amt', auth: 'apikey', fields: ['data'], okPath: 'data[0]', label: 'Treasury RFR', sources: ['US Treasury'], timeoutMs: 8000, retries: 1, onError: 'degrade' },
    ],
    logic: { mode: 'fn', fn: 'optionsIngest', llm: { enabled: false } },
    output: { channels: ['option_chain_data', 'underlying_data', 'greeks_data'], storeInMessages: true },
    tasks: ['Fetching chains', 'Loading underlying bars', 'Deriving greeks', 'Reading rfr'],
    mock: { generator: 'seeded', seedFrom: 'ticker' },
    onAllSourcesFailed: { action: 'useMock' },
    flavors: [
      {
        id: 'default',
        name: 'Balanced',
        role: 'Chain · greeks · rfr · bars',
        instructions: OPTIONS_INSTRUCTIONS.options_ingestion,
        isDefault: true,
        modelRole: 'deep-thought',
      },
    ],
  },

  vol_surface: {
    id: 'vol_surface',
    kind: 'analyst',
    name: 'Volatility Surface',
    role: 'Skew · term structure · IV rank',
    stage: 2,
    accent: '#6366f1',
    monogram: 'VS',
    prompt: OPTIONS_INSTRUCTIONS.vol_surface,
    dependsOn: ['options_ingestion'],
    dataSources: [{ from: 'options_ingestion', fields: ['option_chain', 'iv_history'], label: 'Option chain IVs', sources: ['Polygon Options (mock)'] }],
    features: [
      { key: 'atm_iv', label: 'ATM IV', source: 'dataSources.0', aggregation: 'last' },
      { key: 'skew_slope', label: 'Skew slope', source: 'dataSources.0', aggregation: 'last' },
      { key: 'iv_percentile', label: 'IV percentile', source: 'dataSources.0', aggregation: 'last' },
    ],
    logic: { mode: 'fn', fn: 'volSurfaceAnalysis', llm: { enabled: false } },
    output: { channels: ['vol_surface_analysis'], storeInMessages: true },
    tasks: ['Building skew', 'Fitting term structure', 'Ranking IV'],
    mock: { generator: 'seeded', seedFrom: 'ticker',
      ranges: { atm_iv: [15, 60], skew_slope: [-30, 10], iv_percentile: [5, 95] } },
    flavors: [
      {
        id: 'default',
        name: 'Balanced',
        role: 'Skew · term structure · IV rank',
        instructions: OPTIONS_INSTRUCTIONS.vol_surface,
        isDefault: true,
        modelRole: 'deep-thought',
      },
    ],
  },

  options_pricing: {
    id: 'options_pricing',
    kind: 'analyst',
    name: 'Options Pricing',
    role: 'Fair value · edge · structures',
    stage: 2,
    accent: '#8b5cf6',
    monogram: 'OP',
    prompt: OPTIONS_INSTRUCTIONS.options_pricing,
    dependsOn: ['options_ingestion', 'vol_surface'],
    dataSources: [{ from: 'options_ingestion', fields: ['option_chain', 'greeks'], label: 'Chain + greeks', sources: ['Polygon Options (mock)'] }],
    features: [
      { key: 'edge_pct', label: 'Edge %', source: 'dataSources.0', aggregation: 'last' },
      { key: 'open_interest', label: 'Open interest', source: 'dataSources.0', aggregation: 'last' },
    ],
    logic: { mode: 'fn', fn: 'optionsPricingAnalysis', llm: { enabled: false } },
    output: { channels: ['options_pricing_analysis'], storeInMessages: true },
    tasks: ['Re-pricing strikes', 'Ranking edge', 'Assembling structures'],
    mock: { generator: 'seeded', seedFrom: 'ticker',
      ranges: { edge_pct: [0, 12], open_interest: [500, 20000] } },
    flavors: [
      {
        id: 'default',
        name: 'Balanced',
        role: 'Fair value · edge · structures',
        instructions: OPTIONS_INSTRUCTIONS.options_pricing,
        isDefault: true,
        modelRole: 'deep-thought',
      },
      {
        id: 'momentum',
        name: 'Momentum-leaning',
        role: 'Edge · fast structures · momentum',
        instructions:
          OPTIONS_INSTRUCTIONS.options_pricing +
          '\n\nFLAVOR BIAS (momentum-leaning): prefer structures with positive gamma and lean toward call-side edges; rank edge_pct with a 1.2x multiplier on upside strikes.',
        modelRole: 'deep-thought',
      },
    ],
  },

  options_greeks: {
    id: 'options_greeks',
    kind: 'analyst',
    name: 'Options Greeks',
    role: 'Net delta · gamma · vega · theta',
    stage: 2,
    accent: '#a855f7',
    monogram: 'OG',
    prompt: OPTIONS_INSTRUCTIONS.options_greeks,
    dependsOn: ['options_ingestion'],
    dataSources: [{ from: 'options_ingestion', fields: ['greeks'], label: 'Per-strike greeks', sources: ['Polygon Options (mock)'] }],
    features: [
      { key: 'net_delta', label: 'Net delta', source: 'dataSources.0', aggregation: 'last' },
      { key: 'net_gamma', label: 'Net gamma', source: 'dataSources.0', aggregation: 'last' },
      { key: 'net_vega', label: 'Net vega', source: 'dataSources.0', aggregation: 'last' },
      { key: 'net_theta', label: 'Net theta', source: 'dataSources.0', aggregation: 'last' },
    ],
    logic: { mode: 'fn', fn: 'optionsGreeksAnalysis', llm: { enabled: false } },
    output: { channels: ['options_greeks_analysis'], storeInMessages: true },
    tasks: ['Rolling up greeks', 'Checking budget', 'Flagging blow-ups'],
    mock: { generator: 'seeded', seedFrom: 'ticker',
      ranges: { net_delta: [-100, 100], net_gamma: [-5, 5], net_vega: [-10, 10], net_theta: [-5, 5] } },
    flavors: [
      {
        id: 'default',
        name: 'Balanced',
        role: 'Net delta · gamma · vega · theta',
        instructions: OPTIONS_INSTRUCTIONS.options_greeks,
        isDefault: true,
        modelRole: 'deep-thought',
      },
    ],
  },

  options_flow: {
    id: 'options_flow',
    kind: 'analyst',
    name: 'Options Flow',
    role: 'Gamma walls · dealer positioning',
    stage: 2,
    accent: '#d946ef',
    monogram: 'OF',
    prompt: OPTIONS_INSTRUCTIONS.options_flow,
    dependsOn: ['options_ingestion'],
    dataSources: [{ from: 'options_ingestion', fields: ['option_chain'], label: 'OI + volume by strike', sources: ['Polygon Options (mock)'] }],
    features: [
      { key: 'gamma_wall', label: 'Gamma wall proximity', source: 'dataSources.0', aggregation: 'last' },
      { key: 'call_put_ratio', label: 'Call/Put ratio', source: 'dataSources.0', aggregation: 'last' },
    ],
    logic: {
      mode: 'declarative',
      weighting: [
        { label: 'Gamma wall proximity', inputs: ['gamma_wall'], weight: 0.6, rationale: 'Nearby wall = strong pin / support-resistance' },
        { label: 'Flow direction', inputs: ['call_put_ratio'], weight: 0.4, rationale: 'Call-heavy vs put-heavy sets the bias' },
      ],
      score: { from: 'weightedSum', range: [0, 100], round: true },
      verdict: {
        from: 'score',
        mapping: [
          { if: '>=', value: 60, then: 'BULLISH' },
          { if: '<', value: 40, then: 'BEARISH' },
        ],
        default: 'NEUTRAL',
      },
      summaryTemplate: 'Options flow {score}/100 → {verdict}',
      llm: { enabled: false },
    },
    output: { channels: ['options_flow_analysis'] },
    tasks: ['Locating gamma walls', 'Reading dealer positioning', 'Scoring flow'],
    mock: { generator: 'seeded', seedFrom: 'ticker',
      ranges: { gamma_wall: [20, 90], call_put_ratio: [20, 80] }, flags: [] },
    flavors: [
      {
        id: 'default',
        name: 'Balanced',
        role: 'Gamma walls · dealer positioning',
        instructions: OPTIONS_INSTRUCTIONS.options_flow,
        isDefault: true,
        modelRole: 'deep-thought',
      },
    ],
  },

  options_technical: {
    id: 'options_technical',
    kind: 'analyst',
    name: 'Options Technical',
    role: 'Underlying micro-timing (5m/1m)',
    stage: 2,
    accent: '#c026d3',
    monogram: 'OT',
    prompt: OPTIONS_INSTRUCTIONS.options_technical,
    dependsOn: ['options_ingestion'],
    dataSources: [{ from: 'options_ingestion', fields: ['price_bars'], label: 'Underlying intraday bars', sources: ['Polygon Aggregates (mock)'] }],
    features: [
      { key: 'trend', label: 'Trend alignment', source: 'dataSources.0', aggregation: 'last' },
      { key: 'momentum', label: 'Momentum', source: 'dataSources.0', aggregation: 'last' },
    ],
    logic: {
      mode: 'declarative',
      weighting: [
        { label: 'Trend alignment', inputs: ['trend'], weight: 0.6, rationale: 'Price above/below short SMA sets bias' },
        { label: 'Momentum', inputs: ['momentum'], weight: 0.4, rationale: 'Recent return confirms or denies the trend' },
      ],
      score: { from: 'weightedSum', range: [0, 100], round: true },
      verdict: {
        from: 'score',
        mapping: [
          { if: '>=', value: 60, then: 'GO' },
          { if: '<', value: 40, then: 'WAIT' },
        ],
        default: 'MIXED',
      },
      summaryTemplate: 'Options timing {score}/100 → {verdict}',
      llm: { enabled: false },
    },
    output: { channels: ['options_technical_analysis'] },
    tasks: ['Reading micro-trend', 'Timing entry', 'Marking invalidation'],
    mock: { generator: 'seeded', seedFrom: 'ticker',
      ranges: { trend: [20, 85], momentum: [15, 80] }, flags: [] },
    flavors: [
      {
        id: 'default',
        name: 'Balanced',
        role: 'Underlying micro-timing (5m/1m)',
        instructions: OPTIONS_INSTRUCTIONS.options_technical,
        isDefault: true,
        modelRole: 'deep-thought',
      },
    ],
  },

  options_risk: {
    id: 'options_risk',
    kind: 'analyst',
    name: 'Options Risk',
    role: 'Max loss · IV-crush · sizing',
    stage: 3,
    accent: '#f43f5e',
    monogram: 'OR',
    prompt: OPTIONS_INSTRUCTIONS.options_risk,
    dependsOn: ['options_pricing', 'options_greeks', 'options_flow'],
    dataSources: [
      { from: 'options_pricing', fields: ['recommended_structure'], label: 'Selected structure', sources: ['(pipeline)'] },
      { from: 'options_greeks', fields: ['net_vega', 'net_gamma'], label: 'Net greeks', sources: ['(pipeline)'] },
      { from: 'options_ingestion', fields: ['iv_history', 'option_chain'], label: 'IV + liquidity', sources: ['Polygon Options (mock)'] },
    ],
    logic: { mode: 'fn', fn: 'optionsRiskAssessment', llm: { enabled: false } },
    output: { channels: ['options_risk_assessment'] },
    tasks: ['Bounding max loss', 'Testing greek blow-up', 'Gauging IV-crush', 'Sizing position'],
    mock: { generator: 'seeded', seedFrom: 'ticker',
      ranges: { max_loss: [100, 2000], iv_percentile: [5, 95], max_allocation: [3, 20] } },
    flavors: [
      {
        id: 'default',
        name: 'Balanced',
        role: 'Max loss · IV-crush · sizing',
        instructions: OPTIONS_INSTRUCTIONS.options_risk,
        isDefault: true,
        modelRole: 'deep-thought',
      },
      {
        id: 'conservative',
        name: 'Conservative',
        role: 'Capital preservation · tight sizing',
        instructions:
          OPTIONS_INSTRUCTIONS.options_risk +
          '\n\nFLAVOR BIAS (conservative): cap max_allocation at the low end, require defined-risk structures only, and reject any position whose max_loss exceeds 1% of portfolio equity.',
        modelRole: 'deep-thought',
      },
    ],
  },
};

// Provide a friendly lookup
export const ANALYST_DEF_IDS = Object.keys(ANALYST_DEFS);
export const ANALYST_DEF_BY_ID = ANALYST_DEFS;

/** Return a list of default analyst ids used by the reference long-term agency. */
export function defaultAnalystIds(): string[] {
  return ['orchestrator', 'data_ingestion', 'fundamental', 'technical', 'sentiment', 'risk', 'governance'];
}

/** Options-swing pipeline ids (Phase C). options_technical is omitted — swing
 *  lets vol_surface/options_pricing carry timing (spec §227). */
export function optionsSwingAnalystIds(): string[] {
  return ['orchestrator', 'options_ingestion', 'vol_surface', 'options_pricing',
    'options_greeks', 'options_flow', 'options_risk', 'governance'];
}

/** Options-intraday pipeline ids (Phase C). Adds options_technical as the 9th
 *  node for underlying micro-timing (spec §227). */
export function optionsIntradayAnalystIds(): string[] {
  return ['orchestrator', 'options_ingestion', 'options_technical', 'vol_surface',
    'options_pricing', 'options_greeks', 'options_flow', 'options_risk', 'governance'];
}

/** All Phase B options analyst ids (for validation / catalog filtering). */
export function optionsAnalystIds(): string[] {
  return ['options_ingestion', 'vol_surface', 'options_pricing', 'options_greeks',
    'options_flow', 'options_technical', 'options_risk'];
}
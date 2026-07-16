// src/types/financial-analysis.ts
// TypeScript interfaces for the financial analysis multi-agent pipeline
// Adapted from TradingAgents Python implementation patterns

/**
 * Base agent state interface - adapted from LangGraph's MessagesState and TradingAgents patterns
 */
export interface AgentState {
  /** Messages array for LangGraph communication */
  messages: Array<any>;
  
  /** Current date for analysis */
  current_date: string;
  
  /** List of ticker symbols being analyzed */
  tickers: string[];
  
  /** Company name or identifier */
  company_name: string;
  
  /** Investment thesis being developed */
  investment_thesis: string;
  
  /** Final decision/advice */
  final_decision: string;
  
  /** Error information if any */
  error: string | null;
  
  /** Current step in the workflow */
  current_step: string;

  /**
   * Structured per-analyst trace captured during execution. Each analyst node
   * appends a snapshot of (a) the instructions it ran under, (b) the input
   * data / sources it consumed, (c) how it weighted those inputs to reach its
   * output, and (d) the output itself. Surfaced on the client for drill-down
   * and traceability. Optional — populated only when nodes run with tracing on.
   */
  analystTraces?: AnalystTrace[];

  /**
   * Runtime connection config (Option B) supplied via the Settings dialog and
   * POSTed to /config. Read at analysis time so the graph can target the
   * configured backend / attach the access token to upstream data calls.
   * Optional — absent when the user relies on server defaults.
   */
  runtimeConfig?: {
    baseUri: string;
    accessToken: string;
    extra: Record<string, string>;
  } | undefined;

  /** §4.9 pipeline-wide data-health summary (aggregated across analysts). */
  dataHealth?: {
    sourcesOk: number;
    sourcesTotal: number;
    degradedAnalysts: string[];
    unavailableSources: string[];
    usedMockFallback: boolean;
  };

  /**
   * Options & derivatives data (doc §5). Populated ONLY by the `options_ingestion`
   * node for OPTION-instrument agencies, keyed by ticker. The equity pipeline
   * (long/medium/intraday) never sets this, so it stays undefined there and the
   * equity path is byte-for-byte untouched. Downstream options analysts read
   * their HistoricalBundle from here; when absent (e.g. a handler unit-tested in
   * isolation) they regenerate the deterministic mock via hist.ts, so behaviour
   * is identical with or without an upstream ingestion node.
   */
  optionsData?: Record<string, HistoricalBundle>;

  /**
   * Equity ingested data (DATA_AND_THESIS_ENHANCEMENT §3.2). Populated ONLY by
   * the `data_ingestion` node for EQUITY-instrument agencies, keyed by ticker.
   * Holds the horizon-appropriate price bars (per interval), the live market
   * snapshot, and the fundamental/sentiment shaped objects. The equity pipeline
   * downstream analysts (fundamental/technical/sentiment/risk) MAY consume this
   * from Phase D onward via guard blocks that fall back to seeded output when
   * `ingested` is absent — so the long-term parity path (no `ingested`) stays
   * byte-for-byte untouched. Phase C only WRITES this channel; it does not yet
   * change any downstream analyst output.
   */
  ingested?: {
    /** Per ticker, per interval, the OHLCV bars actually fetched. */
    bars: Record<string, PriceBarSeries[]>;
    /** Live quote/meta per ticker (Yahoo chart meta when available). */
    market: Record<string, any>;
    /** Fundamental shaped objects (seed-fallback today; live later). */
    fundamental: Record<string, any>;
    /** Sentiment shaped objects (seed-fallback today; live later). */
    sentiment: Record<string, any>;
    /** Provenance of the bars/market: live yahoo, mock, or mixed. */
    source: 'yahoo' | 'mock' | 'mixed';
  };

  /**
   * Optional progress reporter. The server injects a tiny emitter here so the
   * graph can stream real per-analyst events (analyst:start / analyst:done)
   * as each node actually executes. Kept as a minimal interface (not a Socket)
   * so the graph/nodes stay free of any transport dependency and remain
   * unit-testable in isolation. Absent in tests / headless runs.
   */
  progress?: ProgressReporter;

  /**
   * Per-analyst "what data did this analyst receive" annotation
   * (RAW_DATA_DUMP.md). Populated by every consuming handler via
   * `recordDataReceived` (shared.ts) so the export can build a JSON dump that
   * shows, per analyst, exactly the slice of `ingested` / `optionsData` it
   * consumed. Default undefined → absent on legacy runs → parity-safe. This
   * channel is pure annotation; it never alters any analyst's numeric/text
   * output, so the report's analytical content stays byte-identical.
   */
  dataReceived?: DataReceivedEntry[];
}

/**
 * One consumed-data block, describing a precise slice of an ingestion channel.
 */
export interface DataReceivedBlock {
  /** Which domain of the ingested bundle this analyst read. */
  domain:
    | 'bars'
    | 'market'
    | 'fundamental'
    | 'sentiment'
    | 'option_chain'
    | 'greeks'
    | 'underlying'
    | 'iv_history';
  /** Bar interval for `bars` / `underlying` slices (e.g. '1d', '5m', '1m'). */
  interval?: string;
  /** Provenance of the slice: forwarded from the ingestion channel's `source`. */
  source: string;
  /** ISO timestamp the slice was fetched/assembled (when known). */
  asOf?: string;
  /** Number of bars for `bars` / `underlying` slices. */
  barsUsed?: number;
  /** Number of rows for `option_chain` / `greeks` slices. */
  rows?: number;
}

/**
 * A single analyst's annotation: which channel/blocks it consumed. One entry
 * per (analyst, ticker); multiple tickers → multiple entries.
 */
export interface DataReceivedEntry {
  analyst: string;
  ticker: string;
  channel: 'ingested' | 'optionsData';
  blocks: DataReceivedBlock[];
  /** 'live' | 'mock' | 'mixed' from the ingestion source; 'seeded-parity' when
   *  the analyst ran on seed-fallback (no ingested channel present). */
  provenance: 'live' | 'mock' | 'mixed' | 'seeded-parity';
  /** Optional human note (e.g. "price-proxy fallback", "SMA200 insufficient (<200 bars)"). */
  note?: string;
}

/**
 * Minimal progress sink injected into AgentState by the server. The graph nodes
 * call `emit('analyst:start' | 'analyst:done', payload)`; the server forwards
 * these to the connected client. Defined as a structural type so any
 * EventEmitter-like object satisfies it.
 */
export interface ProgressReporter {
  emit(event: string, payload: any): void;
}

/**
 * Researcher team state - adapted from InvestDebateState
 */
export interface InvestDebateState {
  /** Bullish conversation history */
  bull_history: string;
  
  /** Bearish conversation history */
  bear_history: string;
  
  /** Overall conversation history */
  history: string;
  
  /** Latest response from analyst */
  current_response: string;
  
  /** Judge's final decision */
  judge_decision: string;
  
  /** Length of current conversation */
  count: number;
}

/**
 * Risk management team state - adapted from RiskDebateState
 */
export interface RiskDebateState {
  /** Aggressive agent's conversation history */
  aggressive_history: string;
  
  /** Conservative agent's conversation history */
  conservative_history: string;
  
  /** Neutral agent's conversation history */
  neutral_history: string;
  
  /** Overall conversation history */
  history: string;
  
  /** Last speaker */
  latest_speaker: string;
  
  /** Latest response from aggressive analyst */
  current_aggressive_response: string;
  
  /** Latest response from conservative analyst */
  current_conservative_response: string;
  
  /** Latest response from neutral analyst */
  current_neutral_response: string;
  
  /** Judge's decision */
  judge_decision: string;
  
  /** Conversation length */
  count: number;
}

/**
 * Data structures for financial analysis inputs/outputs
 */

/**
 * Fundamental analysis data structure
 */
export interface FundamentalAnalysis {
  /** Balance sheet analysis */
  balance_sheet_analysis: string;
  
  /** Cash flow analysis */
  cash_flow_analysis: string;
  
  /** Income statement analysis */
  income_statement_analysis: string;
  
  /** Moat/competitive advantage assessment */
  moat_assessment: string;
  
  /** Financial health score (0-100) */
  financial_health_score: number;
  
  /** Key financial ratios */
  key_ratios: {
    debt_to_equity: number;
    current_ratio: number;
    roe: number;
    roa: number;
    profit_margin: number;
    free_cash_flow_yield: number;
  };
  
  /** Red flags identified */
  red_flags: string[];
  
  /** Positive indicators */
  green_flags: string[];

  /** Phase E provenance (present only on the data-driven path). */
  data_source?: string;
}

/**
 * Technical analysis data structure
 */
export interface TechnicalAnalysis {
  /** Trend analysis */
  trend_analysis: string;
  
  /** Momentum indicators */
  momentum_analysis: string;
  
  /** Volatility assessment */
  volatility_assessment: string;
  
  /** Support and resistance levels */
  support_resistance: {
    support_levels: number[];
    resistance_levels: number[];
  };
  
  /** Technical indicators */
  indicators: {
    rsi: number;
    macd: {
      macd: number;
      signal: number;
      histogram: number;
    };
    moving_averages: {
      sma_20: number;
      sma_50: number;
      sma_200: number;
      ema_12: number;
      ema_26: number;
    };
    bollinger_bands: {
      upper: number;
      middle: number;
      lower: number;
    };
    /** Phase D data-driven extras (present only when computed from real bars). */
    atr_14?: number;
    vwap?: number;
    insufficient_long_term?: boolean;
    source?: 'yahoo' | 'mock' | 'mixed';
    interval?: string;
    bars_used?: number;
  };
  
  /** Risk metrics */
  risk_metrics: {
    volatility_30d: number;
    beta: number;
    var_95: number;
    max_drawdown: number;
  };
  
  /** Trading signals */
  signals: string[];
  
  /** Overall technical score (0-100) */
  technical_score: number;
}

/**
 * Market/sentiment analysis data structure
 */
export interface SentimentAnalysis {
  /** News sentiment */
  news_sentiment: string;
  
  /** Social media sentiment */
  social_sentiment: string;
  
  /** Analyst sentiment */
  analyst_sentiment: string;
  
  /** Institutional sentiment */
  institutional_sentiment: string;
  
  /** Overall sentiment score (-100 to +100) */
  sentiment_score: number;
  
  /** Key news items */
  key_news: Array<{
    title: string;
    summary: string;
    sentiment: string;
    timestamp: string;
    source: string;
  }>;
  
  /** Social media trends */
  social_trends: string[];

  /** Phase E provenance (present only on the data-driven path). */
  data_source?: string;
}

/**
 * Risk management assessment
 */
export interface RiskAssessment {
  /** Overall risk level */
  risk_level: 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME';
  
  /** Risk factors identified */
  risk_factors: Array<{
    factor: string;
    severity: 'LOW' | 'MEDIUM' | 'HIGH';
    description: string;
    mitigation: string;
  }>;
  
  /** Portfolio impact assessment */
  portfolio_impact: string;
  
  /** Recommended position sizing */
  position_sizing_recommendation: string;
  
  /** Stop loss suggestion */
  stop_loss_suggestion: number | null;
  
  /** Take profit suggestion */
  take_profit_suggestion: number | null;
  
  /** Maximum recommended allocation */
  max_allocation_percent: number;

  /**
   * Phase F provenance. Present ONLY when the risk assessment was informed by
   * the `state.ingested` market meta (real beta / 30d volatility). Absent on the
   * seeded parity path so legacy output is byte-identical.
   */
  data_driven?: {
    source: 'yahoo' | 'mock' | 'mixed';
    volatility_30d?: number;
    beta?: number;
  };
}

/**
 * Final investment decision
 */
export interface InvestmentDecision {
  /** APPROVE or REJECT */
  decision: 'APPROVE' | 'REJECT';
  
  /** Confidence level (0-100) */
  confidence: number;
  
  /** Reasoning for the decision */
  reasoning: string;
  
  /** Preservation-focused rationale */
  preservation_rationale: string;
  
  /** Conditions if approved */
  conditions: string[];
  
  /** Timestamp of decision */
  timestamp: string;
  
  /** Analyst consensus */
  analyst_consensus: {
    fundamental: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
    technical: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
    sentiment: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
    risk: 'LOW' | 'MEDIUM' | 'HIGH';
  };
}

/**
 * Node-specific input/output interfaces
 */

/**
 * Orchestrator node interfaces
 */
export interface OrchestratorInput {
  /** User query or ticker symbol */
  query: string;
  
  /** Analysis depth preference */
  depth: 'QUICK' | 'STANDARD' | 'DEEP';
  
  /** Time horizon for analysis */
  time_horizon: 'SHORT_TERM' | 'MEDIUM_TERM' | 'LONG_TERM';
  
  /** Risk tolerance */
  risk_tolerance: 'CONSERVATIVE' | 'MODERATE' | 'AGGRESSIVE';
}

export interface OrchestratorOutput {
  /** Routed analysis tasks */
  tasks: Array<{
    type: 'FUNDAMENTAL' | 'TECHNICAL' | 'SENTIMENT' | 'RISK';
    priority: 'HIGH' | 'MEDIUM' | 'LOW';
    parameters: Record<string, any>;
  }>;
  
  /** Workflow control signals */
  workflow_control: {
    skip_steps: string[];
    parallel_execution: boolean;
    require_all_analysts: boolean;
  };
}

/**
 * Data Ingestion node interfaces
 */
export interface DataIngestionInput {
  /** Ticker symbols to fetch data for */
  tickers: string[];
  
  /** Data types required */
  data_types: Array<'FUNDAMENTAL' | 'TECHNICAL' | 'SENTIMENT' | 'MARKET'>;
  
  /** Date range for historical data */
  date_range: {
    start: string;
    end: string;
  };
}

export interface DataIngestionOutput {
  /** Fundamental data */
  fundamental_data: Record<string, any>;
  
  /** Technical/price data */
  technical_data: Record<string, any>;
  
  /** Sentiment/news data */
  sentiment_data: Record<string, any>;
  
  /** Market context data */
  market_data: Record<string, any>;
  
  /** Data quality indicators */
  data_quality: {
    completeness: number; // 0-100
    freshness: number; // hours since last update
    sources: string[];
  };
  
  /** Errors encountered during ingestion */
  errors: Array<{
    ticker: string;
    data_type: string;
    error: string;
  }>;
}

/**
 * Fundamental Analyst node interfaces
 */
export interface FundamentalAnalystInput {
  /** Fundamental data from ingestion */
  fundamental_data: Record<string, any>;
  
  /** Company information */
  company_info: {
    name: string;
    sector: string;
    industry: string;
    market_cap: number;
  };
}

export interface FundamentalAnalystOutput {
  /** Fundamental analysis results */
  analysis: FundamentalAnalysis;
  
  /** Confidence in analysis */
  confidence: number;
  
  /** Key assumptions made */
  assumptions: string[];
  
  /** Data limitations noted */
  limitations: string[];
}

/**
 * Technical Analyst node interfaces
 */
export interface TechnicalAnalystInput {
  /** Technical/price data from ingestion */
  technical_data: Record<string, any>;
  
  /** Market context */
  market_context: {
    trend: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
    volatility: 'LOW' | 'MEDIUM' | 'HIGH';
    volume_trend: 'INCREASING' | 'DECREASING' | 'STABLE';
  };
}

export interface TechnicalAnalystOutput {
  /** Technical analysis results */
  analysis: TechnicalAnalysis;
  
  /** Confidence in analysis */
  confidence: number;
  
  /** Key assumptions made */
  assumptions: string[];
  
  /** Data limitations noted */
  limitations: string[];
}

/**
 * Sentiment Analyst node interfaces
 */
export interface SentimentAnalystInput {
  /** Sentiment/news data from ingestion */
  sentiment_data: Record<string, any>;
  
  /** Recent market events */
  recent_events: Array<{
    event: string;
    impact: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL';
    timestamp: string;
  }>;
}

export interface SentimentAnalystOutput {
  /** Sentiment analysis results */
  analysis: SentimentAnalysis;
  
  /** Confidence in analysis */
  confidence: number;
  
  /** Key assumptions made */
  assumptions: string[];
  
  /** Data limitations noted */
  limitations: string[];
}

/**
 * Risk Analyst node interfaces
 */
export interface RiskAnalystInput {
  /** Fundamental analysis results */
  fundamental_analysis: FundamentalAnalysis;
  
  /** Technical analysis results */
  technical_analysis: TechnicalAnalysis;
  
  /** Sentiment analysis results */
  sentiment_analysis: SentimentAnalysis;
  
  /** Market context */
  market_context: {
    volatility_index: number;
    market_trend: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
    sector_performance: number; // relative to sector
  };
}

export interface RiskAnalystOutput {
  /** Risk assessment results */
  assessment: RiskAssessment;
  
  /** Confidence in assessment */
  confidence: number;
  
  /** Key assumptions made */
  assumptions: string[];
  
  /** Data limitations noted */
  limitations: string[];
}

/**
 * Governance Gatekeeper node interfaces
 */
export interface GovernanceGatekeeperInput {
  /** Fundamental analysis results */
  fundamental_analysis: FundamentalAnalysis;
  
  /** Technical analysis results */
  technical_analysis: TechnicalAnalysis;
  
  /** Sentiment analysis results */
  sentiment_analysis: SentimentAnalysis;
  
  /** Risk assessment results */
  risk_assessment: RiskAssessment;
  
  /** Current market conditions */
  market_conditions: {
    volatility_index: number;
    market_trend: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
    sector_performance: number; // relative to sector
  };
  
  /** Investment thesis developed so far */
  investment_thesis: string;
}

export interface GovernanceGatekeeperOutput {
  /** Final investment decision */
  decision: InvestmentDecision;
  
  /** Risk assessment */
  risk_assessment: RiskAssessment;
  
  /** Governance notes */
  governance_notes: string;
  
  /** Preservation score (0-100, higher is better for capital preservation) */
  preservation_score: number;
  
  /** Recommended action */
  recommended_action: string;
  
  /** Next review date */
  next_review_date: string;
}

/**
 * Error handling interfaces
 */
export interface NodeError {
  /** Node that encountered the error */
  node: string;
  
  /** Error type */
  type: string;
  
  /** Error message */
  message: string;
  
  /** Timestamp */
  timestamp: string;
  
  /** Recoverable? */
  recoverable: boolean;
  
  /** Retry count */
  retry_count: number;
}

export interface WorkflowError extends NodeError {
  /** Workflow step where error occurred */
  step: string;
  
  /** Input data that caused error */
  input_data: any;
  
  /** Suggested fallback */
  fallback_suggestion: string;
}

/**
 * The set of analyst roles in the pipeline. Mirrors the frontend's `AnalystId`
 * so a trace produced on the backend maps cleanly to a panel on the client.
 */
export type AnalystId =
  | 'orchestrator'
  | 'data_ingestion'
  | 'fundamental'
  | 'technical'
  | 'sentiment'
  | 'risk'
  | 'governance'
  // ---- Phase B: options analysts (instrument OPTION) ----
  | 'options_ingestion'
  | 'vol_surface'
  | 'options_pricing'
  | 'options_greeks'
  | 'options_flow'
  | 'options_technical'
  | 'options_risk';

/**
 * Per-analyst trace — a faithful record of one analyst node's execution,
 * surfaced on the client for drill-down / traceability. Mirrors the
 * TradingAgents pattern where each agent runs under an explicit instruction
 * prompt, consumes specific data sources, and weights them to a result.
 */
export interface AnalystTrace {
  /** Analyst id (matches AnalystId on the frontend). */
  analyst: AnalystId;
  /** Human-readable analyst name. */
  name: string;
  /** Pipeline stage (1 = intake, 2 = analysis, 3 = decision). */
  stage: 1 | 2 | 3;
  /**
   * The instruction prompt the analyst operated under (adapted from
   * TradingAgents' agent system prompts). This is what the user sees in the
   * drawer's "Instructions" section.
   */
  instructions: string;
  /**
   * Per-ticker inputs consumed. Each entry records the data fields examined
   * and the sources they were drawn from, so the user can drill into exactly
   * what was analyzed for a given ticker.
   */
  inputs: AnalystTraceInput[];
  /**
   * The weighting / scoring steps used to combine the inputs into the output.
   * Ordered list so the user can follow the reasoning chain
   * (input -> weight -> contribution -> output).
   */
  weighting: WeightingStep[];
  /** The analyst's output (verdict / score / key findings). */
  output: {
    verdict?: string;
    score?: number;
    summary: string;
    details?: Record<string, any>;
  };
  /** Free-form notes (assumptions, limitations, caveats). */
  notes?: string[];
  /** §4.9.4 machine-readable per-source status keyed by source id. */
  sourceStatus?: Record<string, 'ok' | 'skipped' | 'failed' | 'fallback'>;
  /** True if the analyst ran on fewer than its full source set. */
  degraded?: boolean;
}

/** One ticker's worth of consumed input, with source attribution. */
export interface AnalystTraceInput {
  ticker: string;
  /** Human label for what was analyzed for this ticker. */
  label: string;
  /** The actual data fields examined (key -> value). */
  data: Record<string, any>;
  /** Sources those fields were drawn from (e.g. "Yahoo Finance"). */
  sources: string[];
}

/**
 * A single weighting/scoring step in the reasoning chain. Designed so the
 * client can render "how we arrived at the output": each step takes some
 * inputs, applies a weight, and yields a contribution toward the output.
 */
export interface WeightingStep {
  /** Short name of the step, e.g. "Leverage penalty". */
  label: string;
  /** Which input fields this step consumed. */
  inputs: string[];
  /** Weight applied (0..1 or arbitrary scale — described by `scale`). */
  weight: number;
  /** What the weight meant in plain language. */
  rationale: string;
  /** Numeric contribution this step made toward the final output. */
  contribution: number;
  /** Optional scale description for the UI, e.g. "0..100 score". */
  scale?: string;
}

// ===========================================================================
// Options & Historical Data Layer (doc §1, §5). All additive + optional-on-
// state, so the equity pipeline (long/medium/intraday) is untouched. Produced
// by src/registry/logic/hist.ts (mock-first, live-ready) and consumed by the
// options agencies' analysts.
// ===========================================================================

export type OptionRight = 'C' | 'P';
export type BarInterval = '1d' | '4h' | '1h' | '5m' | '1m';

/** One OHLCV price bar (daily or intraday). */
export interface PriceBar {
  /** ISO timestamp of the bar open. */
  t: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Volume-weighted average price (optional; present on intraday bars). */
  vwap?: number;
}

/** Historical/intraday price series for one interval. */
export interface PriceBarSeries {
  interval: BarInterval;
  lookback_days: number;
  bars: PriceBar[];
}

/** One option-chain row: a single strike/right for a given expiry. */
export interface OptionQuote {
  expiry: string;      // ISO date
  strike: number;
  type: OptionRight;
  bid: number;
  ask: number;
  last: number;
  volume: number;
  open_interest: number;
  iv: number;          // implied volatility (decimal, e.g. 0.35)
  underlying_price: number;
  underlying_ts: string;
}

/** Per-strike greeks row (see greeks.ts for the math + units). */
export interface GreeksRow {
  expiry: string;
  strike: number;
  type: OptionRight;
  delta: number;
  gamma: number;
  vega: number;
  theta: number;
  rho: number;
  iv_in: number;
  underlying_price: number;
  ttm_years: number;
  rfr: number;
}

/**
 * The full bundle returned by hist.ts for a ticker + profile. Equity agencies
 * ignore the option fields; options agencies consume them. One data contract,
 * one parity fallback.
 */
export interface HistoricalBundle {
  ticker: string;
  underlying_price: number;
  /** Price series keyed by interval (e.g. '1d', '5m'). */
  price_bars: PriceBarSeries[];
  option_chain: OptionQuote[];
  greeks: GreeksRow[];
  rfr: number;
  expiries: string[];
  /** Historical ATM IV samples (for iv_rank/iv_percentile in vol-surface). */
  iv_history: number[];
  /** True when produced from the deterministic mock (no live keys). */
  mock: boolean;
}

/**
 * Volatility-surface summary produced by vol-surface.ts. Captures term
 * structure (IV vs expiry) and skew (IV vs moneyness) plus rank/percentile.
 */
export interface VolSurface {
  atm_iv: number;
  /** dIV/dMoneyness at ATM (negative = typical equity put skew). */
  skew_slope: number;
  /** dIV/dTenor across expiries (positive = upward-sloping term structure). */
  term_slope: number;
  /** Current ATM IV percentile vs iv_history [0..100]. */
  iv_percentile: number;
  /** Current ATM IV rank vs iv_history min/max [0..100]. */
  iv_rank: number;
  /** Per-expiry fitted summary (ATM IV + skew per tenor). */
  by_expiry: Array<{
    expiry: string;
    ttm_years: number;
    atm_iv: number;
    skew_slope: number;
  }>;
  /** Free-form anomaly flags (e.g. inverted term structure, kurtosis). */
  flags: string[];
}

/** A single option chain snapshot (all expiries/strikes/rights for a ticker). */
export interface OptionChain {
  ticker: string;
  underlying_price: number;
  quotes: OptionQuote[];
  expiries: string[];
  rfr: number;
  /** Per-strike Black–Scholes greeks, re-derived from each quote's IV. */
  greeks: GreeksRow[];
}

/** Greeks summary for one expiry/strike (re-exports GreeksRow shape for clarity). */
export interface Greeks {
  delta: number;
  gamma: number;
  vega: number;
  theta: number;
  rho: number;
  iv_in: number;
}

/**
 * Options pricing result — a candidate structure with BS fair value vs market
 * (edge) and a recommended structure. Produced by `options_pricing`.
 */
export interface OptionPricingResult {
  ticker: string;
  candidates: Array<{
    strike: number;
    right: OptionRight;
    fair_value: number;
    market: number;
    edge_pct: number;
  }>;
  recommended_structure: string | null;
  score: number;
  verdict: 'EDGE' | 'THIN_EDGE' | 'NO_EDGE';
}

/**
 * Options risk assessment — the veto-relevant facts governance reads. Produced
 * by `options_risk`. `max_loss` is `null` for an UNDEFINED-risk structure
 * (auto-EXTREME; governance rejects when `requireHedge` is set).
 */
export interface OptionRiskAssessment {
  ticker: string;
  max_loss: number | null;
  iv_percentile: number;
  iv_crush_risk: boolean;
  risk_level: 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME';
  max_allocation: number;
  hard_exit: string;
  hedged: boolean;
}
// frontend/src/components/analysts/analysts.ts
// Static metadata for the analyst panels shown in the AnalystWall.
// This file MUST mirror the backend ANALYST_DEFS in src/registry/analysts.ts.
// The backend registry test (registry.test.ts → deriveAnalystMetaFromDefs)
// asserts that this interface matches the backend truth.
//
// IMPORTANT: this list is the UNION of analysts across ALL agencies (it includes
// `onchain`, which only the crypto-screener agency uses). The per-agency
// composition — i.e. which analysts appear as wall cards — is owned by
// agencies.ts, NOT here. The three equity agencies (long-term / medium-term /
// intraday) are 7-card equity pipelines; crypto-screener is a 4-card set that
// includes onchain. So a frontend docstring that says "7 entries" refers to a
// single equity agency's wall, not this catalog.

export type AnalystId =
  | 'orchestrator'
  | 'data_ingestion'
  | 'fundamental'
  | 'technical'
  | 'sentiment'
  | 'risk'
  | 'governance'
  | 'bull_researcher'
  | 'bear_researcher'
  | 'onchain'
  // ---- Phase B/C: options analysts (instrument OPTION) ----
  | 'options_ingestion'
  | 'vol_surface'
  | 'options_pricing'
  | 'options_greeks'
  | 'options_flow'
  | 'options_technical'
  | 'options_risk';

export interface AnalystMeta {
  id: AnalystId;
  name: string;
  /** Short role line shown under the name. */
  role: string;
  /** Accent color (used for border/glow). */
  accent: string;
  /** Two-letter monogram in the panel header. */
  monogram: string;
  /** Stage number (1 = intake, 2 = analysis, 3 = debate/research, 4 = decision). */
  stage: 1 | 2 | 3 | 4;
  /** Mock sub-tasks cycled through per ticker during a simulated run. */
  tasks: string[];
}

// Pipeline order matches the long-term agency (orchestrator → data_ingestion → fundamental → … → governance)
export const ANALYSTS: AnalystMeta[] = [
  {
    id: 'orchestrator',
    name: 'Orchestrator',
    role: 'Parses query · routes tickers',
    accent: '#64748b',
    monogram: 'OR',
    stage: 1,
    tasks: ['Parsing tickers', 'Resolving options', 'Seeding pipeline'],
  },
  {
    id: 'data_ingestion',
    name: 'Data Ingestion',
    role: 'Fetches · standardizes · loads',
    accent: '#475569',
    monogram: 'DI',
    stage: 1,
    tasks: ['Fetching financials', 'Polling price feeds', 'Scanning news', 'Loading market context'],
  },
  {
    id: 'fundamental',
    name: 'Fundamental',
    role: 'Balance sheet · moat · valuation',
    accent: '#3b82f6',
    monogram: 'FA',
    stage: 2,
    tasks: ['Loading financials', 'Scoring moat', 'Deriving fair value'],
  },
  {
    id: 'technical',
    name: 'Technical',
    role: 'Trend · indicators · levels',
    accent: '#8b5cf6',
    monogram: 'TA',
    stage: 2,
    tasks: ['Reading trend', 'Computing RSI/MACD', 'Marking support/resistance'],
  },
  {
    id: 'sentiment',
    name: 'Sentiment',
    role: 'News · social · positioning',
    accent: '#ec4899',
    monogram: 'SA',
    stage: 2,
    tasks: ['Scanning headlines', 'Weighing social', 'Netting positioning'],
  },
  {
    id: 'bull_researcher',
    name: 'Bull Researcher',
    role: 'Argues the constructive case',
    accent: '#22c55e',
    monogram: 'BL',
    stage: 3,
    tasks: ['Weighing fundamental support', 'Reading technical uptrend', 'Netting positive narrative'],
  },
  {
    id: 'bear_researcher',
    name: 'Bear Researcher',
    role: 'Argues the skeptical case',
    accent: '#ef4444',
    monogram: 'BR',
    stage: 3,
    tasks: ['Stress-testing fundamentals', 'Flagging technical breakdown', 'Challenging the narrative'],
  },
  {
    id: 'risk',
    name: 'Risk',
    role: 'Exposure · sizing · stop',
    accent: '#f59e0b',
    monogram: 'RA',
    stage: 2,
    tasks: ['Sizing exposure', 'Stress testing', 'Setting stop-loss'],
  },
  {
    id: 'governance',
    name: 'Governance',
    role: 'Preservation-first veto',
    accent: '#10b981',
    monogram: 'GV',
    stage: 4,
    tasks: ['Reviewing debate', 'Applying veto test', 'Issuing decision'],
  },
  {
    id: 'onchain',
    name: 'On-Chain Flow',
    role: 'Whale / exchange flows',
    accent: '#f59e0b',
    monogram: 'OC',
    stage: 2,
    tasks: ['Reading exchange netflow', 'Counting active addresses', 'Scoring on-chain'],
  },
  // ---- Phase B/C: options analysts (instrument OPTION) ----
  {
    id: 'options_ingestion',
    name: 'Options Data Ingestion',
    role: 'Chain · greeks · rfr · bars',
    accent: '#0ea5e9',
    monogram: 'OI',
    stage: 1,
    tasks: ['Fetching chains', 'Loading underlying bars', 'Deriving greeks', 'Reading rfr'],
  },
  {
    id: 'vol_surface',
    name: 'Volatility Surface',
    role: 'Skew · term structure · IV rank',
    accent: '#6366f1',
    monogram: 'VS',
    stage: 2,
    tasks: ['Building skew', 'Fitting term structure', 'Ranking IV'],
  },
  {
    id: 'options_pricing',
    name: 'Options Pricing',
    role: 'Fair value · edge · structures',
    accent: '#8b5cf6',
    monogram: 'OP',
    stage: 2,
    tasks: ['Re-pricing strikes', 'Ranking edge', 'Assembling structures'],
  },
  {
    id: 'options_greeks',
    name: 'Options Greeks',
    role: 'Net delta · gamma · vega · theta',
    accent: '#a855f7',
    monogram: 'OG',
    stage: 2,
    tasks: ['Rolling up greeks', 'Checking budget', 'Flagging blow-ups'],
  },
  {
    id: 'options_flow',
    name: 'Options Flow',
    role: 'Gamma walls · dealer positioning',
    accent: '#d946ef',
    monogram: 'OF',
    stage: 2,
    tasks: ['Locating gamma walls', 'Reading dealer positioning', 'Scoring flow'],
  },
  {
    id: 'options_technical',
    name: 'Options Technical',
    role: 'Underlying micro-timing (5m/1m)',
    accent: '#c026d3',
    monogram: 'OT',
    stage: 2,
    tasks: ['Reading micro-trend', 'Timing entry', 'Marking invalidation'],
  },
  {
    id: 'options_risk',
    name: 'Options Risk',
    role: 'Max loss · IV-crush · sizing',
    accent: '#f43f5e',
    monogram: 'OR',
    stage: 3,
    tasks: ['Bounding max loss', 'Testing greek blow-up', 'Gauging IV-crush', 'Sizing position'],
  },
];

export function analystById(id: AnalystId): AnalystMeta {
  const found = ANALYSTS.find((a) => a.id === id);
  if (!found) throw new Error(`Unknown analyst: ${id}`);
  return found;
}
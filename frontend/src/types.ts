// Frontend shared types.
// These mirror the normalized payload the backend emits on `analysis_complete`
// (see src/server/index.ts -> normalizeResult) plus the settings/config model.

import type { AnalystId } from './components/analysts/analysts';

export type Decision = 'APPROVE' | 'REJECT' | 'ERROR';

export interface InvestmentDecision {
  decision: Decision;
  confidence: number | null;
  reasoning: string;
  preservation_rationale: string | null;
  conditions: string[];
  timestamp?: string;
  analyst_consensus?: Record<string, string>;
}

export interface AnalysisResult {
  decision: Decision;
  confidence: number | null;
  reasoning: string;
  preservation_rationale: string | null;
  conditions: string[];
  tickers: string[];
  company_name: string;
  investment_thesis: string;
  final_decision: string;
  error: string | null;
  fundamental_analysis: any | null;
  technical_analysis: any | null;
  sentiment_analysis: any | null;
  risk_assessment: Record<string, any> | null;
  decisions: Record<string, any>;
  riskAssessments: Record<string, any>;
  timestamp?: string;
  /**
   * Structured per-analyst drill-down records (Phase 1 backend feature).
   * One entry per analyst (orchestrator -> fundamental -> ... -> governance),
   * each carrying the instructions, the data/sources consumed, the weighting
   * steps, and the output. Keyed in pipeline order by `analyst`.
   */
  analystTraces: AnalystTrace[];
  /**
   * §4.9 pipeline-wide data-health summary. Present when the multi-source
   * acquisition engine ran (live sources configured); null in the mock-only
   * default. Drives the data-quality strip on the results panel.
   */
  dataHealth?: DataHealth | null;
  /**
   * True when the run executed with DISABLE_MOCK_DATA set AND had no live
   * sources — so the output is EMPTY (not fabricated). The UI shows a banner
   * so the user can never mistake it for a real analysis.
   */
  mockDisabled?: boolean;
  /**
   * Phase B — backend-computed scannable thesis grid (decision + per-analyst
   * verdict/score). Preferred by the results panel; absent in legacy payloads
   * (frontend falls back to deriving rows from analystTraces, then the raw
   * investment_thesis string).
   */
  thesisSummary?: {
    decision: string;
    confidence: number | null;
    reasoning: string | null;
    rows: Array<{
      analyst: string;
      name: string;
      verdict: string | null;
      score: number | null;
      summary: string | null;
    }>;
  } | null;
}

/**
 * §4.9 aggregate data-health summary across all analysts in a run.
 */
export interface DataHealth {
  sourcesOk: number;
  sourcesTotal: number;
  degradedAnalysts: string[];
  unavailableSources: string[];
  usedMockFallback: boolean;
}

/**
 * A single per-ticker input record captured by an analyst for traceability.
 */
export interface AnalystTraceInput {
  ticker: string;
  label?: string;
  data: Record<string, any>;
  sources: string[];
}

/**
 * One step in an analyst's weighting logic — how inputs were combined to reach
 * the output. Used by the drill-down to show the derivation path.
 */
export interface WeightingStep {
  label: string;
  inputs: string[];
  weight: number;
  contribution?: number;
  scale?: string;
  rationale?: string;
}

/**
 * A structured per-analyst execution trace, emitted by the backend on
 * `analysis_complete` and rendered in the AnalystTraceDrawer.
 */
export interface AnalystTrace {
  analyst: AnalystId;
  name: string;
  stage: number;
  instructions: string;
  inputs: AnalystTraceInput[];
  weighting: WeightingStep[];
  output: {
    verdict?: string;
    score?: number;
    summary: string;
    details?: Record<string, any>;
  };
  notes?: string[];
  /** §4.9 per-source status keyed by source id. */
  sourceStatus?: Record<string, 'ok' | 'skipped' | 'failed' | 'fallback'>;
  /** §4.9 true if this analyst ran on fewer than its full source set. */
  degraded?: boolean;
  /** Phase F — selected flavor id (when a flavor drove the run). */
  flavorId?: string;
  /** Phase F — LLM step result (only present when logic.llm.enabled + flavor selected). */
  llm?: {
    text: string;
    verdict?: string | null;
    score?: number | null;
    usedFallback: boolean;
  };
}

export interface AgentThought {
  agent: string;
  thought: string;
  timestamp: string;
}

export interface ProgressUpdate {
  step: string;
  data: any;
  timestamp: string;
}

/**
 * Settings the user supplies via the Settings dialog (Phase 2).
 * These are POSTed to the backend `/config` endpoint (Option B) and never
 * persisted in the client bundle.
 */
export interface ConnectionSettings {
  /** Base URI of the analysis backend, e.g. http://localhost:3001 */
  baseUri: string;
  /** Access token / API key used to authenticate with upstream data sources. */
  accessToken: string;
  /** Free-form additional config (other required knobs). */
  extra: Record<string, string>;
  /**
   * When true, analysts that don't depend on each other run concurrently after
   * data ingestion (fan-out / fan-in) instead of strictly one-after-another.
   * Default false — keeps the legacy serial order for parity until enabled.
   */
  parallelAnalysts?: boolean;
}

export const DEFAULT_SETTINGS: ConnectionSettings = {
  baseUri: 'http://localhost:3001',
  accessToken: '',
  extra: {},
  parallelAnalysts: true,
};

/**
 * B1: one source credential the user supplies through the per-analyst
 * "⚙ Configure source" dialog. POSTed to the backend `/analyst-config`
 * endpoint and stored server-side — never persisted in the client bundle.
 */
export interface AnalystSourceConfig {
  /** Analyst id this source belongs to (e.g. 'fundamental'). */
  analystId: string;
  /** Source id within that analyst (e.g. 'yahoo'). */
  sourceId: string;
  /** API key / bearer token for THIS source. Optional (may be cleared). */
  token: string;
  /** Free-form extra knobs for the source. */
  extra: Record<string, string>;
}

/** Catalog entry returned by GET /analyst-config: one credentialed source. */
export interface AnalystSourceCatalogEntry {
  id: string;
  label: string;
  auth: string;
}

/** One analyst that declares credentialed (live + auth) sources. */
export interface AnalystSourceCatalogAnalyst {
  analystId: string;
  name: string;
  sources: AnalystSourceCatalogEntry[];
}

/** Response from GET /analyst-config. */
export interface AnalystSourceCatalog {
  analysts: AnalystSourceCatalogAnalyst[];
}

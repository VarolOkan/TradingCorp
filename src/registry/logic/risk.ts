// src/registry/logic/risk.ts
// Phase 3 extraction (doc §8 Phase 3). Pure risk-analysis handler.
// RiskAnalystNode is now a thin shim that delegates here.

import type { AgentState, RiskAssessment } from '../../types/financial-analysis';
import { instructionFor } from '../prompts';
import {
  stringToSeed,
  seededRandom,
  updateInvestmentThesis,
  hasTickers,
  annotateDataReceived,
  recordDataReceived,
  type NodeSurface,
} from './shared';
import type { AnalystTuning } from '../../types/registry';

export type { NodeSurface };

export async function riskHandler(
  state: AgentState,
  node: NodeSurface,
  tuning?: AnalystTuning,
): Promise<AgentState> {
  let updatedState = node.updateStep(state, 'risk_analysis_start');
  node.emitProgress(updatedState, 'analyst:start', 'risk', { stage: 2 });

  updatedState = node.addMessage(updatedState, 'system',
    `Starting risk analysis for ${state.tickers.length} ticker(s): ${state.tickers.join(', ')}`);

  try {
    if (!hasTickers(state)) {
      throw new Error('No tickers specified for risk analysis');
    }

    const assessments: Record<string, RiskAssessment> = {};
    for (const ticker of state.tickers) {
      assessments[ticker] = performRiskAnalysis(ticker, tuning, state.ingested);
      // Phase R2 (RAW_DATA_DUMP.md): record which ingested slice risk consumed.
      const ingested = state.ingested;
      const market = ingested?.market?.[ticker];
      if (market) {
        updatedState = recordDataReceived(updatedState, annotateDataReceived(
          'risk', ticker, 'ingested',
          [{ domain: 'market', source: ingested!.source,
            ...(typeof market.beta === 'number' ? { rows: 1 } : {}) }],
          ingested!.source === 'mixed' ? 'mixed' : ingested!.source === 'mock' ? 'mock' : 'live',
          'risk escalation driven by ingested beta / 30d volatility',
        ));
      } else {
        updatedState = recordDataReceived(updatedState, annotateDataReceived(
          'risk', ticker, 'ingested',
          [{ domain: 'market', source: 'seeded' }],
          'seeded-parity', 'no ingested.market — risk ran on seeded fallback',
        ));
      }
    }

    updatedState = {
      ...updatedState,
      messages: [
        ...(updatedState.messages || []),
        {
          role: 'system',
          content: `Risk analysis completed for ${state.tickers.length} ticker(s)`,
          timestamp: new Date().toISOString(),
          data: { assessments, summary: generateAnalysisSummary(assessments) },
        },
      ],
      investment_thesis: updateInvestmentThesis(state.investment_thesis, generateAnalysisSummary(assessments), 'RISK'),
    };

    updatedState = node.captureTrace(updatedState, {
      analyst: 'risk',
      name: 'Risk Analyst',
      stage: 2,
      instructions: instructionFor('risk'),
      inputs: state.tickers.map((ticker) => ({
        ticker,
        label: 'Risk inputs consumed (cross-analyst + market)',
        data: {
          risk_level: assessments[ticker]?.risk_level,
          max_allocation_percent: assessments[ticker]?.max_allocation_percent,
          stop_loss_suggestion: assessments[ticker]?.stop_loss_suggestion,
          take_profit_suggestion: assessments[ticker]?.take_profit_suggestion,
          factors: (assessments[ticker]?.risk_factors ?? []).map((f: any) => `${f.factor} [${f.severity}]`),
        },
        sources: ['Fundamental/Technical/Sentiment outputs', 'Market context (volatility index)'],
      })),
      weighting: [
        { label: 'Volatility & market regime', inputs: ['volatility_index', 'market_trend'], weight: 0.4, rationale: 'Higher volatility / bearish regime compresses allowable sizing.', contribution: 40, scale: '0..100 score weight' },
        { label: 'Idiosyncratic risk factors', inputs: ['risk_factors'], weight: 0.35, rationale: 'Severity-weighted factors scale the risk level up.', contribution: 35, scale: '0..100 score weight' },
        { label: 'Preservation buffer', inputs: ['stop_loss_suggestion', 'max_allocation_percent'], weight: 0.25, rationale: 'Hard stops + capped allocation bound downside first.', contribution: 25, scale: '0..100 score weight' },
      ],
      output: {
        verdict: dominantRiskLevel(assessments),
        summary: generateAnalysisSummary(assessments),
        details: { assessments },
      },
      notes: ['Preservation-first: sizing is inversely scaled to risk level and volatility.'],
    });

    node.emitProgress(updatedState, 'analyst:done', 'risk', { stage: 2, tickers: state.tickers });
    return updatedState;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      ...updatedState,
      error: `Risk analysis error: ${errorMessage}`,
      current_step: 'risk_analysis_error',
      messages: [
        ...(updatedState.messages || []),
        { role: 'error', content: `Failed to perform risk analysis: ${errorMessage}`, timestamp: new Date().toISOString() },
      ],
    };
  }
}

function performRiskAnalysis(
  ticker: string,
  tuning?: AnalystTuning,
  ingested?: AgentState['ingested'],
): RiskAssessment {
  const seed = stringToSeed(ticker + '_risk');
  const rng = seededRandom(seed);
  const horizon = tuning?.horizon ?? 'LONG_TERM';

  // Legacy (no tuning) must reproduce byte-for-byte. Only when an agency passes
  // tuning do we apply horizon/param-based clamping.
  const hasTuning = tuning !== undefined;

  // Per-agency clamping targets (from agency params). When absent, fall back to
  // horizon defaults. These shape the stop-loss and max-allocation so intraday
  // is the strictest (tightest stop, smallest sizing) and long-term the loosest.
  const maxStopLoss = hasTuning
    ? (typeof tuning?.params?.maxStopLoss === 'number'
      ? tuning.params.maxStopLoss
      : horizon === 'INTRADAY' ? 0.05
      : horizon === 'MEDIUM_TERM' || horizon === 'SHORT_TERM' ? 0.1
      : 0.15)
    : 0.2;
  const baseAllocation = hasTuning
    ? (typeof tuning?.params?.baseAllocation === 'number'
      ? tuning.params.baseAllocation
      : horizon === 'INTRADAY' ? 2
      : horizon === 'MEDIUM_TERM' || horizon === 'SHORT_TERM' ? 4
      : 5)
    : undefined;

  let riskLevel = determineRiskLevel(rng);
  const riskFactors = generateRiskFactors(rng);
  const portfolioImpact = assessPortfolioImpact(rng);
  const positionSizingRecommendation = recommendPositionSizing(rng, riskLevel);
  const stopLossSuggestion = calculateStopLoss(rng, maxStopLoss);
  const takeProfitSuggestion = calculateTakeProfit(rng);
  let maxAllocationPercent = baseAllocation !== undefined
    ? Math.min(baseAllocation, calculateMaxAllocation(riskLevel))
    : calculateMaxAllocation(riskLevel);

  // Phase F: when the ingestion channel carries live market meta, escalate the
  // risk level and tighten sizing off the REAL 30-day volatility / beta so the
  // assessment is coherent with the data-driven upstream analysts. Parity is
  // preserved: with no `ingested`, this block is skipped entirely.
  let dataDriven: RiskAssessment['data_driven'] | undefined;
  const market = ingested?.market?.[ticker];
  if (market) {
    const vol30 = toNum(market.volatility_30d);
    const beta = toNum(market.beta);
    // Volatility bands (annualized-ish proxy from the 30d field): escalate level.
    if (vol30 !== null) {
      if (vol30 >= 0.6) riskLevel = escalate(riskLevel, 2);
      else if (vol30 >= 0.4) riskLevel = escalate(riskLevel, 1);
    }
    if (beta !== null && beta >= 1.5) riskLevel = escalate(riskLevel, 1);
    // Re-cap allocation to the (possibly worse) risk level and scale by beta.
    const levelCap = calculateMaxAllocation(riskLevel);
    const betaScale = beta !== null && beta > 1 ? 1 / beta : 1; // higher beta → smaller size
    const capBase = baseAllocation !== undefined ? Math.min(baseAllocation, levelCap) : levelCap;
    maxAllocationPercent = parseFloat((capBase * betaScale).toFixed(2));
    dataDriven = {
      source: ingested?.source ?? 'mixed',
      ...(vol30 !== null ? { volatility_30d: vol30 } : {}),
      ...(beta !== null ? { beta } : {}),
    };
  }

  return {
    risk_level: riskLevel,
    risk_factors: riskFactors,
    portfolio_impact: portfolioImpact,
    position_sizing_recommendation: positionSizingRecommendation,
    stop_loss_suggestion: stopLossSuggestion,
    take_profit_suggestion: takeProfitSuggestion,
    max_allocation_percent: maxAllocationPercent,
    ...(dataDriven ? { data_driven: dataDriven } : {}),
  } as RiskAssessment;
}

/** Coerce a possibly-string numeric field (mock uses toFixed strings). */
function toNum(v: any): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/** Bump a risk level up by `steps` (LOW→MEDIUM→HIGH→EXTREME), clamped. */
function escalate(level: 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME', steps: number): 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME' {
  const order: Array<'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME'> = ['LOW', 'MEDIUM', 'HIGH', 'EXTREME'];
  const idx = Math.min(order.length - 1, order.indexOf(level) + steps);
  return order[idx]!;
}

function determineRiskLevel(rng: () => number): 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME' {
  const v = rng();
  if (v > 0.8) return 'LOW';
  if (v > 0.6) return 'MEDIUM';
  if (v > 0.3) return 'HIGH';
  return 'EXTREME';
}

function generateRiskFactors(rng: () => number): Array<{ factor: string; severity: 'LOW' | 'MEDIUM' | 'HIGH'; description: string; mitigation: string }> {
  const numFactors = Math.floor(rng() * 3) + 1;
  const possibleFactors = [
    { factor: 'Market Volatility', descriptions: ['High market volatility increasing price swings', 'Elevated VIX levels'], mitigations: ['Use stop-loss orders', 'Reduce position size during volatile periods'] },
    { factor: 'Liquidity Risk', descriptions: ['Low trading volume may impact entry/exit', 'Wide bid-ask spreads'], mitigations: ['Limit orders for entry/exit', 'Avoid trading during low-volume periods'] },
    { factor: 'Company-Specific Risk', descriptions: ['Pending litigation or regulatory issues', 'Dependence on single customer/product'], mitigations: ['Diversify across sectors', 'Monitor company news closely'] },
    { factor: 'Sector Concentration', descriptions: ['Heavy exposure to cyclical industry', 'Regulatory changes affecting sector'], mitigations: ['Diversify across sectors', 'Monitor industry trends'] },
    { factor: 'Macroeconomic Factors', descriptions: ['Interest rate sensitivity', 'Exposure to currency fluctuations'], mitigations: ['Hedge with inverse ETFs', 'Consider macroeconomic outlook'] },
  ];

  const selectedIndices: number[] = [];
  while (selectedIndices.length < Math.min(numFactors, possibleFactors.length)) {
    const idx = Math.floor(rng() * possibleFactors.length);
    if (!selectedIndices.includes(idx)) selectedIndices.push(idx);
  }

  const riskFactors: any[] = [];
  for (const idx of selectedIndices) {
    const factorInfo = possibleFactors[idx]!;
    const descIndex = Math.floor(rng() * factorInfo.descriptions.length);
    const mitIndex = Math.floor(rng() * factorInfo.mitigations.length);
    riskFactors.push({
      factor: factorInfo.factor,
      severity: determineSeverity(rng),
      description: factorInfo.descriptions[descIndex]!,
      mitigation: factorInfo.mitigations[mitIndex]!,
    });
  }
  return riskFactors;
}

function determineSeverity(rng: () => number): 'LOW' | 'MEDIUM' | 'HIGH' {
  const v = rng();
  if (v > 0.7) return 'LOW';
  if (v > 0.3) return 'MEDIUM';
  return 'HIGH';
}

function assessPortfolioImpact(rng: () => number): string {
  const v = rng();
  if (v > 0.8) return 'Minimal impact on overall portfolio - well diversified';
  if (v > 0.6) return 'Moderate impact - consider position sizing';
  if (v > 0.3) return 'Significant impact - may require portfolio rebalancing';
  return 'High impact - significant concentration risk';
}

function recommendPositionSizing(rng: () => number, riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME'): string {
  let basePercentage: number;
  switch (riskLevel) {
    case 'LOW': basePercentage = 5 + rng() * 10; break;
    case 'MEDIUM': basePercentage = 2 + rng() * 6; break;
    case 'HIGH': basePercentage = 1 + rng() * 4; break;
    case 'EXTREME': basePercentage = 0.5 + rng() * 2; break;
  }
  return `Recommend allocating ${basePercentage.toFixed(1)}% of portfolio to this position`;
}

function calculateStopLoss(rng: () => number, maxStopLoss = 0.2): number | null {
  if (rng() < 0.2) return null;
  if (maxStopLoss >= 0.2) {
    // Legacy formula (no tuning) — must stay byte-identical.
    return parseFloat((rng() * 0.2 + 0.05).toFixed(2));
  }
  // Clamp the suggested stop to the agency's max tolerance so intraday stays tight.
  return parseFloat((rng() * maxStopLoss + 0.01).toFixed(2));
}

function calculateTakeProfit(rng: () => number): number | null {
  if (rng() < 0.3) return null;
  return parseFloat((rng() * 0.35 + 0.15).toFixed(2));
}

function calculateMaxAllocation(riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME'): number {
  switch (riskLevel) {
    case 'LOW': return 20;
    case 'MEDIUM': return 10;
    case 'HIGH': return 5;
    case 'EXTREME': return 2;
    default: return 5;
  }
}

function generateAnalysisSummary(assessments: Record<string, any>): string {
  const tickers = Object.keys(assessments);
  if (tickers.length === 0) return 'No assessments performed';
  const riskCounts: Record<string, number> = { LOW: 0, MEDIUM: 0, HIGH: 0, EXTREME: 0 };
  for (const ticker in assessments) {
    if (Object.prototype.hasOwnProperty.call(assessments, ticker)) {
      const riskLevel = assessments[ticker].risk_level;
      if (riskLevel) riskCounts[riskLevel as keyof typeof riskCounts]!++;
    }
  }
  return `Risk distribution: ${riskCounts.LOW} Low, ${riskCounts.MEDIUM} Medium, ${riskCounts.HIGH} High, ${riskCounts.EXTREME} Extreme`;
}

function dominantRiskLevel(assessments: Record<string, RiskAssessment>): string {
  const order: Array<'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME'> = ['LOW', 'MEDIUM', 'HIGH', 'EXTREME'];
  let worst = 'LOW';
  for (const ticker of Object.keys(assessments)) {
    const lvl = assessments[ticker]?.risk_level;
    if (lvl && order.indexOf(lvl) > order.indexOf(worst as any)) worst = lvl;
  }
  return worst;
}

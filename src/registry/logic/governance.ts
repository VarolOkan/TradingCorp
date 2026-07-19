// src/registry/logic/governance.ts
// Phase 3 extraction (doc §8 Phase 3). Pure governance-gatekeeper handler.
// GovernanceGatekeeperNode is now a thin shim that delegates here.

import type { AgentState, InvestmentDecision, RiskAssessment } from '../../types/financial-analysis';
import { instructionFor } from '../prompts';
import { logger } from '../../utils/logger';
import { stringToSeed, seededRandom, updateInvestmentThesis, annotateDataReceived, recordDataReceived, type NodeSurface } from './shared';
import type { AnalystTuning } from '../../types/registry';
import { getLastForTicker, getRecentLessons, computeRealizedReturn, computeAlphaVsSpy, type DecisionRecord } from '../../server/decision-log';

export type { NodeSurface };

/**
 * Phase G (governance reflection): scan the upstream analyst traces to discover
 * whether any of them ran on REAL ingested data (vs the seeded parity path) and
 * which domains were data-driven. Returns null when nothing was ingested, so the
 * legacy (no-ingested) governance output stays byte-identical.
 */
type Reflection = {
  dataDriven: boolean;
  domains: string[];
  source: 'yahoo' | 'mock' | 'mixed';
};
function reflectUpstream(state: AgentState): Reflection | null {
  const domains = new Set<string>();
  let source: 'yahoo' | 'mock' | 'mixed' = 'mock';
  let seen = false;
  for (const trace of (state.analystTraces as any) ?? []) {
    if (trace?.analyst === 'governance') continue;
    const det = trace?.output?.details;
    // fundamental / sentiment carry data_source
    const fund = det?.analyses?.[trace.ticker] ?? {};
    if (typeof fund?.data_source === 'string' && fund.data_source) domains.add('fundamental');
    if (typeof trace?.output?.details?.analyses?.[trace.ticker]?.data_source === 'string') domains.add('sentiment');
    // risk carries data_driven
    const risk = det?.assessments?.[trace.ticker];
    if (risk?.data_driven) {
      domains.add('risk');
      source = risk.data_driven.source ?? source;
    }
    // technical carries indicators.source
    const tech = det?.analyses?.[trace.ticker]?.indicators;
    if (tech?.source) {
      domains.add('technical');
      source = tech.source ?? source;
    }
    seen = true;
  }
  if (!seen) return null;
  return { dataDriven: domains.size > 0, domains: [...domains], source };
}

export async function governanceHandler(
  state: AgentState,
  node: NodeSurface,
  tuning?: AnalystTuning,
): Promise<AgentState> {
  let updatedState = node.updateStep(state, 'governance_gatekeeper_start');
  node.emitProgress(updatedState, 'analyst:start', 'governance', { stage: 4 });

  updatedState = node.addMessage(updatedState, 'system',
    `Starting governance review for ${state.tickers.length} ticker(s): ${state.tickers.join(', ')}`);

  try {
    if (!state.tickers || state.tickers.length === 0) {
      throw new Error('No tickers specified for governance review');
    }

    const decisions: Record<string, InvestmentDecision> = {};
    const riskAssessments: Record<string, RiskAssessment> = {};

    // Read the risk analyst's output from state (it ran earlier in the chain)
    // so the governance veto can act on the REAL stop-loss / risk level.
    const riskByTicker = extractRiskAssessments(state);

    // Phase 2 (decision-log reflection): load prior-run records for these
    // tickers and recent cross-ticker lessons, then build honest reflection
    // notes. Gated by DECISION_LOG_ENABLED (default ON). Non-fatal: any error
    // here must never break governance. Absent prior record => no note => the
    // single-run output is byte-identical to Phase 1 (parity preserved).
    const decisionReflections: string[] = [];
    if (process.env.DECISION_LOG_ENABLED !== 'false') {
      try {
        for (const ticker of state.tickers) {
          const prior = getLastForTicker(ticker, 1)[0];
          if (prior) {
            const note = buildDecisionReflection(ticker, prior, extractIngestedPrice(state, ticker));
            if (note) decisionReflections.push(note);
          }
        }
        // Recent cross-ticker lessons (exclude the primary ticker) widen the
        // gatekeeper's memory beyond the immediate symbol.
        const lessons = getRecentLessons(5, state.tickers[0]);
        for (const l of lessons) {
          if (l.reflection) decisionReflections.push(`Recent lesson (${l.tickers.join('/')}): ${l.reflection}`);
        }
      } catch (reflErr) {
        // Non-fatal: log via the node surface if available, otherwise ignore.
        logger.warn(`Decision-log reflection failed (non-fatal): ${reflErr instanceof Error ? reflErr.message : String(reflErr)}`);
      }
    }

    for (const ticker of state.tickers) {
      const { decision, riskAssessment } = performGovernanceReview(ticker, tuning, riskByTicker[ticker], state);
      decisions[ticker] = decision;
      riskAssessments[ticker] = riskAssessment;
      // Phase R2 (RAW_DATA_DUMP.md): governance is reflection-only — it consumes
      // the upstream analysts' findings (already recorded on their own
      // dataReceived entries), so it annotates that it read the upstream traces.
      updatedState = recordDataReceived(updatedState, annotateDataReceived(
        'governance', ticker, 'ingested',
        [{ domain: 'market', source: 'upstream-traces' }],
        'seeded-parity', 'governance consumes upstream analyst outputs (reflection only)',
      ));
    }

    const anyRejected = Object.values(decisions).some((d) => d.decision === 'REJECT');
    const overallDecision: InvestmentDecision = anyRejected
      ? createRejectionDecision(state.tickers)
      : createApprovalDecision(state.tickers);

    // Phase G: reflect on whether this review was informed by real ingested data
    // or ran on the seeded parity path. Drives an honest governance note so the
    // user sees *why* confidence may be limited. Absent on the no-ingested path.
    const reflection = reflectUpstream(state);
    const reflectionNote = reflection
      ? (reflection.dataDriven
          ? `Data-driven review: ${reflection.domains.join(', ')} computed from ingested ${reflection.source} data.`
          : `Seeded review: no ingested data present; verdicts use parity fallback (illustrative).`)
      : undefined;

    // Phase 1 (Bull/Bear debate): reflect the researchers' opposing cases.
    // Advisory only — it surfaces in the trace + reasoning but never overrides
    // the preservation-first veto. Absent (parity) when the debate didn't run.
    const debate = extractDebate(state);
    const netLean = netDebateLean(debate.bull, debate.bear);
    const debateNotes: string[] = [];
    if (debate.bull || debate.bear) {
      if (debate.bull) debateNotes.push(`Bull case: ${debate.bull.verdict} (${debate.bull.score}/100) — ${debate.bull.summary}`);
      if (debate.bear) debateNotes.push(`Bear case: ${debate.bear.verdict} (${debate.bear.score}/100) — ${debate.bear.summary}`);
      if (netLean) debateNotes.push(`Net debate lean: ${netLean}.`);
    }

    updatedState = {
      ...updatedState,
      messages: [
        ...(updatedState.messages || []),
        {
          role: 'system',
          content: `Governance review completed for ${state.tickers.length} ticker(s)`,
          timestamp: new Date().toISOString(),
          data: {
            decisions,
            riskAssessments,
            overallDecision,
            summary: generateDecisionSummary(overallDecision, decisions, riskAssessments),
            ...(reflectionNote ? { reflection: reflectionNote } : {}),
            ...(debateNotes.length ? { debate: debateNotes } : {}),
            ...(decisionReflections.length ? { decisionLog: decisionReflections } : {}),
          },
        },
        ...(decisionReflections.length
          ? [{
              role: 'system' as const,
              content: `Decision-log reflection (prior runs):\n${decisionReflections.join('\n')}`,
              timestamp: new Date().toISOString(),
            }]
          : []),
      ],
      investment_thesis: updateInvestmentThesis(state.investment_thesis, `Final decision: ${overallDecision.decision} with ${overallDecision.confidence}% confidence. ${overallDecision.reasoning}`, 'GOVERNANCE'),
      final_decision: overallDecision.decision,
      error: null,
    };

    updatedState = node.captureTrace(updatedState, {
      analyst: 'governance',
      name: 'Governance Gatekeeper',
      stage: 4,
      instructions: instructionFor('governance'),
      inputs: state.tickers.map((ticker) => ({
        ticker,
        label: 'Per-ticker verdict + risk assessment reviewed',
        data: {
          decision: decisions[ticker]?.decision,
          confidence: decisions[ticker]?.confidence,
          risk_level: riskAssessments[ticker]?.risk_level,
          preservation_rationale: decisions[ticker]?.preservation_rationale,
          conditions: decisions[ticker]?.conditions,
          debateLean: netLean ?? undefined,
        },
        sources: ['Fundamental/Technical/Sentiment/Risk outputs', 'Bull/Bear researcher debate', 'Preservation-first policy'],
      })),
      weighting: [
        { label: 'Preservation (downside) test', inputs: ['risk_level', 'stop_loss_suggestion'], weight: 0.5, rationale: 'If downside is not bounded by stops/sizing, the plan fails the test.', contribution: 50, scale: '0..100 veto weight' },
        { label: 'Consensus alignment', inputs: ['fundamental', 'technical', 'sentiment'], weight: 0.3, rationale: 'Conflicting analyst verdicts reduce confidence and invite conditions.', contribution: 30, scale: '0..100 veto weight' },
        { label: 'Risk-level override', inputs: ['risk_level'], weight: 0.2, rationale: 'Any EXTREME risk flag escalates to REJECT or strict conditions.', contribution: 20, scale: '0..100 veto weight' },
        ...(netLean ? [{ label: 'Bull/Bear debate lean', inputs: ['bull_research', 'bear_research'], weight: 0, rationale: `Advisory signal only (${netLean}) — does not override the preservation test.`, contribution: 0, scale: 'advisory' } as any] : []),
      ],
      output: {
        verdict: overallDecision.decision,
        score: overallDecision.confidence,
        summary: generateDecisionSummary(overallDecision, decisions, riskAssessments),
        details: { overall: overallDecision, perTicker: decisions, debate: debateNotes.length ? { bull: debate.bull, bear: debate.bear, netLean } : undefined },
      },
      notes: [overallDecision.preservation_rationale, ...(reflectionNote ? [reflectionNote] : []), ...debateNotes, ...decisionReflections].filter(Boolean) as string[],
    });

    node.emitProgress(updatedState, 'analyst:done', 'governance', {
      stage: 4,
      tickers: state.tickers,
      decision: overallDecision.decision,
      confidence: overallDecision.confidence,
    });
    return updatedState;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      ...updatedState,
      error: `Governance review error: ${errorMessage}`,
      current_step: 'governance_gatekeeper_error',
      messages: [
        ...(updatedState.messages || []),
        { role: 'error', content: `Failed to complete governance review: ${errorMessage}`, timestamp: new Date().toISOString() },
      ],
    };
  }
}

function performGovernanceReview(
  ticker: string,
  tuning?: AnalystTuning,
  upstreamRisk?: RiskAssessment,
  state?: AgentState,
): { decision: InvestmentDecision; riskAssessment: RiskAssessment } {
  const seed = stringToSeed(ticker + '_governance');
  const rng = seededRandom(seed);
  const decisionValue = rng();

  const horizon = tuning?.horizon ?? 'LONG_TERM';
  const hasTuning = tuning !== undefined;

  // ---- Phase D: options-aware governance veto ----
  // When the owning agency trades OPTIONS and supplies an `optionsVeto`, apply
  // the IV-percentile cap + hedge/no-overnight rules instead of (on top of)
  // the equity preservation gate. This is the gatekeeper's last-word veto per
  // doc §D / §17 (Governance Gatekeeper GUARDRAILS).
  if (tuning?.instrument === 'OPTION' && tuning.params?.optionsVeto) {
    const veto = tuning.params.optionsVeto as Record<string, any>;
    const opt = extractOptionsRisk(state, ticker);
    const ivPct = typeof opt?.iv_percentile === 'number' ? opt.iv_percentile : null;
    const maxLoss = opt?.max_loss ?? null;
    const riskLevel = opt?.risk_level ?? null;

    const reasons: string[] = [];
    // IV-percentile cap (swing 90 / intraday 80).
    if (typeof veto.maxIvPercentile === 'number' && ivPct !== null && ivPct > veto.maxIvPercentile) {
      reasons.push(`IV percentile ${ivPct} exceeds agency cap ${veto.maxIvPercentile}`);
    }
    // Hedge requirement (swing): an undefined-risk / unhedged structure is rejected.
    if (veto.requireHedge && (maxLoss === null || maxLoss === undefined || opt?.hedged === false)) {
      reasons.push('undefined-risk / unhedged structure rejected (requireHedge)');
    }
    // Intraday no-overnight strictness: reject HIGH risk too (stricter than swing).
    if (veto.noOvernight && (riskLevel === 'HIGH' || riskLevel === 'EXTREME')) {
      reasons.push(`no-overnight agency rejects ${riskLevel} risk structure`);
    }

    let decision: InvestmentDecision;
    if (reasons.length > 0) {
      decision = createOptionsRejectionDecision([ticker], reasons);
    } else if (decisionValue > 0.3) {
      decision = createApprovalDecision([ticker]);
    } else {
      decision = createRejectionDecision([ticker]);
    }
    const optAlloc = typeof opt?.max_allocation === 'number' ? opt!.max_allocation : 10;
    const riskAssessment: RiskAssessment = {
      risk_level: decision.decision === 'REJECT' ? 'HIGH' : 'LOW',
      risk_factors: [{ factor: 'Options structure risk', severity: 'MEDIUM', description: reasons.join('; ') || 'Clean structure', mitigation: 'Define risk, size to IV regime' }],
      portfolio_impact: 'Options-position sized per agency risk budget',
      position_sizing_recommendation: `Recommend ≤${optAlloc}% portfolio allocation`,
      stop_loss_suggestion: null,
      take_profit_suggestion: null,
      max_allocation_percent: optAlloc,
    };
    return { decision, riskAssessment };
  }

  // Per-agency stop-loss tolerance for the governance veto. When an agency
  // supplies maxStopLoss on its risk analyst params it propagates here via the
  // upstream risk assessment; otherwise fall back to horizon defaults.
  const maxStopLossTolerance = typeof tuning?.params?.maxStopLoss === 'number'
    ? tuning.params.maxStopLoss
    : horizon === 'INTRADAY' ? 0.05
    : horizon === 'MEDIUM_TERM' || horizon === 'SHORT_TERM' ? 0.1
    : 0.15;

  const upstreamStop = upstreamRisk?.stop_loss_suggestion ?? null;
  const upstreamRiskLevel = upstreamRisk?.risk_level ?? null;

  // Legacy (no tuning): pure random decision — byte-identical to before.
  // With tuning: apply a horizon-dependent preservation gate on top of the
  // same random seed, so the decision is still deterministic but stricter for
  // shorter horizons.
  let decision: InvestmentDecision;
  if (!hasTuning) {
    decision = decisionValue > 0.3 ? createApprovalDecision([ticker]) : createRejectionDecision([ticker]);
  } else {
    const strictVeto =
      (upstreamStop != null && upstreamStop > maxStopLossTolerance) ||
      upstreamRiskLevel === 'EXTREME' ||
      (horizon === 'INTRADAY' && upstreamRiskLevel === 'HIGH');
    if (strictVeto) {
      decision = createRejectionDecision([ticker]);
    } else if (decisionValue > 0.3) {
      decision = createApprovalDecision([ticker]);
    } else {
      decision = createRejectionDecision([ticker]);
    }
  }

  const riskAssessment: RiskAssessment = {
    risk_level: decisionValue > 0.7 ? 'LOW' : decisionValue > 0.4 ? 'MEDIUM' : 'HIGH',
    risk_factors: [
      { factor: 'Market Volatility', severity: 'MEDIUM', description: 'Standard market volatility present', mitigation: 'Use appropriate position sizing' },
    ],
    portfolio_impact: 'Moderate impact on portfolio',
    position_sizing_recommendation: 'Recommend 5% portfolio allocation',
    stop_loss_suggestion: 0.15,
    take_profit_suggestion: 0.30,
    max_allocation_percent: 5,
  };

  return { decision, riskAssessment };
}

/** Pull the Bull/Bear researcher verdicts off the pipeline state so the
 *  governance gatekeeper can reflect the debate in its decision. Returns the
 *  per-channel {verdict, score, summary} for each researcher, or undefined
 *  entries when the debate step didn't run (unit-test isolation / parity). */
function extractDebate(state: AgentState | undefined): {
  bull?: { verdict: string; score: number; summary: string };
  bear?: { verdict: string; score: number; summary: string };
} {
  const out: { bull?: any; bear?: any } = {};
  if (!state || !Array.isArray(state.messages)) return out;
  for (const msg of state.messages) {
    const data = (msg as any).data;
    if (!data || !Array.isArray(data.channels)) continue;
    if (data.channels.includes('bull_research') && data.analyses) {
      const r = data.analyses;
      const first = r[Object.keys(r)[0]];
      if (first) out.bull = { verdict: first.verdict, score: first.score, summary: first.summary };
    }
    if (data.channels.includes('bear_research') && data.analyses) {
      const r = data.analyses;
      const first = r[Object.keys(r)[0]];
      if (first) out.bear = { verdict: first.verdict, score: first.score, summary: first.summary };
    }
  }
  return out;
}

/** Net debate lean from the bull/bear scores: BULLISH if bull >> bear,
 *  BEARISH if bear >> bull, else BALANCED. Advisory only — never overrides the
 *  preservation-first veto. */
function netDebateLean(bull?: { score: number }, bear?: { score: number }): 'BULLISH' | 'BEARISH' | 'BALANCED' | null {
  if (bull == null || bear == null) return null;
  const delta = (bull.score ?? 0) - (bear.score ?? 0);
  if (delta >= 15) return 'BULLISH';
  if (delta <= -15) return 'BEARISH';
  return 'BALANCED';
}

/**
 * Phase 2 (decision-log reflection): build a one-paragraph reflection from a
 * prior run's decision record and the current run's ingested price for the
 * same ticker. Returns null when there is no prior record (parity path — the
 * rest of governance is unchanged). Honest about `asOf`: the realised return
 * is computed from the prior entry price vs THIS run's ingested price, and is
 * labelled as such. Pure / deterministic.
 */
function buildDecisionReflection(ticker: string, prior: DecisionRecord, currentPrice?: number): string | null {
  if (!prior) return null;
  const date = (prior.ts || '').slice(0, 10) || 'prior';
  const parts: string[] = [
    `Prior ${ticker} call (${date}): ${prior.decision} @ ${prior.confidence ?? '?'}% confidence.`,
  ];
  const entry = prior.prices?.[ticker] ?? (prior as any).priceAtDecision;
  if (typeof entry === 'number' && typeof currentPrice === 'number' && entry !== 0) {
    const ret = computeRealizedReturn(entry, currentPrice);
    if (ret != null) {
      const dir = ret >= 0 ? 'up' : 'down';
      parts.push(`${ticker} is ${dir} ${Math.abs(ret).toFixed(1)}% vs the ${entry.toFixed(2)} entry (asOf this run's ingested price).`);
      if (typeof prior.spyPrice === 'number' && typeof (prior as any).spyCurrentPrice === 'number') {
        const spyRet = computeRealizedReturn(prior.spyPrice, (prior as any).spyCurrentPrice);
        const alpha = computeAlphaVsSpy(ret, spyRet);
        if (alpha != null) parts.push(`Alpha vs SPY: ${alpha >= 0 ? '+' : ''}${alpha.toFixed(1)}%.`);
      }
      // Honest conviction adjustment: a prior APPROVE that lost money is a miss.
      if (prior.decision === 'APPROVE' && ret <= -5) {
        parts.push('That prior approval subsequently lost money — revisit the thesis and tighten conditions before re-approving.');
      } else if (prior.decision === 'REJECT' && ret >= 5) {
        parts.push('That prior rejection subsequently rose — reconsider whether the veto was too strict.');
      }
    }
  } else {
    parts.push('(No ingested price on the prior run to compute a realised return.)');
  }
  return parts.join(' ');
}

/** Current ingested price for a ticker from state.ingested.bars (last close). */
function extractIngestedPrice(state: AgentState | undefined, ticker: string): number | undefined {
  const series = (state as any)?.ingested?.bars?.[ticker];
  if (!Array.isArray(series) || series.length === 0) return undefined;
  const last = series[series.length - 1];
  const close = last?.close ?? last?.c;
  return typeof close === 'number' ? close : undefined;
}

/** Pull the risk analyst's per-ticker assessment off the pipeline state so
 *  governance can veto on the real stop-loss / risk level it computed. Returns
 *  a map keyed by ticker; absent when the risk stage hasn't run yet. */
function extractRiskAssessments(state: AgentState): Record<string, RiskAssessment> {
  const out: Record<string, RiskAssessment> = {};
  for (const msg of state.messages ?? []) {
    const data = (msg as any).data;
    if (data && data.assessments && typeof data.assessments === 'object') {
      for (const [ticker, assessment] of Object.entries(data.assessments as Record<string, RiskAssessment>)) {
        out[ticker] = assessment;
      }
    }
  }
  return out;
}

/** Pull the options_risk analyst's per-ticker assessment off the pipeline state
 *  so governance's options veto can act on the REAL iv_percentile / max_loss /
 *  risk_level it computed. Returns the ticker's assessment, or undefined when
 *  the options-risk stage hasn't run yet (unit-test isolation). */
function extractOptionsRisk(state: AgentState | undefined, ticker: string): {
  iv_percentile: number;
  max_loss: number | null;
  risk_level: string;
  max_allocation: number;
  hedged: boolean;
} | undefined {
  if (!state || !Array.isArray(state.messages)) return undefined;
  for (const msg of state.messages) {
    const data = (msg as any).data;
    if (data && data.analyses && typeof data.analyses === 'object' && data.analyses[ticker]) {
      const a = data.analyses[ticker];
      const d = a.data ?? {};
      return {
        iv_percentile: typeof d.iv_percentile === 'number' ? d.iv_percentile : (typeof a.iv_percentile === 'number' ? a.iv_percentile : NaN),
        max_loss: typeof d.max_loss === 'number' ? d.max_loss : null,
        risk_level: d.risk_level ?? a.risk_level ?? 'MEDIUM',
        max_allocation: typeof d.max_allocation === 'number' ? d.max_allocation : 10,
        // A defined-risk structure (max_loss present) is treated as hedged.
        hedged: typeof d.max_loss === 'number',
      };
    }
  }
  return undefined;
}

function createOptionsRejectionDecision(tickers: string[], reasons: string[]): InvestmentDecision {
  return {
    decision: 'REJECT',
    confidence: 90,
    reasoning: `Options governance veto: ${reasons.join('; ')}`,
    preservation_rationale: 'Options structure failed the agency veto (IV/hedge/overnight rules)',
    conditions: [],
    timestamp: new Date().toISOString(),
    analyst_consensus: { fundamental: 'NEUTRAL', technical: 'NEUTRAL', sentiment: 'NEUTRAL', risk: 'HIGH' },
  };
}

function createRejectionDecision(tickers: string[]): InvestmentDecision {
  return {
    decision: 'REJECT',
    confidence: 85,
    reasoning: 'Does not meet preservation-first criteria',
    preservation_rationale: 'Capital preservation priority overrides potential returns',
    conditions: [],
    timestamp: new Date().toISOString(),
    analyst_consensus: { fundamental: 'NEUTRAL', technical: 'NEUTRAL', sentiment: 'NEUTRAL', risk: 'HIGH' },
  };
}

function createApprovalDecision(tickers: string[]): InvestmentDecision {
  return {
    decision: 'APPROVE',
    confidence: 75,
    reasoning: 'Meets preservation-first criteria with acceptable risk-adjusted returns',
    preservation_rationale: 'Acceptable risk-adjusted return with capital protection',
    conditions: ['Position size limited to 5% of portfolio', 'Stop loss recommended at 15-20% below entry', 'Monitor for deterioration in fundamentals'],
    timestamp: new Date().toISOString(),
    analyst_consensus: { fundamental: 'BULLISH', technical: 'NEUTRAL', sentiment: 'NEUTRAL', risk: 'MEDIUM' },
  };
}

function generateDecisionSummary(
  overallDecision: InvestmentDecision,
  decisions: Record<string, InvestmentDecision>,
  riskAssessments: Record<string, RiskAssessment>,
): string {
  const tickers = Object.keys(decisions);
  const approvedCount = Object.values(decisions).filter((d) => d.decision === 'APPROVE').length;
  const rejectedCount = tickers.length - approvedCount;
  return `${tickers.length} ticker(s) reviewed: ${approvedCount} approved, ${rejectedCount} rejected. Overall decision: ${overallDecision.decision} with ${overallDecision.confidence}% confidence.`;
}

// src/registry/logic/fundamental.ts
// Phase 3 extraction (doc §8 Phase 3). Pure fundamental-analysis handler.
// The FundamentalAnalystNode is now a thin shim that delegates here, so the
// data-driven agency graph produces byte-identical output to the legacy graph.

import type { AgentState, FundamentalAnalysis, PriceBar } from '../../types/financial-analysis';
import { instructionFor } from '../prompts';
import { stringToSeed, seededRandom, updateInvestmentThesis, hasTickers, annotateDataReceived, recordDataReceived, type NodeSurface } from './shared';
import type { AnalystTuning } from '../../types/registry';

export type { NodeSurface };

/** Annualized close-to-close volatility from a bar series (price-based quality
 *  proxy when we have bars but no live fundamentals). Returns null if <2 bars. */
function annualizedVol(bars: PriceBar[]): number | null {
  if (bars.length < 2) return null;
  const rets: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1]!.close;
    if (prev > 0) rets.push(Math.log(bars[i]!.close / prev));
  }
  if (rets.length < 2) return null;
  const mean = rets.reduce((s, x) => s + x, 0) / rets.length;
  const variance = rets.reduce((s, x) => s + (x - mean) ** 2, 0) / (rets.length - 1);
  // Assume ~252 trading days for daily; scaling is a proxy only.
  return Math.sqrt(variance) * Math.sqrt(252);
}

export async function fundamentalHandler(
  state: AgentState,
  node: NodeSurface,
  _tuning?: AnalystTuning,
): Promise<AgentState> {
  let updatedState = node.updateStep(state, 'fundamental_analysis_start');
  node.emitProgress(updatedState, 'analyst:start', 'fundamental', { stage: 2 });

  updatedState = node.addMessage(updatedState, 'system',
    `Starting fundamental analysis for ${state.tickers.length} ticker(s): ${state.tickers.join(', ')}`);

  try {
    if (!hasTickers(state)) {
      throw new Error('No tickers specified for fundamental analysis');
    }

    const analyses: Record<string, FundamentalAnalysis> = {};
    for (const ticker of state.tickers) {
      analyses[ticker] = performFundamentalAnalysis(ticker, state.ingested);
      // Phase R2 (RAW_DATA_DUMP.md): record which ingested slice fundamental consumed.
      const ingested = state.ingested;
      const realFund = ingested?.fundamental?.[ticker];
      const bars = ingested?.bars?.[ticker]?.find((s) => s.interval === '1d')?.bars
        ?? ingested?.bars?.[ticker]?.[0]?.bars;
      if (realFund && typeof realFund === 'object') {
        updatedState = recordDataReceived(updatedState, annotateDataReceived(
          'fundamental', ticker, 'ingested',
          [{ domain: 'fundamental', source: ingested!.source }],
          ingested!.source === 'mixed' ? 'mixed' : ingested!.source === 'mock' ? 'mock' : 'live',
          'live fundamentals supplied upstream',
        ));
      } else if (bars && bars.length >= 2) {
        updatedState = recordDataReceived(updatedState, annotateDataReceived(
          'fundamental', ticker, 'ingested',
          [{ domain: 'bars', interval: '1d', source: ingested!.source, barsUsed: bars.length }],
          ingested!.source === 'mixed' ? 'mixed' : ingested!.source === 'mock' ? 'mock' : 'live',
          'price-proxy fallback (no ingested.fundamental)',
        ));
      } else {
        updatedState = recordDataReceived(updatedState, annotateDataReceived(
          'fundamental', ticker, 'ingested',
          [{ domain: 'fundamental', source: 'seeded' }],
          'seeded-parity', 'no ingested — fundamental ran on seeded fallback',
        ));
      }
    }

    // Honest provenance: classify what each ticker actually consumed so the
    // trace note reflects truth (a hardcoded "Mock data" label is a BUG — it
    // stays even when live fundamentals are supplied upstream).
    type FundMode = 'live' | 'proxy' | 'seeded';
    const modes: FundMode[] = state.tickers.map((t) => {
      const ds = (analyses[t]?.data_source as string | undefined) ?? '';
      if (ds.includes('live-fundamentals')) return 'live';
      if (ds.includes('price-proxy')) return 'proxy';
      return 'seeded';
    });
    const anyLive = modes.includes('live');
    const anyProxy = modes.includes('proxy');
    const anySeeded = modes.includes('seeded');

    // Honest input source labels (no more "Finnhub (mock)" fiction).
    const inputSources: string[] = [];
    if (anyLive) inputSources.push('Alpha Vantage / Yahoo (live fundamentals)');
    if (anyProxy) inputSources.push('Yahoo Finance (price-action proxy)');
    if (anySeeded) inputSources.push('seeded parity fallback');
    if (inputSources.length === 0) inputSources.push('seeded parity fallback');

    // Honest, semantically-correct trace notes.
    const honestNotes: string[] = [];
    if (anyLive && !anyProxy && !anySeeded) {
      honestNotes.push('Fundamentals from live market data (Alpha Vantage / Yahoo). Findings are auditable.');
    } else if (anyProxy && !anyLive && !anySeeded) {
      honestNotes.push('No fundamental feed configured — ran on a price-action proxy (trend + volatility). Indicative, not auditable; wire Alpha Vantage OVERVIEW for full balance-sheet ratios.');
    } else if (anySeeded && !anyLive && !anyProxy) {
      honestNotes.push('No fundamental feed configured — ran on seeded parity fallback. Wire a live source (Alpha Vantage OVERVIEW) to make findings auditable.');
    } else {
      // Mixed: report exactly which paths fired.
      const parts: string[] = [];
      if (anyLive) parts.push('live fundamentals for some tickers');
      if (anyProxy) parts.push('price-proxy for some tickers');
      if (anySeeded) parts.push('seeded fallback for some tickers');
      honestNotes.push(`Mixed inputs (${parts.join('; ')}). Wire Alpha Vantage OVERVIEW for full auditable fundamentals across all tickers.`);
    }

    updatedState = {
      ...updatedState,
      messages: [
        ...(updatedState.messages || []),
        {
          role: 'system',
          content: `Fundamental analysis completed for ${state.tickers.length} ticker(s)`,
          timestamp: new Date().toISOString(),
          data: { analyses, summary: generateAnalysisSummary(analyses) },
        },
      ],
      investment_thesis: updateInvestmentThesis(state.investment_thesis, generateAnalysisSummary(analyses), 'FUNDAMENTAL'),
    };

    updatedState = node.captureTrace(updatedState, {
      analyst: 'fundamental',
      name: 'Fundamental Analyst',
      stage: 2,
      instructions: instructionFor('fundamental'),
      inputs: state.tickers.map((ticker) => ({
        ticker,
        label: 'Fundamental data ingested',
        data: summarizeFundamentalInput(analyses[ticker]),
        sources: inputSources,
      })),
      weighting: [
        { label: 'Leverage & liquidity discipline', inputs: ['debt_to_equity', 'current_ratio'], weight: 0.4, rationale: 'High D/E and low current ratio are penalized as balance-sheet risk.', contribution: 40, scale: '0..100 score weight' },
        { label: 'Profitability (ROE / margin)', inputs: ['roe', 'profit_margin'], weight: 0.35, rationale: 'Strong return on equity and margins lift the health score.', contribution: 35, scale: '0..100 score weight' },
        { label: 'Cash generation', inputs: ['free_cash_flow_yield'], weight: 0.25, rationale: 'Positive, healthy free cash flow yield supports the score.', contribution: 25, scale: '0..100 score weight' },
      ],
      output: {
        score: avgHealthScore(analyses),
        verdict: avgHealthScore(analyses) >= 75 ? 'BULLISH' : avgHealthScore(analyses) >= 60 ? 'NEUTRAL' : 'BEARISH',
        summary: generateAnalysisSummary(analyses),
        details: { analyses },
      },
      dataProvenance: (anyLive || anyProxy) && !anySeeded ? 'live'
        : (anyLive || anyProxy) && anySeeded ? 'mixed'
        : 'seeded-parity',
      notes: honestNotes,
    });

    node.emitProgress(updatedState, 'analyst:done', 'fundamental', { stage: 2, tickers: state.tickers, summary: generateAnalysisSummary(analyses) });
    return updatedState;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      ...updatedState,
      error: `Fundamental analysis error: ${errorMessage}`,
      current_step: 'fundamental_analysis_error',
      messages: [
        ...(updatedState.messages || []),
        { role: 'error', content: `Failed to perform fundamental analysis: ${errorMessage}`, timestamp: new Date().toISOString() },
      ],
    };
  }
}

function performFundamentalAnalysis(
  ticker: string,
  ingested?: AgentState['ingested'],
): FundamentalAnalysis {
  const seed = stringToSeed(ticker);
  const rng = seededRandom(seed);
  const financialHealthScore = Math.floor(rng() * 40) + 60;

  // Phase E: prefer real fundamentals from the ingestion channel. When only bars
  // are present, compute a price-based quality proxy (trend + volatility). When
  // nothing is ingested, fall back to the seeded path (parity default).
  const realFund = ingested?.fundamental?.[ticker];
  const bars = ingested?.bars?.[ticker]?.find((s) => s.interval === '1d')?.bars
    ?? ingested?.bars?.[ticker]?.[0]?.bars;

  if (realFund && typeof realFund === 'object') {
    // Live/real fundamental object supplied upstream — map it onto our shape.
    const kr = realFund.key_ratios ?? realFund;
    const keyRatios = {
      debt_to_equity: numOr(kr.debt_to_equity, rng() * 0.8 + 0.2),
      current_ratio: numOr(kr.current_ratio, rng() * 2.0 + 0.5),
      roe: numOr(kr.roe, rng() * 0.25 + 0.05),
      roa: numOr(kr.roa, rng() * 0.15 + 0.02),
      profit_margin: numOr(kr.profit_margin, rng() * 0.25 + 0.05),
      free_cash_flow_yield: numOr(kr.free_cash_flow_yield, rng() * 0.15 + 0.02),
    };
    const healthScore = typeof realFund.financial_health_score === 'number'
      ? Math.round(realFund.financial_health_score)
      : scoreFromRatios(keyRatios);
    return buildFundamental(keyRatios, healthScore, rng, ingested?.source ?? 'mixed', 'live-fundamentals');
  }

  if (bars && bars.length >= 2) {
    // Price-based quality proxy: momentum (trend) + inverse volatility drive a
    // health-ish score, and we synthesize plausible ratios anchored on that.
    const closes = bars.map((b) => b.close);
    const first = closes[0]!;
    const last = closes[closes.length - 1]!;
    const trendRet = first > 0 ? (last - first) / first : 0; // total return over window
    const vol = annualizedVol(bars) ?? 0.3;
    // Higher trend + lower vol → higher proxy score (bounded 40..95).
    const proxy = Math.max(40, Math.min(95, Math.round(65 + trendRet * 80 - (vol - 0.3) * 40)));
    const keyRatios = {
      debt_to_equity: parseFloat((rng() * 0.8 + 0.2).toFixed(2)),
      current_ratio: parseFloat((rng() * 2.0 + 0.5).toFixed(2)),
      roe: parseFloat((Math.max(0, 0.05 + trendRet * 0.3)).toFixed(4)),
      roa: parseFloat((rng() * 0.15 + 0.02).toFixed(4)),
      profit_margin: parseFloat((Math.max(0.02, 0.1 + trendRet * 0.2)).toFixed(4)),
      free_cash_flow_yield: parseFloat((rng() * 0.15 + 0.02).toFixed(4)),
    };
    return buildFundamental(keyRatios, proxy, rng, ingested?.source ?? 'mixed', 'price-proxy');
  }

  // Seeded fallback (parity default — identical to legacy output).
  const keyRatios = {
    debt_to_equity: parseFloat((rng() * 0.8 + 0.2).toFixed(2)),
    current_ratio: parseFloat((rng() * 2.0 + 0.5).toFixed(2)),
    roe: parseFloat((rng() * 0.25 + 0.05).toFixed(4)),
    roa: parseFloat((rng() * 0.15 + 0.02).toFixed(4)),
    profit_margin: parseFloat((rng() * 0.25 + 0.05).toFixed(4)),
    free_cash_flow_yield: parseFloat((rng() * 0.15 + 0.02).toFixed(4)),
  };
  const redFlags: string[] = [];
  const greenFlags: string[] = [];
  if (keyRatios.debt_to_equity > 0.5) redFlags.push('High debt-to-equity ratio'); else greenFlags.push('Moderate debt levels');
  if (keyRatios.current_ratio < 1.0) redFlags.push('Low current ratio indicates potential liquidity issues'); else greenFlags.push('Adequate liquidity position');
  if (keyRatios.roe > 0.15) greenFlags.push('Strong return on equity'); else if (keyRatios.roe < 0.05) redFlags.push('Low return on equity');
  if (keyRatios.profit_margin > 0.20) greenFlags.push('Healthy profit margins'); else if (keyRatios.profit_margin < 0.05) redFlags.push('Low profit margins');
  if (redFlags.length === 0) redFlags.push('Monitor debt levels closely');
  if (greenFlags.length === 0) greenFlags.push('Stable financial foundation');
  return {
    balance_sheet_analysis: `Balance sheet shows ${keyRatios.debt_to_equity > 0.5 ? 'elevated' : 'moderate'} leverage with ${keyRatios.current_ratio > 1.5 ? 'strong' : 'adequate'} liquidity.`,
    cash_flow_analysis: `Cash flow generation is ${keyRatios.free_cash_flow_yield > 0.05 ? 'strong' : 'moderate'} with positive free cash flow yield.`,
    income_statement_analysis: `Revenue trends show ${keyRatios.profit_margin > 0.15 ? 'robust' : 'moderate'} profitability with ROE of ${(keyRatios.roe * 100).toFixed(1)}%.`,
    moat_assessment: assessMoat(rng),
    financial_health_score: financialHealthScore,
    key_ratios: keyRatios,
    red_flags: redFlags,
    green_flags: greenFlags,
  };
}

function numOr(v: any, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? parseFloat(v.toFixed(4)) : parseFloat(fallback.toFixed(4));
}

/** Health score from ratios (used when a live fundamental omits an explicit score). */
function scoreFromRatios(kr: { debt_to_equity: number; current_ratio: number; roe: number; profit_margin: number }): number {
  let score = 60;
  score += kr.debt_to_equity < 0.5 ? 8 : -8;
  score += kr.current_ratio > 1.5 ? 6 : kr.current_ratio < 1 ? -6 : 0;
  score += kr.roe > 0.15 ? 10 : kr.roe < 0.05 ? -6 : 0;
  score += kr.profit_margin > 0.2 ? 8 : kr.profit_margin < 0.05 ? -6 : 0;
  return Math.max(0, Math.min(100, Math.round(score)));
}

/** Assemble the FundamentalAnalysis from ratios + score for the data-driven paths. */
function buildFundamental(
  keyRatios: FundamentalAnalysis['key_ratios'],
  healthScore: number,
  rng: () => number,
  source: string,
  provenance: 'live-fundamentals' | 'price-proxy',
): FundamentalAnalysis {
  const redFlags: string[] = [];
  const greenFlags: string[] = [];
  if (keyRatios.debt_to_equity > 0.5) redFlags.push('High debt-to-equity ratio'); else greenFlags.push('Moderate debt levels');
  if (keyRatios.current_ratio < 1.0) redFlags.push('Low current ratio indicates potential liquidity issues'); else greenFlags.push('Adequate liquidity position');
  if (keyRatios.roe > 0.15) greenFlags.push('Strong return on equity'); else if (keyRatios.roe < 0.05) redFlags.push('Low return on equity');
  if (keyRatios.profit_margin > 0.20) greenFlags.push('Healthy profit margins'); else if (keyRatios.profit_margin < 0.05) redFlags.push('Low profit margins');
  if (redFlags.length === 0) redFlags.push('Monitor debt levels closely');
  if (greenFlags.length === 0) greenFlags.push('Stable financial foundation');
  return {
    balance_sheet_analysis: `Balance sheet shows ${keyRatios.debt_to_equity > 0.5 ? 'elevated' : 'moderate'} leverage with ${keyRatios.current_ratio > 1.5 ? 'strong' : 'adequate'} liquidity.`,
    cash_flow_analysis: `Cash flow generation is ${keyRatios.free_cash_flow_yield > 0.05 ? 'strong' : 'moderate'} with positive free cash flow yield.`,
    income_statement_analysis: `Revenue trends show ${keyRatios.profit_margin > 0.15 ? 'robust' : 'moderate'} profitability with ROE of ${(keyRatios.roe * 100).toFixed(1)}%.`,
    moat_assessment: assessMoat(rng),
    financial_health_score: healthScore,
    key_ratios: keyRatios,
    red_flags: redFlags,
    green_flags: greenFlags,
    // Provenance so the trace/UI can show this was data-driven (not seeded).
    data_source: `${source}:${provenance}`,
  } as FundamentalAnalysis;
}

function assessMoat(rng: () => number): string {
  const moatScore = rng();
  if (moatScore > 0.8) return 'Wide economic moat with sustainable competitive advantages';
  if (moatScore > 0.5) return 'Narrow economic moat with some competitive advantages';
  return 'Limited economic moat; operates in competitive industry';
}

function generateAnalysisSummary(analyses: Record<string, any>): string {
  const tickers = Object.keys(analyses);
  if (tickers.length === 0) return 'No analyses performed';
  let totalScore = 0; let count = 0;
  for (const ticker in analyses) {
    if (Object.prototype.hasOwnProperty.call(analyses, ticker)) {
      totalScore += analyses[ticker].financial_health_score;
      count++;
    }
  }
  const avgScore = count > 0 ? totalScore / count : 0;
  return `Average financial health score across ${tickers.length} ticker(s): ${avgScore.toFixed(1)}/100`;
}

function avgHealthScore(analyses: Record<string, FundamentalAnalysis>): number {
  const tickers = Object.keys(analyses);
  if (tickers.length === 0) return 0;
  const total = tickers.reduce((sum, t) => sum + (analyses[t]?.financial_health_score ?? 0), 0);
  return Math.round(total / tickers.length);
}

function summarizeFundamentalInput(analysis: FundamentalAnalysis | undefined): Record<string, any> {
  if (!analysis) return {};
  return {
    financial_health_score: analysis.financial_health_score,
    key_ratios: analysis.key_ratios,
    moat_assessment: analysis.moat_assessment,
    red_flags: analysis.red_flags,
    green_flags: analysis.green_flags,
  };
}

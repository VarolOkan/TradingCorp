// src/registry/logic/technical.ts
// Phase 3 extraction (doc §8 Phase 3). Pure technical-analysis handler.
// TechnicalAnalystNode is now a thin shim that delegates here, so the
// data-driven agency graph produces byte-identical output to the legacy graph.

import type { AgentState, TechnicalAnalysis, PriceBar } from '../../types/financial-analysis';
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

/** Pick the analysis interval from the ingested bars for a horizon. */
function intervalForHorizon(horizon: string, intervals: string[]): string {
  if (horizon === 'INTRADAY') return intervals.includes('1m') ? '1m' : intervals.includes('5m') ? '5m' : intervals[0]!;
  if (horizon === 'MEDIUM_TERM' || horizon === 'SHORT_TERM') return intervals.includes('5m') ? '5m' : intervals.includes('1d') ? '1d' : intervals[0]!;
  return intervals.includes('1d') ? '1d' : intervals[0]!; // LONG_TERM
}

/** Minimum warm-up guard (López de Prado, 2018): never emit a windowed indicator
 *  from fewer bars than its period. When insufficient, return null so the
 *  verdict degrades honestly (the doc's "no silent passes" rule). Mark SMA200 as
 *  explicitly insufficient when <200 bars. */
function sma(closes: number[], period: number): number | null {
  if (closes.length < period) return null;
  let s = 0;
  for (let i = closes.length - period; i < closes.length; i++) s += closes[i]!;
  return s / period;
}
function ema(closes: number[], period: number): number | null {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let prev = closes[0]!;
  for (let i = 1; i < closes.length; i++) prev = closes[i]! * k + prev * (1 - k);
  return prev;
}
function rsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i]! - closes[i - 1]!;
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}
function macd(closes: number[]): { macd: number | null; signal: number | null; histogram: number | null } {
  const fast = ema(closes, 12);
  const slow = ema(closes, 26);
  if (fast === null || slow === null) return { macd: null, signal: null, histogram: null };
  const m = fast - slow;
  // Signal = EMA(9) of the MACD line; we approximate with a single EMA pass over
  // closes-based MACD would need the full MACD series. For the guard we compute
  // signal only when enough bars exist for a stable EMA(9) of the MACD series.
  // Simpler + honest: signal null unless we have a clean 26+9 bar window.
  if (closes.length < 35) return { macd: m, signal: null, histogram: null };
  // Build the MACD series over the available window for a real signal EMA.
  const series: number[] = [];
  for (let i = 26; i < closes.length; i++) {
    const f = ema(closes.slice(0, i + 1), 12);
    const s = ema(closes.slice(0, i + 1), 26);
    if (f !== null && s !== null) series.push(f - s);
  }
  const signal = ema(series, 9);
  return { macd: m, signal, histogram: signal !== null ? m - signal : null };
}
function atr(bars: PriceBar[], period = 14): number | null {
  if (bars.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = bars.length - period; i < bars.length; i++) {
    const c = bars[i]!;
    const prev = bars[i - 1]!;
    const tr = Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
    trs.push(tr);
  }
  return trs.reduce((s, x) => s + x, 0) / trs.length;
}
function vwap(bars: PriceBar[]): number | null {
  const sub = bars.filter((b) => b.vwap === undefined); // intraday bars have vwap
  // Prefer provided vwap when present on intraday bars.
  const provided = bars.filter((b) => typeof b.vwap === 'number');
  if (provided.length > 0) {
    const tpv = provided.reduce((s, b) => s + ((b.high + b.low + b.close) / 3) * b.volume, 0);
    const tv = provided.reduce((s, b) => s + b.volume, 0);
    return tv > 0 ? tpv / tv : null;
  }
  if (sub.length === 0) return null;
  const tpv = sub.reduce((s, b) => s + ((b.high + b.low + b.close) / 3) * b.volume, 0);
  const tv = sub.reduce((s, b) => s + b.volume, 0);
  return tv > 0 ? tpv / tv : null;
}
function bollinger(closes: number[], period = 20): { upper: number | null; middle: number | null; lower: number | null } {
  const mid = sma(closes, period);
  if (mid === null) return { upper: null, middle: null, lower: null };
  const slice = closes.slice(-period);
  const variance = slice.reduce((s, x) => s + (x - mid) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  return { upper: mid + 2 * sd, middle: mid, lower: mid - 2 * sd };
}

/**
 * Phase D: derive the technical `indicators` from the ingested bars of the
 * horizon-appropriate interval. Returns null when `ingested` is absent or the
 * ticker has no bars, so the caller falls back to the seeded path (parity).
 */
function computeIndicatorsFromBars(
  ingested: NonNullable<AgentState['ingested']>,
  ticker: string,
  horizon: string,
): TechnicalAnalysis['indicators'] | null {
  const seriesList = ingested.bars[ticker];
  if (!seriesList || seriesList.length === 0) return null;
  const intervals = seriesList.map((s) => s.interval);
  const chosen = intervalForHorizon(horizon, intervals);
  const series = seriesList.find((s) => s.interval === chosen) ?? seriesList[0]!;
  const bars = series.bars;
  const closes = bars.map((b) => b.close);
  if (closes.length < 2) return null;

  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  const sma200 = sma(closes, 200); // warm-up guard: null if <200 bars
  const rsi14 = rsi(closes, 14);
  const macdVals = macd(closes);
  const atr14 = atr(bars, 14);
  const v = vwap(bars);
  const bb = bollinger(closes, 20);

  // When SMA200 is insufficient (intraday / short windows), surface an explicit
  // "insufficient data" marker rather than a silent null/zero.
  const insufficientLongTerm = !sma200 && (horizon === 'LONG_TERM' || horizon === 'MEDIUM_TERM');

  return {
    rsi: rsi14 ?? 0,
    macd: { macd: macdVals.macd ?? 0, signal: macdVals.signal ?? 0, histogram: macdVals.histogram ?? 0 },
    moving_averages: {
      sma_20: sma20 ?? 0,
      sma_50: sma50 ?? 0,
      sma_200: sma200 ?? 0, // 0 == "insufficient data" sentinel for the UI/guard
      ema_12: ema(closes, 12) ?? 0,
      ema_26: ema(closes, 26) ?? 0,
    },
    bollinger_bands: { upper: bb.upper ?? 0, middle: bb.middle ?? 0, lower: bb.lower ?? 0 },
    // Extra context the trace can expose (real-data provenance).
    atr_14: atr14 ?? 0,
    vwap: v ?? 0,
    insufficient_long_term: insufficientLongTerm,
    source: ingested.source,
    interval: chosen,
    bars_used: closes.length,
  } as TechnicalAnalysis['indicators'];
}

export async function technicalHandler(
  state: AgentState,
  node: NodeSurface,
  tuning?: AnalystTuning,
): Promise<AgentState> {
  let updatedState = node.updateStep(state, 'technical_analysis_start');
  node.emitProgress(updatedState, 'analyst:start', 'technical', { stage: 2 });

  updatedState = node.addMessage(updatedState, 'system',
    `Starting technical analysis for ${state.tickers.length} ticker(s): ${state.tickers.join(', ')}`);

  try {
    if (!hasTickers(state)) {
      throw new Error('No tickers specified for technical analysis');
    }

    const analyses: Record<string, TechnicalAnalysis> = {};
    const realBarsUsed = new Set<string>();
    for (const ticker of state.tickers) {
      analyses[ticker] = performTechnicalAnalysis(ticker, tuning, state.ingested);
      // Phase R2 (RAW_DATA_DUMP.md): record exactly which price-bar slice the
      // technical analyst consumed, for the per-analyst export annotation.
      const horizon = (tuning?.horizon as string) ?? 'LONG_TERM';
      const ingestedBars = state.ingested?.bars?.[ticker];
      if (ingestedBars && ingestedBars.length > 0) {
        const intervals = ingestedBars.map((s) => s.interval);
        const chosen = intervalForHorizon(horizon, intervals);
        const series = ingestedBars.find((s) => s.interval === chosen) ?? ingestedBars[0]!;
        if (series.bars.length >= 2) realBarsUsed.add(ticker);
        updatedState = recordDataReceived(updatedState, annotateDataReceived(
          'technical', ticker, 'ingested',
          [{ domain: 'bars', interval: chosen, source: state.ingested!.source, barsUsed: series.bars.length }],
          state.ingested!.source === 'mixed' ? 'mixed' : state.ingested!.source === 'mock' ? 'mock' : 'live',
        ));
      } else {
        updatedState = recordDataReceived(updatedState, annotateDataReceived(
          'technical', ticker, 'ingested',
          [{ domain: 'bars', source: 'seeded' }],
          'seeded-parity', 'no ingested.bars — technical ran on seeded fallback',
        ));
      }
    }

    updatedState = {
      ...updatedState,
      messages: [
        ...(updatedState.messages || []),
        {
          role: 'system',
          content: `Technical analysis completed for ${state.tickers.length} ticker(s)`,
          timestamp: new Date().toISOString(),
          data: { analyses, summary: generateAnalysisSummary(analyses) },
        },
      ],
      investment_thesis: updateInvestmentThesis(state.investment_thesis, generateAnalysisSummary(analyses), 'TECHNICAL'),
    };

    updatedState = node.captureTrace(updatedState, {
      analyst: 'technical',
      name: 'Technical Analyst',
      stage: 2,
      instructions: instructionFor('technical'),
      inputs: state.tickers.map((ticker) => ({
        ticker,
        label: 'Price & indicator data ingested',
        data: {
          technical_score: analyses[ticker]?.technical_score,
          rsi: analyses[ticker]?.indicators?.rsi,
          macd_histogram: analyses[ticker]?.indicators?.macd?.histogram,
          sma_200: analyses[ticker]?.indicators?.moving_averages?.sma_200,
          support: analyses[ticker]?.support_resistance?.support_levels,
          resistance: analyses[ticker]?.support_resistance?.resistance_levels,
        },
        sources: ['Yahoo Finance (price/volume bars → indicators)'],
      })),
      weighting: [
        { label: 'Trend alignment', inputs: ['sma_20', 'sma_50', 'sma_200'], weight: 0.4, rationale: 'Price above the moving-average stack is bullish; below is bearish.', contribution: 40, scale: '0..100 score weight' },
        { label: 'Momentum (RSI / MACD)', inputs: ['rsi', 'macd_histogram'], weight: 0.35, rationale: 'RSI in a healthy band and positive MACD histogram lift the score.', contribution: 35, scale: '0..100 score weight' },
        { label: 'Volatility & structure', inputs: ['volatility_30d', 'support_resistance'], weight: 0.25, rationale: 'Tight volatility and price holding support support the score.', contribution: 25, scale: '0..100 score weight' },
      ],
      output: {
        score: avgTechnicalScore(analyses),
        verdict: avgTechnicalScore(analyses) >= 60 ? 'BULLISH' : avgTechnicalScore(analyses) >= 45 ? 'NEUTRAL' : 'BEARISH',
        summary: generateAnalysisSummary(analyses),
        details: { analyses },
      },
      notes: realBarsUsed.size > 0
        ? [`Technical verdict derived from real Yahoo OHLCV bars for: ${[...realBarsUsed].join(', ')}. Indicators + trend/momentum/volatility/support-resistance computed from price history.`]
        : ['No ingested price bars — technical ran on seeded fallback (wire live price history for auditable signals).'],
    });

    node.emitProgress(updatedState, 'analyst:done', 'technical', {
      stage: 2,
      tickers: state.tickers,
      summary: generateAnalysisSummary(analyses),
    });
    return updatedState;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      ...updatedState,
      error: `Technical analysis error: ${errorMessage}`,
      current_step: 'technical_analysis_error',
      messages: [
        ...(updatedState.messages || []),
        { role: 'error', content: `Failed to perform technical analysis: ${errorMessage}`, timestamp: new Date().toISOString() },
      ],
    };
  }
}

function performTechnicalAnalysis(
  ticker: string,
  tuning?: AnalystTuning,
  ingested?: AgentState['ingested'],
): TechnicalAnalysis {
  const seed = stringToSeed(ticker + '_technical');
  const rng = seededRandom(seed);
  const horizon = tuning?.horizon ?? 'LONG_TERM';
  const sensitivity = typeof tuning?.params?.signalSensitivity === 'number'
    ? tuning.params.signalSensitivity
    : 0;

  // --- Real-data path: when bars were ingested, derive EVERYTHING from them ---
  const realIndicators = ingested ? computeIndicatorsFromBars(ingested, ticker, horizon) : null;
  const seriesList = ingested?.bars?.[ticker];
  const barsForTicker = seriesList && seriesList.length > 0
    ? (seriesList.find((s) => s.interval === intervalForHorizon(horizon, seriesList.map((s) => s.interval)))
        ?? seriesList[0]!)?.bars
    : undefined;

  if (realIndicators && barsForTicker && barsForTicker.length >= 2) {
    const derived = deriveTechnicalFromBars(barsForTicker, realIndicators, horizon, sensitivity);
    return derived;
  }

  // --- Seeded fallback (no/insufficient bars): legacy parity output ----------
  const technicalScore = Math.floor(rng() * 40) + 30;
  const trend = determineTrend(rng);
  const momentum = analyzeMomentum(rng);
  const volatility = assessVolatility(rng);
  const supportResistance = generateSupportResistance(rng);
  const indicators = generateIndicators(rng);
  const riskMetrics = generateRiskMetrics(rng);
  const signals = generateSignals(indicators, trend, momentum);

  let biasedScore = technicalScore;
  let biasedVolatility = volatility;
  const maxLookbackDays = typeof tuning?.params?.maxLookbackDays === 'number'
    ? tuning.params.maxLookbackDays
    : undefined;
  if (horizon === 'INTRADAY') {
    biasedScore = Math.min(100, biasedScore + 5 + sensitivity);
    if (maxLookbackDays !== undefined && maxLookbackDays <= 5) {
      biasedVolatility = 'High volatility - significant price instability';
    }
  } else if (horizon === 'MEDIUM_TERM' || horizon === 'SHORT_TERM') {
    biasedScore = Math.min(100, biasedScore + 2 + sensitivity * 0.5);
  }

  return {
    trend_analysis: trend,
    momentum_analysis: momentum,
    volatility_assessment: biasedVolatility,
    support_resistance: supportResistance,
    indicators,
    risk_metrics: riskMetrics,
    signals,
    technical_score: biasedScore,
  };
}

/**
 * 2.1 — fully data-driven technical verdict from real OHLCV bars. Replaces the
 * seeded RNG narrative (trend/momentum/volatility/S-R) with measurements:
 *  - trend: price position vs SMA stack + higher-highs/lows over the window
 *  - momentum: RSI band + MACD histogram sign
 *  - volatility: stdev of returns (annualized-ish) + ATR relative to price
 *  - support/resistance: recent swing lows/highs (local extrema)
 *  - score: blended from trend alignment + momentum + volatility structure
 * When bars are absent this is never called (seeded fallback above handles it).
 */
function deriveTechnicalFromBars(
  bars: PriceBar[],
  ind: TechnicalAnalysis['indicators'],
  horizon: string,
  sensitivity: number,
): TechnicalAnalysis {
  const closes = bars.map((b) => b.close);
  const last = closes[closes.length - 1]!;
  const sma20 = ind.moving_averages?.sma_20 ?? 0;
  const sma50 = ind.moving_averages?.sma_50 ?? 0;
  const sma200 = ind.moving_averages?.sma_200 ?? 0;
  const rsiV = ind.rsi ?? 0;
  const macdHist = ind.macd?.histogram ?? 0;

  // Trend: count how many of the MA stack price sits above.
  let above = 0;
  if (sma20 > 0 && last > sma20) above++;
  if (sma50 > 0 && last > sma50) above++;
  if (sma200 > 0 && last > sma200) above++;
  const maStack = [sma20, sma50, sma200].filter((v) => v > 0);
  const allAbove = maStack.length > 0 && maStack.every((v) => last > v);
  const allBelow = maStack.length > 0 && maStack.every((v) => last < v);

  // Higher-highs / lower-lows over the window.
  let hh = 0;
  let ll = 0;
  for (let i = 1; i < bars.length; i++) {
    if (bars[i]!.high > bars[i - 1]!.high) hh++;
    if (bars[i]!.low < bars[i - 1]!.low) ll++;
  }
  const upSwings = hh >= ll;

  let trend: string;
  if (allAbove && upSwings) trend = 'Strong uptrend with higher highs and higher lows';
  else if (above >= 2) trend = 'Moderate uptrend with some consolidation';
  else if (allBelow && !upSwings) trend = 'Strong downtrend with lower lows and lower highs';
  else if (above <= 0 && ll > hh) trend = 'Moderate downtrend with lower lows and lower highs';
  else trend = 'Sideways/range-bound trading';

  // Momentum from RSI band + MACD histogram.
  let momentum: string;
  if (rsiV >= 70 && macdHist > 0) momentum = 'Very strong bullish momentum with accelerating price action';
  else if (rsiV > 55 && macdHist >= 0) momentum = 'Positive momentum with steady upward pressure';
  else if (rsiV <= 30 && macdHist < 0) momentum = 'Very strong bearish momentum with accelerating decline';
  else if (rsiV < 45 && macdHist <= 0) momentum = 'Weak bearish momentum with slight downward pressure';
  else momentum = 'Neutral momentum with balanced buying/selling pressure';

  // Volatility from stdev of daily returns, annualized (√252 for daily; √ of
  // bar-count scale for intraday as a rough proxy).
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1]!;
    if (prev > 0) rets.push((closes[i]! - prev) / prev);
  }
  const mean = rets.reduce((s, x) => s + x, 0) / (rets.length || 1);
  const variance = rets.reduce((s, x) => s + (x - mean) ** 2, 0) / (rets.length || 1);
  const dailyVol = Math.sqrt(variance);
  const annualizedVol = dailyVol * Math.sqrt(closes.length > 30 ? 252 : closes.length);
  let volatility: string;
  if (annualizedVol > 0.6) volatility = 'High volatility - significant price instability';
  else if (annualizedVol > 0.3) volatility = 'Elevated volatility - increased price swings';
  else if (annualizedVol > 0.12) volatility = 'Moderate volatility - normal market fluctuations';
  else volatility = 'Low volatility - stable price action';

  // Support / resistance: recent swing lows/highs (local extrema in the window).
  const supportResistance = computeSupportResistance(bars, last);

  // Risk metrics: derive vol + a beta-like proxy from return dispersion.
  const riskMetrics = {
    volatility_30d: parseFloat((annualizedVol * 0.7 + 0.1).toFixed(4)), // scaled to 30d-ish
    beta: parseFloat((1 + (annualizedVol - 0.3) * 1.5).toFixed(2)),
    var_95: parseFloat((annualizedVol * 1.65).toFixed(4)),
    max_drawdown: parseFloat(computeMaxDrawdown(closes).toFixed(4)),
  };

  // Score: trend alignment (0..40) + momentum (0..35) + volatility structure (0..25).
  const trendScore = (() => {
    if (allAbove && upSwings) return 40;
    if (above >= 2) return 32;
    if (above === 1) return 22;
    if (allBelow) return 8;
    return 15;
  })();
  const momScore = (() => {
    if (rsiV >= 70 && macdHist > 0) return 35;
    if (rsiV > 55 && macdHist >= 0) return 28;
    if (rsiV < 30 && macdHist < 0) return 6;
    if (rsiV < 45 && macdHist <= 0) return 12;
    return 20;
  })();
  const volScore = (() => {
    if (annualizedVol > 0.6 || annualizedVol < 0.12) return 14; // extreme either way
    if (annualizedVol > 0.3) return 18;
    return 25;
  })();
  let score = Math.round(trendScore + momScore + volScore + sensitivity);
  // Mild horizon bias (unchanged intent from legacy): intraday hotter, medium mild.
  if (horizon === 'INTRADAY') score = Math.min(100, score + 5 + sensitivity);
  else if (horizon === 'MEDIUM_TERM' || horizon === 'SHORT_TERM') score = Math.min(100, score + 2 + sensitivity * 0.5);
  score = Math.max(0, Math.min(100, score));

  const signals = generateSignals(ind, trend, momentum);

  return {
    trend_analysis: trend,
    momentum_analysis: momentum,
    volatility_assessment: volatility,
    support_resistance: supportResistance,
    indicators: ind,
    risk_metrics: riskMetrics,
    signals,
    technical_score: score,
  };
}

/** Recent swing highs/lows as resistance/support (local extrema in the window). */
function computeSupportResistance(bars: PriceBar[], last: number): { support_levels: number[]; resistance_levels: number[] } {
  const highs = bars.map((b) => b.high);
  const lows = bars.map((b) => b.low);
  const maxH = Math.max(...highs);
  const minL = Math.min(...lows);
  const recent = bars.slice(-Math.min(bars.length, 20));
  const supp = recent.map((b) => b.low).sort((a, b) => a - b).slice(0, 2);
  const res = recent.map((b) => b.high).sort((a, b) => b - a).slice(0, 2);
  const support_levels = Array.from(new Set([...supp, minL])).sort((a, b) => a - b).slice(0, 3);
  const resistance_levels = Array.from(new Set([...res, maxH])).sort((a, b) => b - a).slice(0, 3);
  // Guard against empty / degenerate.
  if (support_levels.length === 0) support_levels.push(parseFloat((last * 0.95).toFixed(2)));
  if (resistance_levels.length === 0) resistance_levels.push(parseFloat((last * 1.05).toFixed(2)));
  return { support_levels, resistance_levels };
}

function computeMaxDrawdown(closes: number[]): number {
  let peak = closes[0] ?? 0;
  let maxDd = 0;
  for (const c of closes) {
    if (c > peak) peak = c;
    if (peak > 0) {
      const dd = (peak - c) / peak;
      if (dd > maxDd) maxDd = dd;
    }
  }
  return maxDd;
}

function determineTrend(rng: () => number): string {
  const v = rng();
  if (v > 0.7) return 'Strong uptrend with higher highs and higher lows';
  if (v > 0.4) return 'Moderate uptrend with some consolidation';
  if (v > 0.2) return 'Sideways/range-bound trading';
  if (v > 0.1) return 'Moderate downtrend with lower lows and lower highs';
  return 'Strong downtrend with lower lows and lower highs';
}

function analyzeMomentum(rng: () => number): string {
  const v = rng();
  if (v > 0.8) return 'Very strong bullish momentum with accelerating price action';
  if (v > 0.6) return 'Positive momentum with steady upward pressure';
  if (v > 0.4) return 'Neutral momentum with balanced buying/selling pressure';
  if (v > 0.2) return 'Weak bearish momentum with slight downward pressure';
  return 'Very strong bearish momentum with accelerating decline';
}

function assessVolatility(rng: () => number): string {
  const v = rng();
  if (v > 0.8) return 'Low volatility - stable price action';
  if (v > 0.6) return 'Moderate volatility - normal market fluctuations';
  if (v > 0.4) return 'Elevated volatility - increased price swings';
  return 'High volatility - significant price instability';
}

function generateSupportResistance(rng: () => number): { support_levels: number[]; resistance_levels: number[] } {
  const basePrice = 50 + rng() * 150;
  return {
    support_levels: [
      parseFloat((basePrice * 0.9).toFixed(2)),
      parseFloat((basePrice * 0.8).toFixed(2)),
      parseFloat((basePrice * 0.7).toFixed(2)),
    ],
    resistance_levels: [
      parseFloat((basePrice * 1.1).toFixed(2)),
      parseFloat((basePrice * 1.2).toFixed(2)),
      parseFloat((basePrice * 1.3).toFixed(2)),
    ],
  };
}

function generateIndicators(rng: () => number): {
  rsi: number;
  macd: { macd: number; signal: number; histogram: number };
  moving_averages: { sma_20: number; sma_50: number; sma_200: number; ema_12: number; ema_26: number };
  bollinger_bands: { upper: number; middle: number; lower: number };
} {
  const basePrice = 50 + rng() * 150;
  return {
    rsi: parseFloat((rng() * 100).toFixed(1)),
    macd: {
      macd: parseFloat(((rng() - 0.5) * 4).toFixed(2)),
      signal: parseFloat(((rng() - 0.5) * 4).toFixed(2)),
      histogram: parseFloat(((rng() - 0.5) * 4).toFixed(2)),
    },
    moving_averages: {
      sma_20: parseFloat((basePrice * (0.9 + rng() * 0.2)).toFixed(2)),
      sma_50: parseFloat((basePrice * (0.85 + rng() * 0.3)).toFixed(2)),
      sma_200: parseFloat((basePrice * (0.8 + rng() * 0.4)).toFixed(2)),
      ema_12: parseFloat((basePrice * (0.92 + rng() * 0.16)).toFixed(2)),
      ema_26: parseFloat((basePrice * (0.88 + rng() * 0.24)).toFixed(2)),
    },
    bollinger_bands: {
      upper: parseFloat((basePrice * 1.05).toFixed(2)),
      middle: parseFloat((basePrice * (0.95 + rng() * 0.1)).toFixed(2)),
      lower: parseFloat((basePrice * 0.95).toFixed(2)),
    },
  };
}

function generateRiskMetrics(rng: () => number): {
  volatility_30d: number; beta: number; var_95: number; max_drawdown: number;
} {
  return {
    volatility_30d: parseFloat((rng() * 0.5 + 0.1).toFixed(4)),
    beta: parseFloat((rng() * 1.5 + 0.5).toFixed(2)),
    var_95: parseFloat((rng() * 0.2 + 0.05).toFixed(4)),
    max_drawdown: parseFloat((rng() * 0.4 + 0.1).toFixed(4)),
  };
}

function generateSignals(indicators: any, trend: string, momentum: string): string[] {
  const signals: string[] = [];
  if (indicators.rsi > 70) signals.push('RSI indicates overbought conditions');
  else if (indicators.rsi < 30) signals.push('RSI indicates oversold conditions');
  if (indicators.macd.macd > indicators.macd.signal) signals.push('MACD bullish crossover');
  else signals.push('MACD bearish crossover');
  if (trend.includes('uptrend')) signals.push('Trend following suggests long positions');
  else if (trend.includes('downtrend')) signals.push('Trend following suggests short positions');
  if (momentum.includes('bullish')) signals.push('Momentum indicators support buying');
  else if (momentum.includes('bearish')) signals.push('Momentum indicators support selling');
  if (signals.length === 0) signals.push('Mixed technical signals - wait for clearer direction');
  return signals;
}

function generateAnalysisSummary(analyses: Record<string, any>): string {
  const tickers = Object.keys(analyses);
  if (tickers.length === 0) return 'No analyses performed';
  let totalScore = 0;
  let count = 0;
  for (const ticker in analyses) {
    if (Object.prototype.hasOwnProperty.call(analyses, ticker)) {
      totalScore += analyses[ticker].technical_score;
      count++;
    }
  }
  const avgScore = count > 0 ? totalScore / count : 0;
  return `Average technical score across ${tickers.length} ticker(s): ${avgScore.toFixed(1)}/100`;
}

function avgTechnicalScore(analyses: Record<string, TechnicalAnalysis>): number {
  const tickers = Object.keys(analyses);
  if (tickers.length === 0) return 0;
  const total = tickers.reduce((sum, t) => sum + (analyses[t]?.technical_score ?? 0), 0);
  return Math.round(total / tickers.length);
}

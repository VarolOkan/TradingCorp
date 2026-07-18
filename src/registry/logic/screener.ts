// src/registry/logic/screener.ts
// Phase 6 (Stock Screener): find the most *promising* tickers for the
// CURRENTLY SELECTED AGENCY, FAST.
//
// Design constraints (from the user):
//   - "promising for the current selected agency" -> the scoring blend is
//     weighted by WHICH analysts the agency actually contains (technical /
//     sentiment / fundamental / risk / onchain). A crypto-screener agency
//     weights sentiment+onchain; an options agency weights technical+risk; a
//     long-term equity agency weights technical+fundamental+sentiment, etc.
//   - "should not take too long" -> ONLY cheap, LLM-FREE signals are used:
//       * technical/momentum/volatility derived from price bars (fetchPriceBars)
//       * sentiment from news headlines (fetchCompanyNews + scoreHeadline)
//     No per-candidate LLM call. Work runs through a bounded concurrency pool
//     (default 6 in-flight) so a 25-ticker universe screens in well under a
//     second locally and a few seconds over the network.
//
// The screener is DETERMINISTIC given the same (bars, news) inputs, so it is
// fully unit-testable with injected fetch fns (no network needed).

import { resolveDomain } from './domains';
import type { PriceBarsFetchFn, PriceBarsResult } from './hist';
import { fetchCompanyNews, scoreHeadline, type NewsFetchFn } from './news';
import { AGENCIES } from '../agencies';
import { getUniverse, type UniverseTrace } from './universe';

export interface ScreenerOptions {
  /** Override the candidate universe (comma/space separated or array). */
  universe?: string[];
  /** Max tickers to return (top-N by promise score). Default 8. */
  limit?: number;
  /** Bar interval for the technical read. Default '1d'. */
  interval?: '1m' | '5m' | '1h' | '4h' | '1d';
  /** Lookback in days for bars. Default 90. */
  lookbackDays?: number;
  /**
   * Instrument intent: 'EQUITY' (default) or 'OPTION'. The screener always
   * ranks equity underlyings; 'OPTION' lets the caller mark that they intend
   * optionable underlyings and surfaces an honest note. Per-option greeks
   * ranking is a later phase and is NOT faked here (see docs/SCREENER_STANDARDS.md).
   */
  instrument?: 'EQUITY' | 'OPTION';
  /** Max concurrent ticker evaluations. Default 6. */
  concurrency?: number;
  /** Injected price fetch (tests / no-network). */
  fetchFn?: PriceBarsFetchFn;
  /** Injected news fetch (tests / no-network). */
  newsFetchFn?: NewsFetchFn;
  /** Finnhub key (optional; falls back to seeded headlines without it). */
  finnhubKey?: string;
  /** Universe provider id (env UNIVERSE_PROVIDER default 'nasdaqtrader'). Phase 1. */
  universeProvider?: string;
  /** Injected universe fetch (tests / no-network). Defaults to global fetch in Node. */
  universeFetchFn?: import('./universe/sharedFetch').FetchFn;
  /**
   * Hard cap on how many universe symbols we actually SCORE (default 400).
   * The raw universe can be ~13k; without priced quotes we can't pre-trim it,
   * so this bounds the per-ticker bar/news calls so the screen stays fast.
   */
  maxScreenUniverse?: number;
  /** Minimum average DAILY bar volume (shares) a result must clear. 0 (default)
   *  = no minimum. Rows whose avgVolume is below this are dropped; the universe
   *  pre-filter (when quotes carry averageDailyVolume3Month) also trims cheaply. */
  minVolumeDaily?: number;
}

export interface ScreenerRow {
  ticker: string;
  /** 0..100 blended promise score for this agency. */
  promise: number;
  /** 0..100 technical axis (trend + momentum + low volatility). */
  technical: number;
  /** -100..100 news sentiment axis (averaged headline polarity). */
  sentiment: number;
  /** 0..100 momentum axis (trailing return, normalized). */
  momentum: number;
  /** 0..100 volatility-quality axis (lower vol = higher). */
  stability: number;
  /** Mean share volume across the bars actually evaluated (interval-dependent).
   *  For 1d/4h screens this approximates daily liquidity; for 5m/1m it is the
   *  per-bar mean (smaller). Always present, 0 when no volume data. */
  avgVolume: number;
  verdict: 'STRONG' | 'WATCH' | 'WEAK';
  /** Which axis the agency weighted most (for the UI hint). */
  topAxis: 'technical' | 'sentiment' | 'fundamental' | 'risk' | 'onchain';
  /** Data source for THIS row's price bars: 'yahoo' (real, delayed) or 'mock'. */
  barsSource: 'yahoo' | 'mock';
  /** Data source for THIS row's news: finnhub|yahoo|google|mixed|mock. */
  newsSource: string;
  /** ISO timestamp of the underlying price-bar data (as-of). */
  asOf: string;
}

/** Aggregate badge for the whole screen result, derived from row sources. */
export type DataSourceBadge = 'LIVE' | 'DELAYED' | 'MOCK';

export interface ScreenerResult {
  agencyId: string;
  weights: Record<string, number>;
  rows: ScreenerRow[];
  universeSize: number;
  screenedAt: string;
  /** Wall-clock ms the screen took (proves it's fast). */
  elapsedMs: number;
  /** Truthful data-source badge for the whole screen (see DataSourceBadge). */
  dataSource: DataSourceBadge;
  /** Count of rows whose price bars came from a live source (yahoo). */
  liveRows: number;
  /** Volume-gate summary: how many symbols/rows were dropped by the min-volume
   *  floor (pre-filter + row-level). 0 when no minimum is set. */
  minVolumeDropped?: number;
  /** Step-by-step universe pipeline trace (which source won, listed->parsed->prefiltered). */
  universeTrace?: UniverseTrace;
  /** Instrument intent this screen was run with ('EQUITY' | 'OPTION'). */
  instrument?: 'EQUITY' | 'OPTION';
  note?: string;
}

// A deterministic, liquid starting universe. In production you would replace
// this with a real tradable universe (or pass `universe=` from the frontend).
export const DEFAULT_UNIVERSE: string[] = [
  'AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'TSLA', 'AMD',
  'NFLX', 'AVGO', 'JPM', 'V', 'MA', 'UNH', 'XOM', 'BAC',
  'DIS', 'INTC', 'CSCO', 'ORCL', 'CRM', 'ADBE', 'QCOM', 'TXN', 'PYPL',
];

// Which agency analysts map to which scoring axis. Used to weight the blend
// so the result reflects the selected agency's composition.
const AXIS_ANALYSTS: Record<string, string[]> = {
  technical: ['technical', 'options_technical'],
  sentiment: ['sentiment', 'onchain'],
  fundamental: ['fundamental'],
  risk: ['risk', 'options_risk'],
  onchain: ['onchain'],
};

/**
 * Derive axis weights from the agency's analyst list. Each present analyst
 * contributes to its axis; weights are normalized to sum to 1. If none of the
 * known axes are present we fall back to a balanced technical/sentiment blend.
 */
export function resolveAgencyWeights(agencyId: string): Record<string, number> {
  const agency = AGENCIES[agencyId];
  const analystIds = new Set((agency?.analysts ?? []).map((a) => (typeof a === 'string' ? a : a.id)));
  const raw: Record<string, number> = {};
  for (const [axis, ids] of Object.entries(AXIS_ANALYSTS)) {
    raw[axis] = ids.some((id) => analystIds.has(id)) ? 1 : 0;
  }
  const total = Object.values(raw).reduce((s, v) => s + v, 0);
  if (total === 0) {
    // No recognized analyst -> balanced default (equity-ish).
    return { technical: 0.5, sentiment: 0.3, fundamental: 0.1, risk: 0.1, onchain: 0 };
  }
  const norm: Record<string, number> = {};
  for (const [axis, v] of Object.entries(raw)) norm[axis] = v / total;
  return norm;
}

function sma(values: number[], n: number): number | null {
  if (values.length < n) return null;
  let s = 0;
  for (let i = values.length - n; i < values.length; i++) s += values[i]!;
  return s / n;
}

function stdev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = values.reduce((s, v) => s + v, 0) / values.length;
  const v = values.reduce((s, x) => s + (x - m) * (x - m), 0) / (values.length - 1);
  return Math.sqrt(v);
}

/** RSI(14) from a close series — Wilder-style smoothing. */
function rsi14(closes: number[]): number {
  if (closes.length < 15) return 50;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    if (d >= 0) gain += d;
    else loss -= d;
  }
  const n = closes.length - 1;
  const ag = gain / n;
  const al = loss / n;
  if (al === 0) return 100;
  const rs = ag / al;
  return 100 - 100 / (1 + rs);
}

/**
 * Fast, LLM-free technical promise score (0..100) from price bars:
 * trend alignment (price vs SMA stack) + momentum (RSI band) + volatility
 * quality (penalize very high vol). Mirrors the spirit of the Technical
 * Analyst's verdict without the LLM.
 */
export function technicalPromiseScore(closes: number[]): number {
  if (closes.length < 5) return 50;
  // (bump transform-cache: stable scoring heuristic below)
  const last = closes[closes.length - 1]!;
  const sma20 = sma(closes, 20) ?? last;
  const sma50 = sma(closes, 50) ?? last;
  const rsi = rsi14(closes);

  // Trend: above both MAs is bullish.
  let trend = 0;
  if (last >= sma20) trend += 0.5;
  if (last >= sma50) trend += 0.5;
  const trendScore = trend * 100; // 0/50/100

  // Momentum: RSI in a healthy 45..70 band is ideal; <30 oversold (ok), >75 hot.
  let momScore: number;
  if (rsi >= 45 && rsi <= 70) momScore = 100;
  else if (rsi < 45) momScore = 60 + (rsi / 45) * 40; // 60..100 warming up
  else momScore = Math.max(0, 100 - (rsi - 70) * 2.5); // cooling from hot

  // Volatility quality: normalized 30d stdev of returns; prefer tighter.
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) rets.push(closes[i]! / closes[i - 1]! - 1);
  const vol = stdev(rets);
  // vol of ~0.5% daily is calm (100), ~3%+ is wild (0).
  const volScore = Math.max(0, Math.min(100, 100 - (vol / 0.03) * 100));

  return Math.round(0.45 * trendScore + 0.35 * momScore + 0.2 * volScore);
}

/** Momentum axis (0..100): trailing return over the window, normalized. */
export function momentumScore(closes: number[]): number {
  if (closes.length < 2) return 50;
  const ret = closes[closes.length - 1]! / closes[0]! - 1;
  // +20% over window -> 100; -20% -> 0.
  return Math.max(0, Math.min(100, 50 + (ret / 0.2) * 50));
}

/** Stability axis (0..100): inverse of normalized volatility. */
export function stabilityScore(closes: number[]): number {
  if (closes.length < 2) return 50;
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) rets.push(closes[i]! / closes[i - 1]! - 1);
  const vol = stdev(rets);
  return Math.max(0, Math.min(100, 100 - (vol / 0.03) * 100));
}

/** Average news sentiment (-100..100) from headlines. */
export function newsSentimentScore(headlineScores: number[]): number {
  if (headlineScores.length === 0) return 0;
  const avg = headlineScores.reduce((s, v) => s + v, 0) / headlineScores.length;
  // scoreHeadline returns roughly -40..+40 per headline; clamp to -100..100.
  return Math.max(-100, Math.min(100, avg * 2.5));
}

function verdictFor(promise: number): ScreenerRow['verdict'] {
  if (promise >= 62) return 'STRONG';
  if (promise >= 48) return 'WATCH';
  return 'WEAK';
}

function topAxis(weights: Record<string, number>): ScreenerRow['topAxis'] {
  let best: ScreenerRow['topAxis'] = 'technical';
  let bestV = -1;
  for (const [axis, v] of Object.entries(weights)) {
    if (v > bestV) {
      bestV = v;
      best = axis as ScreenerRow['topAxis'];
    }
  }
  return best;
}

async function evaluateTicker(
  ticker: string,
  agencyId: string,
  weights: Record<string, number>,
  opts: Required<Pick<ScreenerOptions, 'interval' | 'lookbackDays' | 'finnhubKey'>> & ScreenerOptions,
): Promise<ScreenerRow> {
  // P4: price bars now funnelled through resolveDomain('price_bars') so the
  // multi-source layer (swappable sources, honest degrade) is the single entry.
  // record[0].data === the raw fetchPriceBars result (bars + source), so the
  // downstream `barsRes.bars` shape is preserved byte-for-byte.
  const ctxFetch = opts.fetchFn ? ((url: string) => (opts.fetchFn as any)(url)) as any : undefined;
  const [barsRec] = await resolveDomain('price_bars', ticker, {
    ...(ctxFetch ? { fetchFn: ctxFetch } : {}),
    profile: { intervals: [opts.interval as '1d'], lookbackDays: opts.lookbackDays } as any,
  });
  const barsRes = ((barsRec as any)?.data ?? { bars: [], source: 'mock' as const }) as PriceBarsResult;

  const newsRes = await fetchCompanyNews(ticker, {
    ...(opts.newsFetchFn ? { fetchFn: opts.newsFetchFn } : {}),
    ...(opts.finnhubKey ? { finnhubKey: opts.finnhubKey } : {}),
  }).catch(() => null);

  const closes = barsRes.bars.map((b) => b.close);
  const volumes = barsRes.bars.map((b) => b.volume);
  const totalVol = volumes.reduce((s, v) => s + v, 0);
  const avgVolume = volumes.length ? totalVol / volumes.length : 0;
  const technical = technicalPromiseScore(closes);
  const momentum = momentumScore(closes);
  const stability = stabilityScore(closes);
  const sentiment = newsRes ? newsSentimentScore(newsRes.headlines.map((h) => h.score)) : 0;

  // Blend using agency weights. Fundamental/risk/onchain axes are derived from
  // the signals we have (fundamental ~ technical quality; risk ~ stability;
  // onchain ~ sentiment for crypto agencies).
  const fundamental = technical; // cheap proxy: a sound technical setup reads as fundamentally intact here
  const risk = stability; // lower vol = better risk-adjusted
  const onchain = sentiment; // crypto agencies lean on sentiment/on-chain flow proxy

  const w = (axis: keyof typeof weights) => weights[axis] ?? 0;
  const blended =
    w('technical') * technical +
    w('sentiment') * ((sentiment + 100) / 2) + // map -100..100 -> 0..100
    w('fundamental') * fundamental +
    w('risk') * risk +
    w('onchain') * ((onchain + 100) / 2);
  const promise = Math.max(0, Math.min(100, Math.round(blended)));

  return {
    ticker,
    promise,
    technical,
    sentiment: Math.round(sentiment),
    momentum: Math.round(momentum),
    stability: Math.round(stability),
    avgVolume: Math.round(avgVolume),
    verdict: verdictFor(promise),
    topAxis: topAxis(weights),
    barsSource: barsRes.source,
    newsSource: newsRes?.source ?? 'mock',
    asOf: barsRes.bars.length ? barsRes.bars[barsRes.bars.length - 1]!.t : new Date().toISOString(),
  };
}

/** Tiny bounded-concurrency pool. */
async function mapPool<T, R>(items: T[], worker: (item: T) => Promise<R>, concurrency: number): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let idx = 0;
  async function run() {
    while (idx < items.length) {
      const cur = idx++;
      out[cur] = await worker(items[cur]!);
    }
  }
  const pool = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, () => run());
  await Promise.all(pool);
  return out;
}

/**
 * Screen a universe of tickers for the given agency and return the top-N most
 * promising, sorted by blended promise score (desc). Fast + deterministic.
 */
// Agencies that make decisions on intraday horizons screen on short, granular
// bars; everyone else uses daily bars over a longer lookback. This is the
// SINGLE source of truth for the screener's horizon — the frontend mirror
// (agencies.ts) encodes the same rule so the request it sends matches.
const INTRADAY_SCREENER_AGENCIES: string[] = ['intraday', 'options-intraday'];

export interface ScreenerProfile {
  interval: '1m' | '5m' | '1h' | '4h' | '1d';
  lookbackDays: number;
  /** Minimum average daily bar volume (shares) the agency screens for. 0 = off (explicit). */
  minVolumeDaily: number;
}

/**
 * Map an agency to the bar horizon the screener should evaluate it on. Without
 * this, every agency screened on the same default (1d / 90d) bars and returned
 * an identical ranking — which is what made intraday and long-term look the
 * same. Intraday agencies get short, high-granularity bars; the rest get daily.
 * minVolumeDaily is the per-agency floor (set in the Agency settings dialog);
 * default 100000 shares/day, 0 means explicitly off.
 */
export function resolveScreenerProfile(
  agencyId: string,
  agencyDef?: { horizon?: string; assetClass?: string; instrument?: string; screenerInterval?: '1m' | '5m' | '1h' | '4h' | '1d'; screenerLookbackDays?: number; minVolumeDaily?: number },
): ScreenerProfile {
  // Explicit agency fields win (set in the Agency settings dialog).
  if (agencyDef?.screenerInterval && agencyDef?.screenerLookbackDays) {
    return {
      interval: agencyDef.screenerInterval,
      lookbackDays: agencyDef.screenerLookbackDays,
      minVolumeDaily: agencyDef.minVolumeDaily ?? 100_000,
    };
  }
  // Fall back to the implicit horizon rule (intraday ⇒ 5m/5d, else 1d/90d).
  if (INTRADAY_SCREENER_AGENCIES.includes(agencyId)) {
    return { interval: '5m', lookbackDays: 5, minVolumeDaily: agencyDef?.minVolumeDaily ?? 100_000 };
  }
  return { interval: '1d', lookbackDays: 90, minVolumeDaily: agencyDef?.minVolumeDaily ?? 100_000 };
}

/** Resolve the instrument intent from an agency's assetClass/instrument.
 *  OPTION ⇒ 'OPTION'; CRYPTO ⇒ 'EQUITY' (screen equity underlyings — the
 *  crypto universe source is still TBD); everything else ⇒ 'EQUITY'. */
export function resolveScreenerInstrument(
  agencyDef?: { assetClass?: string; instrument?: string },
): 'EQUITY' | 'OPTION' {
  const ac = agencyDef?.assetClass ?? agencyDef?.instrument;
  return ac === 'OPTION' ? 'OPTION' : 'EQUITY';
}

// Deterministic, seedable shuffle (mulberry32 + Fisher-Yates) so the screener
// can de-bias a large universe before capping it, WITHOUT making results
// non-reproducible across runs (tests assert on these). Seeding by a fixed
// constant keeps the screen stable for a given universe.
function seededShuffle<T>(items: T[], seed = 0x9e3779b9): T[] {
  let s = seed >>> 0;
  const rand = () => {
    // mulberry32
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export async function screenTickers(agencyId: string, options: ScreenerOptions = {}): Promise<ScreenerResult> {
  const minVolumeDaily = options.minVolumeDaily ?? 0;
  let universeTrace: UniverseTrace | undefined;
  let universe: string[];
  let universeQuotes: Map<string, { avgDailyVolume?: number }> = new Map();
  if (options.universe && options.universe.length) {
    universe = options.universe;
  } else {
    const uOpts = options.universeProvider
      ? { providerId: options.universeProvider, ...(options.universeFetchFn ? { fetchFn: options.universeFetchFn } : {}) }
      : { ...(options.universeFetchFn ? { fetchFn: options.universeFetchFn } : {}) };
    const u = await getUniverse(uOpts);
    universeTrace = u.trace;
    universe = u.quotes.map((q) => q.ticker);
    universeQuotes = new Map<string, { avgDailyVolume?: number }>(
      u.quotes.map((q) => [q.ticker, q.averageDailyVolume3Month != null ? { avgDailyVolume: q.averageDailyVolume3Month } : {}] as [string, { avgDailyVolume?: number }]),
    );
  }
  const limit = options.limit ?? 15;
  // Bounded screen set: the raw universe can be ~13k; without priced quotes we
  // can't pre-trim it, so cap how many symbols we actually score (bounds the
  // per-ticker bar/news calls). Priced pre-filtered pools are already small.
  const maxScreen = options.maxScreenUniverse ?? 400;
  // Cheap volume pre-filter (only when a floor is set AND quotes carry ADV).
  // averageDailyVolume3Month is a single quote call per ticker — far cheaper
  // than fetching full bars — so a high floor trims the screen set BEFORE the
  // per-ticker bar/news work. The row-level avgVolume floor (below) is the
  // authoritative gate; this is just a fast pre-trim.
  let minVolumePreTrim = 0;
  if (minVolumeDaily > 0 && universeQuotes.size > 0) {
    const before = universe.length;
    universe = universe.filter((t) => {
      const adv = universeQuotes.get(t)?.avgDailyVolume;
      // Unknown ADV (unpriced live pool / quote endpoint blocked / rate-limited)
      // must NOT be dropped here — defer to the row-level avgVolume gate, which
      // scores real bar volume. Only drop when we actually have a quote ADV
      // below the floor. Otherwise a blocked quote endpoint would wipe the
      // whole universe for any non-zero floor.
      if (adv == null) return true;
      return adv >= minVolumeDaily;
    });
    minVolumePreTrim = before - universe.length;
  }
  if (universe.length > maxScreen) {
    // De-bias before capping. The raw universe (e.g. nasdaqtrader) is returned
    // alphabetically; a naive slice(0, N) would always screen the A… tickers
    // and never reach the rest of the alphabet. A deterministic (seeded) shuffle
    // spreads the cap across the whole universe so the screen isn't biased by
    // symbol spelling, while staying reproducible for a given universe.
    universe = seededShuffle(universe).slice(0, maxScreen);
  }
  // Honor an explicit interval/lookback if the caller passed one (tests, or a
  // future UI control); otherwise derive it from the agency's horizon so
  // intraday and long-term actually screen on different bars.
  const profile = resolveScreenerProfile(agencyId);
  const interval = options.interval ?? profile.interval;
  const lookbackDays = options.lookbackDays ?? profile.lookbackDays;
  const concurrency = options.concurrency ?? 6;

  const weights = resolveAgencyWeights(agencyId);
  const start = Date.now();

  const rows = await mapPool(
    universe,
    (t) => evaluateTicker(t, agencyId, weights, { ...options, interval, lookbackDays, finnhubKey: options.finnhubKey ?? '' }),
    concurrency,
  );

  rows.sort((a, b) => b.promise - a.promise);
  // Authoritative volume gate: drop rows whose avgVolume is below the floor.
  // minVolumeDaily=0 means no minimum (default; existing agencies unaffected).
  let minVolumeDropped = 0;
  let passed = rows;
  if (minVolumeDaily > 0) {
    passed = rows.filter((r) => r.avgVolume >= minVolumeDaily);
    minVolumeDropped = rows.length - passed.length;
  }
  const elapsedMs = Date.now() - start;

  // Truthful badge. The universe being LIVE is the headline fact (the user
  // pulled a real list of symbols). The per-row bars may still fall back to
  // mock if the chart endpoint is throttled — but that's a per-row detail, not
  // a reason to slap MOCK on the whole screen. So:
  //   - MOCK only when the universe itself fell back (usedFallback) AND every
  //     row is on mock bars (nothing live at all).
  //   - DELAYED when the universe is live (the normal case) — even if some rows
  //     used mock bars; the sub-count (liveRows vs total) tells the story.
  //   - LIVE reserved for a future sub-second feed.
  const liveRows = rows.filter((r) => r.barsSource !== 'mock').length;
  const universeFellBack = universeTrace?.usedFallback === true;
  let dataSource: DataSourceBadge = 'DELAYED';
  if (universeFellBack && liveRows === 0) dataSource = 'MOCK';
  else if (liveRows === rows.length && !universeFellBack) dataSource = 'DELAYED'; // real universe + real bars

  const instrument = options.instrument ?? 'EQUITY';
  return {
    agencyId,
    weights,
    rows: passed.slice(0, limit),
    universeSize: universe.length,
    screenedAt: new Date().toISOString(),
    elapsedMs,
    dataSource,
    liveRows,
    minVolumeDropped,
    universeTrace: universeTrace
      ? {
          ...universeTrace,
          gates: {
            ...(universeTrace.gates ?? {}),
            ...(minVolumeDaily > 0
              ? { minVolume: minVolumePreTrim + minVolumeDropped }
              : {}),
          },
        }
      : universeTrace,
    instrument,
    note: instrument === 'OPTION'
      ? 'LLM-free screen: technical/momentum/volatility from price bars + news sentiment; ranks equity underlyings you can trade options on. Per-option greeks ranking is a later phase. Weights reflect the selected agency.'
      : 'LLM-free screen: technical/momentum/volatility from price bars + news sentiment. Weights reflect the selected agency.',
  };
}

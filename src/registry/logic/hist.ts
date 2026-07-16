// src/registry/logic/hist.ts
// Phase A (doc §1, §3). Historical & Derivatives Data Layer.
//
// ONE provider module returning { price_bars, option_chain, greeks, rfr,
// expiries, iv_history } for a ticker + profile. Equity agencies ignore the
// option fields; options agencies consume them. This keeps the data contract
// in one place and makes the parity fallback uniform.
//
// MOCK-FIRST: live option/greeks keys are absent by default (Issue #2), so the
// deterministic mock generators are the default path. They are seeded with the
// SAME contract as the rest of the codebase — seededRandom(stringToSeed(ticker))
// — so runs are byte-stable per ticker. Greeks are computed from the mock chain
// via the real Black–Scholes engine (greeks.ts), so they are internally
// consistent with the chain (no fake-number drift): BS(price) ≈ mid.
//
// Live sources (Polygon/Tiingo/Treasury) are declared on options_ingestion's
// dataSources with onError:'degrade' → when a key is absent the acquisition
// layer no-ops and this mock bundle is used, exactly like yahoo/alphaVantage.

import type {
  HistoricalBundle,
  PriceBar,
  PriceBarSeries,
  OptionQuote,
  OptionChain,
  GreeksRow,
  BarInterval,
  OptionRight,
} from '../../types/financial-analysis';
import { stringToSeed, seededRandom } from './shared';
import { bsPrice, bsGreeks, yearsToExpiry, resolveRfr, DEFAULT_RFR } from './greeks';

/**
 * The shared seededRandom LCG can emit values outside [0,1) on its early calls
 * (JS `%` preserves sign), which is fine for the existing handlers' seeds but
 * would corrupt price/strike math here. This wrapper normalizes any draw into
 * a proper [0,1) uniform while staying fully deterministic per seed.
 */
function makeRng(seedStr: string): () => number {
  const base = seededRandom(stringToSeed(seedStr));
  return () => {
    const v = base();
    const frac = v - Math.floor(v); // maps any real into [0,1)
    return frac;
  };
}

export interface HistProfile {
  /** Trading days / calendar days of history to synthesize (default 90). */
  lookbackDays?: number;
  /** Which bar intervals to produce (default ['1d']). */
  intervals?: BarInterval[];
  /** Expiry set to generate: 'monthly+weekly' | 'weekly+0dte' | 'monthly'. */
  expiries?: string;
  /** Strikes each side of spot (default 10). */
  strikesEachSide?: number;
  /** Strike spacing in dollars (default derived from spot). */
  strikeSpacing?: number;
  /** Real current underlying price. When supplied, the mock chain is centered
   *  on THIS price (with a realistic strike spacing) instead of a random band,
   *  so a cheap stock like SOFI (~$18) doesn't get ~$300 strikes. */
  spot?: number;
  /** Risk-free rate override (live Treasury); falls back to DEFAULT_RFR. */
  rfr?: number;
  /** "now" anchor for deterministic expiry/ttm math (default fixed epoch). */
  asOf?: string;
}

// A FIXED reference date makes mock output fully deterministic across machines
// and test runs (no dependence on the wall clock). Chosen inside the design's
// 2026 timeframe.
const MOCK_ASOF = '2026-07-10T00:00:00.000Z';

/** Deterministic base spot per ticker (mirrors the equity mock's price band). */
function basePrice(ticker: string): number {
  const rng = makeRng(`${ticker}:spot`);
  // Believable band $40–$440, rounded to a whole dollar.
  return Math.round(40 + rng() * 400);
}

/** Round a strike to the nearest multiple of `spacing`. */
function roundToSpacing(x: number, spacing: number): number {
  return Math.round(x / spacing) * spacing;
}

/** Exchange-like strike spacing as a function of the underlying price:
 *  cheap stocks get fine ($0.50/$1) increments, dear stocks coarser ($5/$10). */
function deriveStrikeSpacing(spot: number): number {
  if (spot < 10) return 0.5;
  if (spot < 25) return 1;
  if (spot < 100) return 2.5;
  if (spot < 250) return 5;
  return 10;
}

/** Generate a seeded OHLCV random walk of `count` bars ending "now". */
function generateBars(
  ticker: string,
  interval: BarInterval,
  count: number,
  spot: number,
  asOf: Date,
): PriceBar[] {
  const rng = makeRng(`${ticker}:bars:${interval}`);
  const bars: PriceBar[] = [];
  // Walk BACKWARD from spot so the last close equals ~spot.
  const stepMs =
    interval === '1d' ? 24 * 3600 * 1000
      : interval === '4h' ? 4 * 3600 * 1000
      : interval === '1h' ? 3600 * 1000
      : interval === '5m' ? 5 * 60 * 1000
      : 60 * 1000;
  const vol = interval === '1d' ? 0.015 : 0.003; // per-bar stdev-ish
  let close = spot;
  const tmp: PriceBar[] = [];
  for (let i = 0; i < count; i++) {
    const drift = (rng() - 0.5) * 2 * vol; // symmetric random walk
    const open = close;
    const nextClose = Math.max(1, open * (1 + drift));
    const high = Math.max(open, nextClose) * (1 + rng() * vol * 0.5);
    const low = Math.min(open, nextClose) * (1 - rng() * vol * 0.5);
    const volume = Math.round(1_000_000 * (0.5 + rng()));
    const vwap = parseFloat(((high + low + nextClose) / 3).toFixed(2));
    const t = new Date(asOf.getTime() - i * stepMs).toISOString();
    tmp.push({
      t,
      open: parseFloat(open.toFixed(2)),
      high: parseFloat(high.toFixed(2)),
      low: parseFloat(low.toFixed(2)),
      close: parseFloat(nextClose.toFixed(2)),
      volume,
      ...(interval === '1d' ? {} : { vwap }),
    });
    close = nextClose;
  }
  // tmp is newest-first; reverse to chronological (oldest-first).
  for (let i = tmp.length - 1; i >= 0; i--) bars.push(tmp[i]!);
  return bars;
}

/** Third Friday of a given year/month (monthly OPEX). month is 0-indexed. */
function thirdFriday(year: number, month: number): Date {
  const d = new Date(Date.UTC(year, month, 1));
  // day-of-week: 5 = Friday
  let fridays = 0;
  while (true) {
    if (d.getUTCDay() === 5) {
      fridays++;
      if (fridays === 3) break;
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return d;
}

/** Next `n` weekly Fridays strictly after `from`. */
function nextWeeklyFridays(from: Date, n: number): Date[] {
  const out: Date[] = [];
  const d = new Date(from.getTime());
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + 1);
  while (out.length < n) {
    if (d.getUTCDay() === 5) out.push(new Date(d.getTime()));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/** Build the expiry calendar per the requested profile. */
function generateExpiries(profile: string | undefined, asOf: Date): string[] {
  const set = new Set<string>();
  const wants0dte = (profile ?? '').includes('0dte');
  const wantsWeekly = (profile ?? 'monthly+weekly').includes('weekly');
  const wantsMonthly = (profile ?? 'monthly+weekly').includes('monthly');

  if (wants0dte) {
    // 0DTE: same-day expiry (asOf date itself).
    set.add(new Date(asOf.getTime()).toISOString().slice(0, 10));
  }
  if (wantsWeekly) {
    for (const f of nextWeeklyFridays(asOf, 4)) set.add(f.toISOString().slice(0, 10));
  }
  if (wantsMonthly) {
    let y = asOf.getUTCFullYear();
    let m = asOf.getUTCMonth();
    let added = 0;
    while (added < 4) {
      const tf = thirdFriday(y, m);
      if (tf.getTime() > asOf.getTime()) {
        set.add(tf.toISOString().slice(0, 10));
        added++;
      }
      m++;
      if (m > 11) {
        m = 0;
        y++;
      }
    }
  }
  // Always guarantee at least one expiry.
  if (set.size === 0) {
    for (const f of nextWeeklyFridays(asOf, 4)) set.add(f.toISOString().slice(0, 10));
  }
  return Array.from(set).sort();
}

/**
 * Seeded IV for a strike, exhibiting a realistic equity smile/skew:
 * higher IV for OTM puts (low moneyness) and a mild rise for far OTM calls.
 */
function seededIv(rng: () => number, moneyness: number, baseIv: number): number {
  // moneyness = K/S. Skew: puts (K<S) richer.
  const skew = (1 - moneyness) * 0.35; // +IV as K falls below S
  const wingKurtosis = Math.pow(Math.abs(1 - moneyness), 2) * 0.6;
  const noise = (rng() - 0.5) * 0.02;
  const iv = baseIv + skew + wingKurtosis + noise;
  return Math.min(1.5, Math.max(0.05, parseFloat(iv.toFixed(4))));
}

/**
 * Generate the mock historical bundle for one ticker + profile. Deterministic:
 * same (ticker, profile) → byte-identical output. Greeks are BS-derived from
 * the mock chain so they stay internally consistent (BS(mid) ≈ mid).
 */
export function generateMockBundle(ticker: string, profile: HistProfile = {}): HistoricalBundle {
  const asOf = new Date(profile.asOf ?? MOCK_ASOF);
  const lookbackDays = profile.lookbackDays ?? 90;
  const intervals = profile.intervals ?? ['1d'];
  const strikesEachSide = profile.strikesEachSide ?? 10;
  const rfr = typeof profile.rfr === 'number' && Number.isFinite(profile.rfr) ? profile.rfr : DEFAULT_RFR;

  // Real current price when available (passed from the live-quote fetch), else a
  // deterministic per-ticker band. Using the real spot means a cheap stock like
  // SOFI (~$18) gets ~$18 strikes, not ~$300.
  const spot = typeof profile.spot === 'number' && profile.spot > 0 ? profile.spot : basePrice(ticker);
  // Realistic strike spacing by price tier (mimics how exchanges list strikes).
  const spacing = profile.strikeSpacing ?? deriveStrikeSpacing(spot);

  // ---- Price bars per interval ----
  const price_bars: PriceBarSeries[] = intervals.map((interval) => {
    const count =
      interval === '1d'
        ? lookbackDays
        : interval === '4h'
        ? lookbackDays * 6 // ~6 4h bars per RTH day
        : interval === '1h'
        ? lookbackDays * 24 // ~24 1h bars per RTH day
        : interval === '5m'
        ? lookbackDays * 78 // ~78 5m bars per RTH day
        : lookbackDays * 390; // 1m bars per RTH day
    // Cap intraday bar counts so the mock stays lightweight.
    const cap = interval === '1d' ? count : Math.min(count, 390);
    return {
      interval,
      lookback_days: lookbackDays,
      bars: generateBars(ticker, interval, cap, spot, asOf),
    };
  });

  // ---- Option chain ----
  const expiries = generateExpiries(profile.expiries, asOf);
  const chainRng = makeRng(`${ticker}:chain`);
  const baseIv = 0.25 + chainRng() * 0.1; // per-ticker base IV 0.25–0.35
  const option_chain: OptionQuote[] = [];
  const greeks: GreeksRow[] = [];
  const atmStrike = roundToSpacing(spot, spacing);

  for (const expiry of expiries) {
    const ttm = yearsToExpiry(`${expiry}T00:00:00.000Z`, asOf);
    for (let k = -strikesEachSide; k <= strikesEachSide; k++) {
      const strike = atmStrike + k * spacing;
      if (strike <= 0) continue;
      const moneyness = strike / spot;
      const iv = seededIv(chainRng, moneyness, baseIv);
      for (const type of ['C', 'P'] as OptionRight[]) {
        const mid = bsPrice(type, spot, strike, ttm, rfr, iv);
        const spread = Math.max(0.02, mid * 0.02);
        const bid = parseFloat(Math.max(0, mid - spread / 2).toFixed(2));
        const ask = parseFloat((mid + spread / 2).toFixed(2));
        const last = parseFloat(mid.toFixed(2));
        const volume = Math.round(chainRng() * 5000);
        const open_interest = Math.round(chainRng() * 20000);
        option_chain.push({
          expiry,
          strike,
          type,
          bid,
          ask,
          last,
          volume,
          open_interest,
          iv,
          underlying_price: spot,
          underlying_ts: asOf.toISOString(),
        });
        const g = bsGreeks(type, spot, strike, ttm, rfr, iv);
        greeks.push({
          expiry,
          strike,
          type,
          delta: parseFloat(g.delta.toFixed(4)),
          gamma: parseFloat(g.gamma.toFixed(6)),
          vega: parseFloat(g.vega.toFixed(4)),
          theta: parseFloat(g.theta.toFixed(4)),
          rho: parseFloat(g.rho.toFixed(4)),
          iv_in: iv,
          underlying_price: spot,
          ttm_years: parseFloat(ttm.toFixed(6)),
          rfr,
        });
      }
    }
  }

  // ---- Historical ATM IV samples (for iv_rank/iv_percentile) ----
  const ivRng = makeRng(`${ticker}:ivhist`);
  const iv_history: number[] = [];
  for (let i = 0; i < 60; i++) {
    iv_history.push(parseFloat((baseIv + (ivRng() - 0.5) * 0.2).toFixed(4)));
  }

  return {
    ticker,
    underlying_price: spot,
    price_bars,
    option_chain,
    greeks,
    rfr,
    expiries,
    iv_history,
    mock: true,
  };
}

/**
 * Public entry point. In v1 this always returns the deterministic mock bundle
 * (live keys are out of scope, Issue #2). It is async + profile-driven so the
 * options_ingestion node can await it uniformly and a live provider can slot in
 * behind the same signature later without touching callers.
 */
export async function fetchHistoricalBundle(
  ticker: string,
  profile: HistProfile = {},
): Promise<HistoricalBundle> {
  return generateMockBundle(ticker, profile);
}

/**
 * Phase I (historical quotes): fetch REAL OHLCV price bars for a ticker from
 * Yahoo Finance's tokenless chart endpoint, mapped into the `PriceBarSeries`
 * shape used by the options/equity layers.
 *
 * - `range`/`interval` are derived from `lookbackDays`/`interval` so the caller
 *   can ask for e.g. 1y daily or 5d 5m. Yahoo's `range` vocabulary is coarse
 *   (1d/5d/1mo/3mo/6mo/1y/2y/5y/ytd/max), so we bucket `lookbackDays` into the
 *   nearest matching range and let `interval` pick the bar size.
 * - Mock-first / parity-safe: if no `fetchFn` is supplied (or Yahoo is
 *   unreachable/blocked), we fall back to the deterministic seeded
 *   `generateBars` mock so callers always get structurally-valid data. The
 *   returned `mock` flag tells the UI which path was used.
 *
 * @returns a single `PriceBarSeries` (one interval). For multiple intervals,
 *   call once per interval.
 */
export type PriceBarsFetchFn = (url: string) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<any>;
}>;

function yahooRange(lookbackDays: number): string {
  if (lookbackDays <= 1) return '1d';
  if (lookbackDays <= 5) return '5d';
  if (lookbackDays <= 22) return '1mo';
  if (lookbackDays <= 66) return '3mo';
  if (lookbackDays <= 132) return '6mo';
  return '1y';
}

const YAHOO_CHART = (symbol: string, range: string, interval: string) =>
  `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol,
  ).toUpperCase()}?range=${range}&interval=${interval}`;

function toNum(v: any): number | null {
  if (v === undefined || v === null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export interface PriceBarsResult {
  ticker: string;
  interval: BarInterval;
  lookback_days: number;
  bars: PriceBar[];
  source: 'yahoo' | 'mock';
  note?: string;
}

export async function fetchPriceBars(
  ticker: string,
  opts: { interval?: BarInterval; lookbackDays?: number; fetchFn?: PriceBarsFetchFn } = {},
): Promise<PriceBarsResult> {
  const interval = opts.interval ?? '1d';
  const lookbackDays = opts.lookbackDays ?? 90;
  const sym = ticker.trim().toUpperCase();

  const doFetch = opts.fetchFn ?? ((globalThis as any).fetch?.bind?.(globalThis) as PriceBarsFetchFn | undefined);
  if (typeof doFetch === 'function') {
    try {
      const res = await doFetch(YAHOO_CHART(sym, yahooRange(lookbackDays), interval));
      if (res.ok) {
        const payload = await res.json().catch(() => null);
        const result = payload?.chart?.result?.[0];
        const ts: number[] = result?.timestamp ?? [];
        const q = result?.indicators?.quote?.[0] ?? {};
        if (ts.length > 0 && Array.isArray(q.open)) {
          const bars: PriceBar[] = [];
          for (let i = 0; i < ts.length; i++) {
            const open = toNum(q.open[i]);
            const close = toNum(q.close[i]);
            if (open === null || close === null) continue; // skip null pads
            bars.push({
              t: new Date(ts[i] * 1000).toISOString(),
              open,
              high: toNum(q.high?.[i]) ?? open,
              low: toNum(q.low?.[i]) ?? open,
              close,
              volume: toNum(q.volume?.[i]) ?? 0,
              ...(interval === '1d' ? {} : { vwap: toNum(q.vwap?.[i]) ?? undefined }),
            });
          }
          if (bars.length > 0) {
            return {
              ticker: sym,
              interval,
              lookback_days: lookbackDays,
              bars,
              source: 'yahoo',
            };
          }
        }
      }
    } catch {
      /* fall through to mock */
    }
  }

  // Mock fallback (deterministic, parity-safe).
  const asOf = new Date();
  const bars = generateBars(sym, interval, lookbackDays, basePrice(sym), asOf);
  return {
    ticker: sym,
    interval,
    lookback_days: lookbackDays,
    bars,
    source: 'mock',
    note: 'Live price history unavailable — showing deterministic mock bars.',
  };
}

/**
 * Phase I (options historical chains): fetch a REAL option chain for a ticker
 * from Polygon's tokenless-eligible snapshot endpoint, mapped into the
 * `OptionQuote[]` shape used by the options agencies (vol-surface, pricing,
 * risk).
 *
 * - Requires a Polygon API key (`apiKey`), which is read from `process.env`
 *   when `fetchFn` is not supplied (production wiring). When no key is
 *   available, OR the source is unreachable/blocked, we fall back to the
 *   deterministic seeded mock chain from `generateMockBundle` — so the options
 *   agencies always get structurally-valid data (parity: no key = mock).
 * - Greeks are NOT trusted from the feed; we re-derive them with `bsGreeks`
 *   from the contract's IV + the live underlying price, so the greeks row is
 *   consistent with the project's pricing model regardless of source.
 *
 * @returns an `OptionChain` (ticker + underlying + quotes + expiries + rfr).
 */
export type OptionChainFetchFn = (url: string) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<any>;
}>;

function polygonSnapshotUrl(ticker: string, apiKey: string) {
  return `https://api.polygon.io/v3/snapshot/options/${encodeURIComponent(
    ticker.toUpperCase(),
  )}?apiKey=${encodeURIComponent(apiKey)}`;
}

function numOr(v: any, fallback = 0): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export interface OptionChainResult extends OptionChain {
  source: 'polygon' | 'yahoo' | 'mock';
  note?: string;
}

const YAHOO_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

/**
 * PURE parser for a Yahoo v7 /finance/options payload.
 * Shape: { optionChain: { result: [ { quote, options: [ { expirationDate (epoch
 * s), calls:[{strike,bid,ask,lastPrice,impliedVolatility,volume,openInterest}],
 * puts:[...] } ] } ] } }
 * Returns null when the payload is unparseable / has no contracts.
 */
export function parseYahooOptions(ticker: string, payload: any): OptionChainResult | null {
  const top = payload?.optionChain?.result?.[0];
  if (!top) return null;
  const contracts = top.options ?? [];
  if (!Array.isArray(contracts) || contracts.length === 0) return null;
  const spot = numOr(top.quote?.regularMarketPrice);
  const expirySet = new Set<string>();
  const quotes: OptionQuote[] = [];
  const pushContract = (c: any, type: OptionRight, expISO: string) => {
    const strike = numOr(c.strike);
    if (strike <= 0) return;
    const bid = numOr(c.bid);
    const ask = numOr(c.ask);
    const last = numOr(c.lastPrice ?? (bid + ask) / 2);
    const iv = numOr(c.impliedVolatility, 0.3);
    const volume = numOr(c.volume ?? 0);
    const openInterest = numOr(c.openInterest ?? 0);
    quotes.push({
      expiry: expISO,
      strike,
      type,
      bid,
      ask,
      last,
      volume,
      open_interest: openInterest,
      iv,
      underlying_price: spot,
      underlying_ts: new Date().toISOString(),
    });
  };
  for (const node of contracts) {
    const expRaw = numOr(node.expirationDate);
    const expISO = expRaw > 0 ? new Date(expRaw * 1000).toISOString().slice(0, 10) : '';
    if (!expISO) continue;
    expirySet.add(expISO);
    for (const c of node.calls ?? []) pushContract(c, 'C', expISO);
    for (const c of node.puts ?? []) pushContract(c, 'P', expISO);
  }
  if (quotes.length === 0) return null;
  return {
    ticker: ticker.toUpperCase(),
    underlying_price: spot,
    quotes,
    expiries: Array.from(expirySet).sort(),
    rfr: resolveRfr(),
    greeks: chainToGreeksRows(quotes, spot, resolveRfr()),
    source: 'yahoo',
    note: 'Delayed ~15-20 min — tokenless Yahoo options chain (real quotes).',
  };
}

/** PURE parser: Polygon v3 options snapshot payload → OptionQuote[].
 *  Accepts either the raw `results` object (v3 shape: { ticker, underlying_asset,
 *  options: [...] }) or the bare options array. Extracted from fetchOptionChain
 *  so the §4.9 acquisition engine (which may have already fetched + validated the
 *  snapshot) can reuse the exact same parsing without re-fetching. Returns null
 *  when the payload is unusable. */
export function parsePolygonChainResults(payload: any, ticker: string): OptionChainResult | null {
  const sym = String(ticker).trim().toUpperCase();
  // Normalize to the options array regardless of how the caller sliced it.
  const results: any[] = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.options)
      ? payload.options
      : Array.isArray(payload?.results)
        ? payload.results
        : [];
  if (results.length === 0) return null;
  const quotes: OptionQuote[] = [];
  const expirySet = new Set<string>();
  const underlyingPrice =
    numOr(payload?.underlying_asset?.last_price) ||
    numOr(results[0]?.underlying_asset?.last_price) ||
    numOr(results[0]?.details?.underlying_asset?.last_price);
  const spot = underlyingPrice || basePrice(sym);
  for (const c of results) {
    const d = c.details ?? {};
    const expiry = (d.expiration_date as string) ?? '';
    const strike = numOr(d.strike_price);
    const type: OptionRight = d.contract_type === 'put' ? 'P' : 'C';
    const greeks = c.greeks ?? {};
    const lastQuote = c.last_quote ?? {};
    const bid = numOr(lastQuote.bid);
    const ask = numOr(lastQuote.ask);
    const last = numOr(greeks.last_price ?? c.last_trade?.price ?? (bid + ask) / 2);
    const iv = numOr(greeks.implied_volatility, 0.3);
    const volume = numOr(c.last_trade?.size ?? greeks.size ?? 0);
    const openInterest = numOr(d.open_interest ?? 0);
    if (!expiry || strike <= 0) continue;
    expirySet.add(expiry);
    quotes.push({
      expiry,
      strike,
      type,
      bid,
      ask,
      last,
      volume,
      open_interest: openInterest,
      iv,
      underlying_price: spot,
      underlying_ts: new Date().toISOString(),
    });
  }
  if (quotes.length === 0) return null;
  const rfr = resolveRfr();
  return {
    ticker: sym,
    underlying_price: spot,
    quotes,
    expiries: Array.from(expirySet).sort(),
    rfr,
    greeks: chainToGreeksRows(quotes, spot, rfr),
    source: 'polygon',
  };
}

/** PURE parser: Polygon v2 aggregates `results` array → PriceBar[]. */
export function parsePolygonAggregates(results: any, interval: BarInterval = '1d'): PriceBar[] {
  if (!Array.isArray(results)) return [];
  return results
    .filter((r: any) => r && typeof r.t === 'number')
    .map((r: any) => ({
      t: new Date(r.t).toISOString(),
      open: numOr(r.o) ?? 0,
      high: numOr(r.h) ?? 0,
      low: numOr(r.l) ?? 0,
      close: numOr(r.c) ?? 0,
      volume: numOr(r.v) ?? 0,
    }))
    .filter((b: PriceBar) => b.close > 0);
}

/** PURE parser: Treasury avg_interest_rates data row → annualized rfr (0..1). */
export function parseTreasuryRfr(row: any): number | null {
  const v = numOr(row?.avg_interest_rate_amt);
  if (v === null) return null;
  // Treasury publishes percent (e.g. 4.32); normalize to a 0..1 rate.
  return v / 100;
}
/** Fetch a URL with a few short retries (handles Yahoo's intermittent 429s). */
async function fetchWithRetry(gf: (u: string, i?: any) => Promise<any>, url: string, headers: Record<string, string>, tries = 3): Promise<any> {
  let lastErr: any;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const res = await gf(url, { method: 'GET', headers });
      if (res.status === 429 && attempt < tries - 1) {
        await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (attempt < tries - 1) await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
    }
  }
  if (lastErr) throw lastErr;
  return null;
}

/**
 * Tokenless Yahoo options chain (v7/finance/options). Mirrors the crumb dance
 * the Quote tab already uses. Returns REAL (delayed ~15-20m) data when Yahoo is
 * reachable. No API key required — but Yahoo rate-limits aggressively, so callers
 * must treat a failure as "fall through to mock".
 */
async function fetchYahooOptionChain(
  ticker: string,
  gf?: (url: string, init?: any) => Promise<any>,
): Promise<OptionChainResult | null> {
  const fetchFn = gf ?? ((globalThis as any).fetch as ((url: string, init?: any) => Promise<any>) | undefined);
  if (typeof fetchFn !== 'function') {
    console.warn(`[options] Yahoo fallback skipped for ${ticker}: no fetch transport available (globalThis.fetch undefined and no injected fetchFn).`);
    return null;
  }
  try {
    // 1) seed the A3 session cookie
    const seed = await fetchFn('https://fc.yahoo.com', { method: 'GET', redirect: 'manual', headers: { 'User-Agent': YAHOO_UA } });
    const setCookie =
      typeof (seed.headers as any).getSetCookie === 'function'
        ? (seed.headers as any).getSetCookie()
        : [seed.headers.get('set-cookie')].filter(Boolean);
    const cookie = (setCookie as string[]).map((c) => c.slice(0, c.indexOf(';'))).join('; ');
    // 2) crumb
    const crumbRes = await fetchFn('https://query2.finance.yahoo.com/v1/test/getcrumb', {
      method: 'GET', redirect: 'manual',
      headers: { 'User-Agent': YAHOO_UA, ...(cookie ? { Cookie: cookie } : {}) },
    });
    const crumb = (await crumbRes.text()).trim();
    if (!crumb) {
      console.warn(`[options] Yahoo fallback failed for ${ticker}: crumb endpoint returned empty (status ${crumbRes.status}). Falling back to MOCK.`);
      return null;
    }
    // 3) options chain (retry on 429)
    const res = await fetchWithRetry(
      fetchFn,
      `https://query2.finance.yahoo.com/v7/finance/options/${encodeURIComponent(ticker.toUpperCase())}?crumb=${encodeURIComponent(crumb)}`,
      { 'User-Agent': YAHOO_UA, ...(cookie ? { Cookie: cookie } : {}) },
    );
    if (!res) {
      console.warn(`[options] Yahoo fallback failed for ${ticker}: options request returned no response (network/timeout). Falling back to MOCK.`);
      return null;
    }
    if (!res.ok) {
      // v7/finance/options is aggressively rate-limited (HTTP 429). Fall back to
      // the quoteSummary optionChain module (v10), which returns the SAME nested
      // options[].calls/puts shape and is usually not rate-limited as hard.
      console.warn(`[options] Yahoo v7 options HTTP ${res.status} for ${ticker}; trying quoteSummary optionChain module instead.`);
      const qsUrl = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker.toUpperCase())}?modules=optionChain&crumb=${encodeURIComponent(crumb)}`;
      const qsRes = await fetchWithRetry(
        fetchFn,
        qsUrl,
        { 'User-Agent': YAHOO_UA, ...(cookie ? { Cookie: cookie } : {}) },
      );
      if (qsRes && qsRes.ok) {
        const qsPayload = (await qsRes.json().catch(() => null)) as any;
        // quoteSummary nests under result[0].optionChain (same inner shape).
        const adapted = { optionChain: { result: [{ quote: qsPayload?.quoteSummary?.result?.[0]?.price ?? {}, options: qsPayload?.quoteSummary?.result?.[0]?.optionChain?.options ?? [] }] } };
        const parsedQs = parseYahooOptions(ticker, adapted);
        if (parsedQs) {
          console.log(`[options] Yahoo quoteSummary fallback OK for ${ticker}: ${parsedQs.quotes.length} quotes (source=${parsedQs.source}).`);
          return parsedQs;
        }
      }
      console.warn(`[options] Yahoo fallback failed for ${ticker}: options request HTTP ${res.status} (likely 429 rate-limit or 401). Falling back to MOCK.`);
      return null;
    }
    const payload = (await res.json().catch(() => null)) as any;
    const parsed = parseYahooOptions(ticker, payload);
    if (!parsed) {
      console.warn(`[options] Yahoo fallback returned an unparseable/empty payload for ${ticker} (check optionChain.result[0].options[].calls/puts). Falling back to MOCK.`);
      return null;
    }
    console.log(`[options] Yahoo fallback OK for ${ticker}: ${parsed.quotes.length} quotes across ${parsed.expiries.length} expiry (source=${parsed.source}).`);
    return parsed;
  } catch (e) {
    console.warn(`[options] Yahoo fallback errored for ${ticker}: ${e instanceof Error ? e.message : String(e)}. Falling back to MOCK.`);
    return null;
  }
}

export async function fetchOptionChain(
  ticker: string,
  opts: { apiKey?: string; fetchFn?: OptionChainFetchFn; rfr?: number } = {},
): Promise<OptionChainResult> {
  const sym = ticker.trim().toUpperCase();
  const rfr = resolveRfr(opts.rfr);

  const doFetch =
    opts.fetchFn ??
    ((globalThis as any).fetch?.bind?.(globalThis) as OptionChainFetchFn | undefined);
  const fetchInjected = !!opts.fetchFn;
  const apiKey =
    opts.apiKey ?? (typeof process !== 'undefined' ? process.env?.POLYGON_API_KEY : undefined);

  // Live path when: a transport is available AND (a key is set OR the caller
  // explicitly injected a transport — i.e. they handle auth themselves).
  if (typeof doFetch === 'function' && (apiKey || fetchInjected)) {
    try {
      const res = await doFetch(polygonSnapshotUrl(sym, apiKey));
      if (res.ok) {
        const payload = await res.json().catch(() => null);
        const results = payload?.results?.results;
        if (Array.isArray(results) && results.length > 0) {
          const quotes: OptionQuote[] = [];
          const expirySet = new Set<string>();
          const underlyingPrice =
            numOr(payload?.results?.underlying_asset?.last_price) ||
            numOr(results[0]?.underlying_asset?.last_price);
          let spot = underlyingPrice || basePrice(sym);

          for (const c of results) {
            const d = c.details ?? {};
            const expiry = (d.expiration_date as string) ?? '';
            const strike = numOr(d.strike_price);
            const type: OptionRight = d.contract_type === 'put' ? 'P' : 'C';
            const greeks = c.greeks ?? {};
            const lastQuote = c.last_quote ?? {};
            const bid = numOr(lastQuote.bid);
            const ask = numOr(lastQuote.ask);
            const last = numOr(greeks.last_price ?? c.last_trade?.price ?? (bid + ask) / 2);
            const iv = numOr(greeks.implied_volatility, 0.3);
            const volume = numOr(c.last_trade?.size ?? greeks.size ?? 0);
            const openInterest = numOr(d.open_interest ?? 0);
            if (!expiry || strike <= 0) continue;
            expirySet.add(expiry);
            quotes.push({
              expiry,
              strike,
              type,
              bid,
              ask,
              last,
              volume,
              open_interest: openInterest,
              iv,
              underlying_price: spot,
              underlying_ts: new Date().toISOString(),
            });
          }
          if (quotes.length > 0) {
            return {
              ticker: sym,
              underlying_price: spot,
              quotes,
              expiries: Array.from(expirySet).sort(),
              rfr,
              greeks: chainToGreeksRows(quotes, spot, rfr),
              source: 'polygon',
            };
          }
        }
      }
    } catch {
      /* fall through to mock */
    }
  }

  // Mock fallback (deterministic, parity-safe). But first try Yahoo's tokenless
  // options chain so we show REAL (delayed) data even without a Polygon key.
  // Either way, anchor the mock on the REAL current price (from the Yahoo chart
  // endpoint that also feeds the Quote tab) so a cheap stock like SOFI (~$18)
  // gets ~$18 strikes instead of the old random ~$300 band.
  let realSpot: number | undefined;
  if (doFetch) {
    try {
      const pr = await fetchPriceBars(sym, { interval: '1d', lookbackDays: 5, fetchFn: doFetch as any });
      if (pr.source === 'yahoo' && pr.bars.length > 0) {
        const last = pr.bars[pr.bars.length - 1]!.close;
        if (typeof last === 'number' && last > 0) realSpot = last;
      }
    } catch {
      /* fall through — use the random band */
    }
  }
  const mockBundle = generateMockBundle(sym, realSpot ? { spot: realSpot } : {});
  if (!apiKey) {
    const yahoo = await fetchYahooOptionChain(sym, doFetch);
    if (yahoo) return yahoo;
    // Yahoo was attempted but returned nothing — explain in the console + note so
    // the MOCK result is diagnosable rather than silent.
    console.warn(`[options] ${sym}: returning MOCK chain (spot ${realSpot ? realSpot.toFixed(2) : 'band'} — no POLYGON_API_KEY set and Yahoo tokenless fetch returned no data). Set POLYGON_API_KEY for live, or check the [options] logs above for the Yahoo failure reason.`);
    return {
      ticker: sym,
      underlying_price: mockBundle.underlying_price,
      quotes: mockBundle.option_chain,
      expiries: mockBundle.expiries,
      rfr,
      greeks: chainToGreeksRows(mockBundle.option_chain, mockBundle.underlying_price, rfr),
      source: 'mock',
      note: realSpot
        ? `MOCK — strikes centered on real quote $${realSpot.toFixed(2)}, but no live option chain (no POLYGON_API_KEY and Yahoo tokenless fetch returned no data). See backend [options] logs.`
        : 'MOCK — no live feed. No POLYGON_API_KEY and Yahoo tokenless fetch returned no data. See backend [options] logs.',
    };
  }
  return {
    ticker: sym,
    underlying_price: mockBundle.underlying_price,
    quotes: mockBundle.option_chain,
    expiries: mockBundle.expiries,
    rfr,
    greeks: chainToGreeksRows(mockBundle.option_chain, mockBundle.underlying_price, rfr),
    source: 'mock',
    note: 'Live option chain unavailable — showing deterministic mock chain.',
  };
}

/**
 * Phase I (options ingestion wiring): upgrade a base `HistoricalBundle`
 * (typically the mock bundle) with LIVE price bars + option chain when a
 * Polygon key (and a fetch transport) is available. Returns a bundle whose
 * `mock` flag is `false` only when BOTH the live price bars AND live option
 * chain were successfully acquired; otherwise it keeps the mock fallback for
 * the missing piece(s). This is the glue that lets `options_ingestion` consume
 * real data with zero behavioral change when no key is present (parity).
 */
export interface LiveOptionsResult extends HistoricalBundle {
  /** 'live' when both price bars + chain came from a provider; 'mock' otherwise. */
  source: 'polygon' | 'yahoo' | 'mock';
}

function chainToGreeksRows(
  quotes: OptionQuote[],
  spot: number,
  rfr: number,
): GreeksRow[] {
  const rows: GreeksRow[] = [];
  for (const q of quotes) {
    const ttm = yearsToExpiry(`${q.expiry}T00:00:00.000Z`, new Date());
    const g = bsGreeks(q.type, spot, q.strike, ttm, rfr, q.iv);
    rows.push({
      expiry: q.expiry,
      strike: q.strike,
      type: q.type,
      delta: parseFloat(g.delta.toFixed(4)),
      gamma: parseFloat(g.gamma.toFixed(6)),
      vega: parseFloat(g.vega.toFixed(4)),
      theta: parseFloat(g.theta.toFixed(4)),
      rho: parseFloat(g.rho.toFixed(4)),
      iv_in: q.iv,
      underlying_price: spot,
      ttm_years: parseFloat(ttm.toFixed(6)),
      rfr,
    });
  }
  return rows;
}

export async function resolveLiveOptionsBundle(
  ticker: string,
  profile: HistProfile = {},
  opts: { apiKey?: string; fetchFn?: OptionChainFetchFn } = {},
): Promise<LiveOptionsResult> {
  const base = generateMockBundle(ticker, profile);
  const rfr = base.rfr;

  // Live price bars (Yahoo, tokenless).
  const priceRes = await fetchPriceBars(ticker, {
    interval: profile.intervals?.[0] === '5m' || profile.intervals?.[0] === '1m' ? (profile.intervals[0] as '5m' | '1m') : '1d',
    lookbackDays: profile.lookbackDays ?? 90,
    ...(opts.fetchFn ? { fetchFn: opts.fetchFn as any } : {}),
  });
  const priceMock = priceRes.source === 'mock';

  // Live option chain (Polygon, keyed).
  const chainRes = await fetchOptionChain(ticker, {
    ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
    ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
  });
  const chainMock = chainRes.source === 'mock';

  const price_bars: PriceBarSeries[] = priceMock
    ? base.price_bars
    : [
        {
          interval: priceRes.interval,
          lookback_days: priceRes.lookback_days,
          bars: priceRes.bars,
        },
      ];

  const option_chain = chainMock ? base.option_chain : chainRes.quotes;
  const underlying_price = chainMock ? base.underlying_price : chainRes.underlying_price;
  const greeks = chainToGreeksRows(option_chain, underlying_price, rfr);
  const expiries = chainMock ? base.expiries : chainRes.expiries;

  const live = !priceMock && !chainMock;
  return {
    ticker,
    underlying_price,
    price_bars,
    option_chain,
    greeks,
    rfr,
    expiries,
    iv_history: base.iv_history,
    mock: !live,
    source: live ? 'polygon' : 'mock',
  };
}

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
import { logger } from '../../utils/logger';

// P4: the price-bars + option-chain fetchers moved to adapters/{price-bars,option-chain}.ts.
// hist.ts now owns ONLY the deterministic mock engine + the PURE parsers (no provider
// URLs, no fetch orchestration). OptionChainResult + OptionChainFetchFn types
// live in the adapter layer (../sources/adapters/option-chain) — imported type-only.
import type { OptionChainFetchFn, OptionChainResult } from '../sources/adapters/option-chain';
import type { PriceBarsResult, PriceBarsFetchFn } from '../sources/adapters/price-bars';

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
export function basePrice(ticker: string): number {
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
export function generateBars(
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
// P4: the option-chain fetch orchestration (Massive + CBOE + Yahoo URLs) moved to
// adapters/option-chain.ts. hist.ts keeps ONLY the PURE parsers + the deterministic
// mock bundle (no provider URLs). The fetchers + resolveLiveOptionsBundle live in the
// adapter; consumers import them from there (see option-chain.ts).

function numOr(v: any, fallback = 0): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** True when v is a real, finite number (CBOE occasionally sends null/NaN greeks). */
function isFiniteNum(v: any): boolean {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n);
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

/**
 * PURE parser for CBOE's FREE delayed options feed
 * (https://cdn.cboe.com/api/global/delayed_quotes/options/{TICKER}.json).
 * No API key, no auth. Each row carries the OCC symbol
 * (e.g. NVDA260717C00002500) + bid/ask/iv/delta/gamma/vega/theta/rho/
 * open_interest/volume. We decode the OCC symbol for expiry/strike/right,
 * which removes any dependence on a flaky crumb-based Yahoo path.
 * Returns null when unparseable / empty.
 */
const CBOE_SYMBOL = /^([A-Z]+)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/;
export function parseCboeOptions(ticker: string, payload: any): OptionChainResult | null {
  const data = payload?.data;
  const rows = data?.options;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  // CBOE ships the REAL underlying quote at the top level — use it as spot.
  // (Deriving spot from the median strike, as an earlier version did, made
  // every contract look deep ITM/OTM and pinned recomputed delta to ±1.0.)
  const topSpot = numOr(data.current_price ?? data.close ?? data.prev_day_close, 0);
  const expirySet = new Set<string>();
  const quotes: OptionQuote[] = [];
  const cboeGreeks: Array<{ delta: number | undefined; gamma: number | undefined; vega: number | undefined; theta: number | undefined; rho: number | undefined }> = [];
  let spot = topSpot;
  const now = new Date();
  const rfr = resolveRfr();
  for (const r of rows) {
    const m = CBOE_SYMBOL.exec(String(r.option ?? ''));
    if (!m) continue;
    const yy = m[2], mm = m[3], dd = m[4];
    const expISO = `20${yy}-${mm}-${dd}`;
    const type: OptionRight = m[5] === 'C' ? 'C' : 'P';
    const strike = Number(m[6]) / 1000;
    if (strike <= 0) continue;
    const bid = numOr(r.bid);
    const ask = numOr(r.ask);
    const last = numOr(r.last_trade_price ?? r.theo ?? (bid + ask) / 2);
    // CBOE reports IV as a DECIMAL already (e.g. 0.7709 = 77%). Do NOT /100.
    // CBOE sometimes sends 0 IV for illiquid deep-ITM contracts; treat 0 as
    // "missing" so it doesn't poison the vol-surface analyst (ATM IV/skew).
    const rawIv = numOr(r.iv, 0);
    const iv = rawIv > 0 ? rawIv : 0.3;
    const volume = numOr(r.volume ?? 0);
    const openInterest = numOr(r.open_interest ?? 0);
    expirySet.add(expISO);
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
    // Capture CBOE's own greeks (they are correct + smooth); undefined when
    // the feed omits a field so we can BS-fill just that gap below.
    cboeGreeks.push({
      delta: isFiniteNum(r.delta) ? Number(r.delta) : undefined,
      gamma: isFiniteNum(r.gamma) ? Number(r.gamma) : undefined,
      vega: isFiniteNum(r.vega) ? Number(r.vega) : undefined,
      theta: isFiniteNum(r.theta) ? Number(r.theta) : undefined,
      rho: isFiniteNum(r.rho) ? Number(r.rho) : undefined,
    });
  }
  if (quotes.length === 0) return null;
  // Fallback only if CBOE gave no usable underlying quote.
  if (!spot) {
    const near = Array.from(expirySet).sort()[0];
    const nearStrikes = quotes.filter((q) => q.expiry === near).map((q) => q.strike).sort((a, b) => a - b);
    spot = nearStrikes.length ? (nearStrikes[Math.floor(nearStrikes.length / 2)] ?? basePrice(ticker)) : basePrice(ticker);
  }
  for (const q of quotes) q.underlying_price = spot;
  // Prefer CBOE's published greeks; BS-fill any missing field per row so the
  // greeks column is smooth and delta ≈ 0.5 at-the-money, not a step to ±1.
  const greeks: GreeksRow[] = quotes.map((q, i) => {
    const c = cboeGreeks[i] ?? { delta: undefined, gamma: undefined, vega: undefined, theta: undefined, rho: undefined };
    const ttm = yearsToExpiry(`${q.expiry}T00:00:00.000Z`, now);
    const needsFill = c.delta === undefined || c.gamma === undefined || c.vega === undefined || c.theta === undefined || c.rho === undefined;
    const bs = needsFill ? bsGreeks(q.type, spot, q.strike, ttm, rfr, q.iv) : null;
    return {
      expiry: q.expiry,
      strike: q.strike,
      type: q.type,
      delta: parseFloat((c.delta ?? bs!.delta).toFixed(4)),
      gamma: parseFloat((c.gamma ?? bs!.gamma).toFixed(6)),
      vega: parseFloat((c.vega ?? bs!.vega).toFixed(4)),
      theta: parseFloat((c.theta ?? bs!.theta).toFixed(4)),
      rho: parseFloat((c.rho ?? bs!.rho).toFixed(4)),
      iv_in: q.iv,
      underlying_price: spot,
      ttm_years: parseFloat(ttm.toFixed(6)),
      rfr,
    };
  });
  return {
    ticker: ticker.toUpperCase(),
    underlying_price: spot,
    quotes,
    expiries: Array.from(expirySet).sort(),
    rfr,
    greeks,
    source: 'cboe',
    note: 'Delayed ~15-20 min — free CBOE delayed options feed (real bid/ask/IV + greeks).',
  };
}

/** PURE parser: Polygon v3 options snapshot payload → OptionQuote[].
 *  Accepts either the raw `results` object (v3 shape: { ticker, underlying_asset,
 *  options: [...] }) or the bare options array. Extracted from acquireOptionChain
 *  so the §4.9 acquisition engine (which may have already fetched + validated the
 *  snapshot) can reuse the exact same parsing without re-fetching. Returns null
 *  when the payload is unusable. */
export function parsePolygonChainResults(payload: any, ticker: string): OptionChainResult | null {
  const sym = String(ticker).trim().toUpperCase();
  // Normalize to the options array regardless of how the caller sliced it.
  // Real Polygon v3 /snapshot/options/{ticker} nests under
  // `results.options.calls` + `results.options.puts`; older/mock shapes use a
  // flat `options` (or `results`) array. Flatten all of them.
  let results: any[] = [];
  if (Array.isArray(payload)) {
    results = payload;
  } else if (Array.isArray(payload?.options)) {
    results = payload.options;
  } else if (Array.isArray(payload?.results) && Array.isArray(payload.results[0]?.details)) {
    // results is already a flat contract array.
    results = payload.results;
  } else if (payload?.results?.options) {
    // Real v3 nested shape.
    const o = payload.results.options;
    results = [...(o.calls ?? []), ...(o.puts ?? [])];
    if (payload.underlying_asset == null && payload.results.underlying_asset) {
      payload = { ...payload, underlying_asset: payload.results.underlying_asset };
    }
  } else if (Array.isArray(payload?.results)) {
    results = payload.results;
  }
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
 * Phase I (options ingestion wiring): upgrade a base `HistoricalBundle`
 * (typically the mock bundle) with LIVE price bars + option chain when a
 * Polygon key (and a fetch transport) is available. Returns a bundle whose
 * `mock` flag is `false` only when BOTH the live price bars AND live option
 * chain were successfully acquired; otherwise it keeps the mock fallback for
 * the missing piece(s). This is the glue that lets `options_ingestion` consume
 * real data with zero behavioral change when no key is present (parity).
 */

export function chainToGreeksRows(
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

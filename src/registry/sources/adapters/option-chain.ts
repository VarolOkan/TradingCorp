// src/registry/sources/adapters/option-chain.ts
// P4 (docs/ARCHITECTURE.md §Multi-Source Data Architecture, P4). Relocation of the option-chain
// acquisition logic out of the legacy hist.ts fetcher and into the adapter layer
// (allow-listed by the grep guard — every provider URL now lives in `adapters/`
// or `DEFAULT_SOURCE_URIS`). The PARSE half (parseCboeOptions / parseYahooOptions
// / parsePolygonChainResults) and the deterministic mock fallback (generateMockBundle)
// stay in hist.ts as shared utils; this file owns the TRANSPORT + fallback orchestration.
//
// Behavior is byte-for-byte identical to the original `hist.acquireOptionChain`
// (verified by domains.p0.test.ts + options-history.test.ts + hist.test.ts).

import {
  parseCboeOptions,
  parseYahooOptions,
  parsePolygonChainResults,
  generateMockBundle,
  chainToGreeksRows,
} from '../../logic/hist';
import type { HistProfile } from '../../logic/hist';
import type { OptionChain, PriceBarSeries, HistoricalBundle } from '../../../types/financial-analysis';
import { resolveRfr } from '../../logic/greeks';
import { acquirePriceBars } from './price-bars';
import { logger } from '../../../utils/logger';

// Canonical option-chain types live HERE (the adapter layer). hist.ts re-exports
// them type-only for backward-compat (erased at compile time, so no runtime cycle).
export type OptionChainFetchFn = (url: string, headers?: Record<string, string>) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  json: () => Promise<any>;
}>;

export interface OptionChainResult extends OptionChain {
  source: 'polygon' | 'yahoo' | 'cboe' | 'mock';
  note?: string;
}

// Backward-compat alias removed: callers + tests now import `acquireOptionChain`.
// (Self-alias within the adapter — no import cycle.)

// Provider URLs now live in the adapter layer (grep-guard compliant).
const MASSIVE_SNAPSHOT = (ticker: string) =>
  `https://api.massive.com/v3/snapshot/options/${encodeURIComponent(ticker.toUpperCase())}`;
const CBOE_DELAYED = (ticker: string) =>
  `https://cdn.cboe.com/api/global/delayed_quotes/options/${encodeURIComponent(ticker.toUpperCase())}.json`;
const YAHOO_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

/** Fetches + parses the CBOE delayed options feed. No key required. */
export async function fetchCboeOptionChain(
  ticker: string,
  gf?: (url: string, init?: any) => Promise<any>,
): Promise<OptionChainResult | null> {
  const fetchFn = gf ?? ((globalThis as any).fetch as ((url: string, init?: any) => Promise<any>) | undefined);
  if (typeof fetchFn !== 'function') {
    logger.warn(`[options] CBOE fallback skipped for ${ticker}: no fetch transport available.`);
    return null;
  }
  try {
    const res = await fetchFn(CBOE_DELAYED(ticker), { method: 'GET', headers: { 'User-Agent': YAHOO_UA, Accept: 'application/json' } });
    if (!res || !res.ok) {
      logger.warn(`[options] CBOE fallback failed for ${ticker}: HTTP ${res?.status ?? 'no-response'}. Falling back.`);
      return null;
    }
    const payload = (await res.json().catch(() => null)) as any;
    const parsed = parseCboeOptions(ticker, payload);
    if (parsed) {
      logger.info(`[options] CBOE delayed feed OK for ${ticker}: ${parsed.quotes.length} quotes across ${parsed.expiries.length} expiry.`);
    } else {
      logger.warn(`[options] CBOE fallback returned an unparseable/empty payload for ${ticker}.`);
    }
    return parsed;
  } catch (e) {
    logger.warn(`[options] CBOE fallback errored for ${ticker}: ${e instanceof Error ? e.message : String(e)}.`);
    return null;
  }
}

/** Tokenless Yahoo options chain (v7/finance/options) + quoteSummary fallback. */
async function fetchYahooOptionChain(
  ticker: string,
  gf?: (url: string, init?: any) => Promise<any>,
): Promise<OptionChainResult | null> {
  const fetchFn = gf ?? ((globalThis as any).fetch as ((url: string, init?: any) => Promise<any>) | undefined);
  if (typeof fetchFn !== 'function') {
    logger.warn(`[options] Yahoo fallback skipped for ${ticker}: no fetch transport available (globalThis.fetch undefined and no injected fetchFn).`);
    return null;
  }
  try {
    const seed = await fetchFn('https://fc.yahoo.com', { method: 'GET', redirect: 'manual', headers: { 'User-Agent': YAHOO_UA } });
    const setCookie =
      typeof (seed.headers as any).getSetCookie === 'function'
        ? (seed.headers as any).getSetCookie()
        : [seed.headers.get('set-cookie')].filter(Boolean);
    const cookie = (setCookie as string[]).map((c) => c.slice(0, c.indexOf(';'))).join('; ');
    const crumbRes = await fetchFn('https://query2.finance.yahoo.com/v1/test/getcrumb', {
      method: 'GET',
      redirect: 'manual',
      headers: { 'User-Agent': YAHOO_UA, ...(cookie ? { Cookie: cookie } : {}) },
    });
    const crumb = (await crumbRes.text()).trim();
    if (!crumb) {
      logger.warn(`[options] Yahoo fallback failed for ${ticker}: crumb endpoint returned empty (status ${crumbRes.status}). Falling back to MOCK.`);
      return null;
    }
    const res = await fetchYahooWithRetry(
      fetchFn,
      `https://query2.finance.yahoo.com/v7/finance/options/${encodeURIComponent(ticker.toUpperCase())}?crumb=${encodeURIComponent(crumb)}`,
      { 'User-Agent': YAHOO_UA, ...(cookie ? { Cookie: cookie } : {}) },
    );
    if (!res) {
      logger.warn(`[options] Yahoo fallback failed for ${ticker}: options request returned no response (network/timeout). Falling back to MOCK.`);
      return null;
    }
    if (!res.ok) {
      logger.warn(`[options] Yahoo v7 options HTTP ${res.status} for ${ticker}; trying quoteSummary optionChain module instead.`);
      const qsUrl = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker.toUpperCase())}?modules=optionChain&crumb=${encodeURIComponent(crumb)}`;
      const qsRes = await fetchYahooWithRetry(fetchFn, qsUrl, { 'User-Agent': YAHOO_UA, ...(cookie ? { Cookie: cookie } : {}) });
      if (qsRes && qsRes.ok) {
        const qsPayload = (await qsRes.json().catch(() => null)) as any;
        const adapted = { optionChain: { result: [{ quote: qsPayload?.quoteSummary?.result?.[0]?.price ?? {}, options: qsPayload?.quoteSummary?.result?.[0]?.optionChain?.options ?? [] }] } };
        const parsedQs = parseYahooOptions(ticker, adapted);
        if (parsedQs) {
          logger.info(`[options] Yahoo quoteSummary fallback OK for ${ticker}: ${parsedQs.quotes.length} quotes (source=${parsedQs.source}).`);
          return parsedQs;
        }
      }
      logger.warn(`[options] Yahoo fallback failed for ${ticker}: options request HTTP ${res.status} (likely 429 rate-limit or 401). Falling back to MOCK.`);
      return null;
    }
    const payload = (await res.json().catch(() => null)) as any;
    const parsed = parseYahooOptions(ticker, payload);
    if (!parsed) {
      logger.warn(`[options] Yahoo fallback returned an unparseable/empty payload for ${ticker} (check optionChain.result[0].options[].calls/puts). Falling back to MOCK.`);
      return null;
    }
    logger.info(`[options] Yahoo fallback OK for ${ticker}: ${parsed.quotes.length} quotes across ${parsed.expiries.length} expiry (source=${parsed.source}).`);
    return parsed;
  } catch (e) {
    logger.warn(`[options] Yahoo fallback errored for ${ticker}: ${e instanceof Error ? e.message : String(e)}. Falling back to MOCK.`);
    return null;
  }
}

/** Fetch a URL with a few short retries (handles Yahoo's intermittent 429s). */
async function fetchYahooWithRetry(gf: (u: string, i?: any) => Promise<any>, url: string, headers: Record<string, string>, tries = 3): Promise<any> {
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
 * Acquire a REAL option chain (Polygon/Massive keyed live path, then CBOE /
 * Yahoo free delayed fallbacks), mapped into the `OptionChain` shape. Falls back
 * to the deterministic seeded `generateMockBundle` chain when no transport / key
 * and all free feeds are unreachable (parity-safe).
 *
 * Behavior is byte-for-byte identical to the original `hist.fetchOptionChain`.
 */
export async function acquireOptionChain(
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
  // Captures WHY a keyed live attempt failed, so the eventual MOCK note can say
  // "key was set but live call returned 401" instead of a misleading silent mock.
  let lastLiveError: string | undefined;
  if (typeof doFetch === 'function' && (apiKey || fetchInjected)) {
    try {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
      const res = await doFetch(MASSIVE_SNAPSHOT(sym), apiKey ? headers : undefined);
      const rawText = await res.text().catch(() => '');
      if (res.ok) {
        const payload = (() => { try { return JSON.parse(rawText); } catch { return null; } })();
        const parsed = parsePolygonChainResults(payload?.results, sym) ?? parsePolygonChainResults(payload, sym);
        if (parsed && parsed.quotes.length > 0) return parsed;
      } else {
        let providerMsg = '';
        try {
          const b = JSON.parse(rawText);
          if (b && typeof b.message === 'string') providerMsg = b.message;
        } catch { /* non-JSON body */ }
        logger.warn(`[options] ${sym}: live Polygon/Massive call returned ${res.status} (ok=${res.ok}) with no usable option chain${providerMsg ? ` — ${providerMsg}` : ''}. Falling back to MOCK.`);
        lastLiveError = providerMsg
          ? `live call returned HTTP ${res.status} (${providerMsg})`
          : `live call returned HTTP ${res.status}`;
      }
    } catch (e) {
      logger.warn(`[options] ${sym}: live Polygon/Massive call errored: ${e instanceof Error ? e.message : String(e)}. Falling back to MOCK.`);
      lastLiveError = e instanceof Error ? e.message : String(e);
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
      const pr = await acquirePriceBars(sym, { interval: '1d', lookbackDays: 5, fetchFn: doFetch as any });
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
    // Real delayed data, no key: CBOE's free feed first (Yahoo's tokenless
    // path is now 429/crumb-blocked, so it's a last-resort fallback).
    const cboe = await fetchCboeOptionChain(sym, doFetch);
    if (cboe) return cboe;
    const yahoo = await fetchYahooOptionChain(sym, doFetch);
    if (yahoo) return yahoo;
    logger.warn(`[options] ${sym}: returning MOCK chain (spot ${realSpot ? realSpot.toFixed(2) : 'band'} — no POLYGON_API_KEY set and Yahoo tokenless fetch returned no data). Set POLYGON_API_KEY for live, or check the [options] logs above for the Yahoo failure reason.`);
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
  // Before falling back to a deterministic MOCK, try CBOE's free delayed
  // feed. This is the honest "real bid/ask another way" path: it needs no
  // key, so it works whether or not a (entitlement-blocked) Massive key is
  // set. We prefer real delayed data over a synthetic mock wherever possible.
  const cboe = await fetchCboeOptionChain(sym, doFetch);
  if (cboe) return cboe;

  return {
    ticker: sym,
    underlying_price: mockBundle.underlying_price,
    quotes: mockBundle.option_chain,
    expiries: mockBundle.expiries,
    rfr,
    greeks: chainToGreeksRows(mockBundle.option_chain, mockBundle.underlying_price, rfr),
    source: 'mock',
    note: lastLiveError
      ? `MOCK — a Massive/Polygon key was configured but the live option-chain call failed (${lastLiveError}). See backend [options] logs.`
      : 'Live option chain unavailable — showing deterministic mock chain.',
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
 *
 * P4: moved from hist.ts to the adapter layer. Uses the domain acquire
 * functions directly (no resolveDomain hop) to avoid an import cycle.
 */
export interface LiveOptionsResult extends HistoricalBundle {
  /** 'live' when both price bars + chain came from a provider; 'mock' otherwise. */
  source: 'polygon' | 'yahoo' | 'cboe' | 'mock';
  /** True when the option CHAIN was acquired live (drives the Options-tab badge). */
  chainLive?: boolean;
  /** True when the historical price BARS were acquired live (tracked separately). */
  barsLive?: boolean;
  /** Provenance note (e.g. Massive 401 entitlement story, or CBOE delayed feed). */
  note?: string;
}

export async function resolveLiveOptionsBundle(
  ticker: string,
  profile: HistProfile = {},
  opts: { apiKey?: string; fetchFn?: OptionChainFetchFn } = {},
): Promise<LiveOptionsResult> {
  const base = generateMockBundle(ticker, profile);
  const rfr = base.rfr;

  // Live price bars (Yahoo, tokenless).
  const priceRes = await acquirePriceBars(ticker, {
    interval: profile.intervals?.[0] === '5m' || profile.intervals?.[0] === '1m' ? (profile.intervals[0] as '5m' | '1m') : '1d',
    lookbackDays: profile.lookbackDays ?? 90,
    fetchFn: opts.fetchFn as any,
  });
  const priceMock = priceRes.source === 'mock';

  // Live option chain (Polygon, keyed).
  const chainRes = await acquireOptionChain(ticker, {
    ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
    ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
  });
  const chainMock = chainRes.source === 'mock';

  // Real-bid/ask fallback: if the keyed Polygon path wasn't entitled (or no
  // key), try CBOE's free delayed feed before settling for a synthetic mock
  // chain. This keeps the vol-surface / pricing analysts on REAL data.
  let chainFinal = chainRes;
  if (chainMock) {
    const gf = opts.fetchFn ?? ((globalThis as any).fetch as ((u: string, i?: any) => Promise<any>) | undefined);
    const cboe = await fetchCboeOptionChain(ticker, gf as any);
    if (cboe) chainFinal = cboe;
  }

  const price_bars: PriceBarSeries[] = priceMock
    ? base.price_bars
    : [
        {
          interval: priceRes.interval,
          lookback_days: priceRes.lookback_days,
          bars: priceRes.bars,
        },
      ];

  const option_chain = chainFinal.source === 'mock' ? base.option_chain : chainFinal.quotes;
  const underlying_price = chainFinal.source === 'mock' ? base.underlying_price : chainFinal.underlying_price;
  const greeks = chainToGreeksRows(option_chain, underlying_price, rfr);
  const expiries = chainFinal.source === 'mock' ? base.expiries : chainFinal.expiries;

  const live = !priceMock && chainFinal.source !== 'mock';
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
    source: chainFinal.source,
    ...(chainFinal.note ? { note: chainFinal.note } : {}),
  };
}

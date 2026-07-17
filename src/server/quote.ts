// src/server/quote.ts
// Phase I: lightweight market-quote endpoint used by the frontend to show a
// ticker's company name + a rich set of market stats (price, change, day
// range, 52-week range, volume vs average, exchange, session state, etc.)
// right after the user enters a symbol.
//
// Source: Yahoo Finance chart endpoint (tokenless; works without an API key
// for the demo). The fetch is transport-injected so unit tests can drive every
// branch with a mock (no network in tests). Failures are graceful: the route
// returns a `note` instead of throwing, so the UI can show "unavailable".
//
// Everything below is derived from a SINGLE tokenless chart call, so the Quote
// tab stays fully populated even when the market is closed (at which point Yahoo
// stops populating most `meta` fields — we recover them from the OHLCV series):
//   { symbol, name, price, open, change, changePct, dayHigh, dayLow,
//     previousClose, week52High, week52Low, yearChangePct, volume, avgVolume3m,
//     currency, exchange, marketState, delaySec, timezoneOffsetMin,
//     marketCap, sharesOut, floatShares, avgVolume10d, dividendYield, peTTM,
//     epsTTM, priceToSales, priceToBook, earningsDate,
//     marketTime, source, note? }
//
// The fundamentals block (market cap … earnings date) is filled best-effort
// from Yahoo's quoteSummary endpoint via a tokenless crumb dance; when that
// call is unavailable the fields are simply null and the UI omits them.

import { logger } from '../utils/logger';

export interface QuoteResult {
  symbol: string;
  name: string | null;
  price: number | null;
  open: number | null;
  /** Absolute change vs previous close (price - previousClose). */
  change: number | null;
  /** Percent change vs previous close. */
  changePct: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  previousClose: number | null;
  week52High: number | null;
  week52Low: number | null;
  /** Approx. 1-year change % (latest close vs first available close). */
  yearChangePct: number | null;
  volume: number | null;
  /** Trailing ~3-month average daily volume (mean of last 63 bars, or Yahoo avgVolume). */
  avgVolume3m: number | null;
  currency: string | null;
  /** Human exchange name, e.g. "NasdaqGS". */
  exchange: string | null;
  /** Session state: PRE | REGULAR | MIDPOST | POST | CLOSED. */
  marketState: string | null;
  /** Data latency in seconds (Yahoo `exchangeDataDelayedBy`). */
  delaySec: number | null;
  /** Exchange UTC offset in minutes (Yahoo `gmtOffSetMilliseconds`). */
  timezoneOffsetMin: number | null;
  marketTime: number | null;
  // --- Fundamentals (quoteSummary; tokenless crumb dance, best-effort) ---
  marketCap: number | null;
  sharesOut: number | null;
  floatShares: number | null;
  avgVolume10d: number | null;
  dividendYield: number | null;
  peTTM: number | null;
  epsTTM: number | null;
  priceToSales: number | null;
  priceToBook: number | null;
  /** Next earnings report date, ISO 'YYYY-MM-DD' (Yahoo calendarEvents). */
  earningsDate: string | null;
  source: 'yahoo';
  note?: string;
}

export type FetchFn = (url: string) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<any>;
}>;

// Fundamentals need a cookie-aware fetch: Yahoo's quoteSummary requires a
// session cookie + crumb, so the three requests (cookie seed → crumb →
// summary) must share a cookie jar and a User-Agent. We keep this as its own
// fetch type (which the production server provides) so unit tests can inject a
// mock that returns canned crumb/summary bodies without any network.
export type FundFetchFn = (url: string) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<any>;
  /** Raw body text. Yahoo's crumb endpoint returns a bare string (not JSON),
   * so callers must use this for the crumb step. */
  text: () => Promise<string>;
}>;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/**
 * Build a cookie-aware fetch for Yahoo fundamentals (tokenless crumb dance).
 * Shares an in-memory cookie jar across the three requests (cookie seed →
 * crumb → summary). Redirects are followed MANUALLY (not via fetch's
 * redirect:'follow') because undici's automatic follow DROPS the intermediate
 * redirect's Set-Cookie — and Yahoo's fc.yahoo.com sets the A3 session cookie
 * on a 302. If we let undici auto-follow, no cookie is ever captured and the
 * crumb request comes back empty. Handling redirects by hand lets us ingest the
 * cookie at every hop. Gzip is handled by the global fetch automatically.
 */
export function makeYahooFundFetch(): FundFetchFn {
  const jar = new Map<string, string>();
  const ingestCookies = (res: globalThis.Response) => {
    const list =
      typeof (res.headers as any).getSetCookie === 'function'
        ? (res.headers as any).getSetCookie()
        : [res.headers.get('set-cookie')].filter(Boolean);
    for (const c of list as string[]) {
      const eq = c.indexOf('=');
      if (eq < 0) continue;
      const key = c.slice(0, eq).trim();
      const val = c.slice(eq + 1, c.indexOf(';')).trim();
      if (key) jar.set(key, val);
    }
  };
  const cookieHeader = () => {
    const parts: string[] = [];
    jar.forEach((v, k) => parts.push(`${k}=${v}`));
    return parts.join('; ');
  };
  const gf = (globalThis as any).fetch as (url: string, init?: any) => Promise<globalThis.Response>;
  const doFetch = async (url: string) => {
    const res = await gf(url, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        'User-Agent': UA,
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        ...(cookieHeader() ? { Cookie: cookieHeader() } : {}),
      },
    });
    ingestCookies(res);
    return res;
  };
  return async (url: string) => {
    try {
      let res = await doFetch(url);
      // Manually follow 3xx (updating the cookie jar at each hop).
      let hops = 0;
      while (res.status >= 300 && res.status < 400 && hops < 5) {
        const loc = res.headers.get('location');
        if (!loc) break;
        res = await doFetch(loc.startsWith('http') ? loc : new URL(loc, url).toString());
        hops++;
      }
      const text = await res.text();
      return {
        ok: res.status < 400,
        status: res.status,
        text: async () => text,
        json: async () => {
          try {
            return JSON.parse(text);
          } catch {
            return {};
          }
        },
      };
    } catch (err) {
      logger.warn(`[quote] fundamentals fetch error: ${err instanceof Error ? err.message : String(err)}`);
      return { ok: false, status: 0, text: async () => '', json: async () => ({}) };
    }
  };
}

export interface Fundamentals {
  marketCap: number | null;
  sharesOut: number | null;
  floatShares: number | null;
  avgVolume3m: number | null;
  avgVolume10d: number | null;
  dividendYield: number | null;
  peTTM: number | null;
  epsTTM: number | null;
  priceToSales: number | null;
  priceToBook: number | null;
  earningsDate: string | null;
}

const rawNum = (v: any): number | null => {
  if (!v || typeof v !== 'object') return null;
  const n = typeof v.raw === 'number' ? v.raw : Number(v.raw);
  return Number.isFinite(n) ? n : null;
};

/**
 * Fetch company fundamentals via Yahoo's quoteSummary endpoint using the
 * tokenless crumb dance. Best-effort: any failure returns all-null fields
 * (the quote tab simply omits them) rather than throwing.
 */
export async function fetchFundamentals(symbol: string, fundFetch: FundFetchFn): Promise<Fundamentals> {
  const sym = symbol.trim().toUpperCase();
  const empty: Fundamentals = {
    marketCap: null,
    sharesOut: null,
    floatShares: null,
    avgVolume3m: null,
    avgVolume10d: null,
    dividendYield: null,
    peTTM: null,
    epsTTM: null,
    priceToSales: null,
    priceToBook: null,
    earningsDate: null,
  };
  try {
    // 1) Seed a session cookie.
    await fundFetch('https://fc.yahoo.com');
    // 2) Acquire a crumb. The crumb endpoint returns a BARE STRING, not JSON,
    // so read it as text. Strip any surrounding whitespace before use.
    const crumbRes = await fundFetch(`https://query2.finance.yahoo.com/v1/test/getcrumb`);
    const crumb = (await crumbRes.text()).trim();
    if (!crumb || crumb.length === 0) {
      // Yahoo blocked the crumb (rate-limit / consent wall). Fundamentals are
      // omitted gracefully; surface a server-log hint for diagnosis.
      logger.warn(`[quote] fundamentals crumb unavailable for ${sym} (status ${crumbRes.status}); fundamentals omitted`);
      return empty;
    }
    // 3) Pull the four modules we need.
    const url =
      `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${sym}` +
      `?modules=price,summaryDetail,defaultKeyStatistics,calendarEvents&crumb=${encodeURIComponent(crumb)}`;
    const sumRes = await fundFetch(url);
    const payload = (await sumRes.json()) as any;
    const res = payload?.quoteSummary?.result?.[0];
    if (!res) return empty;
    const price = res.price ?? {};
    const sd = res.summaryDetail ?? {};
    const ks = res.defaultKeyStatistics ?? {};
    const cal = res.calendarEvents ?? {};
    let earningsDate: string | null = null;
    const ed = cal?.earnings?.earningsDate;
    if (Array.isArray(ed) && ed.length > 0 && ed[0]?.fmt) earningsDate = String(ed[0].fmt);
    return {
      marketCap: rawNum(price.marketCap),
      sharesOut: rawNum(ks.sharesOutstanding),
      floatShares: rawNum(ks.floatShares),
      avgVolume3m: rawNum(sd.averageVolume),
      avgVolume10d: rawNum(sd.averageVolume10days),
      dividendYield: rawNum(sd.dividendYield),
      peTTM: rawNum(sd.trailingPE),
      epsTTM: rawNum(sd.epsTrailingTwelveMonths),
      priceToSales: rawNum(sd.priceToSalesTrailing12Months),
      priceToBook: rawNum(sd.priceToBook),
      earningsDate,
    };
  } catch {
    return empty;
  }
}

const YAHOO = (symbol: string) =>
  `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol).toUpperCase()}?range=1y&interval=1d`;

const num = (v: any): number | null => {
  if (v === undefined || v === null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

// Mean of the trailing `n` finite values of an array (skips nulls).
const trailingMean = (arr: any[] | undefined, n: number): number | null => {
  if (!Array.isArray(arr)) return null;
  const tail = arr.slice(-n).filter((v) => v !== null && v !== undefined && Number.isFinite(v));
  if (tail.length === 0) return null;
  return tail.reduce((s, v) => s + (v as number), 0) / tail.length;
};

// Normalize Yahoo's marketState enum to a small, UI-friendly set.
const marketStateOf = (raw: any): string | null => {
  if (typeof raw !== 'string') return null;
  const s = raw.toUpperCase();
  if (s === 'PRE' || s === 'PREPRE') return 'PRE';
  if (s === 'REGULAR') return 'REGULAR';
  if (s === 'MIDPOST' || s === 'POSTPOST') return 'MIDPOST';
  if (s === 'POST') return 'POST';
  return 'CLOSED';
};

export async function fetchQuote(symbol: string, fetchFn?: FetchFn, fundFetch?: FundFetchFn): Promise<QuoteResult> {
  const sym = symbol.trim().toUpperCase();
  const base: QuoteResult = {
    symbol: sym,
    name: null,
    price: null,
    open: null,
    change: null,
    changePct: null,
    dayHigh: null,
    dayLow: null,
    previousClose: null,
    week52High: null,
    week52Low: null,
    yearChangePct: null,
    volume: null,
    avgVolume3m: null,
    currency: null,
    exchange: null,
    marketState: null,
    delaySec: null,
    timezoneOffsetMin: null,
    marketCap: null,
    sharesOut: null,
    floatShares: null,
    avgVolume10d: null,
    dividendYield: null,
    peTTM: null,
    epsTTM: null,
    priceToSales: null,
    priceToBook: null,
    earningsDate: null,
    marketTime: null,
    source: 'yahoo',
  };

  const doFetch = fetchFn ?? ((url: string) => (globalThis as any).fetch(url));
  if (typeof doFetch !== 'function') {
    return { ...base, note: 'No fetch implementation available' };
  }

  let res;
  try {
    res = await doFetch(YAHOO(sym));
  } catch (err) {
    return { ...base, note: `quote fetch failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!res.ok) {
    return { ...base, note: `quote source returned HTTP ${res.status}` };
  }

  let payload: any;
  try {
    payload = await res.json();
  } catch {
    return { ...base, note: 'quote source returned unreadable payload' };
  }

  const result = payload?.chart?.result?.[0];
  if (!result) {
    return { ...base, note: payload?.chart?.error?.description ?? 'no quote data' };
  }

  const meta = result.meta ?? {};
  const quote = result.indicators?.quote?.[0] ?? {};
  const ts: number[] = result.timestamp ?? [];
  const lastIdx = ts.length > 0 ? ts.length - 1 : -1;
  const closeArr: number[] = quote.close ?? [];
  const highArr: number[] = quote.high ?? [];
  const lowArr: number[] = quote.low ?? [];
  const volArr: number[] = quote.volume ?? [];
  const openArr: number[] = quote.open ?? [];

  const lastClose = lastIdx >= 0 && closeArr[lastIdx] !== undefined ? closeArr[lastIdx] : undefined;
  const lastOpen = lastIdx >= 0 && openArr[lastIdx] !== undefined ? openArr[lastIdx] : undefined;
  const lastHigh = lastIdx >= 0 && highArr[lastIdx] !== undefined ? highArr[lastIdx] : undefined;
  const lastLow = lastIdx >= 0 && lowArr[lastIdx] !== undefined ? lowArr[lastIdx] : undefined;
  const lastVol = lastIdx >= 0 && volArr[lastIdx] !== undefined ? volArr[lastIdx] : undefined;

  // Previous close: prefer meta, else derive from the prior daily bar.
  const prevClose = num(meta.previousClose) ?? (closeArr.length > 1 ? num(closeArr[closeArr.length - 2]) : null);

  // 52-week high/low: prefer meta, else derive from the trailing ~252 bars.
  const w52High = num(meta.fiftyTwoWeekHigh) ?? (() => {
    const h = highArr.slice(-252).filter((v: any) => v !== null && Number.isFinite(v));
    return h.length ? Math.max(...h) : null;
  })();
  const w52Low = num(meta.fiftyTwoWeekLow) ?? (() => {
    const l = lowArr.slice(-252).filter((v: any) => v !== null && Number.isFinite(v));
    return l.length ? Math.min(...l) : null;
  })();

  const price = num(meta.regularMarketPrice) ?? num(lastClose);
  const change = price !== null && prevClose !== null ? +(price - prevClose).toFixed(2) : null;
  const changePct = price !== null && prevClose !== null && prevClose !== 0 ? +(((price - prevClose) / prevClose) * 100).toFixed(2) : null;

  // Approx. 1-year change %: latest close vs first available close.
  const firstClose = closeArr.find((v) => v !== null && Number.isFinite(v));
  const yearChangePct =
    price !== null && firstClose !== undefined && firstClose !== null && firstClose !== 0
      ? +(((price - firstClose) / firstClose) * 100).toFixed(2)
      : null;

  const avgVolume3m = trailingMean(volArr, 63);

  // Best-effort fundamentals (tokenless crumb dance). Only attempted when a
  // fundamentals fetch is injected (production); unit tests omit it so they
  // stay network-free. Any failure yields nulls (UI omits the fields).
  let fundamentals: Fundamentals | null = null;
  if (fundFetch) {
    fundamentals = await fetchFundamentals(sym, fundFetch);
  }

  return {
    ...base,
    name: meta.longName || meta.shortName || null,
    price,
    open: num(lastOpen),
    change,
    changePct,
    dayHigh: num(lastHigh),
    dayLow: num(lastLow),
    previousClose: prevClose,
    week52High: w52High,
    week52Low: w52Low,
    yearChangePct,
    volume: num(lastVol),
    avgVolume3m: fundamentals?.avgVolume3m ?? avgVolume3m,
    currency: meta.currency ?? null,
    exchange: meta.fullExchangeName || meta.exchangeName || null,
    marketState: marketStateOf(meta.marketState),
    delaySec: num(meta.exchangeDataDelayedBy),
    timezoneOffsetMin:
      meta.gmtOffSetMilliseconds != null ? Math.round(meta.gmtOffSetMilliseconds / 60000) : null,
    marketTime: num(meta.regularMarketTime) ?? (lastIdx >= 0 ? num(ts[lastIdx]) : null),
    marketCap: fundamentals?.marketCap ?? null,
    sharesOut: fundamentals?.sharesOut ?? null,
    floatShares: fundamentals?.floatShares ?? null,
    avgVolume10d: fundamentals?.avgVolume10d ?? null,
    dividendYield: fundamentals?.dividendYield ?? null,
    peTTM: fundamentals?.peTTM ?? null,
    epsTTM: fundamentals?.epsTTM ?? null,
    priceToSales: fundamentals?.priceToSales ?? null,
    priceToBook: fundamentals?.priceToBook ?? null,
    earningsDate: fundamentals?.earningsDate ?? null,
  };
}

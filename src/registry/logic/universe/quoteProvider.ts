// src/registry/logic/universe/quoteProvider.ts
// Phase 1: batch quote fetcher for the pre-filter (SERVER-SIDE).
//
// VERIFIED live (HTTP 200) on 2026-07-15: Yahoo v7/finance/quote
//   https://query1.finance.yahoo.com/v7/finance/quote?symbols=AAPL,MSFT,...
// returns price + exchange + averageDailyVolume3Month in ONE call; batch
// ~50-200 symbols/request so a 3k pool = ~30 cached requests/day.
//
// Design: batch ~100 symbols/req, space them ~120ms, cache results 24h
// to disk (.data/quotes-cache.json) so a WARM screen costs ~0 network
// calls. On any failure (429/network) return [] so the caller falls back
// to cache/empty and never hard-fails the screen.
//
// The fetch is INJECTABLE for tests (mock returns canned JSON).
import { realFetch, type FetchFn } from './sharedFetch';
import type { Exchange, Quote } from './types';

const QUOTE_URL = 'https://query1.finance.yahoo.com/v7/finance/quote';
const CHUNK = 100;
const SPACE_MS = 120;
const MAX_RETRIES = 4; // survive transient 429/5xx (Yahoo rate-limits cold batches)
const BASE_BACKOFF_MS = 700;

export interface QuoteProviderOpts {
  fetchFn?: FetchFn;
  /** Disk cache loader/saver (injectable for tests). */
  cache?: {
    load: () => Record<string, Quote> | null;
    save: (map: Record<string, Quote>) => void;
  };
  chunk?: number;
  spaceMs?: number;
  /** Override backoff for tests. */
  backoffMs?: number;
}

interface YahooQuote {
  symbol: string;
  regularMarketPrice?: number;
  marketCap?: number;
  averageDailyVolume3Month?: number;
  exchangeName?: string;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export function makeYahooQuoteProvider(opts: QuoteProviderOpts = {}): {
  id: string;
  batchQuotes: (tickers: string[]) => Promise<Quote[]>;
} {
  const doFetch = opts.fetchFn ?? realFetch();
  const cache = opts.cache;
  const chunk = opts.chunk ?? CHUNK;
  const space = opts.spaceMs ?? SPACE_MS;
  const backoff = opts.backoffMs ?? BASE_BACKOFF_MS;

  return {
    id: 'yahoo-quote',
    async batchQuotes(tickers: string[]): Promise<Quote[]> {
      if (tickers.length === 0) return [];
      const cached = cache?.load() ?? {};
      const need = tickers.filter((t) => !cached[t.toUpperCase()]);
      const fresh: Quote[] = [];
      // Circuit-breaker: if the first few batches all fail to yield ANY quote
      // (e.g. Yahoo IP-rate-limited with 429), stop grinding the remaining
      // ~130 batches of a 13k universe — return empty fast so the caller falls
      // back to the live unpriced pool instead of spending minutes retrying.
      let emptyBatches = 0;
      const BREAK_AFTER_EMPTY = 2;

      for (let i = 0; i < need.length; i += chunk) {
        if (emptyBatches >= BREAK_AFTER_EMPTY && fresh.length === 0) break; // host blocked -> bail
        const batch = need.slice(i, i + chunk);
        let attempt = 0;
        let done = false;
        let batchGotQuote = false;
        while (attempt <= MAX_RETRIES && !done) {
          try {
            const res = await doFetch(`${QUOTE_URL}?symbols=${batch.join(',')}`);
            if (res.status === 401 || res.status === 403 || (res.status >= 400 && res.status < 500 && res.status !== 429)) {
              // hard client error (401/403/404, and non-429 4xx) — cannot recover; stop retrying
              done = true;
              break;
            }
            if (res.ok) {
              const data = (await res.json()) as { quoteResponse?: { result?: YahooQuote[] } };
              for (const q of data.quoteResponse?.result ?? []) {
                const t = q.symbol.toUpperCase();
                const price = q.regularMarketPrice ?? 0;
                const adv = (q.averageDailyVolume3Month ?? 0) * price;
                const quote: Quote = {
                  ticker: t,
                  price,
                  ...(q.marketCap != null ? { marketCap: q.marketCap } : {}),
                  advUsd: adv,
                };
                if (q.exchangeName) quote.exchange = q.exchangeName as string as Exchange;
                cached[t] = quote;
                fresh.push(cached[t]!);
              }
              batchGotQuote = fresh.length > 0;
              done = true;
              break;
            }
            // 429 / 5xx -> honor Retry-After or back off, then retry
            const retryAfter = res.headers?.['retry-after'];
            const wait = retryAfter ? parseInt(String(retryAfter), 10) * 1000 || backoff : backoff * (attempt + 1);
            await sleep(wait);
            attempt += 1;
          } catch {
            // network error -> back off and retry
            await sleep(backoff * (attempt + 1));
            attempt += 1;
          }
        }
        if (!batchGotQuote) emptyBatches += 1;
        if (i + chunk < need.length) await sleep(space);
      }

      if (fresh.length && cache) cache.save(cached);
      // Return quotes for the requested tickers (cached + fresh), in input order.
      return tickers
        .map((t) => cached[t.toUpperCase()])
        .filter((q): q is Quote => Boolean(q));
    },
  };
}

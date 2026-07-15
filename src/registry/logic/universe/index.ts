// src/registry/logic/universe/index.ts
// Phase 1: the swappable universe entry point.
//
// getUniverse() builds the broad pool from a SELECTED provider (env
// UNIVERSE_PROVIDER, default 'nasdaqtrader'), runs the cheap pre-filter
// (price/mktcap/ADV/exchange/sector), and caches the result daily
// (two-layer: symbols + quotes). Swapping a source = flip one env var
// or repoint a provider URL — no call site imports a concrete source.
//
// If every source fails, gracefully fall back to the legacy hardcoded
// DEFAULT_UNIVERSE (kept here so the screen never breaks).
import { realFetch, type FetchFn } from './sharedFetch';
import { makeNasdaqTraderProvider } from './nasdaqTraderProvider';
import { makeSecProvider } from './secProvider';
import { makeWikipediaSp500Provider, makeSp500CsvProvider } from './wikipediaSp500Provider';
import { makeYahooQuoteProvider } from './quoteProvider';
import { preFilterUniverse, preFilterUniverseDetailed } from './preFilter';
import type { UniverseProvider, UniverseSymbol, Quote } from './types';

const DEFAULT_UNIVERSE: string[] = [
  'AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'TSLA', 'AMD',
  'NFLX', 'AVGO', 'JPM', 'V', 'MA', 'UNH', 'XOM', 'BAC',
  'DIS', 'INTC', 'CSCO', 'ORCL', 'CRM', 'ADBE', 'QCOM', 'TXN', 'PYPL',
];

export interface UniverseCache {
  load: () => { symbols: UniverseSymbol[]; quotes: Quote[] } | null;
  save: (data: { symbols: UniverseSymbol[]; quotes: Quote[] }) => void;
}

export interface GetUniverseOpts {
  providerId?: string;
  fetchFn?: FetchFn;
  cache?: UniverseCache;
  /** Skip the quote pre-filter (return the raw pool). Test-only. */
  skipQuotes?: boolean;
}

function buildRegistry(fetchFn: FetchFn): Record<string, UniverseProvider> {
  return {
    nasdaqtrader: makeNasdaqTraderProvider({ fetchFn }),
    sec: makeSecProvider({ fetchFn }),
    'wikipedia-sp500': makeWikipediaSp500Provider({ fetchFn }),
    'sp500-csv-mirror': makeSp500CsvProvider({ fetchFn }),
  };
}

/**
 * Build (and cache) the screenable universe for the selected provider.
 * Returns pre-filtered Quotes (ticker + sector) PLUS a `trace` describing
 * exactly what happened (which source won, listed->parsed->prefiltered counts,
 * fallback flag) so the UI can show whether we pulled the broad pool or the
 * hardcoded 25-ticker fallback. On total provider failure, returns the legacy
 * DEFAULT_UNIVERSE as pseudo-quotes so the screen still yields candidates.
 */
export async function getUniverse(
  opts: GetUniverseOpts = {},
): Promise<{ quotes: Quote[]; trace: UniverseTrace }> {
  const fetchFn = opts.fetchFn ?? realFetch();
  const providerId = opts.providerId ?? process.env.UNIVERSE_PROVIDER ?? 'nasdaqtrader';
  const cache = opts.cache;
  const steps: UniverseTraceStep[] = [];

  // 1) Try cache first (daily TTL handled by the caller's cache impl).
  if (cache) {
    const hit = cache.load();
    if (hit && hit.quotes.length) {
      steps.push({ source: 'cache', kind: 'cache', result: `hit (${hit.quotes.length})`, total: hit.quotes.length });
      return {
        quotes: hit.quotes,
        trace: {
          provider: 'cache',
          usedFallback: false,
          origin: 'cache',
          steps,
          listedCount: hit.symbols.length,
          parsedCount: hit.symbols.length,
          prefilteredCount: hit.quotes.length,
          finalCount: hit.quotes.length,
          note: 'Universe served from daily cache (no network). Pass a fresh cache to force a refresh.',
        },
      };
    }
    steps.push({ source: 'cache', kind: 'cache', result: 'miss', total: 0 });
  }

  // 2) Resolve provider; fall back down the chain on failure.
  const registry = buildRegistry(fetchFn);
  const ordered = [providerId, 'nasdaqtrader', 'sec', 'wikipedia-sp500'].filter(
    (id, i, a) => a.indexOf(id) === i,
  );
  let symbols: UniverseSymbol[] | null = null;
  let winningId: string | null = null;
  for (const id of ordered) {
    try {
      const syms = await registry[id]!.fetchSymbols();
      const parsed = syms.length;
      if (parsed > 0) {
        symbols = syms;
        winningId = id;
        steps.push({
          source: id,
          kind: 'provider',
          listed: parsed,
          parsed,
          result: 'ok',
          total: parsed,
        });
        break;
      }
      steps.push({ source: id, kind: 'provider', result: 'empty', total: 0 });
    } catch (e: any) {
      steps.push({ source: id, kind: 'provider', result: `threw: ${String(e?.message ?? e)}`, total: 0 });
    }
  }

  if (!symbols || symbols.length === 0) {
    // Graceful fallback: legacy hardcoded list as pseudo-quotes.
    const fb = DEFAULT_UNIVERSE.map((t) => ({ ticker: t, price: 0, marketCap: 0, advUsd: 0 }));
    steps.push({
      source: 'fallback',
      kind: 'fallback',
      result: `no live provider succeeded -> DEFAULT_UNIVERSE (${fb.length})`,
      total: fb.length,
    });
    return {
      quotes: fb,
      trace: {
        provider: 'fallback',
        usedFallback: true,
        origin: 'fallback',
        steps,
        listedCount: 0,
        parsedCount: DEFAULT_UNIVERSE.length,
        prefilteredCount: DEFAULT_UNIVERSE.length,
        finalCount: DEFAULT_UNIVERSE.length,
        note:
          'No live universe source was reachable (no network / all providers 404). ' +
          'Fell back to the hardcoded 25-ticker DEFAULT_UNIVERSE — mega-caps like GOOGL appear HERE, not from the broad pool. ' +
          'Set UNIVERSE_PROVIDER and give the server egress (Node 18+) to pull the full list.',
      },
    };
  }

  // 3) Quote batch (pre-filter needs price/cap/ADV). Skip in tests.
  let quotes: Quote[] = [];
  if (!opts.skipQuotes) {
    const qp = makeYahooQuoteProvider({ fetchFn, cache: cache as any });
    quotes = await qp.batchQuotes(symbols.map((s) => s.ticker));
  }

  // 4) Pre-filter (free-file gates + quote gates + sector cap) — detailed for visibility.
  const { quotes: filtered, gates } = preFilterUniverseDetailed({ symbols, quotes });

  // 5) Persist for the daily cache.
  if (cache && filtered.length) cache.save({ symbols, quotes });

  if (filtered.length === 0) {
    // Quote pre-filter dropped everything. Two distinct reasons:
    //  (a) quotes genuinely unavailable (Yahoo blocked/rate-limited) -> the
    //      universe itself is LIVE and fine; we should still screen it, just
    //      without the price/cap/ADV gates. Don't collapse to the 25-ticker
    //      hardcoded fallback — that would WRONGLY inject mega-caps like GOOGL
    //      from the fallback list.
    //  (b) real quotes arrived but every symbol failed the floors -> also keep
    //      the live universe (it's the broad pool, not the fallback), but mark
    //      it as unpriced so the UI knows the gates didn't apply.
    // Either way: ship the LIVE pool as unpriced pseudo-quotes so the per-ticker
    // fetchPriceBars path in screenTickers can still score them.
    const live = symbols.map((s) => ({
      ticker: s.ticker,
      price: 0,
      marketCap: 0,
      advUsd: 0,
      ...(s.exchange ? { exchange: s.exchange } : {}),
      ...(s.sector ? { sector: s.sector } : {}),
    }));
    steps.push({
      source: 'fallback',
      kind: 'fallback',
      result: `quote pre-filter dropped all ${symbols.length} symbols (quotes unavailable/blocked) -> kept LIVE pool unpriced (${live.length})`,
      total: live.length,
    });
    return {
      quotes: live,
      trace: {
        provider: winningId!,
        usedFallback: false, // universe itself is live; only the quote gates were skipped
        origin: 'live',
        steps,
        listedCount: symbols.length,
        parsedCount: symbols.length,
        prefilteredCount: 0,
        finalCount: live.length,
        gates,
        note:
          'A live universe was pulled, but the quote pre-filter could NOT be applied ' +
          '(Yahoo v7 quote endpoint was blocked/rate-limited — IP 429). The broad pool is still ' +
          'screened on price bars; the price/market-cap/ADV gates were skipped this run. ' +
          'This is NOT the 25-ticker hardcoded fallback.',
      },
    };
  }

  return {
    quotes: filtered,
    trace: {
      provider: winningId!,
      usedFallback: false,
      origin: 'live',
      steps,
      listedCount: symbols.length,
      parsedCount: symbols.length,
      prefilteredCount: filtered.length,
      finalCount: filtered.length,
      gates,
      note: `Live universe pulled from '${winningId}'. GOOGL (if present) comes from the broad pool, not the hardcoded fallback.`,
    },
  };
}

export { DEFAULT_UNIVERSE };

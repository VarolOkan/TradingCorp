// src/registry/logic/universe/preFilter.ts
// Phase 1 (Stock Screener rework): the cheap, NETWORK-FREE pre-filter.
//
// Given the broad pool (from a UniverseProvider) and a batch of quotes
// (from a QuoteProvider), trim to a screenable set of QUALITY names
// using ONLY the data we already have — no per-ticker price calls.
//
// The "free" gates (exchange membership, ETF flag, test-issue flag) come
// straight from the universe FILE itself, so they cost 0 network calls.
// Only the price/marketCap/ADV gates need the quote batch, which is
// already fetched (and cached 24h) upstream.
//
// This is deliberately PURE and dependency-free so it is trivially unit-testable.

import type { Exchange, PreFilterCriteria, Quote, UniverseSymbol } from './types';

export interface PreFilterInput {
  symbols: UniverseSymbol[];
  /** Quotes keyed by ticker (from the QuoteProvider batch). Optional. */
  quotes?: Quote[];
  criteria?: PreFilterCriteria;
}

const DEFAULTS: Required<PreFilterCriteria> = {
  minPrice: 10,
  minMarketCap: 2_000_000_000, // $2B
  minAdvUsd: 20_000_000, // $20M/day
  allowedExchanges: ['NYSE', 'NASDAQ', 'NYSE_AMERICAN', 'NYSE_ARCA', 'CBOE'],
  maxPerSector: 0, // 0 = no cap
  dropEtfs: true,
};

function resolve(criteria?: PreFilterCriteria): Required<PreFilterCriteria> {
  return { ...DEFAULTS, ...(criteria ?? {}) };
}

/**
 * Pre-filter the universe down to quality, screenable candidates.
 * Returns the surviving Quote objects (each carries ticker + sector when known).
 * Order is preserved from the input symbols (after sector-cap, stable per sector).
 */
export function preFilterUniverse(input: PreFilterInput): Quote[] {
  const { symbols, quotes = [], criteria } = input;
  const c = resolve(criteria);
  const quoteByTicker = new Map(quotes.map((q) => [q.ticker.toUpperCase(), q]));

  // 1) Free-file gates: test issue, ETF (optional), exchange membership.
  const filePassed = symbols.filter((s) => {
    if (s.isTest) return false;
    if (c.dropEtfs && s.isEtf) return false;
    if (s.exchange && !c.allowedExchanges.includes(s.exchange)) return false;
    return true;
  });

  // 2) Quote gates: must have a quote AND clear price/cap/ADV floors.
  const quotePassed = filePassed.filter((s) => {
    const q = quoteByTicker.get(s.ticker.toUpperCase());
    if (!q) return false; // no quote -> cannot clear the priced gates
    if (q.price < c.minPrice) return false;
    if (c.minMarketCap != null && (q.marketCap ?? 0) < c.minMarketCap) return false;
    if (c.minAdvUsd != null && (q.advUsd ?? 0) < c.minAdvUsd) return false;
    return true;
  });

  // 3) Optional sector cap (diversification). Preserve input order; cap N
  //    names per GICS sector.
  let capped: Quote[] = quotePassed;
  if (c.maxPerSector > 0) {
    const sectorCounts = new Map<string, number>();
    capped = [];
    for (const s of quotePassed) {
      const sector = s.sector ?? '__none__';
      const used = sectorCounts.get(sector) ?? 0;
      if (used >= c.maxPerSector) continue;
      sectorCounts.set(sector, used + 1);
      const q = quoteByTicker.get(s.ticker.toUpperCase())!;
      capped.push({ ...q, ...(s.sector ? { sector: s.sector } : {}) } as Quote);
    }
  } else {
    // Still attach sector to the output Quote when known.
    capped = quotePassed.map((s) => {
      const q = quoteByTicker.get(s.ticker.toUpperCase())!;
      return (s.sector ? { ...q, sector: s.sector } : q) as Quote;
    });
  }

  return capped;
}

/**
 * Detailed variant returning per-gate drop counts (for UI visibility) without
 * changing the contract of preFilterUniverse (used by existing tests).
 */
export interface PreFilterDetailed {
  quotes: Quote[];
  gates: {
    price: number;
    marketCap: number;
    adv: number;
    exchange: number;
    etf: number;
    test: number;
    sectorCap: number;
  };
}

export function preFilterUniverseDetailed(input: PreFilterInput): PreFilterDetailed {
  const { symbols, quotes = [], criteria } = input;
  const c = resolve(criteria);
  const quoteByTicker = new Map(quotes.map((q) => [q.ticker.toUpperCase(), q]));

  let test = 0;
  let etf = 0;
  let exchange = 0;
  const filePassed: UniverseSymbol[] = [];
  for (const s of symbols) {
    if (s.isTest) {
      test += 1;
      continue;
    }
    if (c.dropEtfs && s.isEtf) {
      etf += 1;
      continue;
    }
    if (s.exchange && !c.allowedExchanges.includes(s.exchange)) {
      exchange += 1;
      continue;
    }
    filePassed.push(s);
  }

  let price = 0;
  let marketCap = 0;
  let adv = 0;
  const quotePassed: UniverseSymbol[] = [];
  for (const s of filePassed) {
    const q = quoteByTicker.get(s.ticker.toUpperCase());
    if (!q) continue; // no quote -> dropped (counted as no-quote, not a gate)
    if (q.price < c.minPrice) {
      price += 1;
      continue;
    }
    if (c.minMarketCap != null && (q.marketCap ?? 0) < c.minMarketCap) {
      marketCap += 1;
      continue;
    }
    if (c.minAdvUsd != null && (q.advUsd ?? 0) < c.minAdvUsd) {
      adv += 1;
      continue;
    }
    quotePassed.push(s);
  }

  let sectorCap = 0;
  let capped: Quote[] = quotePassed.map((s) => {
    const q = quoteByTicker.get(s.ticker.toUpperCase())!;
    return (s.sector ? { ...q, sector: s.sector } : q) as Quote;
  });
  if (c.maxPerSector > 0) {
    const sectorCounts = new Map<string, number>();
    const out: Quote[] = [];
    for (const s of quotePassed) {
      const sector = s.sector ?? '__none__';
      const used = sectorCounts.get(sector) ?? 0;
      if (used >= c.maxPerSector) {
        sectorCap += 1;
        continue;
      }
      sectorCounts.set(sector, used + 1);
      const q = quoteByTicker.get(s.ticker.toUpperCase())!;
      out.push((s.sector ? { ...q, sector: s.sector } : q) as Quote);
    }
    capped = out;
  }

  return {
    quotes: capped,
    gates: { price, marketCap, adv, exchange, etf, test, sectorCap },
  };
}

export type { Exchange };

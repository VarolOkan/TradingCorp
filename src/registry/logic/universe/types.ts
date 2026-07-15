// src/registry/logic/universe/types.ts
// Phase 1 (Stock Screener rework): the swappable data-source contracts.
//
// Every external symbol/quote source sits behind one of these two interfaces.
// Swapping a source = change one env var / repoint a provider URL — no call
// site imports a concrete source. This is what keeps the screener free of any
// single point of failure (a source can 404 or rate-limit and we fall through
// to the next column, never hard-failing the screen).
//
// All endpoints referenced by concrete providers were VERIFIED live (HTTP 200)
// on 2026-07-15 by the research subagents. Dead endpoints found during
// research (Stooq bulk CSV, datasets/*) are intentionally NOT implemented.

export type Exchange =
  | 'NYSE'
  | 'NASDAQ'
  | 'NYSE_AMERICAN'
  | 'NYSE_ARCA'
  | 'CBOE'
  | 'OTC';

/** A single tradable symbol as returned by a universe provider. */
export interface UniverseSymbol {
  ticker: string;
  name?: string;
  exchange?: Exchange;
  /** ETF flag — most screens drop these, but it's kept so callers decide. */
  isEtf?: boolean;
  /** Synthetic test issue (e.g. NASDAQ "Test Issue"=Y). ALWAYS dropped. */
  isTest?: boolean;
  /** GICS sector — only present for index providers (Wikipedia / CSV mirror). */
  sector?: string;
  /** SEC CIK — only present for the SEC provider. */
  cik?: string;
}

/**
 * Supplies the broad pool of symbols the screener starts from.
 * `kind: 'full'` = entire market (~8k–10k); `kind: 'index'` = a curated
 * list (e.g. S&P 500). The screener never imports a concrete provider;
 * it goes through getUniverseProvider() in ./index.
 */
export interface UniverseProvider {
  readonly id: string;
  readonly kind: 'full' | 'index';
  fetchSymbols(): Promise<UniverseSymbol[]>;
}

/** A per-symbol quote used by the pre-filter (no analyst scoring — cheap). */
export interface Quote {
  ticker: string;
  price: number;
  /** Market cap in USD. Optional — some sources omit it. */
  marketCap?: number;
  /** Average daily dollar volume (price * shares), USD. Optional. */
  advUsd?: number;
  exchange?: Exchange;
}

/**
 * Batch quote fetcher for the pre-filter. Implementations batch ~100 symbols
 * per request and cache 24h so a warm screen costs ~0 network calls.
 */
export interface QuoteProvider {
  readonly id: string;
  /**
   * Returns quotes for the given tickers. MUST NOT throw on a partial/empty
   * result — on provider failure return [] so the caller falls back to cache.
   */
  batchQuotes(tickers: string[]): Promise<Quote[]>;
}

/** Tunable pre-filter thresholds (see ./preFilter). */
export interface PreFilterCriteria {
  minPrice?: number;
  minMarketCap?: number;
  minAdvUsd?: number;
  allowedExchanges?: Exchange[];
  /** Max names kept per GICS sector (optional diversification cap). */
  maxPerSector?: number;
  /** When true, drop ETFs (default true). */
  dropEtfs?: boolean;
}

/**
 * Visibility aid (your ask): a step-by-step record of what the universe
 * pipeline actually did on this run, so the UI can show whether we pulled the
 * broad pool or fell through to the 25-ticker hardcoded fallback.
 */
export interface UniverseTraceStep {
  /** Provider id attempted (or 'cache' / 'fallback'). */
  source: string;
  /** 'cache' | 'provider' | 'fallback' — what kind of step this was. */
  kind: 'cache' | 'provider' | 'fallback';
  /** Symbols listed by the raw file/index (before parse). */
  listed?: number;
  /** Symbols surviving parse (valid, non-test, mapped). */
  parsed?: number;
  /** Outcome note (e.g. 'ok', 'empty', '404', 'threw: ...'). */
  result: string;
  /** Total symbols after this step (cumulative parsed). */
  total?: number;
  /** Skip reason when a provider was not attempted. */
  skipped?: string;
}

export interface UniverseTrace {
  /** Provider id that actually supplied the universe ('fallback' if none). */
  provider: string;
  /** True when we ended on the hardcoded DEFAULT_UNIVERSE (no live source won). */
  usedFallback: boolean;
  /** 'cache' | 'live' | 'fallback' — where the final universe came from. */
  origin: 'cache' | 'live' | 'fallback';
  /** Ordered steps (cache check + each provider attempt + fallback). */
  steps: UniverseTraceStep[];
  /** Raw symbols listed by the winning source (informational). */
  listedCount: number;
  /** Symbols after parsing/cleaning (before quote pre-filter). */
  parsedCount: number;
  /** Symbols after the cheap pre-filter (price/cap/ADV/exchange/sector). */
  prefilteredCount: number;
  /** Final screenable universe size handed to the scorer. */
  finalCount: number;
  /** Per-gate drop counts from the pre-filter (best-effort). */
  gates?: {
    price?: number;
    marketCap?: number;
    adv?: number;
    exchange?: number;
    etf?: number;
    test?: number;
    sectorCap?: number;
  };
  /** Human note (e.g. whether GOOGL appearing is from the broad pool or fallback). */
  note?: string;
}

// src/registry/types/domains.ts
// P0 of the multi-source architecture (see docs/MULTI_SOURCE_ARCHITECTURE.md).
//
// Declares the TYPED DATA-DOMAIN contract that analysts depend on, decoupled
// from any provider. This file is PURE TYPE DEFINITIONS — no behaviour, no
// provider URLs. It is the stable contract that P1 (adapters) and P2 (fan-in /
// weighting) build on.
//
// P0 invariant: `resolveDomain` (logic/domains.ts) returns a LIST of
// NormalizedRecord<T> — never a single value — so the analyst handler signature
// can absorb N sources in P2 without changing. In P0 the list has exactly one
// element (the legacy single source), preserving byte-for-byte parity.

import type { PriceBarsResult } from '../sources/adapters/price-bars';
import type { OptionChainResult } from '../sources/adapters/option-chain';
import type { NewsResult } from '../logic/news';

/** The set of typed data needs an analyst can declare. Provider-agnostic. */
export type DataDomain =
  | 'price_bars' // OHLCV bars  (technical, options)
  | 'option_chain' // option quotes + expiries + spot (options, risk)
  | 'news_sentiment' // headlines + aggregate sentiment (sentiment)
  | 'fundamentals' // balance-sheet / ratio snapshot (fundamental)
  | 'risk_free_rate' // annualized RFR used in pricing (options)
  | 'market_meta'; // beta / realized vol / mkt cap (risk, fundamental)

/**
 * One normalized record from one source, in a domain's canonical shape.
 * `T` is the domain's canonical interface (see DomainShapes below).
 * The analyst eventually receives `NormalizedRecord<T>[]` and WEIGHS them.
 */
export interface NormalizedRecord<T = any> {
  /** Source id, mirrors DataSourceSpec.id (e.g. 'yahoo', 'alphaVantage'). */
  sourceId: string;
  /** Acquisition status (mirrors AcquireResult.status). */
  status: 'ok' | 'fallback' | 'skipped' | 'failed';
  /** The provider payload normalized into the domain's canonical shape. */
  data: T;
  /**
   * 0..1 self-confidence used by P2 weighting. P0 uses a coarse placeholder:
   * 1 when the backing source is live, 0 when it fell back to seed/mock.
   * P1 adapters compute this from payload freshness / coverage.
   */
  confidence: number;
  /** Human-readable provenance note (honest: 'seed' / 'live' / etc.). */
  note?: string;
}

/** Canonical shapes per domain. These are the ONLY contracts analysts use. */
export interface DomainShapes {
  price_bars: PriceBarsResult;
  option_chain: OptionChainResult;
  news_sentiment: NewsResult;
  // Fundamentals live inside fetchRealFinancialData's `fundamental_data[ticker]`.
  fundamentals: Record<string, any>;
  risk_free_rate: number;
  market_meta: Record<string, any>;
}

export type DomainRecord<D extends DataDomain> = NormalizedRecord<DomainShapes[D]>;
export type DomainRecords<D extends DataDomain> = DomainRecord<D>[];

/** Context threaded into resolveDomain (fetch transport + per-source keys). */
export interface ResolveDomainCtx {
  fetchFn?: (url: string, init?: any) => Promise<any>;
  finnhubKey?: string;
  alphaVantageKey?: string;
  /** Option-chain provider key (Massive/Polygon). Forwarded to fetchOptionChain. */
  apiKey?: string;
  /** Per-source token resolver (B1) — forwarded to acquireSource in P1. */
  resolveToken?: (sourceId: string) => string | undefined;
  /** Optional horizon profile for price_bars / option_chain windows. */
  profile?: { intervals: Array<'1d' | '5m' | '1m'>; lookbackDays: number };
  /**
   * P3 — per-domain ENABLED source ids (ordered). When provided, resolveDomain
   * restricts fan-in to these ids and in THIS order; disabling the last source
   * for a domain degrades that domain (honest `skipped`), not the whole
   * pipeline. When omitted, the domain's default `DOMAIN_SOURCES` list is used,
   * so existing single-source behaviour (and P0 parity) is preserved.
   */
  enabledSources?: Partial<Record<DataDomain, string[]>>;
}

/** Convenience constructor so every backing path emits a uniform envelope. */
export function mkRecord<T>(
  sourceId: string,
  status: NormalizedRecord<T>['status'],
  data: T,
  confidence: number,
  note?: string,
): NormalizedRecord<T> {
  const rec: NormalizedRecord<T> = { sourceId, status, data, confidence };
  if (note !== undefined) rec.note = note;
  return rec;
}

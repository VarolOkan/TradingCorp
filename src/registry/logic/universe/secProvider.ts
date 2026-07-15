// src/registry/logic/universe/secProvider.ts
// Phase 1: SEC EDGAR "company_tickers.json" universe provider (SERVER-SIDE).
//
// VERIFIED live (HTTP 200) on 2026-07-15. ~8k registered filers
// (CIK + ticker + company name). Public-domain (US federal work) -> no
// restriction, but ALWAYS send a descriptive User-Agent per SEC fair-access.
//
// CORS: NONE -> server-side only. This is the BROAD fallback pool; it
// lacks exchange/ETF flags, so the pre-filter keeps everything that has a
// quote (the quote batch supplies the price/cap/ADV gates).
import type { FetchFn } from './sharedFetch';
import { realFetch } from './sharedFetch';
import type { UniverseProvider, UniverseSymbol } from './types';

const DEFAULT_URL = 'https://www.sec.gov/files/company_tickers.json';

export function makeSecProvider(opts: { url?: string; fetchFn?: FetchFn; userAgent?: string } = {}): UniverseProvider {
  const url = opts.url ?? DEFAULT_URL;
  const doFetch = (opts.fetchFn ?? realFetch());
  const ua = opts.userAgent ?? 'TradingCorpScreener/1.0 (screener@example.com)';
  return {
    id: 'sec',
    kind: 'full',
    async fetchSymbols(): Promise<UniverseSymbol[]> {
      const res = await doFetch(url, { headers: { 'User-Agent': ua } });
      if (!res.ok) throw new Error(`SEC ${res.status}`);
      const data = (await res.json()) as Record<string, { cik_str: number; ticker: string; title: string }>;
      return Object.values(data).map((r) => ({
        ticker: r.ticker,
        name: r.title,
        cik: String(r.cik_str),
      }));
    },
  };
}

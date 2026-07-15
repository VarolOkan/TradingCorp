// src/registry/logic/universe/nasdaqTraderProvider.ts
// Phase 1: NASDAQ Trader "nasdaqtraded.txt" universe provider (SERVER-SIDE).
//
// VERIFIED live (HTTP 200) on 2026-07-15. ~10k rows; crucially carries
// Listing Exchange, ETF, and Test Issue flags in ONE pipe-delimited file, so the
// pre-filter can drop OTC / ETF / synthetic names with 0 extra calls.
//
// CORS: NONE -> use server-side only (Node fetch). Do NOT call from the browser.
// License: NASDAQ-sourced; fine for internal use / building your own derived
import type { FetchFn } from './sharedFetch';
import { realFetch } from './sharedFetch';
import type { UniverseProvider, UniverseSymbol } from './types';

// A browser-like UA is REQUIRED: Yahoo (and some exchanga) return 403 to
// requests with no User-Agent, which silently drops every quote and forces the
// DEFAULT_UNIVERSE fallback. We always send one from the server-side fetchers.
export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const EXCH: Record<string, Exchange> = {
  Q: 'NASDAQ',
  N: 'NYSE',
  A: 'NYSE_AMERICAN',
  P: 'NYSE_ARCA',
  Z: 'CBOE',
};

const DEFAULT_URL = 'https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqtraded.txt';

export function makeNasdaqTraderProvider(opts: { url?: string; fetchFn?: FetchFn } = {}): UniverseProvider {
  const url = opts.url ?? DEFAULT_URL;
  const doFetch = (opts.fetchFn ?? realFetch());
  return {
    id: 'nasdaqtrader',
    kind: 'full',
    async fetchSymbols(): Promise<UniverseSymbol[]> {
      const res = await doFetch(url);
      if (!res.ok) throw new Error(`nasdaqtrader ${res.status}`);
      const text = await res.text();
      const lines = text
        .split('\n')
        .map((l) => l.replace(/\r$/, '').trim()) // strip trailing CR + padding
        .filter((l) => l.length > 0) // drop blank lines
        .filter((l) => !/^Nasdaq Traded\|Symbol\|/i.test(l)); // drop the file header row(s)
      const out: UniverseSymbol[] = [];
      for (const l of lines) {
        const c = l.split('|');
        const ticker = (c[1] ?? '').trim();
        if (!ticker) continue; // malformed/short row -> skip, never .trim() undefined
        const exchangeRaw = (c[3] ?? '').trim();
        out.push({
          ticker,
          name: (c[2] ?? '').trim() || undefined,
          exchange: EXCH[exchangeRaw] ?? 'OTC',
          isEtf: (c[5] ?? '') === 'Y',
          isTest: (c[7] ?? '') === 'Y',
        });
      }
      return out.filter((s) => s.ticker.length > 0 && !s.isTest);
    },
  };
}

// src/registry/logic/universe/wikipediaSp500Provider.ts
// Phase 1: S&P 500 universe providers (INDEX subset, browser-OK).
//
// Two implementations behind the same UniverseProvider id-family:
//   (a) wikipediaSp500Provider — Wikipedia MediaWiki API (api.php). VERIFIED
//       live (HTTP 200) on 2026-07-15; returns Access-Control-Allow-Origin:*
//       with &origin=* so it CAN be called from the browser. CC BY-SA.
//       Carries GICS sector in the wikitable -> handy for the sector cap.
//   (b) sp500CsvProvider — a plain CSV mirror via jsDelivr
//       (cdn.jsdelivr.net/gh/...). VERIFIED live (HTTP 200); CORS '*'.
//       Easiest swap target: a single CSV. If it 404s, point at any
//       other CSV mirror. jsDelivr also mirrors arbitrary GitHub repos.
import type { FetchFn } from './sharedFetch';
import { realFetch } from './sharedFetch';
import type { UniverseProvider, UniverseSymbol } from './types';

const WP_URL =
  'https://en.wikipedia.org/w/api.php?action=parse' +
  '&page=List_of_S%26P_500_companies&prop=wikitext&format=json&origin=*';
const CSV_URL = 'https://cdn.jsdelivr.net/gh/hanshof/sp500_constituents@master/sp500_constituents.csv';

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithRetry(
  doFetch: FetchFn,
  url: string,
  init: { headers?: Record<string, string> } = {},
  maxRetries = 4,
): Promise<{ ok: boolean; status: number; text: () => Promise<string>; json: () => Promise<any> }> {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const res = await doFetch(url, init);
    if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429)) return res; // 4xx (except 429) hard-fails: stop
    if (attempt >= maxRetries) return res;
    await sleep(600 * (attempt + 1)); // 429 / 5xx backoff
    attempt += 1;
  }
}

function parseWikiTable(wikitext: string): UniverseSymbol[] {
  const rows = wikitext.split('|-').slice(1);
  return rows
    .map((r) => {
      const cells = r.split('\n|').map((s) => s.replace(/[|]/g, '').trim());
      const ticker = (cells[1]?.match(/\b([A-Z][A-Z0-9.&]{0,5})\b/) ?? [, ''])[1] ?? '';
      const sector = cells[3] ?? '';
      return { ticker, sector, exchange: 'NYSE' as const };
    })
    .filter((s) => s.ticker);
}

function parseCsv(text: string): UniverseSymbol[] {
  const [hdr, ...lines] = text.trim().split('\n');
  if (!hdr) return [];
  return lines
    .filter((l) => l.trim())
    .map((line) => {
      const c = line.split(',');
      const ticker = c[0]!.trim();
      const name = c[1]?.trim();
      const sector = c[3]?.trim();
      return {
        ticker,
        ...(name ? { name } : {}),
        ...(sector ? { sector } : {}),
      } as UniverseSymbol;
    });
}

export function makeWikipediaSp500Provider(opts: { fetchFn?: FetchFn } = {}): UniverseProvider {
  const doFetch = (opts.fetchFn ?? realFetch());
  return {
    id: 'wikipedia-sp500',
    kind: 'index',
    async fetchSymbols(): Promise<UniverseSymbol[]> {
      const res = await fetchWithRetry(doFetch, WP_URL);
      if (!res.ok) throw new Error(`wikipedia ${res.status}`);
      const { parse } = (await res.json()) as { parse: { wikitext: { '*': string } } };
      return parseWikiTable(parse.wikitext['*']);
    },
  };
}

export function makeSp500CsvProvider(opts: { url?: string; fetchFn?: FetchFn } = {}): UniverseProvider {
  const url = opts.url ?? CSV_URL;
  const doFetch = (opts.fetchFn ?? realFetch());
  return {
    id: 'sp500-csv-mirror',
    kind: 'index',
    async fetchSymbols(): Promise<UniverseSymbol[]> {
      const res = await fetchWithRetry(doFetch, url);
      if (!res.ok) throw new Error(`sp500csv ${res.status}`);
      return parseCsv(await res.text());
    },
  };
}

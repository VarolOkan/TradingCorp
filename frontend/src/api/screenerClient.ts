// frontend/src/api/screenerClient.ts
// Phase 6: thin client for GET /screener.
export interface ScreenerRow {
  ticker: string;
  promise: number;
  technical: number;
  sentiment: number;
  momentum: number;
  stability: number;
  verdict: 'STRONG' | 'WATCH' | 'WEAK';
  topAxis: 'technical' | 'sentiment' | 'fundamental' | 'risk' | 'onchain';
  /** 'yahoo' (real, delayed) or 'mock' for this row's price bars. */
  barsSource: 'yahoo' | 'mock';
  /** finnhub|yahoo|google|mixed|mock for this row's news. */
  newsSource: string;
  /** ISO timestamp of the underlying price-bar data (as-of). */
  asOf: string;
}

export type DataSourceBadge = 'LIVE' | 'DELAYED' | 'MOCK';

export interface UniverseTraceStep {
  source: string;
  kind: 'cache' | 'provider' | 'fallback';
  listed?: number;
  parsed?: number;
  result: string;
  total?: number;
  skipped?: string;
}

export interface UniverseTrace {
  provider: string;
  usedFallback: boolean;
  origin: 'cache' | 'live' | 'fallback';
  steps: UniverseTraceStep[];
  listedCount: number;
  parsedCount: number;
  prefilteredCount: number;
  finalCount: number;
  gates?: {
    price?: number;
    marketCap?: number;
    adv?: number;
    exchange?: number;
    etf?: number;
    test?: number;
    sectorCap?: number;
  };
  note?: string;
}

export interface ScreenerResult {
  agencyId: string;
  weights: Record<string, number>;
  rows: ScreenerRow[];
  universeSize: number;
  screenedAt: string;
  elapsedMs: number;
  /** Truthful data-source badge for the whole screen. */
  dataSource: DataSourceBadge;
  /** Count of rows whose price bars came from a live source (yahoo). */
  liveRows: number;
  /** Step-by-step universe pipeline trace (visibility into the backend). */
  universeTrace?: UniverseTrace;
  note?: string;
}

export async function getScreener(
  agencyId: string,
  opts: { limit?: number; universe?: string[]; interval?: '1m' | '5m' | '1d'; lookbackDays?: number } = {},
): Promise<ScreenerResult> {
  const params = new URLSearchParams();
  params.set('agencyId', agencyId);
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.universe && opts.universe.length) params.set('universe', opts.universe.join(','));
  if (opts.interval) params.set('interval', opts.interval);
  if (opts.lookbackDays) params.set('lookbackDays', String(opts.lookbackDays));
  const res = await fetch(`/screener?${params.toString()}`);
  if (!res.ok) throw new Error(`Screener failed: ${res.status}`);
  return res.json() as Promise<ScreenerResult>;
}

// frontend/src/api/historyClient.ts
// Client for the Phase I historical price-bars endpoint (GET /history).
export interface PriceBar {
  t: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  vwap?: number;
}

export interface PriceBarsResult {
  ticker: string;
  interval: '1d' | '5m' | '1m' | '1wk' | '1h';
  lookback_days: number;
  bars: PriceBar[];
  source: 'yahoo' | 'mock';
  note?: string;
}

export async function getPriceHistory(
  symbol: string,
  opts: { interval?: '1d' | '5m' | '1m' | '1wk' | '1h'; lookbackDays?: number } = {},
): Promise<PriceBarsResult> {
  const params = new URLSearchParams({ symbol: symbol.trim().toUpperCase() });
  if (opts.interval) params.set('interval', opts.interval);
  if (opts.lookbackDays) params.set('lookback', String(opts.lookbackDays));
  const res = await fetch(`/history?${params.toString()}`);
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data.error) detail = data.error;
    } catch {
      /* keep generic */
    }
    throw new Error(`Failed to load history: ${detail}`);
  }
  return (await res.json()) as PriceBarsResult;
}

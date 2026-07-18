// src/registry/sources/adapters/price-bars.ts
// P4 (docs/ARCHITECTURE.md §Multi-Source Data Architecture, P4). Relocation of the price-bars
// acquisition logic out of the legacy hist.ts fetcher and into the adapter layer
// (allow-listed by the grep guard — every provider URL now lives in `adapters/`
// or `DEFAULT_SOURCE_URIS`). The PARSE half is the shared `yahooPriceAdapter`;
// the TRANSPORT+fallback half mirrors the original `acquirePriceBars` exactly so
// behavior is byte-for-byte identical (verified by domains.p0.test.ts).
//
// NOTE: we deliberately call `doFetch` directly + feed the FULL payload to the
// adapter (no `acquireSource` field-projection / okPath gating). That is what
// the legacy fetcher did; routing through acquireSource would re-shape the
// payload and break parity.

import type { PriceBar, BarInterval } from '../../../types/financial-analysis';
import { yahooPriceAdapter } from './yahoo-price';
import { generateBars, basePrice } from '../../logic/hist';

export type PriceBarsFetchFn = (url: string) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<any>;
}>;

function yahooRange(lookbackDays: number): string {
  if (lookbackDays <= 1) return '1d';
  if (lookbackDays <= 5) return '5d';
  if (lookbackDays <= 22) return '1mo';
  if (lookbackDays <= 66) return '3mo';
  if (lookbackDays <= 132) return '6mo';
  return '1y';
}

// Provider URL now lives in the adapter layer (grep-guard compliant).
const YAHOO_CHART = (symbol: string, range: string, interval: string) =>
  `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol,
  ).toUpperCase()}?range=${range}&interval=${interval}`;

export interface PriceBarsResult {
  ticker: string;
  interval: BarInterval;
  lookback_days: number;
  bars: PriceBar[];
  source: 'yahoo' | 'mock';
  note?: string;
}

/**
 * Fetch REAL OHLCV price bars for a ticker from Yahoo Finance's tokenless chart
 * endpoint, mapped into the `PriceBarSeries` shape. Falls back to the
 * deterministic seeded `generateBars` mock when no fetchFn / Yahoo is unreachable
 * (parity-safe: callers always get structurally-valid data; `source` tells them).
 *
 * Behavior is byte-for-byte identical to the legacy `hist.fetchPriceBars`.
 */
export async function acquirePriceBars(
  ticker: string,
  opts: { interval?: BarInterval; lookbackDays?: number; fetchFn?: PriceBarsFetchFn } = {},
): Promise<PriceBarsResult> {
  const interval = opts.interval ?? '1d';
  const lookbackDays = opts.lookbackDays ?? 90;
  const sym = ticker.trim().toUpperCase();

  const doFetch =
    opts.fetchFn ?? ((globalThis as any).fetch?.bind?.(globalThis) as PriceBarsFetchFn | undefined);
  if (typeof doFetch === 'function') {
    try {
      const res = await doFetch(YAHOO_CHART(sym, yahooRange(lookbackDays), interval));
      if (res.ok) {
        const payload = await res.json().catch(() => null);
        const parsed = yahooPriceAdapter.normalize(payload, {
          ticker: sym,
          interval,
          lookbackDays,
        });
        if (parsed) return parsed;
      }
    } catch {
      /* fall through to mock */
    }
  }

  // Mock fallback (deterministic, parity-safe).
  const asOf = new Date();
  const bars = generateBars(sym, interval, lookbackDays, basePrice(sym), asOf);
  return {
    ticker: sym,
    interval,
    lookback_days: lookbackDays,
    bars,
    source: 'mock',
    note: 'Live price history unavailable — showing deterministic mock bars.',
  };
}

/**
 * Fetch a raw Yahoo chart result (`chart.result[0]`) for one (range, interval)
 * without parsing. P4: the Yahoo chart URL moved here from data-ingestion.ts so
 * the ingestion orchestrator no longer hard-wires any provider URL (grep-guard
 * compliant). Returns the raw `r` object, or null when Yahoo is unreachable.
 */
export async function acquireYahooChartRaw(
  ticker: string,
  range: string,
  interval: BarInterval,
  fetchFn?: PriceBarsFetchFn,
): Promise<any | null> {
  const doFetch =
    fetchFn ?? ((globalThis as any).fetch?.bind?.(globalThis) as PriceBarsFetchFn | undefined);
  if (typeof doFetch !== 'function') return null;
  try {
    const res = await doFetch(YAHOO_CHART(ticker.trim().toUpperCase(), range, interval));
    if (res.ok) {
      const payload = await res.json().catch(() => null);
      return payload?.chart?.result?.[0] ?? null;
    }
  } catch {
    /* fall through to null */
  }
  return null;
}

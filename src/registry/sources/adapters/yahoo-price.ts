// src/registry/sources/adapters/yahoo-price.ts
// P1: pure parse for the Yahoo v8 chart payload -> canonical PriceBar[].
// Extracted verbatim (behavior-identical) from hist.ts acquirePriceBars inline
// block. The clean extraction also fixes two long-standing strict-mode issues
// the inline version carried (exactOptionalPropertyTypes vwap + possibly-
// undefined timestamp indexing) without changing output.

import type { PriceBar } from '../../../types/financial-analysis';
import type { SourceAdapter, AdapterContext } from './types';

function toNum(v: any): number | null {
  if (v === undefined || v === null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse a Yahoo `chart.result[0]` payload into PriceBar[]. Returns null when the
 * payload is empty/schema-drifted so the caller can fall back to mock.
 */
export function normalizeYahooChart(raw: unknown, ctx: AdapterContext): PriceBar[] | null {
  const payload = raw as any;
  const result = payload?.chart?.result?.[0];
  const ts: number[] = result?.timestamp ?? [];
  const q = result?.indicators?.quote?.[0] ?? {};
  if (!(ts.length > 0 && Array.isArray(q.open))) return null;

  const daily = ctx.interval === '1d';
  const bars: PriceBar[] = [];
  for (let i = 0; i < ts.length; i++) {
    const stamp = toNum(ts[i]);
    const open = toNum(q.open[i]);
    const close = toNum(q.close?.[i]);
    if (stamp === null || open === null || close === null) continue; // skip null pads
    const vwap = daily ? null : toNum(q.vwap?.[i]);
    bars.push({
      t: new Date(stamp * 1000).toISOString(),
      open,
      high: toNum(q.high?.[i]) ?? open,
      low: toNum(q.low?.[i]) ?? open,
      close,
      volume: toNum(q.volume?.[i]) ?? 0,
      // exactOptionalPropertyTypes: only attach vwap when we actually have one.
      ...(vwap !== null ? { vwap } : {}),
    });
  }
  return bars.length > 0 ? bars : null;
}

export const yahooPriceAdapter: SourceAdapter<'price_bars'> = {
  sourceId: 'yahoo',
  domain: 'price_bars',
  normalize(raw, ctx) {
    const bars = normalizeYahooChart(raw, ctx);
    if (!bars) return null;
    return {
      ticker: ctx.ticker,
      interval: ctx.interval ?? '1d',
      lookback_days: ctx.lookbackDays ?? 90,
      bars,
      source: 'yahoo',
    };
  },
};

// src/server/history-routes.ts
// Phase I (historical quotes): GET /history?symbol=&interval=&lookback=
// Returns real OHLCV price bars (Yahoo, tokenless) for a ticker, falling back
// to deterministic mock bars if the source is unavailable. Mirrors the
// quote-routes pattern.
//
// P4: now funnelled through resolveDomain('price_bars') so the multi-source
// layer (swappable sources, honest degrade, fan-in) is the single entry point.
// The response shape is preserved byte-for-byte: resolveDomain records the raw
// fetcher result as `data`, so we return `record[0].data` (== the old
// acquirePriceBars(...) payload the frontend consumes).
import type { Express } from 'express';
import { resolveDomain } from '../registry/logic/domains';
import type { PriceBarsFetchFn } from '../registry/sources/adapters/price-bars';

export function registerHistoryRoutes(app: Express, fetchFn?: PriceBarsFetchFn): void {
  app.get('/history', async (req, res) => {
    const symbol = typeof req.query.symbol === 'string' ? req.query.symbol.trim() : '';
    if (!symbol) {
      return res.status(400).json({ error: 'symbol query parameter is required' });
    }

    const interval = typeof req.query.interval === 'string' ? (req.query.interval as any) : '1d';
    const lookbackRaw = Number(req.query.lookback);
    const lookbackDays = Number.isFinite(lookbackRaw) && lookbackRaw > 0 ? Math.floor(lookbackRaw) : 90;

    try {
      // Bridge the route's fetch-only double into resolveDomain's FetchFn
      // (url + init + signal). Yahoo ignores init, so a URL-only wrapper is safe.
      const ctxFetch = fetchFn ? ((url: string) => (fetchFn as any)(url)) as any : undefined;
      const [rec] = await resolveDomain('price_bars', symbol, {
        fetchFn: ctxFetch,
        profile: { intervals: [interval as '1d'], lookbackDays } as any,
      });
      // record[0].data IS the raw fetcher result (acquirePriceBars payload).
      return res.json((rec as any)?.data ?? null);
    } catch (err) {
      return res.status(502).json({
        error: `history fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });
}

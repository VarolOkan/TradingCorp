// src/server/history-routes.ts
// Phase I (historical quotes): GET /history?symbol=&interval=&lookback=
// Returns real OHLCV price bars (Yahoo, tokenless) for a ticker, falling back
// to deterministic mock bars if the source is unavailable. Mirrors the
// quote-routes pattern.
import type { Express } from 'express';
import { fetchPriceBars, type PriceBarsFetchFn } from '../registry/logic/hist';

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
      const result = await fetchPriceBars(symbol, {
        interval,
        lookbackDays,
        ...(fetchFn ? { fetchFn } : {}),
      });
      return res.json(result);
    } catch (err) {
      return res.status(502).json({
        error: `history fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });
}

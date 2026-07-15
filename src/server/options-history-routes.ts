// src/server/options-history-routes.ts
// Phase I (options historical chains): GET /options-history?symbol=
// Returns a real Polygon option chain (when POLYGON_API_KEY is set) or a
// deterministic mock chain, mapped into OptionQuote[]. Mirrors history-routes.
import type { Express } from 'express';
import { fetchOptionChain, type OptionChainFetchFn } from '../registry/logic/hist';

export function registerOptionsHistoryRoutes(app: Express, fetchFn?: OptionChainFetchFn): void {
  app.get('/options-history', async (req, res) => {
    const symbol = typeof req.query.symbol === 'string' ? req.query.symbol.trim() : '';
    if (!symbol) {
      return res.status(400).json({ error: 'symbol query parameter is required' });
    }
    try {
      const result = await fetchOptionChain(symbol, fetchFn ? { fetchFn } : {});
      return res.json(result);
    } catch (err) {
      return res.status(502).json({
        error: `options-history fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });
}

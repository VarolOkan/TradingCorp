// src/server/screener-routes.ts
// Phase 6: GET /screener — returns the top-N most promising tickers for the
// selected agency. Mirrors the registration pattern of history-routes.ts /
// news-routes.ts. Fast + LLM-free (see src/registry/logic/screener.ts).
import type { Express } from 'express';
import { screenTickers } from '../registry/logic/screener';

export function registerScreenerRoutes(
  app: Express,
  _opts: { fetchFn?: any; newsFetchFn?: any; finnhubKey?: string } = {},
) {
  app.get('/screener', async (req, res) => {
    try {
      const agencyId = typeof req.query.agencyId === 'string' && req.query.agencyId
        ? req.query.agencyId
        : 'long-term';
      const limit = req.query.limit ? Math.max(1, Math.min(25, parseInt(String(req.query.limit), 10) || 15)) : 15;
      const universe = typeof req.query.universe === 'string' && req.query.universe
        ? req.query.universe.split(/[\s,]+/).map((s) => s.trim().toUpperCase()).filter(Boolean)
        : undefined;
      const interval = (typeof req.query.interval === 'string' ? req.query.interval : '1d') as '1m' | '5m' | '1d';
      const lookbackDays = req.query.lookbackDays ? parseInt(String(req.query.lookbackDays), 10) || 90 : 90;

      const result = await screenTickers(agencyId, {
        ...(universe ? { universe } : {}),
        limit,
        interval,
        lookbackDays,
        ...(_opts.finnhubKey ? { finnhubKey: _opts.finnhubKey } : {}),
        ...(_opts.fetchFn ? { fetchFn: _opts.fetchFn } : {}),
        ...(_opts.newsFetchFn ? { newsFetchFn: _opts.newsFetchFn } : {}),
      });
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? 'screener failed' });
    }
  });
}

// src/server/screener-routes.ts
// Phase 6: GET /screener — returns the top-N most promising tickers for the
// selected agency. Mirrors the registration pattern of history-routes.ts /
// news-routes.ts. Fast + LLM-free (see src/registry/logic/screener.ts).
import type { Express } from 'express';
import { screenTickers, resolveScreenerProfile, resolveScreenerInstrument } from '../registry/logic/screener';
import { AGENCIES } from '../registry/agencies';

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
      // Phase 22: timeframe + instrument are AGENCY-LEVEL settings. The agency
      // def (from the registry) supplies the default interval/lookbackDays and
      // instrument intent; an explicit query override is still honored.
      const agencyDef = AGENCIES[agencyId];
      const resolved = resolveScreenerProfile(agencyId, agencyDef);
      const interval = (typeof req.query.interval === 'string' ? req.query.interval : resolved.interval) as '1m' | '5m' | '1h' | '4h' | '1d';
      const lookbackDays = req.query.lookbackDays ? parseInt(String(req.query.lookbackDays), 10) || resolved.lookbackDays : resolved.lookbackDays;
      const minVolumeDaily = req.query.minVolumeDaily
        ? Math.max(0, parseInt(String(req.query.minVolumeDaily), 10) || 0)
        : (agencyDef?.minVolumeDaily ?? 100_000);
      const resolvedInstrument = resolveScreenerInstrument(agencyDef);
      const instrument = (typeof req.query.instrument === 'string' && (req.query.instrument === 'EQUITY' || req.query.instrument === 'OPTION')
        ? req.query.instrument
        : resolvedInstrument) as 'EQUITY' | 'OPTION';

      const result = await screenTickers(agencyId, {
        ...(universe ? { universe } : {}),
        limit,
        interval,
        lookbackDays,
        ...(minVolumeDaily > 0 ? { minVolumeDaily } : {}),
        ...(instrument ? { instrument } : {}),
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

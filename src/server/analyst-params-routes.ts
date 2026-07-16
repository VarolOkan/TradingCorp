// src/server/analyst-params-routes.ts
// REST surface for per-analyst tunable WEIGHTS (docs/EXTENDING_ANALYSTS.md).
//
// POST /analyst-params  — save a weight override set for (session, agency, analyst).
// GET  /analyst-params  — return the saved weights for a whole agency (so the
//                         frontend can repopulate every card's panel at once).
//
// Split out of index.ts so it is unit-testable with supertest without booting
// socket.io. Saved params are never echoed in a way that leaks secrets; they
// are plain numeric weights.

import { Express } from 'express';
import { AnalystParamsStore, ALLOWED_PARAM_KEYS } from './analyst-params';
import { AGENCIES } from '../registry/agencies';
import { logger } from '../utils/logger';

function sessionOf(req: { query: any; body?: any }): string {
  return (
    (req.query && (req.query.sessionId as string)) ||
    (req.body && (req.body as any).sessionId) ||
    'default'
  );
}

/** Register the per-analyst params routes. */
export function registerAnalystParamsRoutes(
  app: Express,
  store: AnalystParamsStore = new AnalystParamsStore(),
): void {
  // GET /analyst-params?sessionId=&agencyId= — all saved weights for an agency.
  app.get('/analyst-params', (req, res) => {
    const sessionId = sessionOf(req);
    const agencyId = (req.query.agencyId as string) || 'long-term';
    const agency = AGENCIES[agencyId];
    if (!agency) {
      res.status(404).json({ error: `Unknown agency: ${agencyId}` });
      return;
    }
    const byAnalyst: Record<string, Record<string, number>> = {};
    for (const ref of agency.analysts) {
      const saved = store.get({ sessionId, agencyId, analystId: ref.id });
      if (saved) byAnalyst[ref.id] = saved;
    }
    res.status(200).json({ sessionId, agencyId, params: byAnalyst });
  });

  // POST /analyst-params — store one analyst's weight overrides.
  app.post('/analyst-params', (req, res) => {
    const sessionId = sessionOf(req);
    const validation = AnalystParamsStore.validate(req.body);
    if (!validation.ok || !validation.value) {
      res.status(400).json({ error: 'Invalid analyst params', details: validation.errors });
      return;
    }
    const { analystId, agencyId } = req.body as { analystId: string; agencyId: string };
    const agency = AGENCIES[agencyId];
    if (!agency || !agency.analysts.some((a) => a.id === analystId)) {
      res.status(404).json({ error: `Analyst ${analystId} not in agency ${agencyId}` });
      return;
    }

    store.set({ sessionId, agencyId, analystId }, validation.value);

    logger.info(
      `Stored params for session=${sessionId} agency=${agencyId} analyst=${analystId} ` +
        `(${Object.keys(validation.value).join(', ') || 'cleared'})`
    );

    res.status(200).json({
      ok: true,
      sessionId,
      agencyId,
      analystId,
      params: validation.value,
    });
  });
}

export { ALLOWED_PARAM_KEYS };

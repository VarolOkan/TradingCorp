// src/server/analyst-config-routes.ts
// REST surface for per-analyst / per-source credentials (B1 design).
//
// POST /analyst-config  — store a token for (session, analystId, sourceId).
// GET  /analyst-config  — return the catalog of analysts whose definition
//                         declares a LIVE + AUTH source, so the client can
//                         render a "⚙ Configure source" button only where it is
//                         actually needed (no button for mock-only analysts).
//
// Split out of index.ts so it is unit-testable with supertest without booting
// socket.io. Tokens are never echoed back in responses and never logged.

import { Express } from 'express';
import { AnalystConfigStore } from './analyst-config';
import { ANALYST_DEFS } from '../registry/analysts';
import { isLiveSource } from '../registry/sources';
import type { DataSourceSpec } from '../types/registry';
import { logger } from '../utils/logger';

/**
 * A source that needs its own credential: a live (rest/graphql) source whose
 * auth policy is NOT 'none'.
 */
function isCredentialedSource(src: DataSourceSpec): boolean {
  return isLiveSource(src) && src.auth !== undefined && src.auth !== 'none';
}

/**
 * Build the per-analyst "needs config" catalog returned by GET /analyst-config.
 * Shape: { analysts: [{ analystId, name, sources: [{ id, label, auth }] }] }
 */
export function buildSourceCatalog(): {
  analysts: Array<{ analystId: string; name: string; sources: Array<{ id: string; label: string; auth: string }> }>;
} {
  const analysts: Array<{ analystId: string; name: string; sources: Array<{ id: string; label: string; auth: string }> }> = [];
  for (const def of Object.values(ANALYST_DEFS)) {
    const sources = (def.dataSources ?? [])
      .filter(isCredentialedSource)
      .map((src) => ({
        id: src.id ?? src.label,
        label: src.label,
        auth: src.auth as string,
      }));
    if (sources.length > 0) {
      analysts.push({ analystId: def.id, name: def.name, sources });
    }
  }
  return { analysts };
}

/**
 * Register the per-analyst config routes.
 */
export function registerAnalystConfigRoutes(
  app: Express,
  store: AnalystConfigStore = new AnalystConfigStore(),
): void {
  // GET /analyst-config — catalog of which analysts need a per-source token.
  app.get('/analyst-config', (_req, res) => {
    res.status(200).json(buildSourceCatalog());
  });

  // POST /analyst-config — store one source credential.
  app.post('/analyst-config', (req, res) => {
    const sessionId =
      (req.query.sessionId as string) ||
      (req.body && (req.body as any).sessionId) ||
      'default';

    const validation = AnalystConfigStore.validate(req.body);
    if (!validation.ok || !validation.value) {
      res.status(400).json({ error: 'Invalid analyst-source config', details: validation.errors });
      return;
    }

    const { analystId, sourceId } = req.body as { analystId: string; sourceId: string };
    store.set({ sessionId, analystId, sourceId }, validation.value);

    logger.info(
      `Stored source credential for session=${sessionId} analyst=${analystId} source=${sourceId} (token=${validation.value.token ? 'set' : 'cleared'})`
    );

    res.status(200).json({
      ok: true,
      sessionId,
      analystId,
      sourceId,
      hasToken: validation.value.token.length > 0,
    });
  });
}

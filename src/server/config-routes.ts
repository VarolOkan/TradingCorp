// src/server/config-routes.ts
// Route registration for runtime connection settings (Option B).
//
// Split out of `index.ts` so the REST surface can be unit-tested without
// pulling in the full Socket.IO / LangGraph server. The Settings dialog POSTs
// the backend baseUri / accessToken / extra here; the store keeps it in-memory
// per session and the analysis handler reads it at request time. The token is
// never logged verbatim and never echoed back to the client.

import { Express } from 'express';
import { ConnectionConfigStore, ResolvedConfig } from './connection-config';
import { logger } from '../utils/logger';
import { config as serverConfig } from '../config';

/**
 * Register the `/config` GET (static analysis config) and POST (runtime
 * connection settings) routes on the given Express app.
 */
export function registerConfigRoutes(
  app: Express,
  store: ConnectionConfigStore = new ConnectionConfigStore()
): void {
  // GET /config — static analysis configuration (defaults from server config).
  app.get('/config', (_req, res) => {
    res.status(200).json({
      analysis: serverConfig.analysis,
      version: '1.0.0',
    });
  });

  // POST /config — accept runtime connection settings (Option B).
  app.post('/config', (req, res) => {
    const sessionId =
      (req.query.sessionId as string) ||
      (req.body && (req.body as any).sessionId) ||
      'default';

    const validation = ConnectionConfigStore.validate(req.body);
    if (!validation.ok || !validation.settings) {
      res.status(400).json({
        error: 'Invalid connection settings',
        details: validation.errors,
      });
      return;
    }

    const resolved: ResolvedConfig = store.set(sessionId, validation.settings);
    logger.info(
      `Stored connection config for session ${sessionId} (baseUri=${resolved.baseUri}, token=${resolved.accessToken ? 'set' : 'unset'})`
    );
    res.status(200).json({
      ok: true,
      sessionId,
      baseUri: resolved.baseUri,
      hasToken: resolved.accessToken.length > 0,
      extraKeys: Object.keys(resolved.extra),
    });
  });
}

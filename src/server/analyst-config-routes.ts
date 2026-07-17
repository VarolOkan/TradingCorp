// src/server/analyst-config-routes.ts
// REST surface for per-analyst / per-source credentials (B1 design).
//
// POST /analyst-config       — store a token for (session, analystId, sourceId).
// GET  /analyst-config       — return the catalog of analysts whose definition
//                              declares a LIVE + AUTH source, so the client can
//                              render a "⚙ Configure source" button only where it
//                              is actually needed (no button for mock-only analysts).
// POST /analyst-config/test  — health-probe one source using the STORED token.
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
 * Shape: { analysts: [{ analystId, name, sources: [{ id, label, auth, hasToken }] }] }
 * `hasToken` lets the client show a "stored" indicator (mirroring the LLM
 * "configured" chip) without echoing the secret back over the wire.
 */
export function buildSourceCatalog(
  store?: AnalystConfigStore,
  sessionId = 'default',
): {
  analysts: Array<{ analystId: string; name: string; sources: Array<{ id: string; label: string; auth: string; hasToken: boolean }> }>;
} {
  const analysts: Array<{ analystId: string; name: string; sources: Array<{ id: string; label: string; auth: string; hasToken: boolean }> }> = [];
  for (const def of Object.values(ANALYST_DEFS)) {
    const sources = (def.dataSources ?? [])
      .filter(isCredentialedSource)
      .map((src) => {
        const id = src.id ?? src.label;
        // hasToken MUST reflect an actual stored *token* (the same thing the
        // /test route checks via store.get().token) — not just any credential
        // (a URI-only entry would otherwise show "stored" yet fail the probe).
        // Uses get() so it prefers the session-agnostic vault, exactly like /test.
        const hasToken = store
          ? (store.get({ sessionId, analystId: def.id, sourceId: id })?.token?.length ?? 0) > 0
          : false;
        return { id, label: src.label, auth: src.auth as string, hasToken };
      });
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
  // Includes `hasToken` per source (so the UI can show a "stored" chip without
  // echoing the secret) and `vaultDisabled` (so the UI can honestly warn that
  // credentials won't survive a restart when no LLM_VAULT_PASSPHRASE is set).
  app.get('/analyst-config', (_req, res) => {
    res.status(200).json({
      ...buildSourceCatalog(store),
      vaultDisabled: store.vaultDisabled(),
    });
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
    const clearToken = Boolean((req.body as any)?.clearToken);
    // Trim the token: API keys never contain whitespace, and paste from a
    // terminal/managed-key UI frequently includes a trailing newline or spaces
    // that silently causes "Authentication failed" at the provider.
    const trimmedToken = validation.value.token.trim();
    store.set(
      { sessionId, analystId, sourceId },
      { ...validation.value, token: trimmedToken, clearToken },
    );

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

  // POST /analyst-config/test — health-probe one source: send a lightweight
  // query to the provider using the STORED token (vault), so the button works
  // even when the field is blank (mirrors the LLM /llm-config/test behaviour).
  // Returns a normalized result safe to show the user.
  app.post('/analyst-config/test', async (req, res) => {
    const body = req.body as {
      analystId?: string;
      sourceId?: string;
      sessionId?: string;
    };
    const analystId = body.analystId ?? 'data_ingestion';
    const sourceId = body.sourceId;
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : 'default';

    if (!sourceId || typeof sourceId !== 'string') {
      res.status(400).json({ ok: false, error: 'sourceId is required' });
      return;
    }

    // Resolve the source spec from the registry so we probe the right endpoint
    // + attach auth the same way the acquisition engine would.
    const def = (ANALYST_DEFS as Record<string, any>)[analystId];
    const src = (def?.dataSources ?? []).find(
      (s: any) => s.id === sourceId && isCredentialedSource(s)
    );
    if (!src) {
      res.status(404).json({ ok: false, error: `Unknown source: ${sourceId}` });
      return;
    }

    // Prefer the stored token (vault) so Test works with a blank field.
    const stored = store.get({ sessionId, analystId, sourceId });
    const token = stored?.token ?? '';
    if (!token) {
      res.status(200).json({
        ok: false,
        sourceId,
        hasToken: false,
        error: 'No token stored — save a token first, then Test.',
      });
      return;
    }

    const probe = await probeSource({
      source: src,
      token,
      baseUri: stored?.extra?.uri,
    });
    res.status(200).json({
      ok: probe.ok,
      sourceId,
      hasToken: true,
      status: probe.status,
      error: probe.error,
      detail: probe.detail,
      latencyMs: probe.latencyMs,
    });
  });
}

/**
 * Health-probe a single credentialed REST source using its stored token.
 * Builds a cheap read-only query (Alpha Vantage GLOBAL_QUOTE / Finnhub quote)
 * and reports ok/status/error + a clipped detail + latency. The token is sent
 * to the provider but never logged or echoed back.
 */
/**
 * Extract the scheme+host origin (e.g. `https://api.massive.com`) from a URL,
 * so a ticker-independent health probe can target the SAME host the deployment
 * uses without inheriting the templated path (`/v3/snapshot/options/{ticker}`).
 * Returns undefined if the input isn't a parseable absolute URL.
 */
function originOf(u: string): string | undefined {
  try {
    return new URL(u).origin;
  } catch {
    return undefined;
  }
}

export async function probeSource(opts: {
  source: DataSourceSpec;
  token: string;
  baseUri?: string | undefined;
}): Promise<{ ok: boolean; status?: number | undefined; error?: string | undefined; detail?: string | undefined; latencyMs?: number | undefined }> {
  const { source, token } = opts;
  // Per-source health query templates (read-only, minimal). New providers
  // extend this map; unrecognised ids fall back to the raw endpoint root.
  const healthQuery: Record<string, string> = {
    alphaVantage: '?function=GLOBAL_QUOTE&symbol=IBM&apikey=__TOKEN__',
    finnhub: '/quote?symbol=AAPL',
  };
  const root = (opts.baseUri && opts.baseUri.trim()) || (source.endpoint ?? '');
  // Polygon / Massive-compatible sources: probe a ticker-INDEPENDENT reference
  // endpoint (/v3/reference/dividends) so a VALID key returns 200 regardless of
  // ticker. The snapshot `endpoint` carries a literal `{ticker}` that would
  // 404/400 on a raw probe and mask a perfectly good key as "auth failed".
  // We derive the host ORIGIN from the Base URI (or the source endpoint) so the
  // probe follows whichever host the deployment targets (api.massive.com by
  // default) — auth is the Bearer token, which the docs confirm works here.
  const REFERENCE_HEALTH = new Set(['polygonOptions', 'polygonHist']);
  let url: string;
  if (REFERENCE_HEALTH.has(source.id ?? '')) {
    const origin = originOf(root) ?? root;
    url = `${origin}/v3/reference/dividends?limit=1`;
  } else {
    const q = healthQuery[source.id ?? ''] ?? '';
    url =
      source.auth === 'apikey' && token
        ? `${root}${q.replace('__TOKEN__', encodeURIComponent(token))}`
        : `${root}${q}`;
  }

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (source.auth === 'bearer' && token) {
    headers['Authorization'] = `Bearer ${token}`;
  } else if (source.auth === 'finnhub' && token) {
    // Finnhub requires `X-Finnhub-Token` (Bearer is rejected with 401).
    headers['X-Finnhub-Token'] = token;
  }

  // DIAGNOSTIC (temporary): log the resolved URL with the token redacted, the
  // auth mode used, and the provider's response so we can see why a probe fails.
  const logUrl = url.replace(/apikey=[^&]+/i, 'apikey=***REDACTED***');
  logger.debug(
    `[probeSource] source=${source.id ?? source.label} auth=${source.auth} ` +
    `url=${logUrl} willSendHeader=${source.auth === 'finnhub' ? 'X-Finnhub-Token' : source.auth === 'bearer' ? 'Authorization' : 'none'}`,
  );

  const start = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const resp = await fetch(url, { method: 'GET', headers, signal: controller.signal });
    clearTimeout(timeout);
    const latencyMs = Date.now() - start;
    const status = resp.status;
    const txt = await resp.text().catch(() => '');
    const detail = txt.slice(0, 300) || undefined;
    // Observability: log the provider's response (status + clipped body) at debug level.
    logger.debug(`[probeSource] response status=${status} latency=${latencyMs}ms body=${txt.slice(0, 300)}`);
    if (status >= 200 && status < 300) {
      return { ok: true, status, detail, latencyMs };
    }
    if (status === 401 || status === 403) {
      return { ok: false, status, error: 'Authentication failed — check the token', detail, latencyMs };
    }
    if (status === 429) {
      return { ok: false, status, error: 'Rate-limited (429) — provider throttling; retry shortly', detail, latencyMs };
    }
    return { ok: false, status, error: `Provider returned HTTP ${status}`, detail, latencyMs };
  } catch (err) {
    const e = err as Error;
    const latencyMs = Date.now() - start;
    if (e.name === 'AbortError') {
      return { ok: false, error: 'Request timed out (8s) — check the Base URI / network', latencyMs };
    }
    return { ok: false, error: e.message || 'Network error — check the Base URI / token', latencyMs };
  }
}

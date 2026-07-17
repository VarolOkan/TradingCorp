// src/server/options-debug-routes.ts
// Self-diagnostic endpoint for the Options tab's live feed. When the Options tab
// shows MOCK even though a Massive/Polygon key is set + tested, this endpoint
// reproduces EXACTLY what the tab's code path does — resolve the vault key,
// issue the same Bearer-authenticated GET to /v3/snapshot/options/{ticker}, and
// return the raw status / headers / body snippet so the failure is diagnosable
// without grepping server logs.
import type { Express } from 'express';
import { analystConfigStore } from './analyst-config';

const MASSIVE_SNAPSHOT = (ticker: string) =>
  `https://api.massive.com/v3/snapshot/options/${encodeURIComponent(ticker.toUpperCase())}`;

export function registerOptionsDebugRoutes(app: Express): void {
  app.get('/debug/options-auth', async (req, res) => {
    const symbol = typeof req.query.symbol === 'string' ? req.query.symbol.trim().toUpperCase() : 'AAPL';

    const steps: Array<Record<string, unknown>> = [];

    // 1) Resolve the vault key the SAME way the Options tab does.
    const vaultKey = analystConfigStore.resolveToken({
      sessionId: 'default',
      analystId: 'options_ingestion',
      sourceId: 'polygonOptions',
    });
    const envKey = (typeof process !== 'undefined' ? process.env?.POLYGON_API_KEY : undefined) ?? '';
    const keySource = vaultKey && vaultKey.trim() ? 'vault(options_ingestion/polygonOptions)' : envKey ? 'env(POLYGON_API_KEY)' : 'none';
    const effectiveKey = (vaultKey && vaultKey.trim()) || envKey || '';
    steps.push({ step: 'resolveKey', keySource, keyLength: effectiveKey.length, keyPresent: effectiveKey.length > 0 });

    if (!effectiveKey) {
      return res.status(200).json({
        symbol,
        ok: false,
        reason: 'NO_KEY',
        message: 'No Massive/Polygon key found (neither the Settings UI vault nor POLYGON_API_KEY env). The Options tab will use the mock chain.',
        steps,
      });
    }

    // 2) Reproduce the live call with Bearer auth (matches the tab's fetchOptionChain).
    const url = MASSIVE_SNAPSHOT(symbol);
    const headers = { Accept: 'application/json', Authorization: `Bearer ${effectiveKey}` };
    steps.push({ step: 'liveCall', url, auth: 'Bearer', apiKeyParam: false });

    let status = -1;
    let statusText = '';
    let bodySnippet = '';
    let parsedOk = false;
    let contractCount = 0;
    let rawHeaders: Record<string, string> = {};
    try {
      const r = await fetch(url, { headers });
      status = r.status;
      statusText = r.statusText;
      rawHeaders = {};
      r.headers.forEach((v, k) => { rawHeaders[k] = v; });
      const text = await r.text();
      bodySnippet = text.slice(0, 600);
      try {
        const json = JSON.parse(text);
        const results = json?.results?.results;
        parsedOk = Array.isArray(results);
        contractCount = parsedOk ? results.length : 0;
      } catch {
        parsedOk = false;
      }
      steps.push({
        step: 'response',
        status,
        statusText,
        contentType: rawHeaders['content-type'] ?? rawHeaders['Content-Type'] ?? '',
        bodyStartsWith: text.slice(0, 80),
        parsed: parsedOk,
        contractCount,
      });
    } catch (e) {
      steps.push({ step: 'error', error: e instanceof Error ? e.message : String(e) });
      return res.status(200).json({
        symbol,
        ok: false,
        reason: 'FETCH_ERROR',
        message: `Live call threw before HTTP: ${e instanceof Error ? e.message : String(e)}`,
        steps,
      });
    }

    // 3) Verdict
    const ok = status === 200 && parsedOk && contractCount > 0;
    return res.status(200).json({
      symbol,
      ok,
      reason: ok ? 'OK' : status !== 200 ? `HTTP_${status}` : parsedOk ? 'EMPTY_RESULTS' : 'UNPARSEABLE_BODY',
      message: ok
        ? `LIVE: ${contractCount} contracts returned for ${symbol}. The Options tab should show LIVE.`
        : status !== 200
          ? `Massive returned HTTP ${status} ${statusText}. Body: ${bodySnippet}`
          : parsedOk
            ? `Massive returned 200 but no usable option chain (0 contracts).`
            : `Massive returned a non-JSON / unexpected body. Body: ${bodySnippet}`,
      bodySnippet,
      steps,
    });
  });
}

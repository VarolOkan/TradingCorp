// src/server/options-history-routes.ts
// Phase I (options historical chains): GET /options-history?symbol=
// Returns a real Polygon/Massive option chain (when a key is configured) or a
// deterministic mock chain, mapped into OptionQuote[]. Mirrors history-routes.
//
// KEY RESOLUTION (bugfix): the option chain key the user enters in the Settings
// UI is stored in the ENCRYPTED VAULT under (analystId 'options_ingestion',
// sourceId 'polygonOptions') — NOT in process.env. This route MUST resolve that
// vault key and pass it to fetchOptionChain, otherwise the tab always falls back
// to MOCK even though the key is set + tested OK. Env var stays as a fallback.
import type { Express } from 'express';
import { fetchOptionChain, type OptionChainFetchFn } from '../registry/logic/hist';
import { analystConfigStore } from './analyst-config';

export function registerOptionsHistoryRoutes(app: Express, fetchFn?: OptionChainFetchFn): void {
  app.get('/options-history', async (req, res) => {
    const symbol = typeof req.query.symbol === 'string' ? req.query.symbol.trim() : '';
    if (!symbol) {
      return res.status(400).json({ error: 'symbol query parameter is required' });
    }
    try {
      // Resolve the vault-stored Massive/Polygon key (same channel the Settings
      // UI writes + the [Test] button probes). Falls back to POLYGON_API_KEY.
      const vaultKey = analystConfigStore.resolveToken({
        sessionId: 'default',
        analystId: 'options_ingestion',
        sourceId: 'polygonOptions',
      });
      const apiKey = vaultKey && vaultKey.trim() ? vaultKey.trim() : undefined;
      const opts: { apiKey?: string; fetchFn?: OptionChainFetchFn } = {};
      if (apiKey) opts.apiKey = apiKey;
      if (fetchFn) opts.fetchFn = fetchFn;
      const result = await fetchOptionChain(symbol, opts);
      return res.json(result);
    } catch (err) {
      return res.status(502).json({
        error: `options-history fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });
}

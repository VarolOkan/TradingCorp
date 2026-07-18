// src/server/options-history-routes.ts
// Phase I (options historical chains): GET /options-history?symbol=
// Returns a real Polygon/Massive option chain (when a key is configured) or a
// deterministic mock chain, mapped into OptionQuote[]. Mirrors history-routes.
//
// P4: funnelled through resolveDomain('option_chain'). The response shape is
// preserved: resolveDomain records the raw fetcher result as `data`, so we
// return `record[0].data` (== the old fetchOptionChain(...) payload).
//
// KEY RESOLUTION (bugfix preserved): the option chain key the user enters in the
// Settings UI is stored in the ENCRYPTED VAULT under (analystId
// 'options_ingestion', sourceId 'polygonOptions') — NOT in process.env. This
// route resolves that vault key and passes it to resolveDomain as `apiKey`,
// otherwise the domain always degrades to MOCK even with a key set + tested OK.
// Env var stays as a fallback.
import type { Express } from 'express';
import { resolveDomain } from '../registry/logic/domains';
import type { OptionChainFetchFn } from '../registry/logic/hist';
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
      const ctxFetch = fetchFn ? ((url: string, _init?: any) => (fetchFn as any)(url)) as any : undefined;
      const [rec] = await resolveDomain('option_chain', symbol, {
        ...(apiKey ? { apiKey } : {}),
        ...(ctxFetch ? { fetchFn: ctxFetch } : {}),
      });
      return res.json((rec as any)?.data ?? null);
    } catch (err) {
      return res.status(502).json({
        error: `options-history fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });
}

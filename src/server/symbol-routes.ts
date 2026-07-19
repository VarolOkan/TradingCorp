// src/server/symbol-routes.ts
// Registers GET /validate-symbols?symbols=AAPL,MSFT,IRON. Server-side validation
// of candidate ticker symbols against a tokenless symbol API (Stooq). This is the
// single source of truth shared with the orchestrator's query-parsing validation
// (src/utils/symbol-lookup.ts) — the frontend must call THIS endpoint rather than
// validating in the browser, because the symbol API is not CORS-accessible from
// the client. Response is fail-open: a network/parse error resolves every symbol
// as valid so the UI never blocks the user on an outage.
import type { Express, Request } from 'express';
import { validateTickers, type SymbolValidationResult } from '../utils/symbol-lookup';

function parseSymbols(req: Request): string[] {
  const raw = typeof req.query.symbols === 'string' ? req.query.symbols : '';
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s.length > 0);
}

export function registerSymbolRoutes(
  app: Express,
  validateFn: (tickers: string[]) => Promise<SymbolValidationResult> = (t) => validateTickers(t),
): void {
  app.get('/validate-symbols', async (req, res) => {
    const symbols = parseSymbols(req);
    if (symbols.length === 0) {
      res.status(400).json({ error: 'symbols query parameter is required' });
      return;
    }
    try {
      const { valid, invalid, localHits } = await validateFn(symbols);
      res.status(200).json({
        results: symbols.map((symbol) => ({ symbol, valid: valid.includes(symbol) })),
        valid,
        invalid,
        localHits,
      });
    } catch (err) {
      res.status(502).json({
        error: 'symbol validation failed',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

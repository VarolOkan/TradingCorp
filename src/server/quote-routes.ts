// src/server/quote-routes.ts
// Registers GET /quote?symbol=AAPL. Thin wrapper over fetchQuote (src/server/quote.ts).
// Kept separate from index.ts so it can be unit-tested with supertest without
// booting the full Socket.IO server.
import type { Express } from 'express';
import { fetchQuote, makeYahooFundFetch, type FetchFn, type FundFetchFn } from './quote';

export function registerQuoteRoutes(app: Express, fetchFn?: FetchFn, fundFetch?: FundFetchFn): void {
  // Production fundamentals fetch (tokenless Yahoo crumb dance). Tests inject a
  // mock fundFetch to stay network-free.
  const fund = fundFetch ?? makeYahooFundFetch();
  app.get('/quote', async (req, res) => {
    const symbol = typeof req.query.symbol === 'string' ? req.query.symbol.trim() : '';
    if (!symbol) {
      res.status(400).json({ error: 'symbol query parameter is required' });
      return;
    }
    try {
      const quote = await fetchQuote(symbol, fetchFn, fund);
      res.status(200).json(quote);
    } catch (err) {
      res.status(502).json({
        error: 'quote fetch failed',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

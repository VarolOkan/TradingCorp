// src/tests/symbol-routes.test.ts
// Server-side GET /validate-symbols. Uses supertest against a bare express app
// with only the symbol route registered. The real two-layer validateTickers is
// replaced by an injected hermetic validateFn (Yahoo-shaped JSON), so no real
// network call is made and the universe pull is bypassed.
import request from 'supertest';
import express from 'express';
import { registerSymbolRoutes } from '../server/symbol-routes';
import type { SymbolValidationResult } from '../utils/symbol-lookup';

// Build a hermetic validateFn: symbols in `validSet` are valid, others invalid.
function fakeValidate(validSet: Set<string>, localHits: string[] = []): (t: string[]) => Promise<SymbolValidationResult> {
  return async (tickers: string[]) => {
    const dedup = Array.from(new Set(tickers.map((t) => t.toUpperCase())));
    const valid = dedup.filter((t) => validSet.has(t));
    const invalid = dedup.filter((t) => !validSet.has(t));
    return {
      valid,
      invalid,
      localHits: localHits.filter((t) => validSet.has(t.toUpperCase())),
    };
  };
}

function makeApp(validateFn: (t: string[]) => Promise<SymbolValidationResult>) {
  const app = express();
  registerSymbolRoutes(app, validateFn);
  return app;
}

describe('GET /validate-symbols', () => {
  it('returns 400 when no symbols are supplied', async () => {
    const res = await request(makeApp(fakeValidate(new Set()))).get('/validate-symbols');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/symbols query parameter/);
  });

  it('splits valid and invalid symbols', async () => {
    const validateFn = fakeValidate(new Set(['AAPL', 'MSFT']));
    const res = await request(makeApp(validateFn)).get('/validate-symbols?symbols=AAPL,GGGGGG,MSFT');
    expect(res.status).toBe(200);
    expect(res.body.valid.sort()).toEqual(['AAPL', 'MSFT']);
    expect(res.body.invalid).toEqual(['GGGGGG']);
    expect(res.body.results).toEqual([
      { symbol: 'AAPL', valid: true },
      { symbol: 'GGGGGG', valid: false },
      { symbol: 'MSFT', valid: true },
    ]);
  });

  it('reports localHits for symbols resolved from the universe set', async () => {
    // AAPL is in the universe (local hit); MSFT is valid but resolved via Yahoo.
    const validateFn = fakeValidate(new Set(['AAPL', 'MSFT']), ['AAPL']);
    const res = await request(makeApp(validateFn)).get('/validate-symbols?symbols=AAPL,MSFT');
    expect(res.body.localHits).toEqual(['AAPL']);
  });

  it('fails OPEN (all valid) when the validate fn throws', async () => {
    const validateFn = async () => {
      throw new Error('downstream error');
    };
    const res = await request(makeApp(validateFn)).get('/validate-symbols?symbols=IRON,SPY');
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/symbol validation failed/);
  });

  it('de-duplicates symbols', async () => {
    const validateFn = fakeValidate(new Set(['AAPL']));
    const res = await request(makeApp(validateFn)).get('/validate-symbols?symbols=aapl,AAPL');
    expect(res.status).toBe(200);
    expect(res.body.valid).toEqual(['AAPL']);
  });
});

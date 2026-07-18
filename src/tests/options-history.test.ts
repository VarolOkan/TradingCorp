// src/tests/options-history.test.ts
// Phase I (options historical chains): real Polygon chain + mock fallback.
import { registerOptionsHistoryRoutes } from '../server/options-history-routes';
import { acquireOptionChain } from '../registry/sources/adapters/option-chain';
import express from 'express';
import request from 'supertest';

function makeApp(fetchFn: any) {
  const app = express();
  app.use(express.json());
  registerOptionsHistoryRoutes(app, fetchFn);
  return app;
}

const polygonSnapshot = (over: any = {}) => ({
  results: {
    underlying_asset: { last_price: 190.5 },
    results: [
      {
        details: { expiration_date: '2026-08-21', strike_price: 190, contract_type: 'call', open_interest: 1234 },
        greeks: { implied_volatility: 0.32, last_price: 5.4, size: 50 },
        last_quote: { bid: 5.3, ask: 5.5 },
        last_trade: { price: 5.4, size: 50 },
      },
      {
        details: { expiration_date: '2026-08-21', strike_price: 190, contract_type: 'put', open_interest: 987 },
        greeks: { implied_volatility: 0.34, last_price: 4.1, size: 30 },
        last_quote: { bid: 4.0, ask: 4.2 },
        last_trade: { price: 4.1, size: 30 },
      },
      {
        details: { expiration_date: '2026-09-18', strike_price: 195, contract_type: 'call', open_interest: 500 },
        greeks: { implied_volatility: 0.3, last_price: 3.0 },
        last_quote: { bid: 2.9, ask: 3.1 },
      },
    ],
    ...over,
  },
});

// Response-like stub returning BOTH text (what acquireOptionChain now reads
// first) and json, so the live parse path works regardless of which the
// code consumes.
function okRes(snapshot: any, status = 200) {
  const body = JSON.stringify(snapshot);
  return { ok: status >= 200 && status < 300, status, text: async () => body, json: async () => snapshot };
}
function errRes(status: number, body: any = {}) {
  const t = JSON.stringify(body);
  return { ok: false, status, text: async () => t, json: async () => body };
}

describe('acquireOptionChain (Phase I)', () => {
  it('maps a Polygon snapshot into OptionQuote[] with source polygon', async () => {
    const fetchFn = async () => okRes(polygonSnapshot());
    const r = await acquireOptionChain('aapl', { apiKey: 'demo', fetchFn });
    expect(r.source).toBe('polygon');
    expect(r.ticker).toBe('AAPL');
    expect(r.underlying_price).toBe(190.5);
    expect(r.quotes.length).toBe(3);
    expect(r.expiries).toEqual(['2026-08-21', '2026-09-18']);
    const call = r.quotes.find((q) => q.strike === 190 && q.type === 'C');
    expect(call?.bid).toBe(5.3);
    expect(call?.iv).toBe(0.32);
    expect(call?.open_interest).toBe(1234);
  });

  it('falls back to deterministic mock when no API key is supplied', async () => {
    const r = await acquireOptionChain('AAPL');
    expect(r.source).toBe('mock');
    expect(r.quotes.length).toBeGreaterThan(0);
    expect(r.note).toContain('No POLYGON_API_KEY');
  });

  it('falls back to mock when Polygon returns a non-ok status', async () => {
    const fetchFn = async () => errRes(429);
    const r = await acquireOptionChain('AAPL', { apiKey: 'demo', fetchFn });
    expect(r.source).toBe('mock');
  });

  it('falls back to mock when the payload has no results', async () => {
    const fetchFn = async () => okRes({ results: { results: [] } });
    const r = await acquireOptionChain('AAPL', { apiKey: 'demo', fetchFn });
    expect(r.source).toBe('mock');
  });
});

describe('GET /options-history route (Phase I)', () => {
  it('400 when symbol missing', async () => {
    const app = makeApp(async () => okRes(polygonSnapshot()));
    const res = await request(app).get('/options-history');
    expect(res.status).toBe(400);
  });

  it('200 with live chain from Polygon', async () => {
    const app = makeApp(async () => okRes(polygonSnapshot()));
    const res = await request(app).get('/options-history?symbol=AAPL');
    expect(res.status).toBe(200);
    expect(res.body.source).toBe('polygon');
    expect(res.body.quotes.length).toBe(3);
  });

  it('200 with mock fallback when no key configured', async () => {
    // no fetchFn → reads process.env.POLYGON_API_KEY (unset in test env)
    const app = express();
    app.use(express.json());
    registerOptionsHistoryRoutes(app);
    const res = await request(app).get('/options-history?symbol=AAPL');
    expect(res.status).toBe(200);
    expect(res.body.source).toBe('mock');
  });

  it('resolves the VAULT key (Settings UI channel) and takes the LIVE path with no injected fetchFn', async () => {
    // Regression: the Options tab showed MOCK even after the user set + tested
    // the Massive/Polygon key, because this route only read process.env and
    // ignored the vault key the Settings UI writes (options_ingestion/polygonOptions).
    const { analystConfigStore } = await import('../server/analyst-config');
    analystConfigStore.set(
      { sessionId: 'default', analystId: 'options_ingestion', sourceId: 'polygonOptions' },
      { token: 'vault-massive-key' },
    );
    // Stub the global fetch acquireOptionChain uses when no fetchFn is injected;
    // assert the vault key reached the outgoing request as a Bearer header
    // (the auth scheme the [Test] probe + engine use — NOT a ?apiKey= param,
    // which Massive rejects) and the URL is the bare api.massive.com endpoint.
    const seenUrls: string[] = [];
    const seenAuth: string[] = [];
    const g: any = globalThis;
    const prevFetch = g.fetch;
    g.fetch = async (url: string, headers?: Record<string, string>) => {
      seenUrls.push(String(url));
      if (headers?.Authorization) seenAuth.push(headers.Authorization);
      return okRes(polygonSnapshot());
    };
    try {
      const app = express();
      app.use(express.json());
      registerOptionsHistoryRoutes(app); // NO fetchFn injected — must resolve vault key itself
      const res = await request(app).get('/options-history?symbol=AAPL');
      expect(res.status).toBe(200);
      expect(res.body.source).toBe('polygon'); // LIVE, not mock
      expect(seenUrls.some((u) => u.includes('api.massive.com'))).toBe(true);
      expect(seenUrls.some((u) => u.includes('/v3/snapshot/options/AAPL'))).toBe(true);
      expect(seenUrls.some((u) => u.includes('apiKey='))).toBe(false); // not a query-param key
      expect(seenAuth.some((h) => h === 'Bearer vault-massive-key')).toBe(true);
    } finally {
      g.fetch = prevFetch;
      analystConfigStore.clear({ sessionId: 'default', analystId: 'options_ingestion', sourceId: 'polygonOptions' });
    }
  });
});

describe('GET /options-history greeks (Phase 17)', () => {
  it('returns a greeks row per quote with valid BS deltas for a live chain', async () => {
    const app = makeApp(async () => okRes(polygonSnapshot()));
    const res = await request(app).get('/options-history?symbol=AAPL');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.greeks)).toBe(true);
    expect(res.body.greeks.length).toBe(res.body.quotes.length);
    for (const g of res.body.greeks) {
      // delta bounds: call in [0,1], put in [-1,0]
      if (g.type === 'C') {
        expect(g.delta).toBeGreaterThanOrEqual(0);
        expect(g.delta).toBeLessThanOrEqual(1);
      } else {
        expect(g.delta).toBeGreaterThanOrEqual(-1);
        expect(g.delta).toBeLessThanOrEqual(0);
      }
      expect(Number.isFinite(g.gamma)).toBe(true);
      expect(Number.isFinite(g.vega)).toBe(true);
      expect(Number.isFinite(g.theta)).toBe(true);
      expect(g.iv_in).toBeGreaterThan(0);
      expect(g.ttm_years).toBeGreaterThan(0);
    }
  });

  it('derives greeks for the mock chain too (no provider needed)', async () => {
    const app = express();
    app.use(express.json());
    registerOptionsHistoryRoutes(app);
    const res = await request(app).get('/options-history?symbol=AAPL');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.greeks)).toBe(true);
    expect(res.body.greeks.length).toBe(res.body.quotes.length);
    // ATM call delta should be near 0.5
    const atmCall = res.body.greeks.find(
      (g: any) => g.type === 'C' && Math.abs(g.strike - res.body.underlying_price) < 1,
    );
    if (atmCall) expect(Math.abs(atmCall.delta - 0.5)).toBeLessThan(0.15);
  });
});

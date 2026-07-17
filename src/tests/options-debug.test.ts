// src/tests/options-debug.test.ts
// Self-diagnostic endpoint for the Options tab's live feed.
import { registerOptionsDebugRoutes } from '../server/options-debug-routes';
import { analystConfigStore } from '../server/analyst-config';
import express from 'express';
import request from 'supertest';

function makeApp() {
  const app = express();
  app.use(express.json());
  registerOptionsDebugRoutes(app);
  return app;
}

const snapshotOk = (ticker: string) => ({
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
    ],
  },
});

describe('GET /debug/options-auth', () => {
  afterEach(() => {
    analystConfigStore.clear({ sessionId: 'default', analystId: 'options_ingestion', sourceId: 'polygonOptions' });
  });

  it('reports NO_KEY when neither vault nor env key is set', async () => {
    const app = makeApp();
    const res = await request(app).get('/debug/options-auth?symbol=AAPL');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.reason).toBe('NO_KEY');
    expect(res.body.steps[0].keySource).toBe('none');
  });

  it('runs the live call with a Bearer header and returns OK when Massive responds', async () => {
    analystConfigStore.set(
      { sessionId: 'default', analystId: 'options_ingestion', sourceId: 'polygonOptions' },
      { token: 'vault-massive-key' },
    );
    const seen: Array<{ url?: string; headers?: Record<string, string> }> = [];
    const g: any = globalThis;
    const prev = g.fetch;
    g.fetch = async (url: string, init?: any) => {
      seen.push({ url: String(url), headers: init?.headers });
      return {
        status: 200,
        statusText: 'OK',
        headers: new Map([['content-type', 'application/json']]),
        text: async () => JSON.stringify(snapshotOk('AAPL')),
      } as any;
    };
    try {
      const app = makeApp();
      const res = await request(app).get('/debug/options-auth?symbol=AAPL');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.reason).toBe('OK');
      expect(res.body.steps[0].keySource).toBe('vault(options_ingestion/polygonOptions)');
      // Auth scheme must be Bearer, NOT a query-param key.
      expect(seen[0]?.url).not.toContain('apiKey=');
      expect(seen[0]?.headers?.Authorization).toBe('Bearer vault-massive-key');
      expect(res.body.steps.find((s: any) => s.step === 'liveCall')?.auth).toBe('Bearer');
    } finally {
      g.fetch = prev;
    }
  });

  it('reports the real HTTP status when Massive rejects the key (e.g. 401)', async () => {
    analystConfigStore.set(
      { sessionId: 'default', analystId: 'options_ingestion', sourceId: 'polygonOptions' },
      { token: 'bad-key' },
    );
    const g: any = globalThis;
    const prev = g.fetch;
    g.fetch = async () => ({
      status: 401,
      statusText: 'Unauthorized',
      headers: new Map([['content-type', 'application/json']]),
      text: async () => JSON.stringify({ status: 'error', message: 'Invalid API key' }),
    } as any);
    try {
      const app = makeApp();
      const res = await request(app).get('/debug/options-auth?symbol=AAPL');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(false);
      expect(res.body.reason).toBe('HTTP_401');
      expect(res.body.message).toContain('401');
    } finally {
      g.fetch = prev;
    }
  });
});

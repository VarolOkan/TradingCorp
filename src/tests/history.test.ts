// src/tests/history.test.ts
// Phase I (historical quotes): real OHLCV bars from Yahoo, mock fallback.
import { registerHistoryRoutes } from '../server/history-routes';
import { fetchPriceBars } from '../registry/logic/hist';
import express from 'express';
import type { Server } from 'http';
import request from 'supertest';

function makeApp(fetchFn: any) {
  const app = express();
  app.use(express.json());
  registerHistoryRoutes(app, fetchFn);
  return app;
}

const yahooChart = (over: any = {}) => ({
  chart: {
    result: [
      {
        timestamp: [1700000000, 1700086400, 1700172800],
        indicators: {
          quote: [
            {
              open: [100, 101, 102],
              high: [103, 104, 105],
              low: [99, 100, 101],
              close: [101, 102, 103],
              volume: [1000, 1100, 1200],
              ...over.quote,
            },
          ],
        },
        ...over.result,
      },
    ],
    error: null,
  },
});

describe('fetchPriceBars (Phase I)', () => {
  it('maps Yahoo chart JSON to PriceBar[] with source yahoo', async () => {
    const fetchFn = async () => ({ ok: true, status: 200, json: async () => yahooChart() });
    const r = await fetchPriceBars('aapl', { interval: '1d', lookbackDays: 90, fetchFn });
    expect(r.source).toBe('yahoo');
    expect(r.ticker).toBe('AAPL');
    expect(r.bars.length).toBe(3);
    expect(r.bars[0]).toMatchObject({ open: 100, close: 101, high: 103, low: 99, volume: 1000 });
    expect(r.bars[0].t).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(r.note).toBeUndefined();
  });

  it('skips null-padded bars and still returns the real ones', async () => {
    const fetchFn = async () => ({
      ok: true,
      status: 200,
      json: async () =>
        yahooChart({ quote: { open: [null, 101, 102], high: [null, 104, 105], low: [null, 100, 101], close: [null, 102, 103], volume: [null, 1100, 1200] } }),
    });
    const r = await fetchPriceBars('AAPL', { fetchFn });
    expect(r.source).toBe('yahoo');
    expect(r.bars.length).toBe(2); // first null-padded bar skipped
  });

  it('falls back to deterministic mock bars when Yahoo is unreachable', async () => {
    const fetchFn = async () => {
      throw new Error('ENOTFOUND');
    };
    const r = await fetchPriceBars('AAPL', { fetchFn });
    expect(r.source).toBe('mock');
    expect(r.bars.length).toBeGreaterThan(0);
    expect(r.note).toContain('unavailable');
  });

  it('falls back to mock when Yahoo returns a non-ok status', async () => {
    const fetchFn = async () => ({ ok: false, status: 429, json: async () => ({}) });
    const r = await fetchPriceBars('AAPL', { fetchFn });
    expect(r.source).toBe('mock');
  });

  it('falls back to mock when no fetchFn is supplied', async () => {
    const r = await fetchPriceBars('AAPL');
    expect(r.source).toBe('mock');
    expect(r.bars.length).toBeGreaterThan(0);
  });

  it('Phase 22: 1h and 4h mock bars are spaced at the correct step (honest, not mislabeled 1m)', async () => {
    const h1 = await fetchPriceBars('AAPL', { interval: '1h', lookbackDays: 2 });
    const h4 = await fetchPriceBars('AAPL', { interval: '4h', lookbackDays: 2 });
    expect(h1.source).toBe('mock');
    expect(h4.source).toBe('mock');
    // 1h step = 3,600,000 ms; 4h step = 14,400,000 ms.
    const step = (a: typeof h1) =>
      new Date(a.bars[a.bars.length - 1].t).getTime() -
      new Date(a.bars[a.bars.length - 2].t).getTime();
    expect(step(h1)).toBe(3600_000);
    expect(step(h4)).toBe(14_400_000);
    // Intraday bars carry vwap; 1h/4h bar counts are capped at 390.
    expect(h1.bars[0].vwap).toBeDefined();
    expect(h4.bars[0].vwap).toBeDefined();
    expect(h1.bars.length).toBeLessThanOrEqual(390);
    expect(h4.bars.length).toBeLessThanOrEqual(390);
  });
});

describe('GET /history route (Phase I)', () => {
  it('400 when symbol missing', async () => {
    const app = makeApp(async () => ({ ok: true, status: 200, json: async () => yahooChart() }));
    const res = await request(app).get('/history');
    expect(res.status).toBe(400);
  });

  it('200 with live bars from Yahoo', async () => {
    const app = makeApp(async () => ({ ok: true, status: 200, json: async () => yahooChart() }));
    const res = await request(app).get('/history?symbol=AAPL&interval=1d&lookback=90');
    expect(res.status).toBe(200);
    expect(res.body.source).toBe('yahoo');
    expect(res.body.bars.length).toBe(3);
  });

  it('200 with mock fallback when Yahoo fails', async () => {
    const app = makeApp(async () => {
      throw new Error('ENOTFOUND');
    });
    const res = await request(app).get('/history?symbol=AAPL');
    expect(res.status).toBe(200);
    expect(res.body.source).toBe('mock');
  });
});

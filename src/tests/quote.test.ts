// src/tests/quote.test.ts
// Phase I: GET /quote proxy + fetchQuote parsing.
// - success: parses name, price, day range, 52w range, volume, currency
// - failure: Yahoo returns non-ok → graceful `note`, no throw
// - empty: Yahoo returns no result → `note: 'no quote data'`
import { registerQuoteRoutes } from '../server/quote-routes';
import { fetchQuote } from '../server/quote';
import express from 'express';
import type { Server } from 'http';
import request from 'supertest';

function makeApp(fetchFn: any, fundFetch?: any) {
  // Default to a no-op fundamentals fetch so route tests stay network-free;
  // the explicit fundamentals tests pass their own mock, and production injects
  // the real makeYahooFundFetch via index.ts.
  const fund = fundFetch ?? (async () => ({ ok: true, status: 200, text: async () => '{}', json: async () => ({}) }));
  const app = express();
  app.use(express.json());
  registerQuoteRoutes(app, fetchFn, fund);
  return app;
}

const yahooPayload = (over: any = {}) => ({
  chart: {
    result: [
      {
        meta: {
          symbol: 'AAPL',
          shortName: 'Apple Inc.',
          longName: 'Apple Inc.',
          regularMarketPrice: 189.5,
          previousClose: 188.0,
          fiftyTwoWeekHigh: 199.62,
          fiftyTwoWeekLow: 164.21,
          currency: 'USD',
          regularMarketTime: 1719000000,
          ...over.meta,
        },
        indicators: {
          quote: [
            {
              high: [191.2, 190.0],
              low: [188.1, 187.5],
              volume: [12345678, 11000000],
              ...over.quote,
            },
          ],
        },
        timestamp: [1719000000, 1719086400],
        ...over.result,
      },
    ],
    error: null,
  },
});

describe('fetchQuote (Phase I)', () => {
  it('parses company name, price, day range, 52w range, volume', async () => {
    const fetchFn = async () => ({ ok: true, status: 200, json: async () => yahooPayload() });
    const q = await fetchQuote('aapl', fetchFn);
    expect(q.symbol).toBe('AAPL');
    expect(q.name).toBe('Apple Inc.');
    expect(q.price).toBe(189.5);
    expect(q.dayHigh).toBe(190.0); // last bar high
    expect(q.dayLow).toBe(187.5); // last bar low
    expect(q.week52High).toBe(199.62);
    expect(q.week52Low).toBe(164.21);
    expect(q.previousClose).toBe(188.0);
    expect(q.volume).toBe(11000000); // last bar volume
    expect(q.currency).toBe('USD');
    expect(q.source).toBe('yahoo');
    expect(q.note).toBeUndefined();
  });

  it('falls back to shortName when longName is absent', async () => {
    const fetchFn = async () => ({
      ok: true,
      status: 200,
      json: async () => yahooPayload({ meta: { longName: undefined, shortName: 'Apple' } }),
    });
    const q = await fetchQuote('AAPL', fetchFn);
    expect(q.name).toBe('Apple');
  });

  it('derives change / %change / 3mo avg vol / 1yr change from the OHLCV series', async () => {
    const fetchFn = async () => ({
      ok: true,
      status: 200,
      json: async () => yahooPayload({
        // Force meta.previousClose absent so it derives from the series.
        meta: { previousClose: undefined, fiftyTwoWeekHigh: undefined, fiftyTwoWeekLow: undefined, fullExchangeName: 'NasdaqGS' },
        quote: {
          open: [188.0, 187.0],
          high: [191.2, 190.0],
          low: [188.1, 187.5],
          close: [188.0, 189.5], // prev=188.0, last=189.5 → +1.5 / +0.80%
          volume: [20000000, 10000000], // avg of last 63 = 15,000,000
        },
      }),
    });
    const q = await fetchQuote('AAPL', fetchFn);
    expect(q.open).toBe(187.0); // last bar open
    expect(q.previousClose).toBe(188.0); // derived from bar[-2].close
    expect(q.change).toBeCloseTo(1.5, 2);
    expect(q.changePct).toBeCloseTo(0.8, 2);
    expect(q.avgVolume3m).toBe(15000000);
    expect(q.yearChangePct).toBeCloseTo(((189.5 - 188.0) / 188.0) * 100, 2); // vs first close
    expect(q.exchange).toBe('NasdaqGS');
    expect(q.volume).toBe(10000000); // last bar volume
  });

  it('computes 52-week high/low from the series when meta omits them', async () => {
    const fetchFn = async () => ({
      ok: true,
      status: 200,
      json: async () => yahooPayload({
        meta: { fiftyTwoWeekHigh: undefined, fiftyTwoWeekLow: undefined },
        quote: { high: [191.2, 195.0, 190.0], low: [188.1, 180.0, 187.5], close: [188.0, 189.5, 190.0] },
      }),
    });
    const q = await fetchQuote('AAPL', fetchFn);
    expect(q.week52High).toBe(195.0);
    expect(q.week52Low).toBe(180.0);
  });

  it('normalizes marketState into the UI-friendly set', async () => {
    const fetchFn = async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => yahooPayload({ meta: { marketState: 'REGULAR' } }),
    });
    const q = await fetchQuote('AAPL', fetchFn);
    expect(q.marketState).toBe('REGULAR');
  });

  it('merges fundamentals (crumb dance) when a fundFetch is injected', async () => {
    const fetchFn = async () => ({ ok: true, status: 200, json: async () => yahooPayload() });
    // Mock the 3-step fundamentals dance: cookie seed, crumb, summary.
    const fundFetch = async (url: string) => {
      if (url.includes('getcrumb')) {
        return { ok: true, status: 200, text: async () => 'test-crumb-123', json: async () => 'test-crumb-123' };
      }
      if (url.includes('quoteSummary')) {
        return {
          ok: true,
          status: 200,
          text: async () => '{}',
          json: async () => ({
            quoteSummary: {
              result: [
                {
                  price: { marketCap: { raw: 4_630_000_000_000 } },
                  summaryDetail: {
                    averageVolume: { raw: 54_680_000 },
                    averageVolume10days: { raw: 73_850_000 },
                    dividendYield: { raw: 0.0034 },
                    trailingPE: { raw: 38.17 },
                    epsTrailingTwelveMonths: { raw: 8.27 },
                    priceToSalesTrailing12Months: { raw: 10.26 },
                    priceToBook: { raw: 56.1 },
                  },
                  defaultKeyStatistics: {
                    sharesOutstanding: { raw: 14_690_000_000 },
                    floatShares: { raw: 14_660_000_000 },
                  },
                  calendarEvents: { earnings: { earningsDate: [{ raw: 1785441600, fmt: '2026-07-30' }] } },
                },
              ],
              error: null,
            },
          }),
        };
      }
      return { ok: true, status: 200, text: async () => '{}', json: async () => ({}) }; // fc.yahoo.com seed
    };
    const q = await fetchQuote('AAPL', fetchFn, fundFetch);
    expect(q.marketCap).toBe(4_630_000_000_000);
    expect(q.sharesOut).toBe(14_690_000_000);
    expect(q.floatShares).toBe(14_660_000_000);
    expect(q.avgVolume3m).toBe(54_680_000); // summary overrides series-derived
    expect(q.avgVolume10d).toBe(73_850_000);
    expect(q.dividendYield).toBeCloseTo(0.0034, 5);
    expect(q.peTTM).toBe(38.17);
    expect(q.epsTTM).toBe(8.27);
    expect(q.priceToSales).toBe(10.26);
    expect(q.priceToBook).toBe(56.1);
    expect(q.earningsDate).toBe('2026-07-30');
  });

  it('leaves fundamentals null (no throw) when fundFetch returns empty', async () => {
    const fetchFn = async () => ({ ok: true, status: 200, json: async () => yahooPayload() });
    const fundFetch = async (url: string) => {
      if (url.includes('getcrumb')) return { ok: true, status: 200, text: async () => '', json: async () => '' }; // no crumb
      return { ok: true, status: 200, text: async () => '{}', json: async () => ({}) };
    };
    const q = await fetchQuote('AAPL', fetchFn, fundFetch);
    expect(q.marketCap).toBeNull();
    expect(q.earningsDate).toBeNull();
  });

  it('omits fundamentals when no fundFetch is injected (network-free tests)', async () => {
    const fetchFn = async () => ({ ok: true, status: 200, json: async () => yahooPayload() });
    const q = await fetchQuote('AAPL', fetchFn); // no 3rd arg
    expect(q.marketCap).toBeNull();
    expect(q.earningsDate).toBeNull();
  });

  it('returns a note (not a throw) when Yahoo responds non-ok', async () => {
    const fetchFn = async () => ({ ok: false, status: 429, json: async () => ({}) });
    const q = await fetchQuote('AAPL', fetchFn);
    expect(q.price).toBeNull();
    expect(q.note).toContain('429');
  });

  it('returns a note when Yahoo returns no result', async () => {
    const fetchFn = async () => ({ ok: true, status: 200, json: async () => ({ chart: { result: [], error: null } }) });
    const q = await fetchQuote('ZZZZ', fetchFn);
    expect(q.note).toBe('no quote data');
  });

  it('returns a note when the fetch throws (network error)', async () => {
    const fetchFn = async () => {
      throw new Error('ENOTFOUND');
    };
    const q = await fetchQuote('AAPL', fetchFn);
    expect(q.note).toContain('ENOTFOUND');
  });
});

describe('GET /quote route (Phase I)', () => {
  it('400 when symbol missing', async () => {
    const app = makeApp(async () => ({ ok: true, status: 200, json: async () => yahooPayload() }));
    const res = await request(app).get('/quote');
    expect(res.status).toBe(400);
  });

  it('200 with normalized quote', async () => {
    const app = makeApp(async () => ({ ok: true, status: 200, json: async () => yahooPayload() }));
    const res = await request(app).get('/quote?symbol=AAPL');
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Apple Inc.');
    expect(res.body.price).toBe(189.5);
  });
});

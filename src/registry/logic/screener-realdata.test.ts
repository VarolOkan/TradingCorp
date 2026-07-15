// src/registry/logic/screener-realdata.test.ts
// Phase 2 (TDD): real-data wiring + truthful source badge. NETWORK-FREE —
// uses an injected fetchFn that returns yahoo-shaped payloads, and asserts
// the per-ticker source + the aggregate dataSource badge are correct.
import { screenTickers } from './screener';
import type { PriceBarsFetchFn } from './hist';
import type { NewsFetchFn } from './news';

// Yahoo chart-shaped payload (v8/finance/chart).
function yahooChartPayload(symbol: string) {
  const ts: number[] = [];
  const open: number[] = [];
  const close: number[] = [];
  const high: number[] = [];
  const low: number[] = [];
  const volume: number[] = [];
  let t = Date.UTC(2026, 6, 1);
  let p = 100;
  for (let i = 0; i < 30; i++) {
    ts.push(Math.floor(t / 1000));
    const o = p;
    const c = p * (1 + (i % 3 === 0 ? 0.02 : -0.01));
    open.push(o);
    close.push(c);
    high.push(Math.max(o, c) * 1.01);
    low.push(Math.min(o, c) * 0.99);
    volume.push(1_000_000 + i * 10_000);
    p = c;
    t += 24 * 3600 * 1000;
  }
  return {
    chart: {
      result: [
        {
          timestamp: ts,
          indicators: { quote: [{ open, close, high, low, volume }] },
        },
      ],
    },
  };
}

const priceFetch: PriceBarsFetchFn = async (url: string) => {
  const sym = (url.match(/chart\/([A-Z.]+)/)?.[1] ?? 'AAPL').toUpperCase();
  return {
    ok: true,
    status: 200,
    json: async () => yahooChartPayload(sym),
  } as any;
};

// Mock NEWS (no-key path): returns seeded headlines.
const newsFetch: NewsFetchFn = async (_url: string) => ({
  ok: true,
  json: async () => [],
  status: 200,
});

// Mock UNIVERSE fetch: returns a tiny nasdaqtraded.txt with one real name + a Yahoo quote.
const universeFetch = async (url: string) => {
  if (url.includes('nasdaqtraded')) {
    return {
      ok: true,
      status: 200,
      text: async () =>
        'Nasdaq Traded|Symbol|Security Name|Listing Exchange|Market Category|ETF|Round Lot Size|Test Issue|Financial Status|CQS Symbol|NASDAQ Symbol|NextShares\n' +
        'Y|ACME|Acme Corp|Q|Q|N|100|N|N|ACME|ACME|A|\n',
    } as any;
  }
  if (url.includes('quote')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        quoteResponse: {
          result: [
            { symbol: 'ACME', regularMarketPrice: 50, marketCap: 5e10, averageDailyVolume3Month: 1e7, exchangeName: 'NMS' },
          ],
        },
      }),
    } as any;
  }
  return { ok: false, status: 404, text: async () => '', json: async () => ({}) } as any;
};

describe('screener — real-data wiring (Phase 2)', () => {
  it('marks rows barsSource=yahoo when a real fetchFn returns bars', async () => {
    const res = await screenTickers('long-term', {
      universe: ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'TSLA'],
      limit: 3,
      fetchFn: priceFetch,
      newsFetchFn: newsFetch,
    });
    expect(res.rows.length).toBe(3);
    expect(res.rows.every((r) => r.barsSource === 'yahoo')).toBe(true);
    expect(res.dataSource).toBe('DELAYED');
  });

  it('badges DELAYED (not MOCK) when the universe is live but bars fall back to mock', async () => {
    // Explicit live universe passed, but no fetchFn -> bars fall through to the
    // deterministic mock. The universe is still real, so the screen is DELAYED
    // (not MOCK); MOCK is reserved for when the universe itself fell back.
    const res = await screenTickers('long-term', {
      universe: ['AAPL', 'MSFT'],
      limit: 2,
    });
    expect(res.rows.every((r) => r.barsSource === 'mock')).toBe(true);
    expect(res.dataSource).toBe('DELAYED');
    expect(res.liveRows).toBe(0);
  });

  it('badges MOCK only when the universe itself fell back AND all bars are mock', async () => {
    // No universe + no fetch transport -> getUniverse falls to DEFAULT_UNIVERSE
    // (usedFallback) and bars are mock -> genuinely nothing live -> MOCK.
    const res = await screenTickers('long-term', {} as any);
    const fellBack = res.universeTrace?.usedFallback === true;
    const allMock = res.rows.every((r) => r.barsSource === 'mock');
    if (fellBack && allMock) {
      expect(res.dataSource).toBe('MOCK');
    } else {
      // If the sandbox HAS egress, the universe is live -> DELAYED by design.
      expect(res.dataSource).toBe('DELAYED');
    }
  });

  it('propagates an asOf timestamp from the newest bar', async () => {
    const res = await screenTickers('long-term', {
      universe: ['AAPL'],
      limit: 1,
      fetchFn: priceFetch,
      newsFetchFn: newsFetch,
    });
    expect(res.rows[0]!.asOf).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('attaches a universeTrace describing the pipeline (fallback when no live source)', async () => {
    // No universe passed + no universeFetchFn -> getUniverse falls through to
    // DEFAULT_UNIVERSE (no egress in the sandbox) and records a fallback trace.
    const res = await screenTickers('long-term', { agencyId: 'long-term' } as any);
    expect(res.universeTrace).toBeDefined();
    expect(res.universeTrace!.provider).toBe('fallback');
    expect(res.universeTrace!.usedFallback).toBe(true);
    expect(res.universeTrace!.finalCount).toBe(25);
    // Explicit universe path: caller supplied the list, so no trace is attached.
    const res2 = await screenTickers('long-term', { universe: ['AAPL', 'MSFT'], limit: 2 });
    expect(res2.universeTrace).toBeUndefined();
  });

  it('universeTrace shows LIVE + funnel counts when a real universe fetchFn is injected', async () => {
    const res = await screenTickers('long-term', {
      universeFetchFn: universeFetch as any,
      limit: 10,
    });
    expect(res.universeTrace).toBeDefined();
    expect(res.universeTrace!.origin).toBe('live');
    expect(res.universeTrace!.usedFallback).toBe(false);
    expect(res.universeTrace!.provider).toBe('nasdaqtrader');
    expect(res.universeTrace!.listedCount).toBe(1);
    expect(res.universeTrace!.parsedCount).toBe(1);
    expect(res.universeTrace!.prefilteredCount).toBe(1);
  });
});

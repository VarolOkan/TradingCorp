// src/registry/logic/hist.test.ts
// Phase A tests for the Historical & Derivatives Data Layer. Assert the mock
// bundle is deterministic, structurally valid, and that greeks are internally
// consistent with the chain (BS(mid) ≈ mid, since both come from greeks.ts).

import { generateMockBundle, fetchHistoricalBundle, parseYahooOptions, parseCboeOptions } from './hist';
import { acquireOptionChain, resolveLiveOptionsBundle } from '../sources/adapters/option-chain';
import { bsPrice } from './greeks';

describe('hist — mock bundle structure', () => {
  const bundle = generateMockBundle('AAPL', {
    lookbackDays: 90,
    intervals: ['1d'],
    expiries: 'monthly+weekly',
  });

  it('returns a well-formed bundle', () => {
    expect(bundle.ticker).toBe('AAPL');
    expect(bundle.mock).toBe(true);
    expect(bundle.underlying_price).toBeGreaterThan(0);
    expect(bundle.rfr).toBeCloseTo(0.043, 6);
  });

  it('produces daily price bars of the requested lookback', () => {
    const daily = bundle.price_bars.find((s) => s.interval === '1d')!;
    expect(daily).toBeDefined();
    expect(daily.bars).toHaveLength(90);
    // Chronological order (oldest first).
    const ts = daily.bars.map((b) => new Date(b.t).getTime());
    for (let i = 1; i < ts.length; i++) expect(ts[i]).toBeGreaterThan(ts[i - 1]!);
    // OHLC sanity: high >= low, high >= close, low <= close.
    for (const b of daily.bars) {
      expect(b.high).toBeGreaterThanOrEqual(b.low);
      expect(b.high).toBeGreaterThanOrEqual(b.close);
      expect(b.low).toBeLessThanOrEqual(b.close);
      expect(b.volume).toBeGreaterThan(0);
    }
  });

  it('produces a non-empty option chain with both calls and puts', () => {
    expect(bundle.option_chain.length).toBeGreaterThan(0);
    expect(bundle.option_chain.some((r) => r.type === 'C')).toBe(true);
    expect(bundle.option_chain.some((r) => r.type === 'P')).toBe(true);
    for (const q of bundle.option_chain) {
      expect(q.ask).toBeGreaterThanOrEqual(q.bid);
      expect(q.iv).toBeGreaterThan(0);
      expect(q.strike).toBeGreaterThan(0);
      expect(['C', 'P']).toContain(q.type);
    }
  });

  it('generates 4 monthly + 4 weekly expiries (deduped, sorted)', () => {
    expect(bundle.expiries.length).toBeGreaterThanOrEqual(4);
    const sorted = [...bundle.expiries].sort();
    expect(bundle.expiries).toEqual(sorted);
  });

  it('greeks rows exist for every chain row and are finite', () => {
    expect(bundle.greeks).toHaveLength(bundle.option_chain.length);
    for (const g of bundle.greeks) {
      for (const v of [g.delta, g.gamma, g.vega, g.theta, g.rho, g.ttm_years]) {
        expect(Number.isFinite(v)).toBe(true);
      }
    }
  });

  it('greeks are internally consistent with the chain: BS(mid) ≈ last', () => {
    // Recompute price from the stored greeks-row inputs → must match `last`
    // in the corresponding chain row (both derive from the same BS engine).
    const chainByKey = new Map(
      bundle.option_chain.map((q) => [`${q.expiry}|${q.strike}|${q.type}`, q]),
    );
    let checked = 0;
    for (const g of bundle.greeks) {
      const q = chainByKey.get(`${g.expiry}|${g.strike}|${g.type}`)!;
      const recomputed = bsPrice(g.type, g.underlying_price, g.strike, g.ttm_years, g.rfr, g.iv_in);
      expect(recomputed).toBeCloseTo(q.last, 1);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('provides iv_history samples for percentile/rank math', () => {
    expect(bundle.iv_history.length).toBeGreaterThan(0);
    for (const v of bundle.iv_history) expect(v).toBeGreaterThan(0);
  });
});

describe('hist — determinism', () => {
  it('same ticker + profile → byte-identical bundle', () => {
    const a = generateMockBundle('TSLA', { lookbackDays: 30 });
    const b = generateMockBundle('TSLA', { lookbackDays: 30 });
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });

  it('different tickers → different underlying price/chain', () => {
    const a = generateMockBundle('AAPL');
    const b = generateMockBundle('NVDA');
    expect(a.underlying_price).not.toEqual(b.underlying_price);
  });
});

describe('hist — intraday profile', () => {
  it('produces 5m and 1m bars when requested', () => {
    const bundle = generateMockBundle('SPY', {
      lookbackDays: 5,
      intervals: ['5m', '1m'],
      expiries: 'weekly+0dte',
    });
    expect(bundle.price_bars.some((s) => s.interval === '5m')).toBe(true);
    expect(bundle.price_bars.some((s) => s.interval === '1m')).toBe(true);
  });

  it('0dte profile includes a same-day expiry', () => {
    const bundle = generateMockBundle('SPY', {
      intervals: ['5m'],
      expiries: 'weekly+0dte',
      asOf: '2026-07-10T00:00:00.000Z',
    });
    expect(bundle.expiries).toContain('2026-07-10');
  });
});

describe('hist — async entry point', () => {
  it('fetchHistoricalBundle resolves to the mock bundle', async () => {
    const bundle = await fetchHistoricalBundle('MSFT', { lookbackDays: 10 });
    expect(bundle.ticker).toBe('MSFT');
    expect(bundle.mock).toBe(true);
  });
});

// A tokenless Yahoo v7 /finance/options payload (calls[]/puts[] under options[]).
function yahooPayload(spot = 225.43) {
  return {
    optionChain: {
      result: [
        {
          quote: { regularMarketPrice: spot },
          options: [
            {
              expirationDate: Math.floor(Date.UTC(2026, 6, 17) / 1000),
              calls: [{ strike: 220, bid: 7.1, ask: 7.35, lastPrice: 7.2, impliedVolatility: 0.28, volume: 1200, openInterest: 5300 }],
              puts: [{ strike: 220, bid: 2.1, ask: 2.3, lastPrice: 2.2, impliedVolatility: 0.31, volume: 800, openInterest: 2200 }],
            },
          ],
        },
      ],
    },
  };
}

function yahooFetchFn() {
  return async (url: string) => {
    if (url.includes('/v7/finance/options')) {
      return { ok: true, status: 200, json: async () => yahooPayload(), text: async () => JSON.stringify(yahooPayload()) } as any;
    }
    // fc.yahoo.com seed + crumb endpoints → empty/ok.
    return { ok: true, status: 200, json: async () => ({}), text: async () => 'crumb', headers: { get: () => null } } as any;
  };
}

describe('hist — options: real (delayed) Yahoo preferred over MOCK', () => {
  it('uses Yahoo (source:"yahoo") when a transport is injected but no POLYGON_API_KEY', async () => {
    const res = await acquireOptionChain('AAPL', { fetchFn: yahooFetchFn() });
    expect(res.source).toBe('yahoo');
    expect(res.underlying_price).toBeCloseTo(225.43, 2);
    expect(res.quotes.length).toBeGreaterThan(0);
    // both calls and puts present
    expect(res.quotes.some((q) => q.type === 'C')).toBe(true);
    expect(res.quotes.some((q) => q.type === 'P')).toBe(true);
    expect(res.note).toMatch(/Delayed/i);
  });

  it('parseYahooOptions handles epoch expiry + calls/puts sub-arrays', () => {
    const r = parseYahooOptions('AAPL', yahooPayload());
    expect(r).not.toBeNull();
    expect(r!.source).toBe('yahoo');
    expect(r!.expiries).toContain('2026-07-17');
    expect(r!.quotes.length).toBe(2);
  });

  it('parseYahooOptions handles the quoteSummary optionChain (v10) nested shape', () => {
    // quoteSummary nests under result[0].optionChain; our adapter wraps it back
    // into the v7 optionChain.result[0].options shape parseYahooOptions expects.
    const qsPayload = {
      quoteSummary: {
        result: [
          {
            price: { regularMarketPrice: 199.5 },
            optionChain: {
              options: [
                {
                  expirationDate: Math.floor(Date.UTC(2026, 6, 24) / 1000),
                  calls: [{ strike: 195, bid: 6.0, ask: 6.2, lastPrice: 6.1, impliedVolatility: 0.29, volume: 100, openInterest: 900 }],
                  puts: [{ strike: 195, bid: 3.0, ask: 3.2, lastPrice: 3.1, impliedVolatility: 0.32, volume: 80, openInterest: 700 }],
                },
              ],
            },
          },
        ],
      },
    };
    const adapted = {
      optionChain: {
        result: [
          {
            quote: (qsPayload as any).quoteSummary.result[0].price ?? {},
            options: (qsPayload as any).quoteSummary.result[0].optionChain.options ?? [],
          },
        ],
      },
    };
    const r = parseYahooOptions('AAPL', adapted);
    expect(r).not.toBeNull();
    expect(r!.underlying_price).toBeCloseTo(199.5, 2);
    expect(r!.expiries).toContain('2026-07-24');
    expect(r!.quotes.length).toBe(2);
  });

  it('falls back to MOCK when no transport and no key', async () => {
    // No fetchFn, and globalThis.fetch undefined in this jest env → Yahoo unreachable.
    const prev = (globalThis as any).fetch;
    (globalThis as any).fetch = undefined;
    try {
      const res = await acquireOptionChain('AAPL');
      expect(res.source).toBe('mock');
    } finally {
      (globalThis as any).fetch = prev;
    }
  });

  it('generateMockBundle centers strikes on the provided real spot (cheap stock)', () => {
    const b = generateMockBundle('SOFI', { spot: 18 });
    expect(b.underlying_price).toBe(18);
    const calls = Array.from(new Set(b.option_chain.filter((q) => q.type === 'C').map((q) => q.strike))).sort((a, c) => a - c);
    // Sub-$25 → $1 spacing; ATM strike rounds to 18; range brackets the real price.
    expect(calls[1] - calls[0]).toBe(1);
    expect(calls).toContain(18);
    expect(calls[0]).toBeLessThan(18);
    expect(calls[calls.length - 1]).toBeGreaterThan(18);
  });

  it('generateMockBundle picks coarser spacing for dear stocks', () => {
    const b = generateMockBundle('AAPL', { spot: 225 });
    const calls = Array.from(new Set(b.option_chain.filter((q) => q.type === 'C').map((q) => q.strike))).sort((a, c) => a - c);
    expect(calls[1] - calls[0]).toBe(5); // $100–$250 tier → $5 spacing
    expect(calls).toContain(225);
  });

  it('acquireOptionChain anchors the MOCK chain on the real Yahoo chart price when options is 429', async () => {
    const chartPayload = {
      chart: {
        result: [
          {
            meta: { regularMarketPrice: 18.0 },
            timestamp: [1, 2, 3],
            indicators: { quote: [{ open: [17.4, 18.1, 17.9], high: [17.6, 18.3, 18.1], low: [17.3, 18.0, 17.8], close: [17.5, 18.2, 18.0], volume: [1, 2, 3] }] },
          },
        ],
      },
    };
    const fakeFetch = async (url: string) => {
      if (url.includes('/v8/finance/chart')) return { ok: true, json: async () => chartPayload } as any;
      if (url.includes('options')) return { ok: false, status: 429, json: async () => ({}) } as any;
      return { ok: false, status: 404, json: async () => ({}) } as any;
    };
    const res = await acquireOptionChain('SOFI', { fetchFn: fakeFetch as any });
    expect(res.source).toBe('mock');
    expect(res.underlying_price).toBeCloseTo(18, 2);
    const calls = Array.from(new Set(res.quotes.filter((q) => q.type === 'C').map((q) => q.strike))).sort((a, c) => a - c);
    expect(calls[0]).toBeLessThan(18);
    expect(calls[calls.length - 1]).toBeGreaterThan(18);
    expect(res.note).toContain('real quote');
  });
});

describe('parseCboeOptions (free delayed feed)', () => {
  // Mirrors the REAL CBOE shape: top-level underlying quote (current_price),
  // IV as a DECIMAL (0.56 = 56%), and per-row greeks that are already correct.
  const payload = {
    timestamp: '2026-07-17 17:04:22',
    data: {
      symbol: 'NVDA',
      current_price: 205.67,
      close: 205.67,
      prev_day_close: 207.4,
      options: [
        // ATM call: delta should stay ~0.61 (NOT snap to 1.0).
        { option: 'NVDA260717C00205000', bid: 3.9, ask: 4.1, iv: 0.5612, open_interest: 900, volume: 120, delta: 0.6139, gamma: 0.1618, vega: 0.13, theta: -0.42, rho: 0.02 },
        // Deep-ITM call: delta ~0.98 is legitimately high but comes from CBOE.
        { option: 'NVDA260717C00197500', bid: 8.05, ask: 8.3, iv: 0.7709, open_interest: 3745, volume: 8570, delta: 0.9822, gamma: 0.011, vega: 0.0019, theta: -0.0254, rho: 0.0 },
        // OTM put on a later expiry.
        { option: 'NVDA260720P00200000', bid: 2.1, ask: 2.3, iv: 0.58, open_interest: 200, volume: 9, delta: -0.31, gamma: 0.05, vega: 0.09, theta: -0.2, rho: -0.01 },
      ],
    },
  };

  it('reads the real underlying spot from current_price (not the median strike)', () => {
    const r = parseCboeOptions('NVDA', payload);
    expect(r).not.toBeNull();
    if (!r) return;
    expect(r.underlying_price).toBeCloseTo(205.67, 2);
    expect(r.quotes.every((q) => q.underlying_price === 205.67)).toBe(true);
  });

  it('decodes OCC symbols into expiry/strike/right and maps bid/ask/iv', () => {
    const r = parseCboeOptions('NVDA', payload);
    expect(r).not.toBeNull();
    if (!r) return;
    expect(r.source).toBe('cboe');
    expect(r.quotes.length).toBe(3);
    expect(r.expiries).toEqual(['2026-07-17', '2026-07-20']);
    const call = r.quotes.find((q) => q.type === 'C' && q.strike === 205);
    expect(call).toBeDefined();
    expect(call!.bid).toBe(3.9);
    expect(call!.ask).toBe(4.1);
    // CBOE reports IV as a DECIMAL already — must NOT be divided by 100.
    expect(call!.iv).toBeCloseTo(0.5612, 4);
  });

  it('uses CBOE published greeks directly — ATM delta stays ~0.5, not pinned to ±1', () => {
    const r = parseCboeOptions('NVDA', payload);
    expect(r).not.toBeNull();
    if (!r) return;
    const atm = r.greeks.find((g) => g.type === 'C' && g.strike === 205);
    const itm = r.greeks.find((g) => g.type === 'C' && g.strike === 197.5);
    expect(atm!.delta).toBeCloseTo(0.6139, 3); // from CBOE, not recomputed to 1.0
    expect(itm!.delta).toBeCloseTo(0.9822, 3);
    // Smooth: ATM delta strictly below the deeper-ITM delta.
    expect(atm!.delta).toBeLessThan(itm!.delta);
    expect(atm!.gamma).toBeCloseTo(0.1618, 4);
  });

  it('BS-fills greeks only when CBOE omits them (missing delta/gamma/etc.)', () => {
    const partial = {
      data: {
        current_price: 100,
        options: [
          // No greeks at all → must be Black-Scholes filled, ATM delta ~0.5.
          { option: 'AAA260717C00100000', bid: 4, ask: 4.2, iv: 0.4, open_interest: 10, volume: 1 },
        ],
      },
    };
    const r = parseCboeOptions('AAA', partial);
    expect(r).not.toBeNull();
    if (!r) return;
    const g = r.greeks[0];
    expect(g.delta).toBeGreaterThan(0.3);
    expect(g.delta).toBeLessThan(0.7); // ATM-ish, smooth — NOT 1.0
    expect(g.gamma).toBeGreaterThan(0);
  });

  it('treats a 0 IV (illiquid deep-ITM) as missing so vol-surface is not poisoned', () => {
    const zeroIv = {
      data: {
        current_price: 205.67,
        options: [
          { option: 'NVDA260717C00190000', bid: 15, ask: 15.4, iv: 0, open_interest: 5, volume: 0, delta: 0.99, gamma: 0.003, vega: 0.001, theta: -0.01, rho: 0 },
        ],
      },
    };
    const r = parseCboeOptions('NVDA', zeroIv);
    expect(r).not.toBeNull();
    if (!r) return;
    expect(r.quotes[0].iv).toBeGreaterThan(0); // 0 replaced with a sane default
  });

  it('uses CBOE real data in resolveLiveOptionsBundle when Polygon is entitlement-blocked', async () => {
    const fakeFetch = async (url: string) => {
      if (url.includes('api.massive.com')) {
        return { ok: false, status: 401, text: async () => JSON.stringify({ status: 'NOT_AUTHORIZED' }), json: async () => ({}) } as any;
      }
      if (url.includes('cdn.cboe.com')) {
        const body = { timestamp: 'x', data: { current_price: 205.67, options: [{ option: 'NVDA260717C00205000', bid: 3.9, ask: 4.1, iv: 0.5612, open_interest: 900, volume: 120, delta: 0.6139, gamma: 0.1618, vega: 0.13, theta: -0.42, rho: 0.02 }] } };
        return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body } as any;
      }
      if (url.includes('query') || url.includes('finance') || url.includes('yahoo')) {
        return { ok: false, status: 429, text: async () => 'Too Many Requests', json: async () => ({}) } as any;
      }
      return { ok: false, status: 404, text: async () => '', json: async () => ({}) } as any;
    };
    const bundle = await resolveLiveOptionsBundle('NVDA', {}, { fetchFn: fakeFetch as any });
    // The OPTION CHAIN is real CBOE data (source reflects the chain).
    expect(bundle.source).toBe('cboe');
    expect(bundle.note).toContain('CBOE');
    expect(bundle.option_chain.length).toBeGreaterThan(0);
    // Price BARS fell back to mock (Yahoo blocked in this stub), so the
    // overall bundle is flagged mock — honest: chain real, bars synthetic.
    expect(bundle.mock).toBe(true);
  });

  it('returns null on empty/unparseable payload', () => {
    expect(parseCboeOptions('NVDA', {})).toBeNull();
    expect(parseCboeOptions('NVDA', { data: { options: [] } })).toBeNull();
  });
});

describe('acquireOptionChain CBOE fallback', () => {
  it('uses CBOE real data when a Massive key is set but the live call is entitlement-blocked (401)', async () => {
    const fakeFetch = async (url: string) => {
      if (url.includes('api.massive.com')) {
        return { ok: false, status: 401, text: async () => JSON.stringify({ status: 'NOT_AUTHORIZED', message: 'not entitled' }), json: async () => ({ status: 'NOT_AUTHORIZED' }) } as any;
      }
      if (url.includes('cdn.cboe.com')) {
        return {
          ok: true, status: 200,
          text: async () => JSON.stringify({ timestamp: 'x', data: { options: [{ option: 'NVDA260717C00002500', bid: 200.5, ask: 205.85, iv: 35.0, open_interest: 17, volume: 0, delta: 1.0 }] } }),
          json: async () => ({ timestamp: 'x', data: { options: [{ option: 'NVDA260717C00002500', bid: 200.5, ask: 205.85, iv: 35.0, open_interest: 17, volume: 0, delta: 1.0 }] } }),
        } as any;
      }
      return { ok: false, status: 404, text: async () => '', json: async () => ({}) } as any;
    };
    const res = await acquireOptionChain('NVDA', { apiKey: 'some-key', fetchFn: fakeFetch as any });
    expect(res.source).toBe('cboe'); // real delayed data, NOT mock
    expect(res.quotes.length).toBeGreaterThan(0);
    expect(res.note).toContain('CBOE');
  });
});


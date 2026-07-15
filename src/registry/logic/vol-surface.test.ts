// src/registry/logic/vol-surface.test.ts
// Phase A tests for the vol-surface builder. Uses the deterministic mock bundle
// plus a hand-built synthetic chain to assert known skew/term slopes.

import { buildVolSurface } from './vol-surface';
import { generateMockBundle } from './hist';
import type { HistoricalBundle, OptionQuote } from '../../types/financial-analysis';

describe('vol-surface — from mock bundle', () => {
  const bundle = generateMockBundle('AAPL', { expiries: 'monthly+weekly' });
  const vs = buildVolSurface(bundle);

  it('produces a well-formed surface', () => {
    expect(vs.atm_iv).toBeGreaterThan(0);
    expect(vs.by_expiry.length).toBeGreaterThan(0);
    expect(vs.iv_percentile).toBeGreaterThanOrEqual(0);
    expect(vs.iv_percentile).toBeLessThanOrEqual(100);
    expect(vs.iv_rank).toBeGreaterThanOrEqual(0);
    expect(vs.iv_rank).toBeLessThanOrEqual(100);
  });

  it('detects the equity put skew (negative skew slope) from mock chain', () => {
    // The mock seeds richer IV for OTM puts (low moneyness) → negative slope.
    expect(vs.skew_slope).toBeLessThan(0);
  });

  it('every by_expiry entry has atm_iv and skew_slope', () => {
    for (const e of vs.by_expiry) {
      expect(e.atm_iv).toBeGreaterThan(0);
      expect(Number.isFinite(e.skew_slope)).toBe(true);
      expect(e.ttm_years).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('vol-surface — synthetic chain (known slopes)', () => {
  // Build a synthetic bundle: single expiry, IV rising linearly with strike.
  function syntheticBundle(ivByStrike: (k: number) => number, expiries: string[]): HistoricalBundle {
    const spot = 100;
    const chain: OptionQuote[] = [];
    for (const expiry of expiries) {
      for (let strike = 80; strike <= 120; strike += 5) {
        for (const type of ['C', 'P'] as const) {
          chain.push({
            expiry,
            strike,
            type,
            bid: 1,
            ask: 1.1,
            last: 1.05,
            volume: 10,
            open_interest: 100,
            iv: ivByStrike(strike),
            underlying_price: spot,
            underlying_ts: '2026-07-10T00:00:00.000Z',
          });
        }
      }
    }
    return {
      ticker: 'SYN',
      underlying_price: spot,
      price_bars: [],
      option_chain: chain,
      greeks: [],
      rfr: 0.043,
      expiries,
      iv_history: [0.2, 0.25, 0.3, 0.35, 0.4],
      mock: true,
    };
  }

  it('positive skew slope when IV rises with strike', () => {
    const b = syntheticBundle((k) => 0.2 + (k - 100) * 0.002, ['2026-08-21']);
    const vs = buildVolSurface(b);
    expect(vs.skew_slope).toBeGreaterThan(0);
    expect(vs.flags).toContain('call_skew');
  });

  it('negative skew slope when IV falls with strike (put skew flag)', () => {
    const b = syntheticBundle((k) => 0.5 - (k - 80) * 0.006, ['2026-08-21']);
    const vs = buildVolSurface(b);
    expect(vs.skew_slope).toBeLessThan(0);
    expect(vs.flags).toContain('steep_put_skew');
  });

  it('flat IV → skew slope ≈ 0', () => {
    const b = syntheticBundle(() => 0.3, ['2026-08-21']);
    const vs = buildVolSurface(b);
    expect(Math.abs(vs.skew_slope)).toBeLessThan(1e-6);
  });

  it('useFrontMonth restricts to the nearest expiry', () => {
    const b = syntheticBundle(() => 0.3, ['2026-07-17', '2026-08-21', '2026-09-18']);
    const vs = buildVolSurface(b, { useFrontMonth: true });
    expect(vs.by_expiry).toHaveLength(1);
    expect(vs.by_expiry[0]!.expiry).toBe('2026-07-17');
  });
});

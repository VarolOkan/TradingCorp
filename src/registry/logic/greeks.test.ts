// src/registry/logic/greeks.test.ts
// Phase A unit tests for the Black–Scholes greeks engine. Known-value cases
// checked against closed-form references (put-call parity, ATM delta≈0.5, etc.).

import {
  bsPrice,
  bsGreeks,
  binomialAmerican,
  americanGreeks,
  deriveGreeks,
  getOptionStyle,
  __setOptionStyle,
  normCdf,
  normPdf,
  yearsToExpiry,
  resolveRfr,
  DEFAULT_RFR,
} from './greeks';

describe('greeks — normCdf / normPdf', () => {
  it('normCdf(0) ≈ 0.5', () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 6);
  });

  it('normCdf is symmetric: Φ(-x) = 1 - Φ(x)', () => {
    for (const x of [0.25, 1, 1.96, 2.5]) {
      expect(normCdf(-x)).toBeCloseTo(1 - normCdf(x), 5);
    }
  });

  it('normCdf(1.96) ≈ 0.975', () => {
    expect(normCdf(1.96)).toBeCloseTo(0.975, 3);
  });

  it('normPdf(0) ≈ 1/sqrt(2π)', () => {
    expect(normPdf(0)).toBeCloseTo(1 / Math.sqrt(2 * Math.PI), 6);
  });
});

describe('greeks — bsPrice', () => {
  it('ATM call and put are positive and satisfy put-call parity', () => {
    const S = 100, K = 100, T = 1, r = 0.05, sigma = 0.2, q = 0;
    const call = bsPrice('C', S, K, T, r, sigma, q);
    const put = bsPrice('P', S, K, T, r, sigma, q);
    expect(call).toBeGreaterThan(0);
    expect(put).toBeGreaterThan(0);
    // C - P = S*e^{-qT} - K*e^{-rT}
    const parity = S * Math.exp(-q * T) - K * Math.exp(-r * T);
    expect(call - put).toBeCloseTo(parity, 6);
  });

  it('matches a textbook value (S=100,K=100,T=1,r=0.05,σ=0.2 → call≈10.4506)', () => {
    const call = bsPrice('C', 100, 100, 1, 0.05, 0.2);
    expect(call).toBeCloseTo(10.4506, 3);
  });

  it('deep ITM call ≈ discounted intrinsic; deep OTM call ≈ 0', () => {
    const itm = bsPrice('C', 200, 100, 1, 0.05, 0.2);
    expect(itm).toBeGreaterThan(100 - 100 * Math.exp(-0.05)); // > pure intrinsic-ish
    const otm = bsPrice('C', 50, 100, 0.1, 0.05, 0.2);
    expect(otm).toBeLessThan(0.5);
  });

  it('degenerate T=0 returns intrinsic value', () => {
    expect(bsPrice('C', 120, 100, 0, 0.05, 0.2)).toBeCloseTo(20, 6);
    expect(bsPrice('P', 80, 100, 0, 0.05, 0.2)).toBeCloseTo(20, 6);
    expect(bsPrice('C', 80, 100, 0, 0.05, 0.2)).toBeCloseTo(0, 6);
  });
});

describe('greeks — bsGreeks', () => {
  it('ATM call delta ≈ 0.5 (slightly above due to drift)', () => {
    const g = bsGreeks('C', 100, 100, 1, 0.05, 0.2);
    expect(g.delta).toBeGreaterThan(0.5);
    expect(g.delta).toBeLessThan(0.65);
  });

  it('call delta ∈ (0,1); put delta ∈ (-1,0)', () => {
    const c = bsGreeks('C', 100, 100, 0.5, 0.03, 0.3);
    const p = bsGreeks('P', 100, 100, 0.5, 0.03, 0.3);
    expect(c.delta).toBeGreaterThan(0);
    expect(c.delta).toBeLessThan(1);
    expect(p.delta).toBeGreaterThan(-1);
    expect(p.delta).toBeLessThan(0);
  });

  it('call delta − put delta ≈ e^{-qT} (parity of deltas, q=0 → 1)', () => {
    const c = bsGreeks('C', 100, 105, 0.75, 0.04, 0.25);
    const p = bsGreeks('P', 100, 105, 0.75, 0.04, 0.25);
    expect(c.delta - p.delta).toBeCloseTo(1, 6);
  });

  it('gamma and vega are identical for call and put at same strike', () => {
    const c = bsGreeks('C', 100, 100, 1, 0.05, 0.2);
    const p = bsGreeks('P', 100, 100, 1, 0.05, 0.2);
    expect(c.gamma).toBeCloseTo(p.gamma, 8);
    expect(c.vega).toBeCloseTo(p.vega, 8);
    expect(c.gamma).toBeGreaterThan(0);
    expect(c.vega).toBeGreaterThan(0);
  });

  it('long option theta is negative (time decay)', () => {
    const c = bsGreeks('C', 100, 100, 0.25, 0.05, 0.4);
    expect(c.theta).toBeLessThan(0);
  });

  it('vega matches numerical derivative dPrice/dSigma', () => {
    const S = 100, K = 100, T = 1, r = 0.05, sigma = 0.2;
    const h = 1e-4;
    const num = (bsPrice('C', S, K, T, r, sigma + h) - bsPrice('C', S, K, T, r, sigma - h)) / (2 * h);
    const g = bsGreeks('C', S, K, T, r, sigma);
    expect(g.vega).toBeCloseTo(num, 2);
  });

  it('delta matches numerical derivative dPrice/dS', () => {
    const S = 100, K = 110, T = 0.5, r = 0.03, sigma = 0.3;
    const h = 1e-3;
    const num = (bsPrice('C', S + h, K, T, r, sigma) - bsPrice('C', S - h, K, T, r, sigma)) / (2 * h);
    const g = bsGreeks('C', S, K, T, r, sigma);
    expect(g.delta).toBeCloseTo(num, 3);
  });

  it('degenerate T=0 returns finite greeks (no NaN)', () => {
    const g = bsGreeks('C', 120, 100, 0, 0.05, 0.2);
    expect(Number.isFinite(g.delta)).toBe(true);
    expect(g.delta).toBe(1); // ITM call
    expect(g.gamma).toBe(0);
  });
});

describe('greeks — yearsToExpiry / resolveRfr', () => {
  it('computes ~1 year for a 365-day gap', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const exp = new Date('2027-01-01T00:00:00Z');
    expect(yearsToExpiry(exp, now)).toBeCloseTo(1, 2);
  });

  it('clamps past/same-day expiry to a small positive epsilon', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const past = new Date('2025-01-01T00:00:00Z');
    const t = yearsToExpiry(past, now);
    expect(t).toBeGreaterThan(0);
    expect(t).toBeLessThan(0.001);
  });

  it('resolveRfr falls back to DEFAULT_RFR on bad input', () => {
    expect(resolveRfr(0.05)).toBe(0.05);
    expect(resolveRfr(undefined)).toBe(DEFAULT_RFR);
    expect(resolveRfr(null)).toBe(DEFAULT_RFR);
    expect(resolveRfr(NaN)).toBe(DEFAULT_RFR);
    expect(resolveRfr(-1)).toBe(DEFAULT_RFR);
  });
});

describe('greeks — binomialAmerican (CRR) + American greeks', () => {
  // American exercise is the correct model for US-listed equity options; the
  // closed-form BS engine is the European reference kept for convergence tests
  // and is selectable via TC_OPTION_STYLE=european (no UI toggle).

  it('converges to the BS European price as tree steps increase', () => {
    const S = 100, K = 100, T = 1, r = 0.05, sigma = 0.2, q = 0;
    const eu = bsPrice('C', S, K, T, r, sigma, q);
    const a200 = binomialAmerican('C', S, K, T, r, sigma, q, 200).price;
    const a2000 = binomialAmerican('C', S, K, T, r, sigma, q, 2000).price;
    expect(a2000).toBeCloseTo(eu, 2);
    expect(Math.abs(a2000 - eu)).toBeLessThan(Math.abs(a200 - eu));
  });

  it('American put on a dividend name is worth MORE than the European (BS) put', () => {
    const S = 100, K = 130, T = 0.1, r = 0.04, sigma = 0.25, q = 0.03;
    const euPut = bsPrice('P', S, K, T, r, sigma, q);
    const am = binomialAmerican('P', S, K, T, r, sigma, q, 400);
    expect(am.price).toBeGreaterThan(euPut);
    expect(am.earlyExercise).toBe(true);
  });

  it('without dividends, American call price == European call price (no early-exercise premium)', () => {
    const S = 100, K = 100, T = 0.5, r = 0.05, sigma = 0.3;
    const eu = bsPrice('C', S, K, T, r, sigma, 0);
    const am = binomialAmerican('C', S, K, T, r, sigma, 0, 2000);
    expect(am.price).toBeCloseTo(eu, 2);
    expect(am.earlyExercise).toBe(false);
  });

  it('American greeks match BS greeks (European reference) within finite-diff tolerance', () => {
    const S = 100, K = 100, T = 1, r = 0.05, sigma = 0.2;
    const bs = bsGreeks('C', S, K, T, r, sigma);
    const am = americanGreeks('C', S, K, T, r, sigma, 0, 400);
    expect(am.delta).toBeCloseTo(bs.delta, 2);
    expect(am.gamma).toBeCloseTo(bs.gamma, 3);
    expect(am.vega).toBeCloseTo(bs.vega, 1);
    expect(am.theta).toBeCloseTo(bs.theta, 1);
    expect(am.rho).toBeCloseTo(bs.rho, 1);
  });

  it('degenerate T=0 / sigma=0 return well-formed finite greeks (no NaN)', () => {
    const g = americanGreeks('C', 120, 100, 0, 0.05, 0.2);
    expect(Number.isFinite(g.delta)).toBe(true);
    expect(g.delta).toBe(1);
    expect(g.gamma).toBe(0);
    const p = binomialAmerican('P', 80, 100, 0, 0.05, 0.2);
    expect(p.price).toBeCloseTo(20, 6);
  });
});

describe('greeks — deriveGreeks dispatch (TC_OPTION_STYLE)', () => {
  const prev = process.env.TC_OPTION_STYLE;
  afterEach(() => {
    if (prev === undefined) delete process.env.TC_OPTION_STYLE;
    else process.env.TC_OPTION_STYLE = prev;
    __setOptionStyle(null);
  });

  it('defaults to American binomial', () => {
    delete process.env.TC_OPTION_STYLE;
    __setOptionStyle(null);
    expect(getOptionStyle()).toBe('american');
    const g = deriveGreeks('C', 100, 100, 1, 0.05, 0.2);
    expect(g.delta).toBeGreaterThan(0.5);
    expect(g.delta).toBeLessThan(1);
  });

  it('TC_OPTION_STYLE=european reverts to the closed-form BS engine', () => {
    process.env.TC_OPTION_STYLE = 'european';
    __setOptionStyle(null);
    expect(getOptionStyle()).toBe('european');
    const am = deriveGreeks('C', 100, 100, 1, 0.05, 0.2);
    const eu = bsGreeks('C', 100, 100, 1, 0.05, 0.2);
    expect(am.delta).toBeCloseTo(eu.delta, 8);
    expect(am.vega).toBeCloseTo(eu.vega, 8);
  });
});

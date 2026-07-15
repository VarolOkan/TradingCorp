// src/registry/logic/greeks.ts
// Phase A (doc §2.2). Black–Scholes options pricing + greeks engine.
//
// Pure, dependency-free functions. This module is the SINGLE source of truth
// for option theoretical price and greeks across BOTH the mock path (hist.ts
// synthesizes an internally-consistent chain from these formulas) AND the live
// path (validate/repair provider greeks). Because it is pure math with known
// closed-form answers, it is trivially unit-testable (known inputs → known
// greeks, see greeks.test.ts).
//
// Conventions / UNITS (documented — matches the spec §2.2):
//   • type: 'C' (call) | 'P' (put)
//   • S: underlying spot price
//   • K: strike
//   • T: time to expiry in YEARS (use yearsToExpiry())
//   • r: continuously-compounded risk-free rate (e.g. 0.043 == 4.3%)
//   • sigma: annualized implied volatility as a decimal (e.g. 0.25 == 25%)
//   • q: continuous dividend yield (default 0)
//   • vega:  price change per 1.00 (i.e. 100 vol-points) change in sigma.
//   • theta: price change per 1 YEAR of time decay (negative for long options).
//   • rho:   price change per 1.00 (100%) change in r.
// Callers that want "per 1 vol-point" or "per day" scale vega/100 and theta/365.

export type OptionType = 'C' | 'P';

export interface Greeks {
  delta: number;
  gamma: number;
  vega: number;
  theta: number;
  rho: number;
}

/** Standard normal probability density function φ(x). */
export function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/**
 * Standard normal cumulative distribution function Φ(x).
 * Uses the Abramowitz & Stegun 7.1.26 erf approximation (max abs error ~1.5e-7),
 * which is more than adequate for pricing/greeks display.
 */
export function normCdf(x: number): number {
  // erf(z) approximation
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-z * z);
  return 0.5 * (1 + sign * y);
}

/** d1 term of the Black–Scholes formula. */
function d1(S: number, K: number, T: number, r: number, sigma: number, q: number): number {
  return (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
}

/**
 * Black–Scholes(-Merton) theoretical price with continuous dividend yield q.
 * Falls back to intrinsic value at the degenerate boundary (T≤0 or sigma≤0).
 */
export function bsPrice(
  type: OptionType,
  S: number,
  K: number,
  T: number,
  r: number,
  sigma: number,
  q = 0,
): number {
  // Degenerate: no time left or no vol → discounted intrinsic value.
  if (T <= 0 || sigma <= 0) {
    const intrinsic = type === 'C' ? Math.max(S - K, 0) : Math.max(K - S, 0);
    return intrinsic;
  }
  const D1 = d1(S, K, T, r, sigma, q);
  const D2 = D1 - sigma * Math.sqrt(T);
  const discR = Math.exp(-r * T);
  const discQ = Math.exp(-q * T);
  if (type === 'C') {
    return S * discQ * normCdf(D1) - K * discR * normCdf(D2);
  }
  return K * discR * normCdf(-D2) - S * discQ * normCdf(-D1);
}

/**
 * Black–Scholes(-Merton) greeks. See module header for units.
 * At the degenerate boundary (T≤0 or sigma≤0) returns a well-formed zero-ish
 * greek set with delta reflecting moneyness, so callers never see NaN.
 */
export function bsGreeks(
  type: OptionType,
  S: number,
  K: number,
  T: number,
  r: number,
  sigma: number,
  q = 0,
): Greeks {
  if (T <= 0 || sigma <= 0) {
    const itm = type === 'C' ? S > K : S < K;
    const sign = type === 'C' ? 1 : -1;
    return { delta: itm ? sign : 0, gamma: 0, vega: 0, theta: 0, rho: 0 };
  }
  const sqrtT = Math.sqrt(T);
  const D1 = d1(S, K, T, r, sigma, q);
  const D2 = D1 - sigma * sqrtT;
  const discR = Math.exp(-r * T);
  const discQ = Math.exp(-q * T);
  const pdfD1 = normPdf(D1);

  const gamma = (discQ * pdfD1) / (S * sigma * sqrtT);
  const vega = S * discQ * pdfD1 * sqrtT; // per 1.00 change in sigma

  let delta: number;
  let theta: number;
  let rho: number;
  if (type === 'C') {
    delta = discQ * normCdf(D1);
    theta =
      -(S * discQ * pdfD1 * sigma) / (2 * sqrtT) -
      r * K * discR * normCdf(D2) +
      q * S * discQ * normCdf(D1);
    rho = K * T * discR * normCdf(D2);
  } else {
    delta = -discQ * normCdf(-D1);
    theta =
      -(S * discQ * pdfD1 * sigma) / (2 * sqrtT) +
      r * K * discR * normCdf(-D2) -
      q * S * discQ * normCdf(-D1);
    rho = -K * T * discR * normCdf(-D2);
  }
  return { delta, gamma, vega, theta, rho };
}

const MS_PER_DAY = 1000 * 60 * 60 * 24;
const DAYS_PER_YEAR = 365;

/**
 * Years-to-expiry as an ACT/365 fraction between `now` and `expiry`.
 * Both args accept an ISO date string or a Date. Never returns negative;
 * a same-day / past expiry clamps to a tiny positive epsilon so downstream
 * BS math stays finite (a 0DTE option still has intraday time value).
 */
export function yearsToExpiry(expiry: string | Date, now: string | Date = new Date()): number {
  const exp = expiry instanceof Date ? expiry : new Date(expiry);
  const ref = now instanceof Date ? now : new Date(now);
  const days = (exp.getTime() - ref.getTime()) / MS_PER_DAY;
  const years = days / DAYS_PER_YEAR;
  // Clamp to a small positive value (≈ 1 hour) to avoid T=0 blow-ups.
  const EPS = 1 / (DAYS_PER_YEAR * 24);
  return years > EPS ? years : EPS;
}

/**
 * Resolve the risk-free rate. Mock default is 0.043 (~4.3%). A live Treasury
 * yield can be threaded in via `override`; anything non-finite falls back to
 * the mock default so the pricing path is never poisoned by a bad feed.
 */
export const DEFAULT_RFR = 0.043;
export function resolveRfr(override?: number | null): number {
  if (typeof override === 'number' && Number.isFinite(override) && override >= 0) {
    return override;
  }
  return DEFAULT_RFR;
}

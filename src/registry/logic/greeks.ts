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

/**
 * Option exercise style for equity-options valuation.
 *
 * US-listed single-stock options are AMERICAN-exercise, so early exercise can
 * add value (notably puts on dividend names). Black–Scholes is the EUROPEAN
 * model and underprices them. We therefore default to AMERICAN via a Cox–Ross–
 * Rubinstein binomial tree. A European reference is kept for parity testing and
 * is selectable by experts via `TC_OPTION_STYLE=european` (no UI toggle — this
 * is an internal/model-correctness switch, not a user-facing preference).
 */
export type OptionStyle = 'american' | 'european';

let _optionStyle: OptionStyle | null = null;
/** Read the exercise-style override once (env is static for a process). */
export function getOptionStyle(): OptionStyle {
  if (_optionStyle) return _optionStyle;
  const v = (process.env.TC_OPTION_STYLE ?? '').trim().toLowerCase();
  _optionStyle = v === 'european' ? 'european' : 'american';
  return _optionStyle;
}
/** Test seam: override the resolved style without touching process.env. */
export function __setOptionStyle(style: OptionStyle | null): void {
  _optionStyle = style;
}

/**
 * Cox–Ross–Rubinstein binomial tree. Returns the AMERICAN option value (early
 * exercise is allowed at every node) and whether early exercise was ever optimal
 * along the path (useful for honesty/diagnostics — a European-only model would
 * silently ignore this value).
 *
 * `steps` controls tree depth; 200 is plenty for single-contract greeks
 * (converges to the BS European price as steps→∞ for non-dividend cases).
 */
export function binomialAmerican(
  type: OptionType,
  S: number,
  K: number,
  T: number,
  r: number,
  sigma: number,
  q = 0,
  steps = 100,
): { price: number; earlyExercise: boolean; step1: number[]; step2: number[] } {
  // Degenerate: no time or no vol → discounted intrinsic (American = European
  // at expiry). Defensive against NaN in downstream math.
  if (T <= 0 || sigma <= 0 || steps < 1) {
    const intrinsic = type === 'C' ? Math.max(S - K, 0) : Math.max(K - S, 0);
    return { price: intrinsic, earlyExercise: false, step1: [intrinsic, intrinsic], step2: [intrinsic, intrinsic, intrinsic] };
  }
  const n = Math.max(1, Math.floor(steps));
  const dt = T / n;
  const df = Math.exp(-r * dt);
  const vol = sigma * Math.sqrt(dt);
  const u = Math.exp(vol);
  const d = Math.exp(-vol);
  const p = (Math.exp((r - q) * dt) - d) / (u - d); // risk-neutral up probability
  const pu = Math.min(1, Math.max(0, p)); // clamp degenerate edge cases
  const pd = 1 - pu;

  // Terminal payoff at each node of the final step (step = n, root = step 0).
  let prev = new Array<number>(n + 1);
  for (let i = 0; i <= n; i++) {
    const ST = S * Math.pow(u, i) * Math.pow(d, n - i);
    prev[i] = type === 'C' ? Math.max(ST - K, 0) : Math.max(K - ST, 0);
  }
  let early = false;
  // step1/step2: the FIRST two timesteps FROM THE ROOT (rows at step = 1 and
  // step = 2 in this backward pass, since root is step = 0). They feed the
  // on-tree delta/gamma, which is robust to the payoff kink at the strike.
  let step1: number[] = [];
  let step2: number[] = [];
  for (let step = n - 1; step >= 0; step--) {
    const cur = new Array<number>(step + 1);
    for (let i = 0; i <= step; i++) {
      const cont = pu * prev[i + 1]! + pd * prev[i]!;
      const discounted = df * cont;
      const ST = S * Math.pow(u, i) * Math.pow(d, step - i);
      const exercise = type === 'C' ? Math.max(ST - K, 0) : Math.max(K - ST, 0);
      // Early-exercise flag: only set when exercise strictly dominates
      // continuation by a scale-relative margin. Without dividends an American
      // call can never early-exercise, so this guards against FP noise at the
      // strike kink (real early-exercise is O(0.01)+, e.g. dividend puts).
      if (exercise > discounted && exercise - discounted > 1e-9 * Math.max(1, discounted)) early = true;
      cur[i] = Math.max(discounted, exercise);
    }
    if (step === 1) step1 = cur.slice();
    if (step === 2) step2 = cur.slice();
    prev = cur;
  }
  return { price: prev[0]!, earlyExercise: early, step1, step2 };
}

/**
 * American greeks. Delta/gamma are read ON the CRR lattice (standard, robust to
 * the payoff kink at the strike) from the first two steps from the root;
 * vega/rho/theta use a small central finite difference on the binomial price
 * (smooth in σ/r/t). Matches the `Greeks` shape + units of `bsGreeks`
 * (vega per 1.00 σ, theta per 1 yr, rho per 1.00 r). Degenerate (T≤0/σ≤0)
 * returns near-intrinsic (no NaN).
 */
export function americanGreeks(
  type: OptionType,
  S: number,
  K: number,
  T: number,
  r: number,
  sigma: number,
  q = 0,
  steps = 100,
): Greeks {
  if (T <= 0 || sigma <= 0) {
    const itm = type === 'C' ? S > K : S < K;
    const sign = type === 'C' ? 1 : -1;
    return { delta: itm ? sign : 0, gamma: 0, vega: 0, theta: 0, rho: 0 };
  }
  const tree = binomialAmerican(type, S, K, T, r, sigma, q, steps);
  const { price, step1, step2 } = tree;
  // Re-derive CRR up/down moves (not returned by the pricer) for the on-tree
  // delta/gamma spot deltas.
  const dt = T / Math.max(1, Math.floor(steps));
  const u = Math.exp(sigma * Math.sqrt(dt));
  const d = Math.exp(-sigma * Math.sqrt(dt));

  // Delta from the two child nodes one step from the root.
  const Vu = step1[1] ?? price;
  const Vd = step1[0] ?? price;
  const Su = S * u;
  const Sd = S * d;
  const delta = (Vu - Vd) / (Su - Sd);

  // Gamma from the second step (nodes 0,1,2 → S·d², S, S·u²). Use the proper
  // delta-difference: gamma = (delta_up − delta_down)/(S_u − S_d), where each
  // local delta is (V_upchild − V_downchild)/(S·(u−d)). This is the standard
  // on-tree gamma and avoids the spurious 1/(u−d)² scaling of a raw 2nd diff.
  let gamma = 0;
  if (step2.length >= 3) {
    const Vdd = step2[0]!;
    const Vud = step2[1]!;
    const Vuu = step2[2]!;
    const Su = S * u;
    const Sd = S * d;
    const du = (Vuu - Vud) / (Su * (u - d));
    const dd = (Vud - Vdd) / (Sd * (u - d));
    gamma = (du - dd) / (Su - Sd);
  }

  // Theta / vega / rho via central FD on the (smooth) binomial price.
  const hV = Math.max(sigma * 1e-2, 1e-5);
  const hT = 1 / 365; // one day → theta per year (matches bsGreeks)
  const hR = 1e-4;
  const theta = -(binomialAmerican(type, S, K, T + hT, r, sigma, q, steps).price
    - binomialAmerican(type, S, K, T - hT, r, sigma, q, steps).price) / (2 * hT);
  const vega = (binomialAmerican(type, S, K, T, r, sigma + hV, q, steps).price
    - binomialAmerican(type, S, K, T, r, sigma - hV, q, steps).price) / (2 * hV);
  const rho = (binomialAmerican(type, S, K, T, r + hR, sigma, q, steps).price
    - binomialAmerican(type, S, K, T, r - hR, sigma, q, steps).price) / (2 * hR);

  return {
    delta,
    gamma: Number.isFinite(gamma) ? gamma : 0,
    vega,
    theta,
    rho,
  };
}

/**
 * Single dispatch seam used by all re-derivation paths (chainToGreeksRows,
 * options-handlers). Honors `TC_OPTION_STYLE`: defaults to the binomial
 * AMERICAN pricer; `european` reverts to the closed-form BS engine. This is the
 * ONLY place that chooses the model, so the exercise-style is consistent across
 * the whole pipeline with no per-call plumbing.
 */
export function deriveGreeks(
  type: OptionType,
  S: number,
  K: number,
  T: number,
  r: number,
  sigma: number,
  q = 0,
  steps = 100,
): Greeks {
  if (getOptionStyle() === 'european') {
    return bsGreeks(type, S, K, T, r, sigma, q);
  }
  return americanGreeks(type, S, K, T, r, sigma, q, steps);
}

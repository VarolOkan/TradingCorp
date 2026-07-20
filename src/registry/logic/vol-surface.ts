// src/registry/logic/vol-surface.ts
// Phase A (doc §2.3). Volatility-surface builder.
//
// From an option chain: build IV-by-strike (per expiry) → fit a simple skew
// (linear regression of IV vs moneyness) → expose term structure (ATM IV vs
// expiry) and skew (IV vs moneyness), plus iv_percentile / iv_rank vs the
// historical IV samples produced by hist.ts.
//
// Pure function over a HistoricalBundle — deterministic and unit-testable
// (synthetic chain → known slopes). Used by options_pricing (edge) and
// options_risk (IV-crush).

import type { HistoricalBundle, OptionQuote, VolSurface } from '../../types/financial-analysis';

/** Simple ordinary-least-squares slope of y over x. Returns 0 if degenerate. */
function olsSlope(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const meanX = xs.reduce((s, v) => s + v, 0) / n;
  const meanY = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i]! - meanX) * (ys[i]! - meanY);
    den += (xs[i]! - meanX) ** 2;
  }
  if (den === 0) return 0;
  return num / den;
}

/** Percentile rank of `value` within `samples` [0..100]. */
function percentileOf(value: number, samples: number[]): number {
  if (samples.length === 0) return 50;
  const below = samples.filter((s) => s <= value).length;
  return parseFloat(((below / samples.length) * 100).toFixed(2));
}

/** Min-max rank of `value` within `samples` [0..100]. */
function rankOf(value: number, samples: number[]): number {
  if (samples.length === 0) return 50;
  const min = Math.min(...samples);
  const max = Math.max(...samples);
  if (max === min) return 50;
  const r = ((value - min) / (max - min)) * 100;
  return parseFloat(Math.min(100, Math.max(0, r)).toFixed(2));
}

/** ATM IV for one expiry: IV of the strike closest to spot (avg C/P). */
function atmIvForExpiry(rows: OptionQuote[], spot: number): number {
  if (rows.length === 0) return 0;
  let best = rows[0]!;
  for (const r of rows) {
    if (Math.abs(r.strike - spot) < Math.abs(best.strike - spot)) best = r;
  }
  const atStrike = rows.filter((r) => r.strike === best.strike);
  const avg = atStrike.reduce((s, r) => s + r.iv, 0) / atStrike.length;
  return parseFloat(avg.toFixed(4));
}

/**
 * Build the vol surface summary from a historical bundle.
 * `useFrontMonth` restricts term-structure computation to the nearest expiry
 * only (intraday agencies care about the front month).
 */
export function buildVolSurface(
  bundle: HistoricalBundle,
  opts: { useFrontMonth?: boolean } = {},
): VolSurface {
  const spot = bundle.underlying_price;
  const chain = bundle.option_chain;
  const expiries = Array.from(new Set(chain.map((r) => r.expiry))).sort();
  const usedExpiries = opts.useFrontMonth ? expiries.slice(0, 1) : expiries;

  const by_expiry = usedExpiries.map((expiry) => {
    const rows = chain.filter((r) => r.expiry === expiry);
    const atm_iv = atmIvForExpiry(rows, spot);
    // Skew: regress IV on moneyness (K/S) across strikes for this expiry.
    const xs = rows.map((r) => r.strike / spot);
    const ys = rows.map((r) => r.iv);
    const skew_slope = parseFloat(olsSlope(xs, ys).toFixed(4));
    const ttm_years = rows[0]?.underlying_ts
      ? Math.max(
          0,
          (new Date(`${expiry}T00:00:00.000Z`).getTime() - new Date(rows[0]!.underlying_ts).getTime()) /
            (365 * 24 * 3600 * 1000),
        )
      : 0;
    return { expiry, ttm_years: parseFloat(ttm_years.toFixed(6)), atm_iv, skew_slope };
  });

  const atm_iv = by_expiry[0]?.atm_iv ?? 0;
  const skew_slope = by_expiry[0]?.skew_slope ?? 0;

  // Term slope: regress ATM IV on ttm across expiries.
  const term_slope =
    by_expiry.length >= 2
      ? parseFloat(
          olsSlope(
            by_expiry.map((e) => e.ttm_years),
            by_expiry.map((e) => e.atm_iv),
          ).toFixed(4),
        )
      : 0;

  const ivHistorySource: 'real-chain' | 'seeded' = bundle.ivHistorySource === 'real-chain' ? 'real-chain' : 'seeded';
  const ivHistoryNote =
    ivHistorySource === 'real-chain'
      ? 'iv_history calibrated from the REAL option chain\'s per-tenor ATM IVs (market-derived term-structure reference; no seeded values).'
      : 'iv_history is a synthetic fallback (no live chain) — iv_percentile/iv_rank are NOT market-calibrated.';

  const iv_percentile = percentileOf(atm_iv, bundle.iv_history);
  const iv_rank = rankOf(atm_iv, bundle.iv_history);

  const flags: string[] = [];
  if (term_slope < 0) flags.push('inverted_term_structure');
  if (skew_slope < -0.15) flags.push('steep_put_skew');
  if (skew_slope > 0.05) flags.push('call_skew');
  if (iv_percentile >= 90) flags.push('iv_elevated');
  if (iv_percentile <= 10) flags.push('iv_depressed');
  // Honest flag: when the history is seeded, the percentile/rank is not a real
  // market reading — surface that so it can't be mistaken for calibrated data.
  if (ivHistorySource === 'seeded') flags.push('iv_history_uncalibrated');

  return {
    atm_iv,
    skew_slope,
    term_slope,
    iv_percentile,
    iv_rank,
    iv_history_source: ivHistorySource,
    iv_history_note: ivHistoryNote,
    by_expiry,
    flags,
  };
}

// frontend/src/components/compare/compareUtils.ts
// Phase 5 (Comparable / multi-ticker analysis): pure helpers for the compare
// view. No React, no I/O — easy to unit-test with injected bars.

export interface ClosePoint {
  t: string; // ISO date/time
  close: number;
}

/**
 * Normalize a close series so the FIRST point = 100 (base). This makes
 * different-priced tickers comparable on a single axis ("relative performance").
 * Returns an array aligned to the input; if the first close is 0/NaN the series
 * is returned unscaled to avoid divide-by-zero nonsense.
 */
export function normalizeToBase(points: ClosePoint[]): number[] {
  if (points.length === 0) return [];
  const base = points[0]!.close;
  if (!base || !isFinite(base)) return points.map((p) => p.close);
  return points.map((p) => (base === 0 ? 0 : (p.close / base) * 100));
}

/**
 * Simple (arithmetic) period-over-period returns from a close series.
 * For N closes returns N-1 return values: r_i = close[i]/close[i-1] - 1.
 */
export function dailyReturns(closes: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1]!;
    const cur = closes[i]!;
    if (!prev || !isFinite(prev)) {
      out.push(0);
    } else {
      out.push(cur / prev - 1);
    }
  }
  return out;
}

/**
 * Pearson correlation coefficient of two equal-or-unequal-length samples.
 * Uses the longest common prefix (aligned by index) — compare view aligns
 * series by position after truncation, so this is the right semantics.
 * Returns 0 when either series has < 2 usable points (undefined correlation).
 */
export function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  let sa = 0;
  let sb = 0;
  for (let i = 0; i < n; i++) {
    sa += a[i]!;
    sb += b[i]!;
  }
  const ma = sa / n;
  const mb = sb / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const xa = a[i]! - ma;
    const xb = b[i]! - mb;
    num += xa * xb;
    da += xa * xa;
    db += xb * xb;
  }
  const denom = Math.sqrt(da * db);
  if (denom === 0) return 0;
  const r = num / denom;
  // Clamp to [-1, 1] against float drift.
  return Math.max(-1, Math.min(1, r));
}

/**
 * Build a symmetric correlation matrix for a set of return-series (keyed by
 * ticker). Diagonal is always 1; off-diagonal is pearson(returns_i, returns_j).
 */
export function correlationMatrix(
  series: Record<string, number[]>,
): { tickers: string[]; matrix: number[][] } {
  const tickers = Object.keys(series);
  const matrix = tickers.map((ti) =>
    tickers.map((tj) =>
      ti === tj ? 1 : pearson(series[ti]!, series[tj]!),
    ),
  );
  return { tickers, matrix };
}

/**
 * Truncate multiple close-series to the same length (shortest) so they align on
 * the normalized chart and correlation. Keeps the TAIL (most recent) window,
 * which is what a "relative performance" comparison should show.
 */
export function alignTail<T>(series: T[][]): T[][] {
  if (series.length === 0) return [];
  const minLen = Math.min(...series.map((s) => s.length));
  if (minLen <= 0) return series.map(() => []);
  return series.map((s) => s.slice(s.length - minLen));
}

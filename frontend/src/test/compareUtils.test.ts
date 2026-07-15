// frontend/src/test/compareUtils.test.ts
// Phase 5 compare-view pure helpers.
import {
  normalizeToBase,
  dailyReturns,
  pearson,
  correlationMatrix,
  alignTail,
} from '../components/compare/compareUtils';

const bars = (closes: number[]) => closes.map((c, i) => ({ t: `2026-01-${i + 1}`, close: c }));

describe('normalizeToBase', () => {
  it('rebases the first point to 100', () => {
    const out = normalizeToBase(bars([200, 210, 190]));
    expect(out[0]).toBe(100);
    expect(out[1]).toBeCloseTo(105);
    expect(out[2]).toBeCloseTo(95);
  });
  it('returns empty for empty input', () => {
    expect(normalizeToBase([])).toEqual([]);
  });
  it('returns unscaled when base is 0', () => {
    expect(normalizeToBase(bars([0, 5, 10]))).toEqual([0, 5, 10]);
  });
});

describe('dailyReturns', () => {
  it('computes period-over-period returns (N-1 values)', () => {
    const r = dailyReturns([100, 110, 99]);
    expect(r).toHaveLength(2);
    expect(r[0]).toBeCloseTo(0.1);
    expect(r[1]).toBeCloseTo(-0.1);
  });
  it('returns empty for a single point', () => {
    expect(dailyReturns([100])).toEqual([]);
  });
});

describe('pearson', () => {
  it('is 1 for a perfectly correlated series', () => {
    expect(pearson([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1);
  });
  it('is -1 for a perfectly inverse series', () => {
    expect(pearson([1, 2, 3, 4], [8, 6, 4, 2])).toBeCloseTo(-1);
  });
  it('is 0 for insufficient samples', () => {
    expect(pearson([1], [2])).toBe(0);
  });
  it('clamps float drift into [-1, 1]', () => {
    const v = pearson([1, 2, 3], [1, 2, 3]);
    expect(v).toBeLessThanOrEqual(1);
    expect(v).toBeGreaterThanOrEqual(-1);
  });
});

describe('correlationMatrix', () => {
  it('has a unit diagonal and symmetric off-diagonals', () => {
    const { tickers, matrix } = correlationMatrix({
      A: [1, 2, 3, 4],
      B: [2, 4, 6, 8],
      C: [8, 6, 4, 2],
    });
    expect(tickers).toEqual(['A', 'B', 'C']);
    expect(matrix[0]![0]).toBe(1);
    expect(matrix[1]![1]).toBe(1);
    expect(matrix[0]![1]).toBeCloseTo(1);
    expect(matrix[0]![2]).toBeCloseTo(-1);
    expect(matrix[2]![0]).toBeCloseTo(-1);
  });
});

describe('alignTail', () => {
  it('truncates each series to the shortest, keeping the tail', () => {
    const out = alignTail([
      [1, 2, 3, 4],
      [9, 8, 7],
    ]);
    expect(out[0]).toEqual([2, 3, 4]);
    expect(out[1]).toEqual([9, 8, 7]);
  });
  it('returns empty array for no input', () => {
    expect(alignTail([])).toEqual([]);
  });
});

// frontend/src/test/watchlist.test.ts
// Phase 7: pure watchlist store functions (no React, no DOM).
import {
  getWatchlist,
  isWatched,
  addWatch,
  removeWatch,
  toggleWatch,
} from '../lib/watchlist';

describe('watchlist store (pure)', () => {
  beforeEach(() => {
    // reset to empty
    [...getWatchlist()].forEach((s) => removeWatch(s));
  });

  it('starts empty in a non-browser / fresh env', () => {
    expect(getWatchlist()).toEqual([]);
  });

  it('addWatch adds an uppercased symbol', () => {
    addWatch('aapl');
    expect(getWatchlist()).toEqual(['AAPL']);
    expect(isWatched('AAPL')).toBe(true);
    expect(isWatched('aapl')).toBe(true);
  });

  it('addWatch ignores duplicates', () => {
    addWatch('AAPL');
    addWatch('AAPL');
    expect(getWatchlist()).toEqual(['AAPL']);
  });

  it('removeWatch removes a symbol', () => {
    addWatch('MSFT');
    expect(isWatched('MSFT')).toBe(true);
    removeWatch('msft');
    expect(isWatched('MSFT')).toBe(false);
    expect(getWatchlist()).toEqual([]);
  });

  it('toggleWatch flips membership and returns the new state', () => {
    expect(toggleWatch('TSLA')).toBe(true); // added
    expect(isWatched('TSLA')).toBe(true);
    expect(toggleWatch('tsla')).toBe(false); // removed (case-insensitive)
    expect(isWatched('TSLA')).toBe(false);
  });

  it('toggleWatch rejects empty/blank symbols', () => {
    expect(toggleWatch('')).toBe(false);
    expect(toggleWatch('   ')).toBe(false);
    expect(getWatchlist()).toEqual([]);
  });

  it('preserves insertion order and dedupes', () => {
    addWatch('AAPL');
    addWatch('MSFT');
    addWatch('AAPL');
    addWatch('NVDA');
    expect(getWatchlist()).toEqual(['AAPL', 'MSFT', 'NVDA']);
  });
});

// frontend/src/test/WatchlistBar.test.tsx
// Phase 7: the persistent Watchlist / Portfolio bar — add, render chips,
// deep-dive (onOpen), and remove.
import { render, screen, fireEvent, within } from '@testing-library/react';
import { vi } from 'vitest';
import { WatchlistBar } from '../components/WatchlistBar';
import { getWatchlist, removeWatch, addWatch } from '../lib/watchlist';

describe('WatchlistBar', () => {
  beforeEach(() => {
    [...getWatchlist()].forEach((s) => removeWatch(s));
  });

  it('renders an empty state when no symbols are saved', () => {
    render(<WatchlistBar onOpen={() => {}} />);
    expect(screen.getByTestId('watchlist-bar')).toBeInTheDocument();
    expect(screen.getByTestId('watchlist-empty')).toBeInTheDocument();
    expect(screen.getByTestId('watchlist-count').textContent).toMatch(/0 symbols/);
  });

  it('adds a valid ticker and shows it as a chip', () => {
    render(<WatchlistBar onOpen={() => {}} />);
    const input = screen.getByTestId('watchlist-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'aapl' } });
    fireEvent.click(screen.getByTestId('watchlist-add-btn'));
    const chip = screen.getByTestId('watchlist-chip-AAPL');
    expect(within(chip).getByTestId('watchlist-open-AAPL').textContent).toBe('AAPL');
    expect(screen.getByTestId('watchlist-count').textContent).toMatch(/1 symbol/);
    // also persisted to the store
    expect(getWatchlist()).toContain('AAPL');
  });

  it('rejects an invalid ticker with an error', () => {
    render(<WatchlistBar onOpen={() => {}} />);
    const input = screen.getByTestId('watchlist-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '!!!' } });
    fireEvent.click(screen.getByTestId('watchlist-add-btn'));
    expect(screen.getByTestId('watchlist-error')).toBeInTheDocument();
    expect(getWatchlist()).toEqual([]);
  });

  it('calls onOpen (deep-dive) when a chip is clicked', () => {
    const onOpen = vi.fn();
    render(<WatchlistBar onOpen={onOpen} />);
    const input = screen.getByTestId('watchlist-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'NVDA' } });
    fireEvent.click(screen.getByTestId('watchlist-add-btn'));
    fireEvent.click(screen.getByTestId('watchlist-open-NVDA'));
    expect(onOpen).toHaveBeenCalledWith('NVDA');
  });

  it('removes a chip and updates the store', () => {
    render(<WatchlistBar onOpen={() => {}} />);
    const input = screen.getByTestId('watchlist-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'MSFT' } });
    fireEvent.click(screen.getByTestId('watchlist-add-btn'));
    expect(screen.getByTestId('watchlist-chip-MSFT')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('watchlist-remove-MSFT'));
    expect(screen.queryByTestId('watchlist-chip-MSFT')).not.toBeInTheDocument();
    expect(getWatchlist()).not.toContain('MSFT');
  });

  it('reflects pre-existing saved symbols on mount', () => {
    // seed via store
    addWatch('GOOGL');
    render(<WatchlistBar onOpen={() => {}} />);
    expect(screen.getByTestId('watchlist-chip-GOOGL')).toBeInTheDocument();
    addWatch('GOOGL'); // no-op dedupe
  });
});

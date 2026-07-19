// frontend/src/test/WatchlistBar.test.tsx
// Phase 7: the persistent Watchlist / Portfolio bar — add, render chips,
// deep-dive (onOpen), and remove. Adding goes through the server-side symbol
// validation (GET /validate-symbols); fetch is stubbed so the tests are hermetic.
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import { WatchlistBar } from '../components/WatchlistBar';
import { getWatchlist, removeWatch, addWatch } from '../lib/watchlist';

const validJson = (symbol: string) => ({
  results: [{ symbol, valid: true }],
  valid: [symbol],
  invalid: [],
});

beforeEach(() => {
  [...getWatchlist()].forEach((s) => removeWatch(s));
  // Default: every symbol is a valid ticker (server validation succeeds).
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 200, json: async () => validJson('AAPL') } as any)),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('WatchlistBar', () => {
  it('renders an empty state when no symbols are saved', () => {
    render(<WatchlistBar onOpen={() => {}} />);
    expect(screen.getByTestId('watchlist-bar')).toBeInTheDocument();
    expect(screen.getByTestId('watchlist-empty')).toBeInTheDocument();
    expect(screen.getByTestId('watchlist-count').textContent).toMatch(/0 symbols/);
  });

  it('adds a valid ticker and shows it as a chip', async () => {
    render(<WatchlistBar onOpen={() => {}} />);
    const input = screen.getByTestId('watchlist-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'aapl' } });
    fireEvent.click(screen.getByTestId('watchlist-add-btn'));
    expect(await screen.findByTestId('watchlist-chip-AAPL')).toBeInTheDocument();
    expect(screen.getByTestId('watchlist-count').textContent).toMatch(/1 symbol/);
    expect(getWatchlist()).toContain('AAPL');
  });

  it('rejects an invalid ticker format with an error', async () => {
    render(<WatchlistBar onOpen={() => {}} />);
    const input = screen.getByTestId('watchlist-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '!!!' } });
    fireEvent.click(screen.getByTestId('watchlist-add-btn'));
    expect(await screen.findByTestId('watchlist-error')).toBeInTheDocument();
    expect(getWatchlist()).toEqual([]);
  });

  it('calls onOpen (deep-dive) when a chip is clicked', async () => {
    const onOpen = vi.fn();
    render(<WatchlistBar onOpen={onOpen} />);
    const input = screen.getByTestId('watchlist-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'NVDA' } });
    fireEvent.click(screen.getByTestId('watchlist-add-btn'));
    fireEvent.click(await screen.findByTestId('watchlist-open-NVDA'));
    expect(onOpen).toHaveBeenCalledWith('NVDA');
  });

  it('removes a chip and updates the store', async () => {
    render(<WatchlistBar onOpen={() => {}} />);
    const input = screen.getByTestId('watchlist-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'MSFT' } });
    fireEvent.click(screen.getByTestId('watchlist-add-btn'));
    expect(await screen.findByTestId('watchlist-chip-MSFT')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('watchlist-remove-MSFT'));
    expect(screen.queryByTestId('watchlist-chip-MSFT')).not.toBeInTheDocument();
    expect(getWatchlist()).not.toContain('MSFT');
  });

  it('reflects pre-existing saved symbols on mount', () => {
    addWatch('GOOGL');
    render(<WatchlistBar onOpen={() => {}} />);
    expect(screen.getByTestId('watchlist-chip-GOOGL')).toBeInTheDocument();
    addWatch('GOOGL'); // no-op dedupe
  });

  it('rejects a non-symbol word (e.g. IRON) via the server validation, but accepts real tickers', async () => {
    // Override the default fetch: "No data"/invalid for IRON, valid for AAPL.
    const fetchMock = vi.fn(async (url: string) => {
      const isIron = /iron/i.test(String(url));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          results: [{ symbol: isIron ? 'IRON' : 'AAPL', valid: !isIron }],
          valid: isIron ? [] : ['AAPL'],
          invalid: isIron ? ['IRON'] : [],
        }),
      } as any;
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<WatchlistBar onOpen={() => {}} />);
    const input = screen.getByTestId('watchlist-input') as HTMLInputElement;

    // IRON looks like a ticker but is not a real symbol → rejected, not added.
    fireEvent.change(input, { target: { value: 'IRON' } });
    fireEvent.click(screen.getByTestId('watchlist-add-btn'));
    expect(await screen.findByTestId('watchlist-error')).toHaveTextContent(/not a recognized ticker/i);
    expect(getWatchlist()).toEqual([]);

    // A real ticker is accepted.
    fireEvent.change(input, { target: { value: 'AAPL' } });
    fireEvent.click(screen.getByTestId('watchlist-add-btn'));
    expect(await screen.findByTestId('watchlist-chip-AAPL')).toBeInTheDocument();
    expect(getWatchlist()).toContain('AAPL');
  });
});

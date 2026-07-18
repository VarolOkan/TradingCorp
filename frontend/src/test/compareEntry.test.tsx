// Guards the compare-entry UX with the pill input:
//  - 1 ticker  -> no Compare button; helpful guidance hint instead of "Comparing 1 tickers"
//  - 2 tickers -> Compare button appears with correct count, and toggles into CompareView
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import AnalysisView from '../components/AnalysisView';

function fakeSocket() {
  return { on: () => {}, off: () => {}, emit: () => {}, connected: true } as any;
}

// getQuote drives the no-run preview validation. NOTREAL throws (not found).
const getQuoteMock = vi.fn(async (s: string) => {
  if (s === 'NOTREAL') throw new Error('not found');
  return { symbol: s, name: `${s} Inc`, price: 100, note: undefined };
});
vi.mock('../api/quoteClient', () => ({ getQuote: (...a: any[]) => getQuoteMock(...a) }));

vi.mock('../api/historyClient', () => ({
  getPriceHistory: async () => ({
    bars: [
      { t: '2024-01-01', open: 100, high: 102, low: 99, close: 100, volume: 1, vwap: 100 },
      { t: '2024-01-02', open: 100, high: 107, low: 100, close: 105, volume: 1, vwap: 105 },
      { t: '2024-01-03', open: 105, high: 112, low: 104, close: 110, volume: 1, vwap: 110 },
    ],
  }),
}));

// Type a ticker into the pill input and commit it with Enter.
function addTicker(symbol: string) {
  const input = screen.getByLabelText('Ticker symbols') as HTMLInputElement;
  fireEvent.change(input, { target: { value: symbol } });
  fireEvent.keyDown(input, { key: 'Enter' });
}

describe('Compare entry UX (pill input)', () => {
  it('1 ticker: no Compare button, shows guidance hint', async () => {
    render(<AnalysisView socket={fakeSocket()} connected={true} />);
    addTicker('AAPL');
    expect(screen.queryByTestId('compare-toggle')).toBeNull();
    const guide = await screen.findByTestId('compare-hint-guide');
    expect(guide.textContent).toMatch(/2–6 tickers/);
  });

  it('2 tickers: Compare button appears with correct count and toggles into CompareView', async () => {
    render(<AnalysisView socket={fakeSocket()} connected={true} />);
    addTicker('AAPL');
    addTicker('MSFT');
    const toggle = await screen.findByTestId('compare-toggle');
    expect(toggle.textContent).toContain('Compare tickers');
    fireEvent.click(toggle);
    expect(await screen.findByTestId('compare-view')).toBeTruthy();
    expect(screen.getByText('Relative performance (rebased to 100)')).toBeTruthy();
    expect(screen.getByText('Return correlation')).toBeTruthy();
  });

  it('caps at 6 pills in the input box', async () => {
    render(<AnalysisView socket={fakeSocket()} connected={true} />);
    ['A', 'B', 'C', 'D', 'E', 'F', 'G'].forEach(addTicker);
    // Only 6 should render.
    ['A', 'B', 'C', 'D', 'E', 'F'].forEach((s) =>
      expect(screen.getByTestId(`pill-${s}`)).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('pill-G')).toBeNull();
  });

  it('shows the full collection: entered pills + watchlist clicks graph together', async () => {
    render(<AnalysisView socket={fakeSocket()} connected={true} />);
    // Enter two tickers as pills.
    addTicker('AAPL');
    addTicker('MSFT');
    // Click two watchlist chips (TSLA, NVDA) — each should ADD, not replace.
    fireEvent.change(screen.getByTestId('watchlist-input'), { target: { value: 'TSLA' } });
    fireEvent.click(screen.getByTestId('watchlist-add-btn'));
    fireEvent.click(screen.getByTestId('watchlist-open-TSLA'));
    fireEvent.change(screen.getByTestId('watchlist-input'), { target: { value: 'NVDA' } });
    fireEvent.click(screen.getByTestId('watchlist-add-btn'));
    fireEvent.click(screen.getByTestId('watchlist-open-NVDA'));

    // All four tickers appear as market cards (the collection, not just the last).
    await waitFor(() =>
      ['AAPL', 'MSFT', 'TSLA', 'NVDA'].forEach((s) =>
        expect(screen.getByTestId(`market-card-${s}`)).toBeTruthy(),
      ),
    );
  });

  it('blurring an invalid ticker previews nothing and does not create a pill', async () => {
    render(<AnalysisView socket={fakeSocket()} connected={true} />);
    const input = screen.getByLabelText('Ticker symbols') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'NOTREAL' } });
    fireEvent.blur(input);
    await waitFor(() => expect(getQuoteMock).toHaveBeenCalled());
    expect(screen.queryByTestId('pill-NOTREAL')).toBeNull();
    expect(screen.queryByTestId('market-card-NOTREAL')).toBeNull();
  });
});

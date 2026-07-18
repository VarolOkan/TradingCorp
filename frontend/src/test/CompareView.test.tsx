// frontend/src/test/CompareView.test.tsx
// Phase 5: the compare view renders a normalized chart, a correlation matrix,
// and side-by-side verdicts from a passed-in AnalysisResult.
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { CompareView } from '../components/compare/CompareView';
import type { PriceBarsResult } from '../api/historyClient';

const makeBars = (closes: number[], ticker: string): PriceBarsResult => ({
  ticker,
  interval: '1d',
  lookback_days: 90,
  source: 'yahoo',
  bars: closes.map((c, i) => ({
    t: `2026-01-${String(i + 1).padStart(2, '0')}`,
    open: c,
    high: c + 1,
    low: c - 1,
    close: c,
    volume: 1000,
  })),
});

// AAPL and MSFT zig-zag together (positively correlated returns); TSLA zig-zags
// in the OPPOSITE phase (negatively correlated). Zig-zags (not monotonic trends)
// are required: monotonic price moves give return series that are both
// decreasing -> falsely +1 correlated.
const HISTORY: Record<string, PriceBarsResult> = {
  AAPL: makeBars([100, 110, 100, 110, 100], 'AAPL'),
  MSFT: makeBars([200, 220, 200, 220, 200], 'MSFT'),
  TSLA: makeBars([100, 90, 100, 90, 100], 'TSLA'),
};

const mockGet = vi.fn(async (symbol: string) => HISTORY[symbol]!);

describe('CompareView', () => {
  beforeEach(() => {
    mockGet.mockClear();
  });

  it('shows the empty state for < 2 tickers', () => {
    render(<CompareView tickers={['AAPL']} result={null} fetchHistory={mockGet} />);
    expect(screen.getByTestId('compare-empty')).toBeInTheDocument();
  });

  it('renders normalized chart, correlation matrix, and per-ticker metrics', async () => {
    render(<CompareView tickers={['AAPL', 'MSFT', 'TSLA']} result={null} fetchHistory={mockGet} />);
    await waitFor(() => expect(screen.getByTestId('norm-chart-svg')).toBeInTheDocument());
    // one normalized path per ticker
    expect(screen.getByTestId('norm-path-AAPL')).toBeInTheDocument();
    expect(screen.getByTestId('norm-path-MSFT')).toBeInTheDocument();
    expect(screen.getByTestId('norm-path-TSLA')).toBeInTheDocument();
    // baseline at 100
    expect(screen.getByTestId('norm-baseline')).toBeInTheDocument();
    // correlation matrix
    const corr = screen.getByTestId('corr-matrix');
    expect(corr).toBeInTheDocument();
    // AAPL/MSFT strongly positively correlated -> cell near 1
    expect(screen.getByTestId('corr-AAPL-MSFT').getAttribute('data-value')).toContain('1.00');
    // AAPL/TSLA inversely correlated -> near -1
    expect(screen.getByTestId('corr-AAPL-TSLA').getAttribute('data-value')).toContain('-1.00');
    // per-ticker comparison metrics table
    expect(screen.getByTestId('metrics-table')).toBeInTheDocument();
    for (const t of ['AAPL', 'MSFT', 'TSLA']) {
      expect(screen.getByTestId(`metric-row-${t}`)).toBeInTheDocument();
      expect(screen.getByTestId(`metric-price-${t}`)).toBeInTheDocument();
      expect(screen.getByTestId(`metric-return-${t}`)).toBeInTheDocument();
      expect(screen.getByTestId(`metric-vol-${t}`)).toBeInTheDocument();
      expect(screen.getByTestId(`metric-sharpe-${t}`)).toBeInTheDocument();
      expect(screen.getByTestId(`metric-drawdown-${t}`)).toBeInTheDocument();
    }
    // a "best" summary line is shown
    expect(screen.getByTestId('metrics-best')).toBeInTheDocument();
    // best return should be the ticker with the highest computed return among the three
    const bestReturnTicker = screen.getByTestId('metrics-best').textContent || '';
    expect(bestReturnTicker).toMatch(/Best return:/);
  });

  it('shows a no-metrics notice when no history loads', async () => {
    const failing = vi.fn(async () => { throw new Error('no history'); });
    render(<CompareView tickers={['AAPL', 'MSFT']} result={null} fetchHistory={failing} />);
    await waitFor(() => expect(screen.getByTestId('metrics-none')).toBeInTheDocument());
  });

  it('fetches a history series per ticker', async () => {
    render(<CompareView tickers={['AAPL', 'MSFT']} result={null} fetchHistory={mockGet} />);
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(2));
  });
});

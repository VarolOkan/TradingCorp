// Regression test: clicking "Run screener" (from the collapsed header) must
// auto-expand the results section so the screened rows are visible after the
// run completes.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ScreenerPanel from '../components/ScreenerPanel';
import { getScreener } from '../api/screenerClient';

const mockResult = {
  agencyId: 'long-term',
  weights: { technical: 0.5, sentiment: 0.5 },
  rows: [
    {
      ticker: 'AAPL',
      promise: 82,
      technical: 80,
      sentiment: 60,
      momentum: 70,
      stability: 75,
      verdict: 'STRONG' as const,
      topAxis: 'technical' as const,
      barsSource: 'yahoo' as const,
      newsSource: 'yahoo',
      asOf: new Date().toISOString(),
      avgVolume: 9_500_000,
    },
  ],
  universeSize: 1,
  screenedAt: new Date().toISOString(),
  elapsedMs: 12,
  dataSource: 'DELAYED' as const,
  liveRows: 1,
  universeTrace: {
    provider: 'fallback',
    usedFallback: true,
    origin: 'fallback',
    steps: [
      { source: 'nasdaqtrader', kind: 'provider', result: 'threw: network', total: 0 },
      { source: 'fallback', kind: 'fallback', result: 'DEFAULT_UNIVERSE (25)', total: 25 },
    ],
    listedCount: 0,
    parsedCount: 25,
    prefilteredCount: 25,
    finalCount: 25,
    note: 'No live universe source was reachable. Fell back to the hardcoded 25-ticker DEFAULT_UNIVERSE.',
  },
};

vi.mock('../api/screenerClient', () => ({
  getScreener: vi.fn(async () => mockResult),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

function lastCallArgs(): { limit?: number; interval?: string; lookbackDays?: number; minVolumeDaily?: number } {
  const calls = (getScreener as ReturnType<typeof vi.fn>).mock.calls;
  return (calls[calls.length - 1]?.[1] ?? {}) as { limit?: number; interval?: string; lookbackDays?: number; minVolumeDaily?: number };
}

describe('ScreenerPanel', () => {
  it('auto-expands after a run so the results are visible', async () => {
    render(<ScreenerPanel agencyId="long-term" onPick={() => {}} />);

    // Starts collapsed.
    const toggle = screen.getByTestId('screener-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    // The collapsed "Run" button is what the user clicks from the closed state.
    const runCollapsed = screen.getByTestId('screener-run-collapsed');
    fireEvent.click(runCollapsed);

    // Panel expands (covers both "expand at start" and "after run completes").
    await waitFor(() => expect(screen.getByTestId('screener-toggle').getAttribute('aria-expanded')).toBe('true'));

    // Results table is rendered once the (mocked) run resolves.
    await waitFor(() => expect(screen.getByTestId('screener-table')).toBeTruthy());
    expect(screen.getByTestId('screener-row-AAPL')).toBeTruthy();
  });

  it('keeps the panel expanded when the run errors (error is shown)', async () => {
    const { getScreener } = await import('../api/screenerClient');
    (getScreener as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));

    render(<ScreenerPanel agencyId="long-term" onPick={() => {}} />);
    fireEvent.click(screen.getByTestId('screener-run-collapsed'));

    await waitFor(() => expect(screen.getByTestId('screener-toggle').getAttribute('aria-expanded')).toBe('true'));
    await waitFor(() => expect(screen.getByTestId('screener-error').textContent).toContain('boom'));
  });

  it('sends a daily horizon (1d / 90d) for the long-term agency', async () => {
    render(<ScreenerPanel agencyId="long-term" onPick={() => {}} />);
    fireEvent.click(screen.getByTestId('screener-run-collapsed'));
    await waitFor(() => expect(screen.getByTestId('screener-table')).toBeTruthy());
    const args = lastCallArgs();
    expect(args.interval).toBe('1d');
    expect(args.lookbackDays).toBe(90);
  });

  it('sends an intraday horizon (5m / 5d) for the intraday agency', async () => {
    render(<ScreenerPanel agencyId="intraday" onPick={() => {}} />);
    fireEvent.click(screen.getByTestId('screener-run-collapsed'));
    await waitFor(() => expect(screen.getByTestId('screener-table')).toBeTruthy());
    const args = lastCallArgs();
    expect(args.interval).toBe('5m');
    expect(args.lookbackDays).toBe(5);
  });

  it('requests the 10-15 candidate default (limit=15), not the old 8', async () => {
    render(<ScreenerPanel agencyId="long-term" onPick={() => {}} />);
    fireEvent.click(screen.getByTestId('screener-run-collapsed'));
    await waitFor(() => expect(screen.getByTestId('screener-table')).toBeTruthy());
    expect(lastCallArgs().limit).toBe(15);
  });

  it('renders the truthful dataSource badge from the screen result', async () => {
    render(<ScreenerPanel agencyId="long-term" onPick={() => {}} />);
    fireEvent.click(screen.getByTestId('screener-run-collapsed'));
    await waitFor(() => expect(screen.getByTestId('screener-source-badge').textContent).toBe('DELAYED'));
    // Per-row source dot is present for each ticker.
    expect(screen.getByTestId('screener-barsource-AAPL')).toBeTruthy();
  });

  it('renders the Data Lineage panel with the fallback warning + funnel counts', async () => {
    render(<ScreenerPanel agencyId="long-term" onPick={() => {}} />);
    fireEvent.click(screen.getByTestId('screener-run-collapsed'));
    await waitFor(() => expect(screen.getByTestId('screener-lineage')).toBeTruthy());
    // Funnel shows the final pool size (25 from fallback).
    expect(screen.getByTestId('screener-funnel-val-final-pool').textContent).toBe('25');
    // Explicit fallback warning is shown (explains GOOGL showing up).
    expect(screen.getByTestId('screener-lineage-warn').textContent).toContain('DEFAULT_UNIVERSE');
    // Origin badge reads FALLBACK.
    expect(screen.getByTestId('screener-lineage-origin').textContent).toBe('FALLBACK');
  });

  it('sorts rows by clicking a header (Ticker ASC -> DESC), and Promise DESC', async () => {
    const { getScreener: gs } = await import('../api/screenerClient');
    const multi = {
      ...mockResult,
      rows: [
        { ticker: 'MSFT', promise: 50, technical: 60, sentiment: 40, momentum: 30, stability: 70, verdict: 'WATCH' as const, topAxis: 'technical' as const, barsSource: 'yahoo' as const, newsSource: 'yahoo', asOf: new Date().toISOString() },
        { ticker: 'AAPL', promise: 90, technical: 80, sentiment: 60, momentum: 70, stability: 75, verdict: 'STRONG' as const, topAxis: 'technical' as const, barsSource: 'yahoo' as const, newsSource: 'yahoo', asOf: new Date().toISOString() },
        { ticker: 'ZNGA', promise: 20, technical: 10, sentiment: 10, momentum: 5, stability: 20, verdict: 'WEAK' as const, topAxis: 'technical' as const, barsSource: 'yahoo' as const, newsSource: 'yahoo', asOf: new Date().toISOString() },
      ],
    };
    (gs as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(multi);

    render(<ScreenerPanel agencyId="long-term" onPick={() => {}} />);
    fireEvent.click(screen.getByTestId('screener-run-collapsed'));
    await waitFor(() => expect(screen.getByTestId('screener-table')).toBeTruthy());

    const order = () =>
      Array.from(document.querySelectorAll('tbody tr'))
        .map((tr) => (tr.getAttribute('data-testid') ?? '').replace('screener-row-', ''));

    // Default (no sort) preserves backend order: MSFT, AAPL, ZNGA.
    expect(order()).toEqual(['MSFT', 'AAPL', 'ZNGA']);

    // Click Ticker -> ASC: AAPL, MSFT, ZNGA.
    fireEvent.click(screen.getByTestId('screener-col-ticker'));
    expect(order()).toEqual(['AAPL', 'MSFT', 'ZNGA']);
    expect(screen.getByTestId('screener-col-ticker').getAttribute('aria-sort')).toBe('ascending');

    // Click Ticker again -> DESC: ZNGA, MSFT, AAPL.
    fireEvent.click(screen.getByTestId('screener-col-ticker'));
    expect(order()).toEqual(['ZNGA', 'MSFT', 'AAPL']);
    expect(screen.getByTestId('screener-col-ticker').getAttribute('aria-sort')).toBe('descending');

    // Click Promise -> ASC (new column resets to ASC): ZNGA(20), MSFT(50), AAPL(90).
    fireEvent.click(screen.getByTestId('screener-col-promise'));
    expect(order()).toEqual(['ZNGA', 'MSFT', 'AAPL']);
    expect(screen.getByTestId('screener-col-promise').getAttribute('aria-sort')).toBe('ascending');

    // Click Promise again -> DESC: AAPL(90), MSFT(50), ZNGA(20).
    fireEvent.click(screen.getByTestId('screener-col-promise'));
    expect(order()).toEqual(['AAPL', 'MSFT', 'ZNGA']);
  });

  it('shows DELAYED badge (not MOCK) when the universe is live even if some bars are mock', async () => {
    const gs = getScreener as unknown as ReturnType<typeof vi.fn>;
    const mixed = {
      ...mockResult,
      universeTrace: { ...mockResult.universeTrace!, usedFallback: false, origin: 'live' as const },
      rows: [
        { ticker: 'AAPL', promise: 90, technical: 80, sentiment: 60, momentum: 70, stability: 75, verdict: 'STRONG' as const, topAxis: 'technical' as const, barsSource: 'yahoo' as const, newsSource: 'yahoo', asOf: new Date().toISOString() },
        { ticker: 'ZZZZ', promise: 10, technical: 10, sentiment: 0, momentum: 5, stability: 20, verdict: 'WEAK' as const, topAxis: 'technical' as const, barsSource: 'mock' as const, newsSource: 'mock', asOf: new Date().toISOString() },
      ],
      liveRows: 1,
    };
    (gs as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mixed);

    render(<ScreenerPanel agencyId="long-term" onPick={() => {}} />);
    fireEvent.click(screen.getByTestId('screener-run-collapsed'));
    await waitFor(() => expect(screen.getByTestId('screener-source-badge').textContent).toContain('DELAYED'));
    // Sub-count tells how many rows are on live bars (1 of 2).
    expect(screen.getByTestId('screener-source-badge').textContent).toContain('1/2 live');
  });

  it('shows only MOCK when the universe itself fell back and every row is mock', async () => {
    const gs = getScreener as unknown as ReturnType<typeof vi.fn>;
    const allMock = {
      ...mockResult,
      dataSource: 'MOCK' as const,
      liveRows: 0,
      rows: [
        { ticker: 'AAPL', promise: 90, technical: 80, sentiment: 60, momentum: 70, stability: 75, verdict: 'STRONG' as const, topAxis: 'technical' as const, barsSource: 'mock' as const, newsSource: 'mock', asOf: new Date().toISOString() },
      ],
    };
    (gs as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(allMock);

    render(<ScreenerPanel agencyId="long-term" onPick={() => {}} />);
    fireEvent.click(screen.getByTestId('screener-run-collapsed'));
    await waitFor(() => expect(screen.getByTestId('screener-source-badge').textContent).toBe('MOCK'));
  });

  it('Promise cell = 2 rows: bar on top, then "score axis" on the line below', async () => {
    render(<ScreenerPanel agencyId="long-term" onPick={() => {}} />);
    fireEvent.click(screen.getByTestId('screener-run-collapsed'));
    await waitFor(() => expect(screen.getByTestId('screener-topaxis-AAPL')).toBeTruthy());
    // The promise cell holds exactly three nodes in DOM order: bar, value, axis.
    const cell = screen.getByTestId('screener-promise-AAPL');
    const bar = cell.querySelector('.screener-promise-bar');
    const val = cell.querySelector('.screener-promise-val');
    const axis = cell.querySelector('.screener-topaxis');
    expect(bar).toBeTruthy();
    expect(val).toBeTruthy();
    expect(axis).toBeTruthy();
    // DOM order: bar -> value -> axis (so CSS lays them as 2 rows, not 3 blocks).
    expect(cell.children[0]).toBe(bar);
    expect(cell.children[1]).toBe(val);
    expect(cell.children[2]).toBe(axis);
    // Axis label is the agency's top-weighted axis, capitalized (here Technical).
    expect(axis!.textContent).toContain('Technical');
  });

  it('shows a live running timer while screening and a field legend when done', async () => {
    // Make the mock resolve slowly so we can observe the running timer mid-flight.
    let resolveFn: (v: unknown) => void;
    const slow = new Promise((res) => { resolveFn = res; });
    const gs = getScreener as unknown as ReturnType<typeof vi.fn>;
    (gs as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(slow);

    render(<ScreenerPanel agencyId="long-term" onPick={() => {}} />);
    fireEvent.click(screen.getByTestId('screener-run-collapsed'));
    // Mid-flight: a running timer indicator is present.
    expect(await screen.findByTestId('screener-running')).toBeTruthy();

    // Finish the request -> running timer gone, legend shown.
    resolveFn!({ ...mockResult, rows: [{ ticker: 'AAPL', promise: 90, technical: 80, sentiment: 60, momentum: 70, stability: 75, verdict: 'STRONG' as const, topAxis: 'technical' as const, barsSource: 'yahoo' as const, newsSource: 'yahoo', asOf: new Date().toISOString() }] });
    await waitFor(() => expect(screen.queryByTestId('screener-running')).toBeNull());
    const legend = await screen.findByTestId('screener-legend');
    expect(legend.textContent).toContain('Promise');
    expect(legend.textContent).toContain('Verdict');
  });

  it('Phase 22: renders the agency-default readout (no Timeframe/Instrument selectors)', async () => {
    render(<ScreenerPanel agencyId="long-term" onPick={() => {}} />);
    // The old selectors are gone.
    expect(screen.queryByTestId('screener-timeframe')).toBeNull();
    expect(screen.queryByTestId('screener-instrument')).toBeNull();
    // The run instead shows the agency's resolved default (interval · lookback · assetClass).
    expect(screen.getByTestId('screener-agency-default').textContent).toContain('1d · 90d · EQUITY');
  });

  it('Phase 22: intraday agency shows its 5m/5d EQUITY default', async () => {
    render(<ScreenerPanel agencyId="intraday" onPick={() => {}} />);
    expect(screen.getByTestId('screener-agency-default').textContent).toContain('5m · 5d · EQUITY');
  });

  it('Phase 22: options agency shows its OPTION asset class default', async () => {
    render(<ScreenerPanel agencyId="options-swing" onPick={() => {}} />);
    expect(screen.getByTestId('screener-agency-default').textContent).toContain('1d · 90d · OPTION');
  });

  it('Phase 22: the readout updates live when the agency switches', async () => {
    const { rerender } = render(<ScreenerPanel agencyId="long-term" onPick={() => {}} />);
    expect(screen.getByTestId('screener-agency-default').textContent).toContain('1d · 90d · EQUITY');
    // Switch to intraday -> readout must reflect the new agency's 5m/5d default.
    rerender(<ScreenerPanel agencyId="intraday" onPick={() => {}} />);
    expect(screen.getByTestId('screener-agency-default').textContent).toContain('5m · 5d · EQUITY');
    // Switch to an options agency -> OPTION asset class.
    rerender(<ScreenerPanel agencyId="options-intraday" onPick={() => {}} />);
    expect(screen.getByTestId('screener-agency-default').textContent).toContain('5m · 5d · OPTION');
  });

  it('Phase 22: sends the agency default profile + asset-class intent (no panel override)', async () => {
    render(<ScreenerPanel agencyId="long-term" onPick={() => {}} />);
    fireEvent.click(screen.getByTestId('screener-run-collapsed'));
    await waitFor(() => expect(screen.getByTestId('screener-table')).toBeTruthy());
    const args = lastCallArgs() as any;
    expect(args.interval).toBe('1d');
    expect(args.lookbackDays).toBe(90);
    expect(args.instrument).toBe('EQUITY');
  });

  it('Phase 22: an OPTION agency sends instrument=OPTION and shows the honest badge', async () => {
    const gs = getScreener as unknown as ReturnType<typeof vi.fn>;
    const optResult = { ...mockResult, instrument: 'OPTION' as const, note: 'option note' };
    (gs as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(optResult);

    render(<ScreenerPanel agencyId="options-intraday" onPick={() => {}} />);
    fireEvent.click(screen.getByTestId('screener-run-collapsed'));
    await waitFor(() => expect(screen.getByTestId('screener-table')).toBeTruthy());
    expect((lastCallArgs() as any).instrument).toBe('OPTION');
    expect(screen.getByTestId('screener-instrument-badge').textContent).toBe('OPTION-LISTED');
  });

  it('Phase 25: renders the avg-volume column with a human-readable share volume', async () => {
    render(<ScreenerPanel agencyId="long-term" onPick={() => {}} />);
    fireEvent.click(screen.getByTestId('screener-run-collapsed'));
    await waitFor(() => expect(screen.getByTestId('screener-table')).toBeTruthy());
    // Column header present.
    expect(screen.getByTestId('screener-col-avgVolume')).toBeTruthy();
    // Cell renders a formatted volume (9.5M for 9,500,000), not a raw number.
    const cell = screen.getByTestId('screener-volume-AAPL');
    expect(cell.textContent).toContain('9.5M');
  });

  it('Phase 25: sends the default min-volume floor (100000) unless the agency overrides it', async () => {
    render(<ScreenerPanel agencyId="long-term" onPick={() => {}} />);
    fireEvent.click(screen.getByTestId('screener-run-collapsed'));
    await waitFor(() => expect(screen.getByTestId('screener-table')).toBeTruthy());
    // Default floor is now 100000 (shares/day), not 0.
    expect((lastCallArgs() as any).minVolumeDaily).toBe(100_000);
  });
});


// frontend/src/test/MarketDataCard.test.tsx
// Phase M: the unified MarketDataCard replaces the three separate quote/history/
// options panels with one card carrying Chart/Quote/History/Options tabs. This
// verifies tab switching, the interval toggle, lazy options fetch, and that each
// tab degrades gracefully on error.
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MarketDataCard } from '../components/MarketDataCard';
import { getWatchlist, removeWatch, isWatched } from '../lib/watchlist';
import * as quoteClient from '../api/quoteClient';
import * as historyClient from '../api/historyClient';
import * as optionsClient from '../api/optionsHistoryClient';
import * as newsClient from '../api/newsClient';

const quote = {
  symbol: 'AAPL',
  name: 'Apple Inc.',
  price: 189.5,
  dayHigh: 190.0,
  dayLow: 187.5,
  week52High: 199.62,
  week52Low: 164.21,
  previousClose: 188.0,
  volume: 11000000,
  currency: 'USD',
  marketTime: 1719000000,
  source: 'yahoo' as const,
};

const bars = {
  ticker: 'AAPL',
  interval: '1d' as const,
  lookback_days: 180,
  bars: [
    { t: '2026-01-01T00:00:00.000Z', open: 100, high: 103, low: 99, close: 101, volume: 1000 },
    { t: '2026-01-02T00:00:00.000Z', open: 101, high: 104, low: 100, close: 102, volume: 1100 },
  ],
  source: 'yahoo' as const,
};

const chain = {
  ticker: 'AAPL',
  underlying_price: 190.5,
  rfr: 0.043,
  expiries: ['2026-08-21', '2026-09-18'],
  quotes: [
    { expiry: '2026-08-21', strike: 190, type: 'C' as const, bid: 5.3, ask: 5.5, last: 5.4, volume: 50, open_interest: 1234, iv: 0.32, underlying_price: 190.5, underlying_ts: '2026-07-10T00:00:00Z' },
    { expiry: '2026-08-21', strike: 190, type: 'P' as const, bid: 4.0, ask: 4.2, last: 4.1, volume: 30, open_interest: 987, iv: 0.34, underlying_price: 190.5, underlying_ts: '2026-07-10T00:00:00Z' },
    { expiry: '2026-08-21', strike: 195, type: 'C' as const, bid: 3.0, ask: 3.2, last: 3.1, volume: 10, open_interest: 500, iv: 0.3, underlying_price: 190.5, underlying_ts: '2026-07-10T00:00:00Z' },
    { expiry: '2026-08-21', strike: 195, type: 'P' as const, bid: 6.0, ask: 6.2, last: 6.1, volume: 5, open_interest: 200, iv: 0.36, underlying_price: 190.5, underlying_ts: '2026-07-10T00:00:00Z' },
  ],
  greeks: [
    { expiry: '2026-08-21', strike: 190, type: 'C' as const, delta: 0.552, gamma: 0.0481, vega: 38.21, theta: -21.8, rho: 24.3, iv_in: 0.32, underlying_price: 190.5, ttm_years: 0.12, rfr: 0.043 },
    { expiry: '2026-08-21', strike: 190, type: 'P' as const, delta: -0.448, gamma: 0.0481, vega: 37.94, theta: -18.4, rho: -19.1, iv_in: 0.34, underlying_price: 190.5, ttm_years: 0.12, rfr: 0.043 },
    { expiry: '2026-08-21', strike: 195, type: 'C' as const, delta: 0.392, gamma: 0.0427, vega: 35.9, theta: -19.6, rho: 18.9, iv_in: 0.3, underlying_price: 190.5, ttm_years: 0.12, rfr: 0.043 },
    { expiry: '2026-08-21', strike: 195, type: 'P' as const, delta: -0.608, gamma: 0.0427, vega: 34.71, theta: -16.2, rho: -22.4, iv_in: 0.36, underlying_price: 190.5, ttm_years: 0.12, rfr: 0.043 },
  ],
  source: 'polygon' as const,
};

describe('MarketDataCard (Phase M)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(quoteClient, 'getQuote').mockResolvedValue(quote);
    vi.spyOn(historyClient, 'getPriceHistory').mockResolvedValue(bars);
  });

  it('renders the card with the symbol + 4 tabs, Chart active by default', () => {
    render(<MarketDataCard symbol="aapl" />);
    expect(screen.getByTestId('market-card-AAPL')).toBeInTheDocument();
    expect(screen.getByTestId('market-tab-chart')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('market-tab-quote')).toBeInTheDocument();
    expect(screen.getByTestId('market-tab-history')).toBeInTheDocument();
    expect(screen.getByTestId('market-tab-options')).toBeInTheDocument();
  });

  it('renders the D3 chart on the Chart tab with interval toggle', async () => {
    render(<MarketDataCard symbol="AAPL" />);
    await waitFor(() => expect(screen.getByTestId('price-chart')).toBeInTheDocument());
    // default interval is 1d
    expect(screen.getByTestId('interval-1d')).toHaveClass('active');
    expect(historyClient.getPriceHistory).toHaveBeenCalledWith('AAPL', { interval: '1d', lookbackDays: 400 });
    // switch to 5m
    fireEvent.click(screen.getByTestId('interval-5m'));
    expect(screen.getByTestId('interval-5m')).toHaveClass('active');
    expect(historyClient.getPriceHistory).toHaveBeenLastCalledWith('AAPL', { interval: '5m', lookbackDays: 5 });
  });

  it('shows the quote stats on the Quote tab', async () => {
    render(<MarketDataCard symbol="AAPL" />);
    fireEvent.click(screen.getByTestId('market-tab-quote'));
    await waitFor(() => expect(screen.getByTestId('quote-stats')).toBeInTheDocument());
    expect(screen.getByText('Apple Inc.')).toBeInTheDocument();
    expect(screen.getByText('189.5')).toBeInTheDocument();
  });

  it('shows the OHLCV table on the History tab', async () => {
    render(<MarketDataCard symbol="AAPL" />);
    fireEvent.click(screen.getByTestId('market-tab-history'));
    await waitFor(() => expect(screen.getByTestId('history-summary')).toBeInTheDocument());
    const summary = screen.getByTestId('history-summary').textContent ?? '';
    expect(summary).toContain('104'); // period high
    expect(screen.getAllByRole('row').length).toBeGreaterThan(1);
  });

  it('lazily fetches options only when the Options tab is opened', async () => {
    const optSpy = vi.spyOn(optionsClient, 'getOptionChain').mockResolvedValue(chain);
    render(<MarketDataCard symbol="AAPL" />);
    // not fetched yet
    await waitFor(() => expect(screen.getByTestId('price-chart')).toBeInTheDocument());
    expect(optSpy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('market-tab-options'));
    await waitFor(() => expect(screen.getByTestId('options-chain-panes')).toBeInTheDocument());
    expect(optSpy).toHaveBeenCalledTimes(1);
    // 2 strikes (190, 195) in each side pane (CALLS pane has 2 rows, PUTS pane 2 rows)
    expect(within(screen.getByTestId('ochain-pane-C')).getAllByTestId('ochain-row').length).toBe(2);
    expect(within(screen.getByTestId('ochain-pane-P')).getAllByTestId('ochain-row').length).toBe(2);
    expect(screen.getByText('LIVE')).toBeInTheDocument(); // source badge (uppercase)
    expect(screen.getByTestId('options-delay')).toHaveTextContent('near real-time · Polygon'); // delay label
  });

  it('renders the unified options chain with greeks merged per row (Phase 17)', async () => {
    vi.spyOn(optionsClient, 'getOptionChain').mockResolvedValue(chain);
    render(<MarketDataCard symbol="AAPL" />);
    fireEvent.click(screen.getByTestId('market-tab-options'));
    await waitFor(() => expect(screen.getByTestId('options-chain-panes')).toBeInTheDocument());
    // ONE table replaces the old split Call/Put + Greeks subtables.
    expect(screen.getByTestId('options-chain-panes')).toBeInTheDocument();
    expect(screen.queryByTestId('options-greeks')).toBeNull();
    expect(screen.queryByTestId('greeks-table')).toBeNull();
    // greeks are merged into the call row: ATM call delta 0.552 and vega scaled ν/100 => 0.3821
    expect(screen.getByText('0.552')).toBeInTheDocument();
    expect(screen.getByText('0.3821')).toBeInTheDocument();
    // Two independent toggles, both active by default (the old "side-all" is gone).
    const toggle = screen.getByTestId('options-side-toggle');
    expect(within(toggle).getByTestId('side-calls')).toHaveClass('active');
    expect(within(toggle).getByTestId('side-puts')).toHaveClass('active');
    expect(screen.queryByTestId('side-all')).toBeNull();
  });

  it('puts CALLS/PUTS toggle and expiry selector on the same toolbar row (toggle left, expiry right)', async () => {
    vi.spyOn(optionsClient, 'getOptionChain').mockResolvedValue(chain);
    render(<MarketDataCard symbol="AAPL" />);
    fireEvent.click(screen.getByTestId('market-tab-options'));
    await waitFor(() => expect(screen.getByTestId('options-chain-panes')).toBeInTheDocument());
    // [CALLS][PUTS] toggle is pinned to the FAR LEFT; the meta cluster
    // (spot · source · delay + Expiry) is grouped on the FAR RIGHT — both on
    // the same header row. DOM order proves left→right placement.
    const toolbar = screen.getByTestId('options-toolbar');
    expect(within(toolbar).getByTestId('options-side-toggle')).toBeInTheDocument();
    expect(within(screen.getByTestId('history-meta-cluster')).getByTestId('options-expiries')).toBeInTheDocument();
    const headKids = Array.from((screen.getByTestId('history-head') as HTMLElement).children).map((c) => (c as HTMLElement).dataset.testid);
    expect(headKids.indexOf('options-toolbar')).toBeLessThan(headKids.indexOf('history-meta-cluster'));
    // ATM strike row gets the active highlight class.
    expect(screen.getAllByTestId('ochain-row').some((r) => r.className.includes('ochain-atm'))).toBe(true);
  });

  it('CALLS + PUTS shows both call and put greeks columns', async () => {
    vi.spyOn(optionsClient, 'getOptionChain').mockResolvedValue(chain);
    render(<MarketDataCard symbol="AAPL" />);
    fireEvent.click(screen.getByTestId('market-tab-options'));
    await waitFor(() => expect(screen.getByTestId('options-chain-panes')).toBeInTheDocument());
    // In ALL mode, call delta (green) and put delta (red) both appear for strike 190.
    expect(screen.getByText('0.552')).toBeInTheDocument(); // call Δ
    expect(screen.getByText('-0.448')).toBeInTheDocument(); // put Δ
  });

  it('toggling CALLS off keeps PUTS on (at least one stays selected)', async () => {
    vi.spyOn(optionsClient, 'getOptionChain').mockResolvedValue(chain);
    render(<MarketDataCard symbol="AAPL" />);
    fireEvent.click(screen.getByTestId('market-tab-options'));
    await waitFor(() => expect(screen.getByTestId('options-chain-panes')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('side-calls'));
    expect(screen.getByTestId('side-calls')).not.toHaveClass('active');
    expect(screen.getByTestId('side-puts')).toHaveClass('active');
    // CALLS pane gone, PUTS pane + centered strike remain.
    expect(screen.queryByTestId('ochain-pane-C')).toBeNull();
    expect(screen.getByTestId('ochain-pane-P')).toBeInTheDocument();
    expect(screen.getByTestId('ochain-center')).toBeInTheDocument();
    // The CALLS side wrapper is fully hidden so PUTS takes the full width.
    const callSide = screen.getByTestId('options-chain-panes').querySelector('.ochain-side-call')!;
    expect(callSide).toHaveClass('ochain-side-hidden');
    // And the PUTS side wrapper is NOT hidden (full width, not half).
    const putSide = screen.getByTestId('options-chain-panes').querySelector('.ochain-side-put')!;
    expect(putSide).not.toHaveClass('ochain-side-hidden');
  });

  it('toggling PUTS off keeps CALLS on (at least one stays selected)', async () => {
    vi.spyOn(optionsClient, 'getOptionChain').mockResolvedValue(chain);
    render(<MarketDataCard symbol="AAPL" />);
    fireEvent.click(screen.getByTestId('market-tab-options'));
    await waitFor(() => expect(screen.getByTestId('options-chain-panes')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('side-puts'));
    expect(screen.getByTestId('side-puts')).not.toHaveClass('active');
    expect(screen.getByTestId('side-calls')).toHaveClass('active');
    expect(screen.queryByTestId('ochain-pane-P')).toBeNull();
    expect(screen.getByTestId('ochain-pane-C')).toBeInTheDocument();
    // The PUTS side wrapper is fully hidden so CALLS takes the full width.
    const putSide = screen.getByTestId('options-chain-panes').querySelector('.ochain-side-put')!;
    expect(putSide).toHaveClass('ochain-side-hidden');
    // And the CALLS side wrapper is NOT hidden (full width, not half).
    const callSide = screen.getByTestId('options-chain-panes').querySelector('.ochain-side-call')!;
    expect(callSide).not.toHaveClass('ochain-side-hidden');
  });

  it('toggling a side back on restores both panes', async () => {
    vi.spyOn(optionsClient, 'getOptionChain').mockResolvedValue(chain);
    render(<MarketDataCard symbol="AAPL" />);
    fireEvent.click(screen.getByTestId('market-tab-options'));
    await waitFor(() => expect(screen.getByTestId('options-chain-panes')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('side-calls')); // now puts-only
    fireEvent.click(screen.getByTestId('side-calls')); // back on -> both
    expect(screen.getByTestId('side-calls')).toHaveClass('active');
    expect(screen.getByTestId('side-puts')).toHaveClass('active');
    expect(screen.getByTestId('ochain-pane-C')).toBeInTheDocument();
    expect(screen.getByTestId('ochain-pane-P')).toBeInTheDocument();
  });

  it('tints ITM vs OTM rows (spot 190.5: call 190 ITM, call 195 OTM; put 190 OTM, put 195 ITM)', async () => {
    vi.spyOn(optionsClient, 'getOptionChain').mockResolvedValue(chain);
    render(<MarketDataCard symbol="AAPL" />);
    fireEvent.click(screen.getByTestId('market-tab-options'));
    await waitFor(() => expect(screen.getByTestId('options-chain-panes')).toBeInTheDocument());
    // 4 call rows + 4 put rows across the two panes; ITM/OTM classes applied.
    const callRows = within(screen.getByTestId('ochain-pane-C')).getAllByTestId('ochain-row');
    const putRows = within(screen.getByTestId('ochain-pane-P')).getAllByTestId('ochain-row');
    // Strike 190 is ITM for calls, OTM for puts; strike 195 the opposite.
    const callItmCount = callRows.filter((r) => r.className.includes('ochain-itm')).length;
    const callOtmCount = callRows.filter((r) => r.className.includes('ochain-otm')).length;
    const putItmCount = putRows.filter((r) => r.className.includes('ochain-itm')).length;
    const putOtmCount = putRows.filter((r) => r.className.includes('ochain-otm')).length;
    expect(callItmCount).toBe(1); // strike 190
    expect(callOtmCount).toBe(1); // strike 195
    expect(putItmCount).toBe(1); // strike 195
    expect(putOtmCount).toBe(1); // strike 190
  });

  it('shows a VISIBLE warning (not just a tooltip) when a key is set but the live options call failed (e.g. 401 entitlement)', async () => {
    // Semantic-honesty: a configured key + a Massive 401 must not be presented
    // as a silent "simulated · no live feed" mock. The backend now returns a
    // `note` naming the failure, and the UI must surface it visibly.
    const failedMock: OptionChainResult = {
      ...chain,
      source: 'mock',
      note: 'MOCK — a Massive/Polygon key was configured but the live option-chain call failed (live call returned HTTP 401). See backend [options] logs.',
    };
    vi.spyOn(optionsClient, 'getOptionChain').mockResolvedValue(failedMock);
    render(<MarketDataCard symbol="NVDA" />);
    fireEvent.click(screen.getByTestId('market-tab-options'));
    const warn = await screen.findByTestId('options-live-failed');
    expect(warn).toBeInTheDocument();
    expect(warn.textContent).toContain('HTTP 401');
    // The headline badge can still read MOCK (no live chain), but it must NOT
    // claim "no live feed" as if no key were configured.
    expect(screen.getByTestId('options-source').textContent).toBe('MOCK');
  });

  it('does NOT show the live-failed warning for a plain no-key mock (silent seed)', async () => {
    const plainMock: OptionChainResult = {
      ...chain,
      source: 'mock',
      note: 'Live option chain unavailable — showing deterministic mock chain.',
    } as OptionChainResult;
    vi.spyOn(optionsClient, 'getOptionChain').mockResolvedValue(plainMock);
    render(<MarketDataCard symbol="AAPL" />);
    fireEvent.click(screen.getByTestId('market-tab-options'));
    await waitFor(() => expect(screen.getByTestId('options-chain-panes')).toBeInTheDocument());
    expect(screen.queryByTestId('options-live-failed')).toBeNull();
  });

  it('renders the CBOE delayed badge + real-bid/ask note when source is cboe', async () => {
    // The "real bid/ask another way" path: a key may be set + Massive
    // entitlement-blocked, but CBOE's free feed returns REAL delayed data.
    // The badge must read DELAYED (real), not MOCK.
    const cboeChain: OptionChainResult = {
      ...chain,
      source: 'cboe',
      note: 'Delayed ~15-20 min — free CBOE delayed options feed (real bid/ask/IV).',
      underlying_price: 207.4,
    };
    vi.spyOn(optionsClient, 'getOptionChain').mockResolvedValue(cboeChain);
    render(<MarketDataCard symbol="NVDA" />);
    fireEvent.click(screen.getByTestId('market-tab-options'));
    await waitFor(() => expect(screen.getByTestId('options-chain-panes')).toBeInTheDocument());
    expect(screen.getByTestId('options-source').textContent).toBe('DELAYED');
    expect(screen.getByTestId('options-delay').textContent).toContain('CBOE (real bid/ask)');
    // No misleading "no live feed" warning on a real delayed source.
    expect(screen.queryByTestId('options-live-failed')).toBeNull();
  });

  it('highlights the active (ATM, nearest-to-spot) row across both panes + center strike', async () => {
    vi.spyOn(optionsClient, 'getOptionChain').mockResolvedValue(chain);
    render(<MarketDataCard symbol="AAPL" />);
    fireEvent.click(screen.getByTestId('market-tab-options'));
    await waitFor(() => expect(screen.getByTestId('options-chain-panes')).toBeInTheDocument());
    const callRows = within(screen.getByTestId('ochain-pane-C')).getAllByTestId('ochain-row');
    const putRows = within(screen.getByTestId('ochain-pane-P')).getAllByTestId('ochain-row');
    // Spot 190.5 → strike 190 is the active (ATM) line. Each pane has 2 rows;
    // exactly one row per pane must carry the highlighted `ochain-atm` class.
    expect(callRows.filter((r) => r.className.includes('ochain-atm')).length).toBe(1);
    expect(putRows.filter((r) => r.className.includes('ochain-atm')).length).toBe(1);
    // The center strike column must also highlight the active strike (190).
    const strikeCells = within(screen.getByTestId('ochain-strike-col')).getAllByTestId('ochain-strike');
    expect(strikeCells.some((c) => c.className.includes('ochain-atm-strike'))).toBe(true);
  });

  it('CALLS-only mode still shows the PUTS header (red) and centered strike', async () => {
    vi.spyOn(optionsClient, 'getOptionChain').mockResolvedValue(chain);
    render(<MarketDataCard symbol="AAPL" />);
    fireEvent.click(screen.getByTestId('market-tab-options'));
    await waitFor(() => expect(screen.getByTestId('options-chain-panes')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('side-calls'));
    expect(screen.queryByTestId('ochain-pane-C')).toBeNull();
    expect(screen.getByTestId('ochain-pane-P')).toBeInTheDocument();
    expect(screen.getByTestId('ochain-center')).toBeInTheDocument();
    // The PUTS header element is present (even though its data pane is hidden).
    expect(screen.getByTestId('head-puts')).toBeInTheDocument();
  });

  it('mirrors the CALLS columns to the PUTS (greeks nearest the center)', async () => {
    vi.spyOn(optionsClient, 'getOptionChain').mockResolvedValue(chain);
    render(<MarketDataCard symbol="AAPL" />);
    fireEvent.click(screen.getByTestId('market-tab-options'));
    await waitFor(() => expect(screen.getByTestId('options-chain-panes')).toBeInTheDocument());
    // Greek column labels live in the STICKY <thead> inside each scrolling pane;
    // read the header cells (columnheader role) from each table.
    const callHead = within(screen.getByTestId('options-chain-C')).getAllByRole('columnheader');
    const putHead = within(screen.getByTestId('options-chain-P')).getAllByRole('columnheader');
    // PUTS read left→right: greeks first, then IV/Bid/Ask.
    expect(putHead[0]).toHaveTextContent('Δlt');
    expect(putHead[putHead.length - 1]).toHaveTextContent('Ask');
    // CALLS are the mirror: Ask/Bid/IV first, greeks last (nearest the center strike).
    expect(callHead[0]).toHaveTextContent('Ask');
    expect(callHead[callHead.length - 1]).toHaveTextContent('Δlt');
    // Both headers carry the full-name tooltip (readable greek names on hover).
    expect(putHead[0]).toHaveAttribute('title', expect.stringContaining('Delta'));
  });

  it('PUTS-only mode still shows the CALLS header (green) and centered strike', async () => {
    vi.spyOn(optionsClient, 'getOptionChain').mockResolvedValue(chain);
    render(<MarketDataCard symbol="AAPL" />);
    fireEvent.click(screen.getByTestId('market-tab-options'));
    await waitFor(() => expect(screen.getByTestId('options-chain-panes')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('side-puts'));
    expect(screen.queryByTestId('ochain-pane-P')).toBeNull();
    expect(screen.getByTestId('ochain-pane-C')).toBeInTheDocument();
    expect(screen.getByTestId('ochain-center')).toBeInTheDocument();
    expect(screen.getByTestId('head-calls')).toBeInTheDocument();
  });


  it('shows an error on the Chart tab when history fails', async () => {
    vi.spyOn(historyClient, 'getPriceHistory').mockRejectedValue(new Error('HTTP 500'));
    render(<MarketDataCard symbol="AAPL" />);
    await waitFor(() => expect(screen.getByTestId('chart-error')).toBeInTheDocument());
    expect(screen.getByText(/HTTP 500/)).toBeInTheDocument();
  });

  it('renders the new 1W / 4H / 1H interval buttons alongside the originals', () => {
    render(<MarketDataCard symbol="AAPL" />);
    for (const id of ['1d', '5m', '1m', '1wk', '4h', '1h']) {
      expect(screen.getByTestId(`interval-${id}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId('interval-1wk')).toHaveTextContent('1W');
    expect(screen.getByTestId('interval-4h')).toHaveTextContent('4H');
    expect(screen.getByTestId('interval-1h')).toHaveTextContent('1H');
  });

  it('1W requests the Yahoo-native 1wk interval with a long lookback', async () => {
    render(<MarketDataCard symbol="AAPL" />);
    await waitFor(() => expect(screen.getByTestId('price-chart')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('interval-1wk'));
    expect(screen.getByTestId('interval-1wk')).toHaveClass('active');
    expect(historyClient.getPriceHistory).toHaveBeenLastCalledWith('AAPL', { interval: '1wk', lookbackDays: 730 });
  });

  it('1H requests the 1h interval', async () => {
    render(<MarketDataCard symbol="AAPL" />);
    await waitFor(() => expect(screen.getByTestId('price-chart')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('interval-1h'));
    expect(historyClient.getPriceHistory).toHaveBeenLastCalledWith('AAPL', { interval: '1h', lookbackDays: 30 });
  });

  it('4H fetches 1h bars (Yahoo has no 4h) so they can be resampled client-side', async () => {
    render(<MarketDataCard symbol="AAPL" />);
    await waitFor(() => expect(screen.getByTestId('price-chart')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('interval-4h'));
    expect(screen.getByTestId('interval-4h')).toHaveClass('active');
    // The 4H button maps to a 1h fetch (resampling happens before charting).
    expect(historyClient.getPriceHistory).toHaveBeenLastCalledWith('AAPL', { interval: '1h', lookbackDays: 30 });
  });

  it('interval buttons render in the requested order: 1W 1D 4H 1H 5M 1M', () => {
    render(<MarketDataCard symbol="AAPL" />);
    const order = within(screen.getByTestId('market-interval'))
      .getAllByRole('button')
      .map((b) => b.getAttribute('data-testid'));
    expect(order).toEqual(['interval-1wk', 'interval-1d', 'interval-4h', 'interval-1h', 'interval-5m', 'interval-1m']);
  });

  it('long-term agency defaults to 1D', async () => {
    render(<MarketDataCard symbol="AAPL" agencyId="long-term" />);
    await waitFor(() => expect(screen.getByTestId('price-chart')).toBeInTheDocument());
    expect(screen.getByTestId('interval-1d')).toHaveClass('active');
    expect(historyClient.getPriceHistory).toHaveBeenLastCalledWith('AAPL', { interval: '1d', lookbackDays: 400 });
  });

  it('intraday agency defaults to 5M', async () => {
    render(<MarketDataCard symbol="AAPL" agencyId="intraday" />);
    await waitFor(() => expect(screen.getByTestId('price-chart')).toBeInTheDocument());
    expect(screen.getByTestId('interval-5m')).toHaveClass('active');
    expect(historyClient.getPriceHistory).toHaveBeenLastCalledWith('AAPL', { interval: '5m', lookbackDays: 5 });
  });

  it('plots the technical analyst support/resistance levels from the `technical` prop', async () => {
    render(
      <MarketDataCard
        symbol="AAPL"
        technical={{ support_resistance: { support_levels: [150], resistance_levels: [200] } }}
      />,
    );
    await waitFor(() => expect(screen.getAllByTestId('sr-support').length).toBeGreaterThan(0));
    expect(screen.getAllByTestId('sr-resistance').length).toBeGreaterThan(0);
    expect(screen.getByText(/S 150/)).toBeInTheDocument();
    expect(screen.getByText(/R 200/)).toBeInTheDocument();
  });

  it('exposes a studies toggle (SMA/EMA/BB/VWAP/RSI) and starts with SMA+BB on', async () => {
    render(<MarketDataCard symbol="AAPL" />);
    await waitFor(() => expect(screen.getByTestId('chart-studies')).toBeInTheDocument());
    const row = screen.getByTestId('chart-studies');
    for (const s of ['sma', 'ema', 'bb', 'vwap', 'rsi']) {
      expect(within(row).getByTestId(`study-${s}`)).toBeInTheDocument();
    }
    expect(within(row).getByTestId('study-sma')).toHaveClass('active');
    expect(within(row).getByTestId('study-bb')).toHaveClass('active');
  });

  it('toggles a study on/off and reflects it in the chart overlays', async () => {
    render(<MarketDataCard symbol="AAPL" />);
    await waitFor(() => expect(screen.getByTestId('price-chart')).toBeInTheDocument());
    const emaBtn = screen.getByTestId('study-ema');
    expect(emaBtn).not.toHaveClass('active');
    fireEvent.click(emaBtn);
    expect(emaBtn).toHaveClass('active');
    expect(screen.getByTestId('indicator-ema12')).toBeInTheDocument();
  });

  it('places the interval + study buttons in ONE wrapping toolbar row', async () => {
    render(<MarketDataCard symbol="AAPL" />);
    await waitFor(() => expect(screen.getByTestId('chart-studies')).toBeInTheDocument());
    // Both groups live inside a single .chart-toolbar so they share one row
    // at wide widths (e.g. 1200px) instead of stacking into two rows.
    const toolbar = screen.getByTestId('market-interval').closest('.chart-toolbar');
    expect(toolbar).not.toBeNull();
    expect(toolbar).toContainElement(screen.getByTestId('chart-studies'));
    // All 6 interval + 5 study buttons are present (no group dropped).
    for (const id of ['1wk', '1d', '4h', '1h', '5m', '1m']) {
      expect(screen.getByTestId(`interval-${id}`)).toBeInTheDocument();
    }
    for (const s of ['sma', 'ema', 'bb', 'vwap', 'rsi']) {
      expect(within(toolbar as HTMLElement).getByTestId(`study-${s}`)).toBeInTheDocument();
    }
  });

  it('renders the News tab with real headlines + aggregate sentiment', async () => {
    const news = {
      ticker: 'AAPL',
      headlines: [
        { title: 'AAPL beats earnings estimates', url: 'http://x/1', source: 'Bloomberg', timestamp: '2026-07-01T00:00:00Z', sentiment: 'POSITIVE', score: 25 },
        { title: 'AAPL downgraded on weak demand', url: 'http://x/2', source: 'Reuters', timestamp: '2026-07-02T00:00:00Z', sentiment: 'NEGATIVE', score: -22 },
      ],
      sentiment_score: 1,
      sentiment_label: 'NEUTRAL',
      source: 'finnhub',
    };
    vi.spyOn(newsClient, 'getNews').mockResolvedValue(news as any);
    render(<MarketDataCard symbol="AAPL" />);
    fireEvent.click(screen.getByTestId('market-tab-news'));
    await waitFor(() => expect(screen.getByTestId('news-list')).toBeInTheDocument());
    expect(screen.getByTestId('news-aggregate')).toHaveTextContent('NEUTRAL');
    expect(screen.getAllByTestId('news-item').length).toBe(2);
    // headline sentiment chips render
    expect(screen.getAllByText('POSITIVE').length).toBeGreaterThan(0);
  });

  it('renders an article snippet; live headlines link to the real story, seeded ones are plain text', async () => {
    // Live (Finnhub) mode: real article URLs are honored.
    const liveNews = {
      ticker: 'AAPL',
      headlines: [
        { title: 'AAPL beats earnings', url: 'https://real-news.example/aap1', source: 'Bloomberg', timestamp: '2026-07-01T00:00:00Z', sentiment: 'POSITIVE', score: 25, summary: 'Apple reported results ahead of estimates and lifted guidance.' },
        { title: 'AAPL downgraded', url: '', source: 'Reuters', timestamp: '2026-07-02T00:00:00Z', sentiment: 'NEGATIVE', score: -22, summary: 'Several desks cut ratings on softer demand.' },
      ],
      sentiment_score: 1,
      sentiment_label: 'NEUTRAL',
      source: 'finnhub',
    };
    vi.spyOn(newsClient, 'getNews').mockResolvedValue(liveNews as any);
    const { unmount } = render(<MarketDataCard symbol="AAPL" />);
    fireEvent.click(screen.getByTestId('market-tab-news'));
    await waitFor(() => expect(screen.getByTestId('news-list')).toBeInTheDocument());
    expect(screen.getByText('Apple reported results ahead of estimates and lifted guidance.')).toBeInTheDocument();
    const links = screen.getAllByRole('link');
    expect(links[0]).toHaveAttribute('href', 'https://real-news.example/aap1');
    // empty live url falls back to a news search (still a real, non-decoy link)
    expect(links[1]).toHaveAttribute('href', expect.stringContaining('https://news.google.com/search'));
    links.forEach((l) => expect(l.getAttribute('href')).not.toContain('example.com/news'));
    unmount();

    // Seeded/mock mode: synthetic headlines render as plain text, NOT links.
    const mockNews = {
      ticker: 'AAPL',
      headlines: [
        { title: 'AAPL beats earnings estimates, raises full-year guidance', url: 'https://news.google.com/search?q=x', source: 'Bloomberg', timestamp: '2026-07-01T00:00:00Z', sentiment: 'POSITIVE', score: 25, summary: 'AAPL reported quarterly results ahead of consensus.' },
      ],
      sentiment_score: 50,
      sentiment_label: 'POSITIVE',
      source: 'mock',
      note: 'FINNHUB_KEY not set; using seeded headlines (parity)',
    };
    vi.spyOn(newsClient, 'getNews').mockResolvedValue(mockNews as any);
    render(<MarketDataCard symbol="AAPL" />);
    fireEvent.click(screen.getByTestId('market-tab-news'));
    await waitFor(() => expect(screen.getByTestId('news-list')).toBeInTheDocument());
    expect(screen.getByText('AAPL reported quarterly results ahead of consensus.')).toBeInTheDocument();
    // seeded headlines are NOT rendered as links
    expect(screen.queryAllByRole('link').length).toBe(0);
    expect(screen.getByText('AAPL beats earnings estimates, raises full-year guidance')).toBeInTheDocument();
  });

  it('shows the Sentiment Analyst read inside the News tab when `sentiment` prop is present', async () => {
    const news = {
      ticker: 'AAPL',
      headlines: [{ title: 'AAPL beats', url: 'http://x/1', source: 'Bloomberg', timestamp: '2026-07-01T00:00:00Z', sentiment: 'POSITIVE', score: 25 }],
      sentiment_score: 40,
      sentiment_label: 'POSITIVE',
      source: 'finnhub',
    };
    vi.spyOn(newsClient, 'getNews').mockResolvedValue(news as any);
    const sentiment = {
      news_sentiment: 'POSITIVE',
      social_sentiment: 'NEUTRAL',
      analyst_sentiment: 'POSITIVE',
      institutional_sentiment: 'POSITIVE',
      sentiment_score: 42,
      data_source: 'finnhub:live-news',
    };
    render(<MarketDataCard symbol="AAPL" sentiment={sentiment} />);
    fireEvent.click(screen.getByTestId('market-tab-news'));
    await waitFor(() => expect(screen.getByTestId('analyst-sentiment')).toBeInTheDocument());
    expect(screen.getByText('Sentiment Analyst read')).toBeInTheDocument();
    expect(screen.getByText('finnhub:live-news')).toBeInTheDocument();
  });

  it('P2b-2: shows fused multi-source readout (both badges + low consensus + shares) when sentiment.consensus present', async () => {
    const news = {
      ticker: 'AAPL',
      headlines: [{ title: 'AAPL beats', url: 'http://x/1', source: 'Bloomberg', timestamp: '2026-07-01T00:00:00Z', sentiment: 'POSITIVE', score: 25 }],
      sentiment_score: 10,
      sentiment_label: 'NEUTRAL',
      source: 'mixed',
    };
    vi.spyOn(newsClient, 'getNews').mockResolvedValue(news as any);
    const sentiment = {
      news_sentiment: 'NEUTRAL',
      social_sentiment: 'NEUTRAL',
      analyst_sentiment: 'POSITIVE',
      institutional_sentiment: 'POSITIVE',
      sentiment_score: 10,
      data_source: 'mixed:finnhub+yahoo',
      consensus: {
        agreement: 0.3,
        low_consensus: true,
        contributors: ['finnhub', 'yahoo'],
        contributions: [
          { sourceId: 'finnhub', value: 40, weight: 1, confidence: 1, effectiveWeight: 1, contribution: 0.6 },
          { sourceId: 'yahoo', value: -20, weight: 1, confidence: 1, effectiveWeight: 1, contribution: 0.4 },
        ],
      },
    };
    render(<MarketDataCard symbol="AAPL" sentiment={sentiment} />);
    fireEvent.click(screen.getByTestId('market-tab-news'));
    await waitFor(() => expect(screen.getByTestId('fusion-consensus')).toBeInTheDocument());
    // Both source badges render.
    expect(screen.getByText('finnhub')).toBeInTheDocument();
    expect(screen.getByText('yahoo')).toBeInTheDocument();
    // Low consensus flag surfaces.
    expect(screen.getByTestId('fusion-low-consensus')).toBeInTheDocument();
    // Per-source contribution shares surface.
    expect(screen.getByText(/finnhub 60%/)).toBeInTheDocument();
    expect(screen.getByText(/yahoo 40%/)).toBeInTheDocument();
    // The legacy single-source string is NOT shown when consensus is present.
    expect(screen.queryByText('mixed:finnhub+yahoo')).not.toBeInTheDocument();
  });

});

describe('MarketDataCard — watch star (Phase 7)', () => {
  beforeEach(() => {
    // reset the shared store
    [...getWatchlist()].forEach((s: string) => removeWatch(s));
    vi.restoreAllMocks();
    vi.spyOn(quoteClient, 'getQuote').mockResolvedValue(quote);
  });

  it('shows an empty star for an unwatched symbol and toggles it on click', () => {
    render(<MarketDataCard symbol="AAPL" />);
    const star = screen.getByTestId('watch-star-AAPL') as HTMLButtonElement;
    expect(star.textContent).toBe('☆');
    expect(star.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(star);
    expect(star.textContent).toBe('★');
    expect(star.getAttribute('aria-pressed')).toBe('true');
    // persisted to the store
    expect(isWatched('AAPL')).toBe(true);
  });

  it('reflects an already-watched symbol via the controlled watched prop', () => {
    render(<MarketDataCard symbol="MSFT" watched onToggleWatch={() => {}} />);
    const star = screen.getByTestId('watch-star-MSFT') as HTMLButtonElement;
    expect(star.textContent).toBe('★');
    expect(star.getAttribute('aria-pressed')).toBe('true');
  });

  it('uses the controlled onToggleWatch when provided (does not touch the store)', () => {
    const onToggle = vi.fn();
    render(<MarketDataCard symbol="NVDA" onToggleWatch={onToggle} />);
    const star = screen.getByTestId('watch-star-NVDA') as HTMLButtonElement;
    fireEvent.click(star);
    expect(onToggle).toHaveBeenCalledWith('NVDA');
    expect(isWatched('NVDA')).toBe(false); // store untouched
  });
});

// frontend/src/test/AnalysisView.test.tsx
// Locks the Phase-4.5 UX contract:
//  1. The agency <select> is rendered ABOVE the ticker input (first decision).
//  2. The analyst wall is visible on first render WITHOUT requiring a ticker —
//     it reflects the currently-selected agency's cards immediately.
//  3. Switching the agency dropdown changes the wall's panel set (7 for
//     long-term, 4 for crypto-screener) before any analysis runs.
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { AnalysisView } from '../components/AnalysisView';
import type { Socket } from 'socket.io-client';
import { AGENCIES } from '../components/analysts/agencies';
import { postReport } from '../api/reportClient';
// ResultsPanel's Save button calls postReport (a real network request). Mock
// it to resolve so the "saved → no prompt" path is exercisable in jsdom.
vi.mock('../api/reportClient', () => ({
  postReport: vi.fn().mockResolvedValue({ ok: true, files: { pdf: 'x.pdf', md: 'x.md', html: 'x.html', json: 'x.json' } }),
  reportViewUrl: vi.fn(() => '#'),
  fetchReportRawData: vi.fn(),
  listReports: vi.fn(),
}));

// getQuote drives the no-run preview validation. Controlled per-test via the
// exported handle so we can simulate a found ticker vs a not-found one.
const getQuoteMock = vi.fn(async (s: string) => {
  if (s === 'NOTREAL') throw new Error('not found');
  return { symbol: s, name: `${s} Inc`, price: 100, note: undefined };
});
vi.mock('../api/quoteClient', () => ({ getQuote: (...a: any[]) => getQuoteMock(...a) }));

// Screener's "Run" calls getScreener. Mock a single promising ticker so the
// "→ Add" button is rendered and exercisable.
vi.mock('../api/screenerClient', () => ({
  getScreener: vi.fn(async () => ({
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
        verdict: 'STRONG',
        topAxis: 'technical',
      },
    ],
    universeSize: 1,
    screenedAt: new Date().toISOString(),
    elapsedMs: 12,
  })),
}));

// Watchlist "Add" validates via the server (validateSymbolsClient). Mock it to
// resolve instantly as "all valid" so the chip renders without a real network
// round-trip (mirrors quoteClient/screenerClient mocks above).
vi.mock('../api/symbolClient', () => ({
  validateSymbolsClient: vi.fn(async () => ({ results: [], valid: [], invalid: [] })),
}));

function fakeSocket(): Socket {
  return {
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
    connected: true,
  } as unknown as Socket;
}

function panels() {
  return document.querySelectorAll('.analyst-panel');
}

describe('AnalysisView — agency-first UX', () => {
  // crypto-screener is hidden by default (no real crypto sources yet). This
  // block exercises the 4-node wall path (a hook that must stay intact), so
  // reveal it for the duration of the block.
  const prevHidden = AGENCIES['crypto-screener']?.hidden;
  beforeAll(() => { AGENCIES['crypto-screener'].hidden = false; });
  afterAll(() => { if (prevHidden === undefined) delete AGENCIES['crypto-screener'].hidden; else AGENCIES['crypto-screener'].hidden = prevHidden; });

  it('renders the agency selector above the ticker input (first analysis control)', () => {
    const { container } = render(<AnalysisView socket={fakeSocket()} connected={true} />);
    const agency = screen.getByLabelText(/Select analysis agency/i);
    const ticker = screen.getByLabelText('Ticker symbols');
    // DOM order: agency appears before the ticker input (the watchlist bar may
    // sit above both as the persistent portfolio home, but the agency is still
    // the first *analysis* control, chosen before any ticker).
    expect(agency.compareDocumentPosition(ticker)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(container.querySelector('.agency-select')).not.toBeNull();
  });

  it('shows the default agency wall on first render (no ticker entered)', () => {
    render(<AnalysisView socket={fakeSocket()} connected={true} />);
    // Long-term default => 9 equity analyst panels (incl. bull/bear debate + governance).
    expect(panels().length).toBe(9);
    expect(screen.getByText('Orchestrator')).toBeInTheDocument();
    expect(screen.getByText('Governance')).toBeInTheDocument();
    expect(screen.queryByText('On-Chain Flow')).toBeNull();
  });

  it('switches the wall to the 4-node crypto-screener on dropdown change', () => {
    render(<AnalysisView socket={fakeSocket()} connected={true} />);
    const agency = screen.getByLabelText(/Select analysis agency/i) as HTMLSelectElement;
    fireEvent.change(agency, { target: { value: 'crypto-screener' } });
    // Before any analysis runs, the wall now shows only the 4 crypto panels.
    expect(panels().length).toBe(4);
    expect(screen.getByText('On-Chain Flow')).toBeInTheDocument();
    expect(screen.queryByText('Orchestrator')).toBeNull();
    expect(screen.queryByText('Fundamental')).toBeNull();
  });
});

// --- Agency-switch guard (unsaved results) ---
// A fake socket that records handlers so tests can fire server events.
function recordingSocket() {
  const handlers: Record<string, (p: any) => void> = {};
  return {
    on: (ev: string, fn: (p: any) => void) => { handlers[ev] = fn; },
    off: vi.fn(),
    emit: vi.fn(),
    connected: true,
    _fire: (ev: string, payload: any) => handlers[ev]?.(payload),
  };
}

const COMPLETE = {
  decision: 'APPROVE',
  confidence: 0.8,
  reasoning: 'ok',
  preservation_rationale: '',
  conditions: [],
  risk_assessment: { score: 0.2, summary: 'low' },
  company_name: 'ACME Corp',
  tickers: ['ACME'],
  analystTraces: [],
};

describe('AnalysisView — agency-switch unsaved-results guard', () => {
  // crypto-screener is hidden by default (no real crypto sources yet). These
  // tests exercise the 4-node wall + switch-guard paths (hooks that must stay
  // intact), so reveal it for the duration of this block.
  const prevHidden = AGENCIES['crypto-screener']?.hidden;
  beforeAll(() => { AGENCIES['crypto-screener'].hidden = false; });
  afterAll(() => { if (prevHidden === undefined) delete AGENCIES['crypto-screener'].hidden; else AGENCIES['crypto-screener'].hidden = prevHidden; });

  it('no prompt when there is no completed result (clean slate switch)', () => {
    render(<AnalysisView socket={recordingSocket() as any} connected={true} />);
    const agency = screen.getByLabelText(/Select analysis agency/i) as HTMLSelectElement;
    fireEvent.change(agency, { target: { value: 'crypto-screener' } });
    expect(screen.queryByTestId('agency-switch-confirm')).toBeNull();
  });

  it('prompts when switching away from an unsaved completed run', () => {
    const socket = recordingSocket();
    render(<AnalysisView socket={socket as any} connected={true} />);
    // Simulate a completed analysis.
    act(() => { socket._fire('analysis_complete', COMPLETE); });
    const agency = screen.getByLabelText(/Select analysis agency/i) as HTMLSelectElement;
    fireEvent.change(agency, { target: { value: 'crypto-screener' } });
    expect(screen.getByTestId('agency-switch-confirm')).toBeInTheDocument();
  });

  it('"Keep current" dismisses the prompt and keeps the result on screen', () => {
    const socket = recordingSocket();
    render(<AnalysisView socket={socket as any} connected={true} />);
    act(() => { socket._fire('analysis_complete', COMPLETE); });
    const agency = screen.getByLabelText(/Select analysis agency/i) as HTMLSelectElement;
    fireEvent.change(agency, { target: { value: 'crypto-screener' } });
    fireEvent.click(screen.getByTestId('agency-switch-confirm-no'));
    expect(screen.queryByTestId('agency-switch-confirm')).toBeNull();
    // Result still displayed (ResultsPanel with the Save button is present).
    expect(screen.getByTestId('export-report')).toBeInTheDocument();
  });

  it('"Switch & clear" wipes the displayed result and switches agency', () => {
    const socket = recordingSocket();
    render(<AnalysisView socket={socket as any} connected={true} />);
    act(() => { socket._fire('analysis_complete', COMPLETE); });
    const agency = screen.getByLabelText(/Select analysis agency/i) as HTMLSelectElement;
    fireEvent.change(agency, { target: { value: 'crypto-screener' } });
    fireEvent.click(screen.getByTestId('agency-switch-confirm-yes'));
    // Prompt gone and result cleared (ResultsPanel unmounts -> no Save button).
    expect(screen.queryByTestId('agency-switch-confirm')).toBeNull();
    expect(screen.queryByTestId('export-report')).toBeNull();
    // Wall now reflects the crypto agency (4 panels).
    expect(document.querySelectorAll('.analyst-panel').length).toBe(4);
  });

  it('no prompt after the result has been saved', async () => {
    const socket = recordingSocket();
    render(<AnalysisView socket={socket as any} connected={true} />);
    act(() => { socket._fire('analysis_complete', COMPLETE); });
    // Save the result (postReport is mocked to resolve).
    fireEvent.click(screen.getByTestId('export-report'));
    // Wait for the saved flag to flip, then switch agency.
    await waitFor(() => {
      const agency = screen.getByLabelText(/Select analysis agency/i) as HTMLSelectElement;
      fireEvent.change(agency, { target: { value: 'crypto-screener' } });
      expect(screen.queryByTestId('agency-switch-confirm')).toBeNull();
    });
  });

  it('restores the Save button for a NEW run after the previous one was saved', async () => {
    // Regression: ResultsPanel holds `reportFiles` in LOCAL state. Once run #1
    // is saved, that state persisted into the next run and the button never came
    // back. runId-bumped `key` now remounts the panel per run, clearing it.
    const socket = recordingSocket();
    render(<AnalysisView socket={socket as any} connected={true} />);

    // Run #1 completes and is saved.
    act(() => { socket._fire('analysis_complete', COMPLETE); });
    fireEvent.click(screen.getByTestId('export-report'));
    await waitFor(() => expect(screen.getByTestId('report-links')).toHaveTextContent(/Saved/));

    // Run #2 starts (analysis_start bumps runId) and completes.
    act(() => { socket._fire('analysis_start', { tickers: ['ACME'] }); });
    act(() => { socket._fire('analysis_complete', COMPLETE); });

    // The Save button MUST be back — a fresh panel, not the stale saved state.
    expect(screen.getByTestId('export-report')).toBeInTheDocument();
    expect(screen.queryByTestId('report-links')).toBeNull();
  });

  it('saves a Medium-term report under MEDIUM-term (not long-term)', async () => {
    // Regression: the selected agency never reached postReport, so every saved
    // report was filed under the backend default "long-term" — even Medium-term
    // runs. Selecting Medium + saving must tag the report with medium-term.
    const postSpy = vi.mocked(postReport);
    postSpy.mockClear();
    const socket = recordingSocket();
    render(<AnalysisView socket={socket as any} connected={true} />);

    // Switch the agency dropdown to Medium term.
    const agency = screen.getByLabelText(/Select analysis agency/i) as HTMLSelectElement;
    fireEvent.change(agency, { target: { value: 'medium-term' } });

    // Complete a run and save it.
    act(() => { socket._fire('analysis_complete', COMPLETE); });
    fireEvent.click(screen.getByTestId('export-report'));
    await waitFor(() => expect(postSpy).toHaveBeenCalled());

    // The report was tagged with the SELECTED agency, not the default.
    const meta = postSpy.mock.calls[0]?.[1] as { agencyId?: string } | undefined;
    expect(meta?.agencyId).toBe('medium-term');
  });
});

// --- Screener "→ Add" fills the Ticker symbols input (pill) and stays open (no auto-run) ---
describe('AnalysisView — screener "→ Add" adds to Ticker symbols, stays open', () => {
  it('places the ticker in the field as a pill, does NOT auto-run, and keeps the panel open', async () => {
    render(<AnalysisView socket={fakeSocket()} connected={true} />);
    const input = screen.getByLabelText('Ticker symbols') as HTMLInputElement;
    expect(input.value).toBe('');

    // Expand the screener and run it.
    fireEvent.click(screen.getByTestId('screener-toggle'));
    fireEvent.click(screen.getByTestId('screener-run'));

    // Results table appears.
    await waitFor(() => expect(screen.getByTestId('screener-table')).toBeTruthy());
    const addBtn = screen.getByTestId('screener-add-AAPL');

    // Click "→ Add" — should fill the input (as a pill) but must NOT start an
    // analysis run, and the panel must stay open so more tickers can be added.
    fireEvent.click(addBtn);

    // 1) Input is populated (as a pill).
    expect(screen.getByTestId('pill-AAPL')).toBeInTheDocument();
    // 2) The analysis run did NOT start.
    expect(screen.queryByText('Analyzing…')).toBeNull();
    // 3) The screener is still open (toggle + body aria-expanded="true").
    expect(screen.getByTestId('screener-toggle').getAttribute('aria-expanded')).toBe('true');
    const body = document.querySelector('.screener-body') as HTMLElement;
    expect(body.getAttribute('aria-expanded')).toBe('true');
  });

  it('adds the ticker to the input even when the socket is disconnected (regression)', async () => {
    // A socket whose emit throws (simulates the backend being down / on the
    // wrong port). The "→ Add" action must still land the ticker as a pill
    // regardless of socket state (it never emits — only adds to the input).
    const throwingSocket = {
      on: vi.fn(),
      off: vi.fn(),
      emit: vi.fn(() => { throw new Error('not connected'); }),
      connected: false,
    } as unknown as Socket;
    render(<AnalysisView socket={throwingSocket} connected={false} />);
    const input = screen.getByLabelText('Ticker symbols') as HTMLInputElement;
    expect(input.value).toBe('');

    fireEvent.click(screen.getByTestId('screener-toggle'));
    fireEvent.click(screen.getByTestId('screener-run'));
    await waitFor(() => expect(screen.getByTestId('screener-table')).toBeTruthy());

    fireEvent.click(screen.getByTestId('screener-add-AAPL'));

    // The ticker MUST land in the input (as a pill) regardless of the socket state.
    expect(screen.getByTestId('pill-AAPL')).toBeInTheDocument();
  });

  it('clicking a watchlist chip drops the ticker into the input box but does NOT auto-run', async () => {
    render(<AnalysisView socket={fakeSocket()} connected={true} />);
    const input = screen.getByLabelText('Ticker symbols') as HTMLInputElement;
    expect(input.value).toBe('');

    // Add a ticker to the watchlist, then click its chip.
    fireEvent.change(screen.getByTestId('watchlist-input'), { target: { value: 'TSLA' } });
    fireEvent.click(screen.getByTestId('watchlist-add-btn'));
    fireEvent.click(await screen.findByTestId('watchlist-open-TSLA'));

    // The chip click seeds the Ticker symbols field with the symbol (as a pill)...
    expect(screen.getByTestId('pill-TSLA')).toBeInTheDocument();
    // ...but it must NOT start an analysis. The user reviews/edits and then
    // clicks [Analyze] themselves. So "Analyzing…" must NOT appear.
    expect(screen.queryByText('Analyzing…')).toBeNull();
  });
});

// --- Phase 7.5: no-run chart preview ---
describe('AnalysisView — no-run chart preview', () => {
  beforeEach(() => {
    getQuoteMock.mockImplementation(async (s: string) => {
      if (s === 'NOTREAL') throw new Error('not found');
      return { symbol: s, name: `${s} Inc`, price: 100, note: undefined };
    });
  });

  it('clicking a Watchlist chip previews the chart WITHOUT starting the run', async () => {
    render(<AnalysisView socket={fakeSocket()} connected={true} />);
    const input = screen.getByLabelText('Ticker symbols') as HTMLInputElement;

    fireEvent.change(screen.getByTestId('watchlist-input'), { target: { value: 'NVDA' } });
    fireEvent.click(screen.getByTestId('watchlist-add-btn'));
    fireEvent.click(await screen.findByTestId('watchlist-open-NVDA'));

    // The chart card appears immediately...
    await waitFor(() => expect(screen.getByTestId('market-card-NVDA')).toBeTruthy());
    // ...the field is filled (as a pill)...
    expect(screen.getByTestId('pill-NVDA')).toBeInTheDocument();
    // ...but the agency run did NOT start (no "Analyzing…").
    expect(screen.queryByText('Analyzing…')).toBeNull();
  });

  it('leaving the Ticker symbols field previews the chart (onBlur)', async () => {
    render(<AnalysisView socket={fakeSocket()} connected={true} />);
    const input = screen.getByLabelText('Ticker symbols') as HTMLInputElement;

    fireEvent.change(input, { target: { value: 'AAPL' } });
    fireEvent.blur(input);

    await waitFor(() => expect(screen.getByTestId('market-card-AAPL')).toBeTruthy());
    expect(screen.queryByText('Analyzing…')).toBeNull();
  });

  it('a not-found ticker shows NOTHING (no card, no run)', async () => {
    render(<AnalysisView socket={fakeSocket()} connected={true} />);
    const input = screen.getByLabelText('Ticker symbols') as HTMLInputElement;

    fireEvent.change(input, { target: { value: 'NOTREAL' } });
    fireEvent.blur(input);

    // Resolve the async validation, then assert no card appeared.
    await waitFor(() => expect(getQuoteMock).toHaveBeenCalled());
    expect(screen.queryByTestId('market-card-NOTREAL')).toBeNull();
    expect(screen.queryByText('Analyzing…')).toBeNull();
  });

  it('[Analyze] starts the run (preview card is now run-owned)', async () => {
    render(<AnalysisView socket={fakeSocket()} connected={true} />);
    const input = screen.getByLabelText('Ticker symbols') as HTMLInputElement;

    // Preview first via blur (preview only — does NOT auto-add a pill).
    fireEvent.change(input, { target: { value: 'AAPL' } });
    fireEvent.blur(input);
    await waitFor(() => expect(screen.getByTestId('market-card-AAPL')).toBeTruthy());

    // Commit the ticker as a pill (explicit Enter), then run — the agency work starts.
    // addSymbol validates via the (mocked) server, so the pill is committed
    // asynchronously — wait for it before clicking Analyze.
    fireEvent.change(input, { target: { value: 'AAPL' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(screen.getByTestId('pill-AAPL')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Analyze'));
    // The run starts → the "Analyzing…" status <p> appears (the Analyze button
    // also flips to "Analyzing…", so scope the query to the status paragraph).
    expect(await screen.findByText(/Analyzing/, { selector: 'p.analyzing' })).toBeTruthy();
    // The card persists (now driven by the run's tickers, not the preview) — and
    // there is exactly ONE AAPL card, not a preview + run duplicate.
    expect(screen.getAllByTestId('market-card-AAPL').length).toBe(1);
  });
});

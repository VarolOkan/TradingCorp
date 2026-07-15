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

// ResultsPanel's Save button calls postReport (a real network request). Mock
// it to resolve so the "saved → no prompt" path is exercisable in jsdom.
vi.mock('../api/reportClient', () => ({
  postReport: vi.fn().mockResolvedValue({ ok: true, files: { pdf: 'x.pdf', md: 'x.md', html: 'x.html', json: 'x.json' } }),
  reportViewUrl: vi.fn(() => '#'),
  fetchReportRawData: vi.fn(),
  listReports: vi.fn(),
}));

// Screener's "Run" calls getScreener. Mock a single promising ticker so the
// "→ Analyze" button is rendered and exercisable.
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
    // Long-term default => 7 equity analyst panels (no On-Chain Flow).
    expect(panels().length).toBe(7);
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
});

// --- Screener "→ Analyze" fills input, runs, AND collapses the panel ---
describe('AnalysisView — screener "→ Analyze" fills input, runs, collapses', () => {
  it('places the ticker in the field, starts the run, and collapses the panel', async () => {
    render(<AnalysisView socket={fakeSocket()} connected={true} />);
    const input = screen.getByLabelText('Ticker symbols') as HTMLInputElement;
    expect(input.value).toBe('');

    // Expand the screener and run it.
    fireEvent.click(screen.getByTestId('screener-toggle'));
    fireEvent.click(screen.getByTestId('screener-run'));

    // Results table appears.
    await waitFor(() => expect(screen.getByTestId('screener-table')).toBeTruthy());
    const analyzeBtn = screen.getByTestId('screener-analyze-AAPL');

    // Click "→ Analyze" — should fill input, start run, AND collapse panel.
    fireEvent.click(analyzeBtn);

    // 1) Input is populated.
    expect(input.value).toBe('AAPL');
    // 2) The analysis run started.
    expect(screen.getByText('Analyzing…')).toBeTruthy();
    // 3) The screener is now collapsed: the toggle AND the body report
    //    aria-expanded="false" (the body stays mounted but is hidden/animated).
    expect(screen.getByTestId('screener-toggle').getAttribute('aria-expanded')).toBe('false');
    const body = document.querySelector('.screener-body') as HTMLElement;
    expect(body.getAttribute('aria-expanded')).toBe('false');
  });

  it('fills the ticker input even when the socket is disconnected (regression)', async () => {
    // A socket whose emit throws (simulates the backend being down / on the
    // wrong port). Before the fix this threw before setSymbolInput committed,
    // so the field stayed empty.
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

    fireEvent.click(screen.getByTestId('screener-analyze-AAPL'));

    // The ticker MUST land in the input regardless of the socket state.
    expect(input.value).toBe('AAPL');
  });

  it('clicking a watchlist chip drops the ticker into the input box but does NOT auto-run', async () => {
    render(<AnalysisView socket={fakeSocket()} connected={true} />);
    const input = screen.getByLabelText('Ticker symbols') as HTMLInputElement;
    expect(input.value).toBe('');

    // Add a ticker to the watchlist, then click its chip.
    fireEvent.change(screen.getByTestId('watchlist-input'), { target: { value: 'TSLA' } });
    fireEvent.click(screen.getByTestId('watchlist-add-btn'));
    fireEvent.click(screen.getByTestId('watchlist-open-TSLA'));

    // The chip click seeds the Ticker symbols field with the symbol...
    expect(input.value).toBe('TSLA');
    // ...but it must NOT start an analysis. The user reviews/edits and then
    // clicks [Analyze] themselves. So "Analyzing…" must NOT appear.
    expect(screen.queryByText('Analyzing…')).toBeNull();
  });
});

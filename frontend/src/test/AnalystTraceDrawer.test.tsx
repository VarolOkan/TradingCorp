// frontend/src/test/AnalystTraceDrawer.test.tsx
// Verify the drill-down drawer renders the four pillars (instructions, data,
// weighting, sources) from an AnalystTrace and supports switching analysts.

import { render, screen, fireEvent } from '@testing-library/react';
import { AnalystTraceDrawer } from '../components/analysts/AnalystTraceDrawer';
import type { AnalystTrace } from '../types';

function makeTrace(overrides: Partial<AnalystTrace> = {}): AnalystTrace {
  return {
    analyst: 'fundamental',
    name: 'Fundamental',
    stage: 2,
    instructions: 'You are the Fundamental Analyst. Score the balance sheet...',
    inputs: [
      {
        ticker: 'AAPL',
        label: 'Fundamental data ingested',
        data: { financial_health_score: 82, debt_to_equity: 1.2, current_ratio: 1.5 },
        sources: ['Yahoo Finance', 'Alpha Vantage', 'Finnhub (mock)'],
      },
    ],
    weighting: [
      {
        label: 'Leverage & liquidity discipline',
        inputs: ['debt_to_equity', 'current_ratio'],
        weight: 0.4,
        contribution: 40,
        rationale: 'High D/E is penalized.',
        scale: '0..100',
      },
    ],
    output: {
      verdict: 'BULLISH',
      score: 82,
      summary: 'Strong balance sheet; healthy margins.',
      details: {},
    },
    notes: ['Mock data.'],
    ...overrides,
  };
}

describe('AnalystTraceDrawer', () => {
  it('renders nothing when analystId is null', () => {
    const { container } = render(
      <AnalystTraceDrawer traces={[]} analystId={null} onClose={vi.fn()} onSelect={vi.fn()} />
    );
    expect(container.querySelector('.trace-drawer')).toBeNull();
  });

  it('renders the Instructions tab by default with the role prompt', () => {
    render(
      <AnalystTraceDrawer traces={[makeTrace()]} analystId={'fundamental'} onClose={vi.fn()} onSelect={vi.fn()} />
    );
    expect(screen.getByTestId('trace-drawer')).toBeInTheDocument();
    expect(screen.getByText(/You are the Fundamental Analyst/)).toBeInTheDocument();
    expect(screen.getByTestId('trace-tab-instructions').className).toContain('active');
  });

  it('shows per-ticker data fields on the Data Received tab', () => {
    render(
      <AnalystTraceDrawer traces={[makeTrace()]} analystId={'fundamental'} onClose={vi.fn()} onSelect={vi.fn()} />
    );
    fireEvent.click(screen.getByTestId('trace-tab-data'));
    expect(screen.getByTestId('field-AAPL-financial_health_score')).toBeInTheDocument();
    expect(screen.getByText('82')).toBeInTheDocument();
    // The per-ticker input label should be present on the Data tab.
    expect(screen.getByText('Fundamental data ingested')).toBeInTheDocument();
  });

  it('shows weighting steps and the derived output', () => {
    render(
      <AnalystTraceDrawer traces={[makeTrace()]} analystId={'fundamental'} onClose={vi.fn()} onSelect={vi.fn()} />
    );
    fireEvent.click(screen.getByTestId('trace-tab-weighting'));
    expect(screen.getByTestId('weight-step-0')).toContainHTML('40%');
    expect(screen.getByText(/High D\/E is penalized/)).toBeInTheDocument();
    const out = screen.getByTestId('trace-output');
    expect(out.textContent).toContain('BULLISH');
    expect(out.textContent).toContain('score 82');
  });

  it('renders the per-ticker breakdown from output.details', () => {
    // Regression: the actual per-ticker score/verdict/summary lived in
    // output.details.results but was NEVER rendered, so the Weighting -> Output
    // tab felt empty / unreadable. Now it shows a readable per-ticker grid.
    const trace = makeTrace({
      output: {
        verdict: 'BULLISH',
        score: 75,
        summary: 'Wide moat, clean balance sheet.',
        details: {
          results: {
            AAPL: { score: 82, verdict: 'BULLISH', summary: 'Strong margins.' },
            MSFT: { score: 68, verdict: 'NEUTRAL', summary: 'Fair value.' },
          },
        },
      },
    });
    render(<AnalystTraceDrawer traces={[trace]} analystId={'fundamental'} onClose={vi.fn()} onSelect={vi.fn()} />);
    fireEvent.click(screen.getByTestId('trace-tab-weighting'));
    expect(screen.getByTestId('trace-output-details')).toBeInTheDocument();
    expect(screen.getByText('Per-ticker breakdown')).toBeInTheDocument();
    // Both tickers surface with their verdict + score.
    const rows = screen.getAllByTestId('trace-output-details').length;
    expect(rows).toBe(1);
    expect(screen.getByText('AAPL')).toBeInTheDocument();
    expect(screen.getByText('MSFT')).toBeInTheDocument();
    expect(screen.getByText('Strong margins.')).toBeInTheDocument();
  });

  it('lists every analyzed source on the Sources tab', () => {
    render(
      <AnalystTraceDrawer traces={[makeTrace()]} analystId={'fundamental'} onClose={vi.fn()} onSelect={vi.fn()} />
    );
    fireEvent.click(screen.getByTestId('trace-tab-sources'));
    const sources = screen.getAllByTestId('trace-source');
    expect(sources.map((s) => s.textContent)).toEqual([
      'Yahoo Finance',
      'Alpha Vantage',
      'Finnhub (mock)',
    ]);
  });

  it('switches analyst via the in-drawer switcher', () => {
    const onSelect = vi.fn();
    const traces = [
      makeTrace(),
      makeTrace({ analyst: 'technical', name: 'Technical', instructions: 'You are the Technical Analyst.' }),
    ];
    render(<AnalystTraceDrawer traces={traces} analystId={'fundamental'} onClose={vi.fn()} onSelect={onSelect} />);
    fireEvent.click(screen.getByTestId('trace-switch-technical'));
    expect(onSelect).toHaveBeenCalledWith('technical');
  });

  it('expandable per-ticker rows + breadcrumb trace to a datum (Phase 3)', () => {
    render(
      <AnalystTraceDrawer traces={[makeTrace()]} analystId={'fundamental'} onClose={vi.fn()} onSelect={vi.fn()} />
    );
    // Data tab: first ticker expanded by default.
    fireEvent.click(screen.getByTestId('trace-tab-data'));
    expect(screen.getByTestId('field-AAPL-financial_health_score')).toBeInTheDocument();
    // Collapse the AAPL row.
    fireEvent.click(screen.getByTestId('input-toggle-AAPL'));
    expect(screen.queryByTestId('field-AAPL-financial_health_score')).toBeNull();
    // Expand again, then click the field to pin it (breadcrumb analyst>ticker>field).
    fireEvent.click(screen.getByTestId('input-toggle-AAPL'));
    fireEvent.click(screen.getByTestId('field-AAPL-current_ratio'));
    expect(screen.getByTestId('crumb-field').textContent).toBe('current_ratio');
  });

  it('weighting step input links jump to the source datum (breadcrumb)', () => {
    render(
      <AnalystTraceDrawer traces={[makeTrace()]} analystId={'fundamental'} onClose={vi.fn()} onSelect={vi.fn()} />
    );
    fireEvent.click(screen.getByTestId('trace-tab-weighting'));
    // Click the first weighting input link -> should pin that field on the Data tab.
    fireEvent.click(screen.getByTestId('weight-input-0-0'));
    expect(screen.getByTestId('trace-tab-data').className).toContain('active');
    expect(screen.getByTestId('crumb-field').textContent).toBe('debt_to_equity');
    expect(screen.getByTestId('field-AAPL-debt_to_equity').className).toContain('pinned');
  });

  it('renders a visual weighting bar whose width matches the weight', () => {
    render(
      <AnalystTraceDrawer traces={[makeTrace()]} analystId={'fundamental'} onClose={vi.fn()} onSelect={vi.fn()} />
    );
    fireEvent.click(screen.getByTestId('trace-tab-weighting'));
    const fill = document.querySelector('.trace-weight-bar-fill') as HTMLElement;
    expect(fill.style.width).toBe('40%');
  });

  it('clears the breadcrumb when the analyst crumb is clicked', () => {
    render(
      <AnalystTraceDrawer traces={[makeTrace()]} analystId={'fundamental'} onClose={vi.fn()} onSelect={vi.fn()} />
    );
    fireEvent.click(screen.getByTestId('trace-tab-data'));
    fireEvent.click(screen.getByTestId('field-AAPL-current_ratio'));
    expect(screen.getByTestId('crumb-field')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('crumb-analyst'));
    expect(screen.queryByTestId('crumb-field')).toBeNull();
    expect(screen.queryByTestId('crumb-ticker')).toBeNull();
  });

  it('mounts closed then opens without a hooks error', () => {
    const { rerender } = render(
      <AnalystTraceDrawer traces={[makeTrace()]} analystId={null} onClose={vi.fn()} onSelect={vi.fn()} />
    );
    // Closed: nothing rendered.
    expect(screen.queryByTestId('trace-drawer')).toBeNull();
    // Now open it — must not throw "rendered more hooks than previous render".
    rerender(
      <AnalystTraceDrawer traces={[makeTrace()]} analystId={'fundamental'} onClose={vi.fn()} onSelect={vi.fn()} />
    );
    expect(screen.getByTestId('trace-drawer')).toBeInTheDocument();
  });

  it('closes on scrim click and Escape', () => {
    const onClose = vi.fn();
    render(
      <AnalystTraceDrawer traces={[makeTrace()]} analystId={'fundamental'} onClose={onClose} onSelect={vi.fn()} />,
    );
    fireEvent.click(screen.getByTestId('trace-scrim'));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('renders per-source status rows when sourceStatus is present', () => {
    const trace = makeTrace({
      sourceStatus: { yahoo: 'ok', alpha: 'skipped' },
      degraded: true,
      notes: ['alpha: source unavailable'],
    });
    render(
      <AnalystTraceDrawer traces={[trace]} analystId={'fundamental'} onClose={vi.fn()} onSelect={vi.fn()} />,
    );
    // Switch to the Data tab.
    fireEvent.click(screen.getByTestId('trace-tab-data'));
    expect(screen.getByTestId('trace-source-status')).toBeInTheDocument();
    expect(screen.getByTestId('source-row-yahoo')).toBeInTheDocument();
    expect(screen.getByTestId('source-row-alpha')).toBeInTheDocument();
    // Degraded badge visible.
    expect(screen.getByText('⚠ degraded')).toBeInTheDocument();
  });

  it('omits source-status block when no sourceStatus', () => {
    render(
      <AnalystTraceDrawer traces={[makeTrace()]} analystId={'fundamental'} onClose={vi.fn()} onSelect={vi.fn()} />,
    );
    fireEvent.click(screen.getByTestId('trace-tab-data'));
    expect(screen.queryByTestId('trace-source-status')).toBeNull();
  });

  it('Phase I: shows the LIVE saved flavor immediately (not stale last-run trace.instructions)', () => {
    // Last run's instructions differ from the just-saved flavor.
    const trace = makeTrace({ instructions: 'OLD last-run instructions' });
    const liveFlavorsById = {
      fundamental: {
        sessionId: 'default',
        agencyId: 'long-term',
        analystId: 'fundamental',
        flavors: [
          { id: 'default', name: 'Balanced', role: 'Skew', instructions: 'NEW saved instructions' },
        ],
        selectedId: 'default',
      },
    };
    render(
      <AnalystTraceDrawer
        traces={[trace]}
        analystId={'fundamental'}
        onClose={vi.fn()}
        onSelect={vi.fn()}
        liveFlavorsById={liveFlavorsById}
      />,
    );
    // The Instructions tab must show the EDITED text, not the stale trace text.
    expect(screen.getByTestId('trace-instructions-body')).toHaveTextContent('NEW saved instructions');
    expect(screen.queryByText('OLD last-run instructions')).toBeNull();
    // A "live" badge confirms it is reading the saved flavor.
    expect(screen.getByTestId('trace-live-badge')).toBeInTheDocument();
  });
});

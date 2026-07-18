// frontend/src/test/AnalystWall.test.tsx
import { render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import { AnalystWall } from '../components/analysts/AnalystWall';
import type { AnalystRunState } from '../hooks/useAnalystRun';
import { ANALYSTS, analystById } from '../components/analysts/analysts';
import type { AnalystId } from '../types';
import { agencyById } from '../components/analysts/agencies';

function makeRun(overrides: Partial<AnalystRunState> = {}): AnalystRunState {
  return {
    running: true,
    tickerIndex: 0,
    tickers: ['AAPL'],
    cells: ANALYSTS.map((a) => ({
      analyst: a.id,
      ticker: 'AAPL',
      phase: 'idle',
      task: null,
      progress: 0,
    })),
    completed: false,
    ...overrides,
  };
}

describe('AnalystWall', () => {
  it('renders one panel per analyst with name + role', () => {
    render(<AnalystWall run={makeRun()} />);
    expect(screen.getByText('Orchestrator')).toBeInTheDocument();
    expect(screen.getByText('Data Ingestion')).toBeInTheDocument();
    expect(screen.getByText('Fundamental')).toBeInTheDocument();
    expect(screen.getByText('Technical')).toBeInTheDocument();
    expect(screen.getByText('Sentiment')).toBeInTheDocument();
    expect(screen.getByText('Risk')).toBeInTheDocument();
    expect(screen.getByText('Governance')).toBeInTheDocument();
  });

  it('shows the active analyst with its ticker and task', () => {
    const cells = ANALYSTS.map((a) => ({
      analyst: a.id,
      ticker: a.id === 'fundamental' ? 'AAPL' : null,
      phase: a.id === 'fundamental' ? ('active' as const) : ('idle' as const),
      task: a.id === 'fundamental' ? 'Scoring moat' : null,
      progress: a.id === 'fundamental' ? 0.5 : 0,
    }));
    render(<AnalystWall run={makeRun({ cells })} />);
    const panels = document.querySelectorAll('.analyst-panel');
    expect(panels.length).toBe(ANALYSTS.length);
    const active = document.querySelector('.analyst-panel.phase-active');
    expect(active).not.toBeNull();
    expect(active!.textContent).toContain('AAPL');
    expect(active!.textContent).toContain('Scoring moat');
  });

  it('marks done panels with phase-done class', () => {
    const cells = ANALYSTS.map((a) => ({
      analyst: a.id,
      ticker: 'AAPL',
      phase: 'done' as const,
      task: 'done',
      progress: 1,
    }));
    render(<AnalystWall run={makeRun({ cells, completed: true })} />);
    expect(document.querySelectorAll('.analyst-panel.phase-done').length).toBe(ANALYSTS.length);
    expect(document.querySelectorAll('.status-dot.status-done').length).toBe(ANALYSTS.length);
  });

  it('renders a shimmer fill width reflecting progress', () => {
    const cells = ANALYSTS.map((a, i) => ({
      analyst: a.id,
      ticker: 'AAPL',
      phase: 'active' as const,
      task: 't',
      progress: 0.4,
    }));
    render(<AnalystWall run={makeRun({ cells })} />);
    const fill = document.querySelector('.shimmer-fill') as HTMLElement;
    expect(fill.style.width).toBe('40%');
  });

  it('opens the drawer only for analysts that have a trace (clickable)', () => {
    const onOpen = vi.fn();
    // Only fundamental has a trace available.
    render(
      <AnalystWall
        run={makeRun()}
        traceAvailable={(id) => id === 'fundamental'}
        onOpen={onOpen}
      />,
    );
    const fundamental = screen.getByTestId('panel-fundamental');
    const governance = screen.getByTestId('panel-governance');

    expect(fundamental.className).toContain('clickable');
    expect(governance.className).not.toContain('clickable');

    fundamental.click();
    expect(onOpen).toHaveBeenCalledWith('fundamental');

    governance.click();
    // governance has no trace -> no open call
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('renders a degraded badge for analysts flagged degraded', () => {
    const onOpen = vi.fn();
    render(
      <AnalystWall
        run={makeRun()}
        traceAvailable={(id) => id === 'fundamental'}
        onOpen={onOpen}
        degradedIds={new Set<AnalystId>(['fundamental'])}
      />,
    );
    const fundamental = screen.getByTestId('panel-fundamental');
    expect(fundamental.className).toContain('degraded');
    expect(screen.getByTestId('panel-degraded-fundamental')).toBeInTheDocument();
    // Non-degraded analyst gets no badge.
    expect(screen.queryByTestId('panel-degraded-governance')).toBeNull();
  });

  it('renders only the selected agency\'s analysts when analysts prop is passed', () => {
    // The 4-node crypto-screener agency must render 4 panels, not the
    // hardcoded 7. This is the core Phase-4 agency-wiring assertion.
    const cryptoAgency = agencyById('crypto-screener');
    const analysts = cryptoAgency.analysts.map((id) => analystById(id as AnalystId));
    const cells = analysts.map((a) => ({
      analyst: a.id,
      ticker: 'BTC',
      phase: 'done' as const,
      task: 'done',
      progress: 1,
    }));
    render(<AnalystWall run={makeRun({ cells, completed: true })} analysts={analysts} />);
    expect(document.querySelectorAll('.analyst-panel').length).toBe(4);
    expect(screen.getByText('Data Ingestion')).toBeInTheDocument();
    expect(screen.getByText('On-Chain Flow')).toBeInTheDocument();
    // The long-term-only analysts must NOT appear.
    expect(screen.queryByText('Orchestrator')).toBeNull();
    expect(screen.queryByText('Fundamental')).toBeNull();
    expect(screen.queryByText('Governance')).toBeInTheDocument();
  });
});

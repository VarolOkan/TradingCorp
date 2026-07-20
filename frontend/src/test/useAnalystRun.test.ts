// frontend/src/test/useAnalystRun.test.ts
// Tests for the event-driven useAnalystRun hook. We supply a minimal fake
// socket that records listeners and lets the test fire analyst_start /
// analyst_done events, mirroring what the real backend streams.

import { act, renderHook } from '@testing-library/react';
import { useAnalystRun } from '../hooks/useAnalystRun';

function makeFakeSocket() {
  const listeners: Record<string, ((p: any) => void)[]> = {};
  return {
    on(event: string, cb: (p: any) => void) {
      (listeners[event] ||= []).push(cb);
    },
    off(event: string, cb: (p: any) => void) {
      listeners[event] = (listeners[event] || []).filter((f) => f !== cb);
    },
    emit(event: string, payload: any) {
      (listeners[event] || []).forEach((f) => f(payload));
    },
    _listeners: listeners,
  };
}

describe('useAnalystRun (event-driven)', () => {
  it('starts idle with all panels standing by', () => {
    const socket = makeFakeSocket();
    const { result } = renderHook(() => useAnalystRun(socket as any, ['AAPL']));
    expect(result.current.state.running).toBe(false);
    expect(result.current.state.cells.every((c) => c.phase === 'idle')).toBe(true);
    expect(result.current.state.cells[0].ticker).toBe('AAPL');
  });

  it('activates a panel on analyst_start and completes on analyst_done', () => {
    const socket = makeFakeSocket();
    const { result } = renderHook(() => useAnalystRun(socket as any, ['AAPL']));

    act(() => socket.emit('analyst_start', { analyst: 'fundamental', tickers: ['AAPL'] }));
    expect(result.current.state.cells.find((c) => c.analyst === 'fundamental')!.phase).toBe('active');

    act(() =>
      socket.emit('analyst_done', { analyst: 'fundamental', tickers: ['AAPL'], decision: 'APPROVE', confidence: 80 })
    );
    const cell = result.current.state.cells.find((c) => c.analyst === 'fundamental')!;
    expect(cell.phase).toBe('done');
    expect(cell.progress).toBe(1);
    expect(cell.task).toContain('APPROVE');
  });

  it('marks completed once every analyst has emitted done', () => {
    const socket = makeFakeSocket();
    const onComplete = vi.fn();
    const { result } = renderHook(() =>
      useAnalystRun(socket as any, ['AAPL'], { onComplete })
    );

    const ids = ['orchestrator', 'data_ingestion', 'fundamental', 'technical', 'sentiment', 'bull_researcher', 'bear_researcher', 'risk', 'governance', 'onchain',
      'options_ingestion', 'vol_surface', 'options_pricing', 'options_greeks', 'options_flow', 'options_technical', 'options_risk'];
    act(() => {
      for (const id of ids) {
        socket.emit('analyst_start', { analyst: id, tickers: ['AAPL'] });
        socket.emit('analyst_done', { analyst: id, tickers: ['AAPL'] });
      }
    });

    expect(result.current.state.completed).toBe(true);
    expect(result.current.state.running).toBe(false);
    expect(result.current.state.cells.every((c) => c.phase === 'done')).toBe(true);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('ignores analyst ids not in the panel set', () => {
    const socket = makeFakeSocket();
    const { result } = renderHook(() => useAnalystRun(socket as any, ['AAPL']));
    act(() => socket.emit('analyst_start', { analyst: 'unknown_thing' }));
    // No crash; cells unchanged.
    expect(result.current.state.cells.every((c) => c.phase === 'idle')).toBe(true);
  });

  it('resets when a new run starts (analysis_start), not on ticker prop change', () => {
    const socket = makeFakeSocket();
    const { result, rerender } = renderHook(
      ({ tickers }) => useAnalystRun(socket as any, tickers, { analystIds: ['options_ingestion', 'vol_surface', 'options_risk'] }),
      { initialProps: { tickers: ['AAPL'] } }
    );
    act(() => socket.emit('analyst_start', { analyst: 'vol_surface', tickers: ['AAPL'] }));
    expect(result.current.state.cells.find((c) => c.analyst === 'vol_surface')!.phase).toBe('active');

    // Changing the tickers prop alone does NOT reset (the server drives reset
    // via `analysis_start`, which arrives before the analyst stream).
    rerender({ tickers: ['MSFT'] });
    expect(result.current.state.cells.find((c) => c.analyst === 'vol_surface')!.phase).toBe('active');

    // A fresh run (analysis_start with the new tickers) resets the wall.
    act(() => socket.emit('analysis_start', { tickers: ['MSFT'] }));
    expect(result.current.state.cells.every((c) => c.phase === 'idle')).toBe(true);
    expect(result.current.state.cells[0].ticker).toBe('MSFT');
  });

  it('REGRESSION: a whole run streamed before any re-render still lights every panel (no Standing by)', () => {
    // Reproduces the live symptom: the user clicks Analyze, the server emits
    // analysis_start + every analyst_start/done almost immediately (a fast,
    // seeded options run), and React has not yet re-rendered/re-attached
    // listeners. With listeners attached once and reset driven by
    // analysis_start (which precedes the analyst stream), every panel must
    // reach 'done' — NOT stay 'Standing by'.
    const socket = makeFakeSocket();
    const ids = ['options_ingestion', 'vol_surface', 'options_pricing', 'options_greeks', 'options_flow', 'options_risk', 'governance'];
    const { result } = renderHook(() =>
      useAnalystRun(socket as any, ['TSLA'], { analystIds: ids })
    );

    act(() => {
      // The entire run arrives in one synchronous burst (as a fast server can).
      socket.emit('analysis_start', { tickers: ['TSLA'] });
      for (const id of ids) {
        socket.emit('analyst_start', { analyst: id, tickers: ['TSLA'] });
        socket.emit('analyst_done', { analyst: id, tickers: ['TSLA'], decision: 'APPROVE', confidence: 70 });
      }
    });

    expect(result.current.state.completed).toBe(true);
    expect(result.current.state.running).toBe(false);
    expect(result.current.state.cells.every((c) => c.phase === 'done')).toBe(true);
  });
});

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

    const ids = ['orchestrator', 'data_ingestion', 'fundamental', 'technical', 'sentiment', 'risk', 'governance', 'onchain',
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

  it('resets when tickers change (new submission)', () => {
    const socket = makeFakeSocket();
    const { result, rerender } = renderHook(
      ({ tickers }) => useAnalystRun(socket as any, tickers),
      { initialProps: { tickers: ['AAPL'] } }
    );
    act(() => socket.emit('analyst_start', { analyst: 'fundamental' }));
    expect(result.current.state.cells.find((c) => c.analyst === 'fundamental')!.phase).toBe('active');

    rerender({ tickers: ['MSFT'] });
    expect(result.current.state.cells.every((c) => c.phase === 'idle')).toBe(true);
    expect(result.current.state.cells[0].ticker).toBe('MSFT');
  });
});

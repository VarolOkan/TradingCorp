// frontend/src/test/useAnalysis.test.ts
import { renderHook, act } from '@testing-library/react';
import { useAnalysis, parseTickers } from '../hooks/useAnalysis';
import type { Socket } from 'socket.io-client';

function makeSocket() {
  const handlers: Record<string, (p: any) => void> = {};
  const emitted: any[] = [];
  const socket: Partial<Socket> = {
    on: (event: string, cb: (p: any) => void) => {
      handlers[event] = cb;
    },
    off: (event: string) => {
      delete handlers[event];
    },
    emit: (event: string, payload: any) => {
      emitted.push({ event, payload });
    },
  };
  return {
    socket: socket as Socket,
    handlers,
    emitted,
    trigger: (event: string, payload: any) => handlers[event]?.(payload),
  };
}

describe('parseTickers', () => {
  it('splits, trims, uppercases, drops empties', () => {
    expect(parseTickers('aapl, msft ,, nvda')).toEqual(['AAPL', 'MSFT', 'NVDA']);
  });
});

describe('useAnalysis', () => {
  it('emits request_analysis with cleaned tickers and session', () => {
    const { socket, emitted } = makeSocket();
    const { result } = renderHook(() => useAnalysis(socket));
    act(() => result.current.submit(['aapl', 'msft']));
    expect(emitted).toEqual([
      { event: 'request_analysis', payload: { tickers: ['AAPL', 'MSFT'], sessionId: 'default' } },
    ]);
    expect(result.current.running).toBe(true);
  });

  it('reports not connected and does not emit when socket is null', () => {
    const { result } = renderHook(() => useAnalysis(null));
    act(() => result.current.submit(['AAPL']));
    expect(result.current.error).toBe('Not connected to the analysis server');
    expect(result.current.running).toBe(false);
  });

  it('rejects empty ticker input', () => {
    const { socket } = makeSocket();
    const { result } = renderHook(() => useAnalysis(socket));
    act(() => result.current.submit([]));
    expect(result.current.error).toBe('Enter at least one ticker symbol');
    expect(result.current.running).toBe(false);
  });

  it('handles analysis_start -> running + runId increments', () => {
    const { socket, trigger } = makeSocket();
    const { result } = renderHook(() => useAnalysis(socket));
    act(() => result.current.submit(['AAPL']));
    act(() => trigger('analysis_start', { tickers: ['AAPL'] }));
    expect(result.current.running).toBe(true);
    expect(result.current.runId).toBe(1);
  });

  it('handles analysis_complete -> result + not running', () => {
    const { socket, trigger } = makeSocket();
    const { result } = renderHook(() => useAnalysis(socket));
    act(() => result.current.submit(['AAPL']));
    const payload = {
      decision: 'REJECT' as const,
      confidence: 0.85,
      reasoning: 'overvalued',
      preservation_rationale: null,
      conditions: [],
      tickers: ['AAPL'],
      company_name: 'Apple',
      investment_thesis: '',
      final_decision: '',
      error: null,
      fundamental_analysis: null,
      technical_analysis: null,
      sentiment_analysis: null,
      risk_assessment: null,
      decisions: {},
      riskAssessments: {},
    };
    act(() => trigger('analysis_complete', payload));
    expect(result.current.running).toBe(false);
    expect(result.current.result?.decision).toBe('REJECT');
    expect(result.current.result?.confidence).toBe(0.85);
  });

  it('handles analysis_error -> error + not running', () => {
    const { socket, trigger } = makeSocket();
    const { result } = renderHook(() => useAnalysis(socket));
    act(() => result.current.submit(['AAPL']));
    act(() => trigger('analysis_error', { error: 'boom' }));
    expect(result.current.running).toBe(false);
    expect(result.current.error).toBe('boom');
  });

  it('cleans up listeners on unmount', () => {
    const { socket, handlers } = makeSocket();
    const { unmount } = renderHook(() => useAnalysis(socket));
    expect(handlers['analysis_complete']).toBeTypeOf('function');
    unmount();
    expect(handlers['analysis_complete']).toBeUndefined();
  });
});

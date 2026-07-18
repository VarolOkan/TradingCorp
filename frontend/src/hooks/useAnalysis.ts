// frontend/src/hooks/useAnalysis.ts
// React hook that drives a single analysis run over the Socket.IO connection.
// Subscribes to the real server events emitted by src/server/index.ts:
//   analysis_start -> analysis_complete | analysis_error

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import type { AnalysisResult, AnalystTrace } from '../types';

export interface UseAnalysisState {
  running: boolean;
  result: AnalysisResult | null;
  error: string | null;
  /** Increments on each analysis_start so the UI can show activity. */
  runId: number;
  /** Structured per-analyst traces for the drill-down drawer. */
  analystTraces: AnalystTrace[];
}

export interface UseAnalysis extends UseAnalysisState {
  submit: (tickers: string[], sessionId?: string, agencyId?: string) => void;
  reset: () => void;
}

function parseTickers(raw: string): string[] {
  return raw
    .split(',')
    .map((t) => t.trim().toUpperCase())
    .filter((t) => t.length > 0);
}

export function useAnalysis(socket: Socket | null): UseAnalysis {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runId, setRunId] = useState(0);
  const [analystTraces, setAnalystTraces] = useState<AnalystTrace[]>([]);
  const current = useRef<{ tickers: string[] } | null>(null);

  useEffect(() => {
    if (!socket) return;

    const onStart = (payload: { tickers?: string[] }) => {
      current.current = { tickers: payload.tickers ?? [] };
      setRunning(true);
      setError(null);
      setResult(null);
      setAnalystTraces([]);
      setRunId((n) => n + 1);
    };

    const onComplete = (payload: AnalysisResult) => {
      setResult(payload);
      setAnalystTraces(Array.isArray(payload.analystTraces) ? payload.analystTraces : []);
      setRunning(false);
    };

    const onError = (payload: { error?: string }) => {
      setError(payload.error ?? 'Analysis failed');
      setRunning(false);
    };

    socket.on('analysis_start', onStart);
    socket.on('analysis_complete', onComplete);
    socket.on('analysis_error', onError);

    return () => {
      socket.off('analysis_start', onStart);
      socket.off('analysis_complete', onComplete);
      socket.off('analysis_error', onError);
    };
  }, [socket]);

  const submit = useCallback(
    (tickers: string[], sessionId = 'default', agencyId?: string) => {
      if (!socket) {
        setError('Not connected to the analysis server');
        return;
      }
      const cleaned = parseTickers(tickers.join(','));
      if (cleaned.length === 0) {
        setError('Enter at least one ticker symbol');
        return;
      }
      setError(null);
      setResult(null);
      setRunning(true);
      try {
        socket.emit('request_analysis', { tickers: cleaned, sessionId, agencyId });
      } catch (e: any) {
        // A disconnected socket can throw synchronously on emit. Surface a
        // clear error instead of letting the throw abort the caller's state
        // update (e.g. the Screener "→ Add" ticker fill).
        setRunning(false);
        setError(e?.message || 'Failed to send analysis request (not connected)');
      }
    },
    [socket]
  );

  const reset = useCallback(() => {
    setRunning(false);
    setResult(null);
    setError(null);
  }, []);

  return { running, result, error, runId, analystTraces, submit, reset };
}

export { parseTickers };

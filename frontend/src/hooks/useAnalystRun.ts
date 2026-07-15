// frontend/src/hooks/useAnalystRun.ts
// Consumes the REAL per-analyst events streamed by the backend
// (analyst_start / analyst_done) and derives the AnalystWall view-state.
//
// Unlike the earlier timer-based mock, this reflects what the backend's
// LangGraph actually executed: as each analyst node runs it emits start/done,
// and the wall lights the matching panel. The graph processes every ticker in
// a single sequential pass per analyst (orchestrator -> fundamental -> ... ->
// governance), so a run is one pipeline sweep across all analysts.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import { ANALYSTS, AnalystId } from '../components/analysts/analysts';

export type AnalystPhase = 'idle' | 'active' | 'done';

export interface AnalystRunCell {
  analyst: AnalystId;
  ticker: string | null;
  phase: AnalystPhase;
  task: string | null;
  /** 0..1 progress within the current cell (1 once done). */
  progress: number;
  /** Epoch ms when the analyst started (set on analyst_start). Drives the
   *  live count-up timer; undefined until the analyst begins. */
  startTime?: number;
  /** Elapsed ms for the analyst's run (set on analyst_done). */
  durationMs?: number;
}

export interface AnalystRunState {
  running: boolean;
  tickers: string[];
  /** Per-analyst live cell (one row per analyst, in ANALYSTS order). */
  cells: AnalystRunCell[];
  completed: boolean;
}

export interface UseAnalystRunOptions {
  onComplete?: () => void;
}

const IDLE_CELLS = (tickers: string[], ids: string[] = ANALYSTS.map((a) => a.id)): AnalystRunCell[] =>
  ids.map((id) => ({
    analyst: id as AnalystId,
    ticker: tickers.length > 0 ? tickers.join(', ') : null,
    phase: 'idle' as AnalystPhase,
    task: null,
    progress: 0,
  }));

// Map backend analyst id ("fundamental_analyst" style kept simple as the
// frontend ids we emit: orchestrator/fundamental/technical/sentiment/risk/
// governance) to our AnalystId.
function toAnalystId(raw: string): AnalystId {
  return raw as AnalystId;
}

export function useAnalystRun(
  socket: Socket | null,
  tickers: string[],
  { onComplete, analystIds }: UseAnalystRunOptions & { analystIds?: string[] } = {}
) {
  const [state, setState] = useState<AnalystRunState>({
    running: false,
    tickers,
    cells: IDLE_CELLS(tickers, analystIds),
    completed: false,
  });

  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  const startCount = useRef(0);
  const doneCount = useRef(0);
  // Latch so onComplete fires exactly once per run (not on every matched
  // start/done pair, and not again if the effect re-arms).
  const completedRef = useRef(false);

  // Keep the latest tickers in a ref so reset() and the effect don't depend on
  // the (potentially unstable) tickers array identity — otherwise every render
  // would produce a new reset() and re-run the effect, causing an infinite loop.
  const tickersRef = useRef(tickers);
  tickersRef.current = tickers;

  const reset = useCallback(() => {
    const currentTickers = tickersRef.current;
    startCount.current = 0;
    doneCount.current = 0;
    completedRef.current = false;
    setState({
      running: false,
      tickers: currentTickers,
      cells: IDLE_CELLS(currentTickers, analystIds),
      completed: false,
    });
  }, []);

  // Completed is reached once every analyst that started has also emitted done.
  // We count started vs done (not a fixed ANALYSTS.length) because not every
  // analyst node streams a done event (e.g. data_ingestion), and a generic
  // agency may contain any set of analysts.
  const tickersKey = tickers.join(',');
  const agencyKey = (analystIds ?? []).join(',');
  useEffect(() => {
    if (!socket) return;
    reset();

    const onStart = (p: { analyst: string; tickers?: string[] }) => {
      const id = toAnalystId(p.analyst);
      startCount.current += 1;
      const now = Date.now();
      setState((s) => ({
        ...s,
        running: true,
        cells: s.cells.map((c) =>
          c.analyst === id
            ? {
                ...c,
                phase: 'active',
                startTime: now,
                durationMs: undefined,
                ticker:
                  p.tickers && p.tickers.length
                    ? p.tickers.join(', ')
                    : c.ticker,
                task: 'Analyzing…',
                progress: Math.max(c.progress, 0.05),
              }
            : c
        ),
      }));
    };

    const onDone = (p: { analyst: string; tickers?: string[]; decision?: string; confidence?: number }) => {
      const id = toAnalystId(p.analyst);
      setState((s) => ({
        ...s,
        cells: s.cells.map((c) =>
          c.analyst === id
            ? {
                ...c,
                phase: 'done',
                // Freeze the elapsed time for this analyst's run.
                durationMs: c.startTime != null ? Date.now() - c.startTime : undefined,
                ticker:
                  p.tickers && p.tickers.length
                    ? p.tickers.join(', ')
                    : c.ticker,
                task: p.decision ? `${p.decision} (${p.confidence ?? '?'})` : 'Done',
                progress: 1,
              }
            : c
        ),
      }));
      doneCount.current += 1;
      // Mark the run not-running on every done (the last one sticks). The
      // completed/onComplete latch fires exactly once per run.
      const reachedComplete =
        !completedRef.current && startCount.current > 0 && doneCount.current >= startCount.current;
      if (reachedComplete) completedRef.current = true;
      setState((s) => ({
        ...s,
        running: false,
        ...(reachedComplete ? { completed: true } : null),
      }));
      if (reachedComplete) onCompleteRef.current?.();
    };

    const onError = () => {
      setState((s) => ({ ...s, running: false }));
    };

    socket.on('analyst_start', onStart);
    socket.on('analyst_done', onDone);
    socket.on('analysis_error', onError);

    return () => {
      socket.off('analyst_start', onStart);
      socket.off('analyst_done', onDone);
      socket.off('analysis_error', onError);
    };
    // Re-run (and re-arm) when the socket changes OR the requested tickers
    // change (new submission). tickersKey is a stable-by-value string.
  }, [socket, tickersKey, agencyKey, reset]);

  return { state, reset };
}

export default useAnalystRun;

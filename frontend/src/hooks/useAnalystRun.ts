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

  // Keep the latest tickers + analyst-id set in refs so the (socket-once)
  // listeners and reset() always read the CURRENT agency's ids, even though
  // the effect that attaches them runs only when the socket changes.
  const tickersRef = useRef(tickers);
  tickersRef.current = tickers;
  // Keep the analyst-id set in a ref. IMPORTANT: leave it as `undefined` (not
  // `[]`) when the caller passes nothing — IDLE_CELLS treats `undefined` as
  // "all analysts", whereas `[]` would render zero panels.
  const analystIdsRef = useRef(analystIds);
  analystIdsRef.current = analystIds;

  // Reset the wall to idle for the current agency/tickers. Used by the exposed
  // reset() and by the agency-change effect below.
  const reset = useCallback(() => {
    const currentTickers = tickersRef.current;
    const ids = analystIdsRef.current;
    startCount.current = 0;
    doneCount.current = 0;
    completedRef.current = false;
    setState({
      running: false,
      tickers: currentTickers,
      cells: IDLE_CELLS(currentTickers, ids),
      completed: false,
    });
  }, []);

  // Reset the wall to idle for a FRESH run, using the tickers the server just
  // reported on `analysis_start`. This is what makes the wall track each run:
  // the server emits `analysis_start` BEFORE any per-analyst events, so
  // resetting here never races the analyst_start/analyst_done stream.
  const resetForRun = useCallback((runTickers: string[] | undefined) => {
    const ids = analystIdsRef.current;
    const t = runTickers && runTickers.length ? runTickers : tickersRef.current;
    startCount.current = 0;
    doneCount.current = 0;
    completedRef.current = false;
    setState({
      running: false,
      tickers: t,
      cells: IDLE_CELLS(t, ids),
      completed: false,
    });
  }, []);

  // Completed is reached once every analyst that started has also emitted done.
  // We count started vs done (not a fixed ANALYSTS.length) because not every
  // analyst node streams a done event, and a generic agency may contain any
  // set of analysts.
  useEffect(() => {
    if (!socket) return;

    const onAnalysisStart = (p: { tickers?: string[] }) => {
      resetForRun(p?.tickers);
    };

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
      // The run stays "running" until EVERY started analyst has emitted done.
      // Flipping running:false on the first done would clear the wall's
      // live-tick interval and freeze the timers on analysts that are still
      // active (parallel fan-out). This is independent of the `completed`
      // latch below, which fires exactly once per run.
      const allDone =
        startCount.current > 0 && doneCount.current >= startCount.current;
      const justCompleted = allDone && !completedRef.current;
      if (justCompleted) completedRef.current = true;
      setState((s) => ({
        ...s,
        running: !allDone,
        ...(justCompleted ? { completed: true } : null),
      }));
      if (justCompleted) onCompleteRef.current?.();
    };

    const onError = () => {
      setState((s) => ({ ...s, running: false }));
    };

    socket.on('analysis_start', onAnalysisStart);
    socket.on('analyst_start', onStart);
    socket.on('analyst_done', onDone);
    socket.on('analysis_error', onError);

    return () => {
      socket.off('analysis_start', onAnalysisStart);
      socket.off('analyst_start', onStart);
      socket.off('analyst_done', onDone);
      socket.off('analysis_error', onError);
    };
    // Attach listeners ONCE per socket. Do NOT re-arm on wallTickers/agencyId
    // change: re-attaching mid-run detaches the very listeners the server is
    // streaming analyst_start/done to, and the reset() that accompanied the
    // re-arm wiped in-flight cell updates. For a fast (seeded) run the whole
    // pipeline can complete before React re-attaches, leaving every panel
    // stuck on "Standing by". Resetting on the server's 'analysis_start'
    // (which precedes all analyst events) avoids the race entirely.
  }, [socket, resetForRun]);

  // Rebuild the idle wall when the SELECTED AGENCY changes (so the panel set
  // matches the new agency) WITHOUT re-attaching the socket listeners. Agency
  // changes are blocked while a run is in flight (requestAgency guards), so
  // this never fires mid-run and never races the stream.
  const agencyKey = (analystIds ?? []).join(',');
  useEffect(() => {
    reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agencyKey]);

  return { state, reset };
}

export default useAnalystRun;

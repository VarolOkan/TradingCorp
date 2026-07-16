// src/registry/logic/shared.ts
// Phase 3 extraction (doc §8 Phase 3). Shared helpers that every analyst
// logic handler uses, lifted out of the old node classes so the handler
// functions stay pure + testable and the node classes become thin shims.
//
// These are intentionally deterministic (seeded RNG) so the agency graph
// produces byte-identical output to the legacy graph (parity guarantee).
//
// `makeNodeSurface()` is the SINGLE implementation of the NodeSurface contract
// (updateStep / addMessage / captureTrace / emitProgress / executeWithRetry).
// Both handlers (tested directly) and GenericAnalystNode (runtime) use it, so
// there is exactly one source of truth for how an analyst records progress,
// messages and traces. This replaced the old per-analyst `*.node.ts` shim
// subclasses, which only forwarded `process()` into these helpers.

import type { AgentState } from '../../types/financial-analysis';
import type { DataReceivedBlock, DataReceivedEntry } from '../../types/financial-analysis';
import { RetryHandler } from '../../utils/retry-handler';
import { isMockDisabled } from './mockMode';

/**
 * Minimal surface a handler needs from a BaseNode, so the pure logic handlers
 * stay node-agnostic and the node classes become thin shims. Both the legacy
 * node classes and the data-driven GenericAnalystNode satisfy this surface,
 * which is what guarantees byte-identical parity between the two graphs.
 */
export interface NodeSurface {
  updateStep(state: AgentState, step: string): AgentState;
  addMessage(state: AgentState, role: string, content: string): AgentState;
  captureTrace(state: AgentState, trace: any): AgentState;
  emitProgress(state: AgentState, event: 'analyst:start' | 'analyst:done', analyst: string, extra?: Record<string, any>): void;
  /** Optional — only the data-ingestion handler needs retry-wrapped fetches. */
  executeWithRetry?<T>(operation: () => Promise<T>, operationName: string, context?: Record<string, any>): Promise<T>;
}

/**
 * The one canonical NodeSurface implementation. Handlers receive this as their
 * second argument (`node`), so they can record progress/messages/traces without
 * depending on any concrete node class. Pure functions over `state` — safe to
 * reuse across every analyst and in tests.
 */
export function makeNodeSurface(): NodeSurface {
  const retryHandler = new RetryHandler({
    maxAttempts: 3,
    baseDelayMs: 1000,
    maxDelayMs: 30000,
    jitter: true,
  });

  return {
    updateStep(state, step) {
      return { ...state, current_step: step };
    },

    addMessage(state, role, content) {
      return {
        ...state,
        messages: [
          ...(state.messages || []),
          { role, content, timestamp: new Date().toISOString() },
        ],
      };
    },

    captureTrace(state, trace) {
      try {
        const existing = Array.isArray(state.analystTraces) ? state.analystTraces : [];
        return { ...state, analystTraces: [...existing, trace] };
      } catch {
        return state;
      }
    },

    emitProgress(state, event, analyst, extra) {
      if (state.progress && typeof state.progress.emit === 'function') {
        try {
          state.progress.emit(event, { analyst, timestamp: new Date().toISOString(), ...extra });
        } catch {
          /* swallow — progress streaming must never break the analysis */
        }
      }
    },

    executeWithRetry(operation, operationName, context) {
      return retryHandler.executeWithRetry(operation, operationName, context);
    },
  };
}

/** Convert a string to a stable numeric seed (FNV-ish hash). */
export function stringToSeed(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  return Math.abs(hash);
}

/** Create a deterministic seeded RNG in [0, 1) (LCG).
 *  When mock data is globally disabled (DISABLE_MOCK_DATA), this returns a
 *  constant 0 for every draw — so every consumer collapses to its `?? 0`
 *  fallback and NO fabricated numbers flow into the pipeline.
 *  NOTE: clamped to [0,1) — Math.sin(seed) can be negative, and unclamped it
 *  produced negative "mock" magnitudes (e.g. -43,563 balance sheets) that read
 *  as corrupted data. Consumers expect a 0..1 fraction. */
export function seededRandom(seed: number): () => number {
  if (isMockDisabled()) return () => 0;
  let x = Math.sin(seed) * 10000;
  return () => {
    x = (x * 9301 + 49297) % 233280;
    // Clamp to [0,1): x can be negative; the consumer contracts a 0..1 fraction.
    const v = x / 233280;
    return v < 0 ? v + 1 : v;
  };
}

const THESIS_LABELS: Record<string, string> = {
  FUNDAMENTAL: 'fundamental',
  TECHNICAL: 'technical',
  SENTIMENT: 'sentiment',
  RISK: 'risk',
  GOVERNANCE: 'governance',
};

/**
 * Append an analyst-specific analysis block to the running investment thesis.
 * Faithfully reproduces the node-class `updateInvestmentThesis` behaviour.
 */
export function updateInvestmentThesis(
  currentThesis: string | undefined,
  summary: string,
  analysisType: string,
): string {
  const label = THESIS_LABELS[analysisType] || analysisType.toLowerCase();
  const block = `[${label.toUpperCase()} ANALYSIS] ${summary}`;
  if (!currentThesis) return block;
  return `${currentThesis}\n${block}`;
}

/**
 * Build a single `DataReceivedEntry` describing the precise slice of an
 * ingestion channel an analyst consumed. Pure function — no state mutation.
 * Used by every analyst handler so the export can later render, per analyst,
 * exactly the data it saw (RAW_DATA_DUMP.md). Parity-safe: handlers may call
 * this unconditionally; the resulting `dataReceived` channel is pure
 * annotation and never changes the analyst's output.
 */
export function annotateDataReceived(
  analyst: string,
  ticker: string,
  channel: 'ingested' | 'optionsData',
  blocks: DataReceivedBlock[],
  provenance: 'live' | 'mock' | 'mixed' | 'seeded-parity',
  note?: string,
): DataReceivedEntry {
  const entry: DataReceivedEntry = { analyst, ticker, channel, blocks, provenance };
  if (note !== undefined) entry.note = note; // exactOptionalPropertyTypes: only set when present
  return entry;
}

/**
 * Append a `DataReceivedEntry` to `state.dataReceived` (creating the array if
 * needed). Returns a new state; never throws. Mirrors the `captureTrace`
 * pattern so it composes cleanly in handlers.
 */
export function recordDataReceived(
  state: AgentState,
  entry: DataReceivedEntry,
): AgentState {
  try {
    const existing = Array.isArray(state.dataReceived) ? state.dataReceived : [];
    return { ...state, dataReceived: [...existing, entry] };
  } catch {
    return state;
  }
}

/**
 * LangGraph channel reducer for `state.dataReceived`: CONCATENATE every
 * analyst's appended entries but DEDUPE by a stable key. A node receives prior
 * analysts' entries in its state and re-appends them, so under LangGraph's
 * reduction (channel value + node-return are both concatenated) a naive concat
 * would double-count every analyst. Dedup keeps the final array exact.
 * Exported so it can be unit-tested without booting the full agency graph.
 */
export function mergeDataReceived(a: any[] | undefined, b: any[] | undefined): DataReceivedEntry[] {
  const seen = new Set<string>();
  const key = (e: any) =>
    `${e?.analyst ?? ''}|${e?.ticker ?? ''}|${e?.channel ?? ''}|${(e?.blocks ?? []).map((x: any) => x?.domain).join(',')}`;
  const out: DataReceivedEntry[] = [];
  for (const e of [...(a ?? []), ...(b ?? [])]) {
    const k = key(e);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(e);
    }
  }
  return out;
}

export interface AnalystHelpers {
  /** No-op-safe progress emitter (kept minimal; node shims inject the real one). */
  emitProgress?: (state: AgentState, event: 'analyst:start' | 'analyst:done', analyst: string, extra?: Record<string, any>) => void;
}

/** Standard "no tickers" guard shared by all analyst handlers. */
export function hasTickers(state: AgentState): boolean {
  return Array.isArray(state.tickers) && state.tickers.length > 0;
}

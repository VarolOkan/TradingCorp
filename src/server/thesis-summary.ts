// src/server/thesis-summary.ts
// Phase B: thesis summary builder.
// Derives a compact, scannable decision summary from the real per-analyst
// traces. Pure function of the final AgentState — no side effects, deterministic
// (so the parity test stays green). Kept in its own module so it can be unit-
// tested without loading the SQLite-backed server singletons.
//
// Returns null when there is nothing to show, letting the client fall back to
// deriving rows from analystTraces (frontend Phase A) or the raw
// investment_thesis string (parity).

import type { AgentState } from '../types/financial-analysis';

/** Analyst ids that coordinate/intake rather than emit a decision verdict. */
const THESIS_NON_VERDICT = new Set([
  'orchestrator',
  'data_ingestion',
  'options_ingestion',
]);

export interface ThesisSummaryRow {
  analyst: string;
  /** Human-friendly name (pipeline order when available). */
  name: string;
  verdict: string | null;
  score: number | null;
  summary: string | null;
}

export interface ThesisSummary {
  decision: string;
  confidence: number | null;
  reasoning: string | null;
  rows: ThesisSummaryRow[];
}

function prettifyAnalyst(id: string): string {
  return id
    .replace(/[_-]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

export function buildThesisSummary(
  state: AgentState,
  decision: string,
  confidence: number | null,
  reasoning: string,
): ThesisSummary | null {
  const traces = Array.isArray(state.analystTraces) ? state.analystTraces : [];
  const rows: ThesisSummaryRow[] = traces
    .filter((t: any) => t && !THESIS_NON_VERDICT.has(t.analyst))
    .filter((t: any) => t?.output?.verdict || typeof t?.output?.score === 'number')
    .map((t: any) => ({
      analyst: t.analyst,
      name: typeof t.name === 'string' ? t.name : prettifyAnalyst(t.analyst),
      verdict: t?.output?.verdict ?? null,
      score: typeof t?.output?.score === 'number' ? t.output!.score : null,
      summary: typeof t?.output?.summary === 'string' ? t.output!.summary : null,
    }));

  if (rows.length === 0) return null;

  return {
    decision,
    confidence,
    reasoning,
    rows,
  };
}

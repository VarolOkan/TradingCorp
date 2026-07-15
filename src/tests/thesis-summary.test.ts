// src/tests/thesis-summary.test.ts
// Phase B: unit tests for buildThesisSummary — the backend-computed scannable
// thesis grid. Pure function; no server / LangGraph / SQLite needed (imports the
// standalone module so the test runs even where better-sqlite3 can't load).
import { buildThesisSummary } from '../server/thesis-summary';
import type { AgentState } from '../types/financial-analysis';

function makeState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    messages: [],
    current_date: '2026-07-09',
    tickers: ['AAPL'],
    company_name: 'Apple Inc.',
    investment_thesis: 'Seeded narrative.',
    final_decision: '',
    error: null,
    current_step: 'initializing',
    ...overrides,
  };
}

const TRACES = [
  { analyst: 'orchestrator', name: 'Orchestrator', stage: 1, instructions: '', inputs: [], weighting: [], output: { summary: '' } },
  { analyst: 'data_ingestion', name: 'Data Ingestion', stage: 1, instructions: '', inputs: [], weighting: [], output: { summary: '' } },
  { analyst: 'fundamental', name: 'Fundamental', stage: 2, instructions: '', inputs: [], weighting: [], output: { verdict: 'BULLISH', score: 82, summary: 'Wide moat' } },
  { analyst: 'technical', name: 'Technical', stage: 2, instructions: '', inputs: [], weighting: [], output: { verdict: 'NEUTRAL', score: 61, summary: 'Price below SMA200' } },
  { analyst: 'risk', name: 'Risk', stage: 2, instructions: '', inputs: [], weighting: [], output: { verdict: 'MEDIUM', score: 50, summary: 'Stop 15%' } },
  { analyst: 'governance', name: 'Governance', stage: 3, instructions: '', inputs: [], weighting: [], output: { verdict: 'APPROVE', score: 75, summary: 'Approve' } },
];

describe('buildThesisSummary', () => {
  it('derives a scannable grid from analystTraces, excluding intake nodes', () => {
    const s = makeState({ analystTraces: TRACES as any });
    const out = buildThesisSummary(s, 'APPROVE', 0.75, 'Valuation stretched.');
    expect(out).not.toBeNull();
    expect(out!.decision).toBe('APPROVE');
    expect(out!.confidence).toBe(0.75);
    expect(out!.reasoning).toBe('Valuation stretched.');
    // orchestrator + data_ingestion are excluded; 4 verdict rows remain.
    expect(out!.rows.map((r) => r.analyst)).toEqual([
      'fundamental', 'technical', 'risk', 'governance',
    ]);
    expect(out!.rows[0]).toMatchObject({ verdict: 'BULLISH', score: 82 });
  });

  it('returns null when no traces carry a verdict (legacy parity)', () => {
    const s = makeState({ analystTraces: [] });
    const out = buildThesisSummary(s, 'REJECT', null, 'No reasoning');
    expect(out).toBeNull();
  });

  it('is additive and deterministic — same input yields identical output', () => {
    const a = makeState({ analystTraces: TRACES as any });
    const b = makeState({ analystTraces: TRACES as any });
    expect(buildThesisSummary(a, 'APPROVE', 0.75, 'R')).toEqual(
      buildThesisSummary(b, 'APPROVE', 0.75, 'R'),
    );
  });
});

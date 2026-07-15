// src/tests/governance.reflection.test.ts
// Phase G (governance reflection): governance emits a reflection note when the
// upstream analysts ran data-driven (ingested), and stays silent (parity) when
// they were seeded. Imports only the pure governance logic (→ shared/prompts).

import { governanceHandler } from '../registry/logic/governance';
import type { AgentState } from '../types/financial-analysis';
import type { NodeSurface } from '../registry/logic/shared';

const node: NodeSurface = {
  updateStep: (s, step) => ({ ...s, current_step: step }),
  addMessage: (s, role, content) => ({ ...s, messages: [...(s.messages || []), { role, content }] }),
  captureTrace: (s, trace) => ({ ...s, analystTraces: [...((s.analystTraces as any) || []), trace] }),
  emitProgress: () => {},
};

function baseState(): AgentState {
  return {
    messages: [], current_date: '2026-07-10', tickers: ['AAPL'], company_name: 'Apple',
    investment_thesis: '', final_decision: '', error: null, current_step: 'init', analystTraces: [],
  } as AgentState;
}

// A synthetic upstream technical trace that is data-driven (bars-derived).
function dataDrivenTrace(): any {
  return {
    analyst: 'technical',
    ticker: 'AAPL',
    output: {
      details: { analyses: { AAPL: { indicators: { source: 'yahoo', interval: '1d', bars_used: 260 } } } },
    },
  };
}

describe('Phase G: governance reflection', () => {
  it('emits a data-driven reflection note when upstream ran on ingested data', async () => {
    const state = baseState();
    (state as any).analystTraces = [dataDrivenTrace()];
    const out = await governanceHandler(state, node, { horizon: 'LONG_TERM', params: {} });
    const trace = out.analystTraces!.find((t: any) => t.analyst === 'governance')!;
    const note = trace.notes!.find((n: string) => n.includes('Data-driven review'));
    expect(note).toBeDefined();
    expect(note).toContain('technical');
    expect(note).toContain('yahoo');
    // The system message should also carry the reflection.
    const msg = out.messages!.find((m: any) => m.data?.reflection);
    expect(msg?.data.reflection).toBe(note);
  });

  it('PARITY: no data-driven upstream → no reflection note', async () => {
    const out = await governanceHandler(baseState(), node, { horizon: 'LONG_TERM', params: {} });
    const trace = out.analystTraces!.find((t: any) => t.analyst === 'governance')!;
    const note = trace.notes!.find((n: string) => n.includes('review'));
    expect(note).toBeUndefined();
    const msg = out.messages!.find((m: any) => m.data?.reflection);
    expect(msg).toBeUndefined();
  });
});

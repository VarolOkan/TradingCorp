// src/tests/bull-bear.test.ts
// Phase 1 (Bull/Bear Researcher debate): unit tests for the two declarative
// researchers + the governance gatekeeper's consumption of their output.
// Pure logic — no server / LangGraph / SQLite needed (mirrors
// governance.reflection.test.ts). Imports only the handlers.

import { declarativeHandler } from '../registry/logic/declarative';
import { governanceHandler } from '../registry/logic/governance';
import type { AgentState } from '../types/financial-analysis';
import type { AnalystDef } from '../types/registry';
import type { NodeSurface } from '../registry/logic/shared';
import { ANALYST_DEFS } from '../registry/analysts';

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

/** Run a researcher declaratively and return its produced state. */
async function runResearcher(id: 'bull_researcher' | 'bear_researcher', state: AgentState): Promise<AgentState> {
  const def = ANALYST_DEFS[id] as AnalystDef;
  return declarativeHandler(state, node, def, { horizon: 'LONG_TERM', params: {}, instrument: 'EQUITY' });
}

describe('Phase 1: Bull/Bear researchers', () => {
  it('bull_researcher produces a single bull_research trace with a verdict', async () => {
    const out = await runResearcher('bull_researcher', baseState());
    const trace = (out.analystTraces as any)!.find((t: any) => t.analyst === 'bull_researcher');
    expect(trace).toBeDefined();
    expect(trace.output.verdict).toMatch(/BULLISH|NEUTRAL|BEARISH/);
    expect(typeof trace.output.score).toBe('number');
    // Channel written on messages[].data.channels
    const msg = out.messages!.find((m: any) => Array.isArray(m.data?.channels) && m.data.channels.includes('bull_research'));
    expect(msg).toBeDefined();
    expect(msg.data.analyses.AAPL.verdict).toBe(trace.output.verdict);
  });

  it('bear_researcher produces a single bear_research trace with a verdict', async () => {
    const out = await runResearcher('bear_researcher', baseState());
    const trace = (out.analystTraces as any)!.find((t: any) => t.analyst === 'bear_researcher');
    expect(trace).toBeDefined();
    expect(trace.output.verdict).toMatch(/BULLISH|NEUTRAL|BEARISH/);
  });

  it('researchers are stage-3 debate nodes depending on the Analyst Team', () => {
    expect(ANALYST_DEFS.bull_researcher!.stage).toBe(3);
    expect(ANALYST_DEFS.bull_researcher!.dependsOn).toEqual(['fundamental', 'technical', 'sentiment']);
    expect(ANALYST_DEFS.bear_researcher!.stage).toBe(3);
    expect(ANALYST_DEFS.bear_researcher!.dependsOn).toEqual(['fundamental', 'technical', 'sentiment']);
  });

  it('governance reflects the debate (bull/bear notes + net lean) when present', async () => {
    let state = baseState();
    state = await runResearcher('bull_researcher', state);
    state = await runResearcher('bear_researcher', state);
    const out = await governanceHandler(state, node, { horizon: 'LONG_TERM', params: {} });
    const trace = out.analystTraces!.find((t: any) => t.analyst === 'governance')!;
    const notes = (trace.notes ?? []) as string[];
    expect(notes.some((n) => n.startsWith('Bull case:'))).toBe(true);
    expect(notes.some((n) => n.startsWith('Bear case:'))).toBe(true);
    expect(notes.some((n) => n.startsWith('Net debate lean:'))).toBe(true);
    // The debate is exposed on the governance output details + the message data.
    expect((trace.output as any).details.debate).toBeDefined();
    const msg = out.messages!.find((m: any) => m.data?.debate);
    expect(msg?.data.debate.length).toBeGreaterThan(0);
  });

  it('PARITY: governance with no debate channels emits no debate note', async () => {
    const out = await governanceHandler(baseState(), node, { horizon: 'LONG_TERM', params: {} });
    const trace = out.analystTraces!.find((t: any) => t.analyst === 'governance')!;
    const notes = (trace.notes ?? []) as string[];
    expect(notes.some((n) => n.startsWith('Bull case:') || n.startsWith('Bear case:'))).toBe(false);
    expect((trace.output as any).details.debate).toBeUndefined();
  });
});

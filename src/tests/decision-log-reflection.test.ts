// src/tests/decision-log-reflection.test.ts
// Phase 2 (decision-log reflection in governance): when a prior decision record
// exists for the ticker, governance injects an honest realised-return reflection
// into its trace notes + a system message. With NO prior record (parity), the
// output is unchanged from Phase 1.
import os from 'os';
import fs from 'fs';
import path from 'path';
import { governanceHandler } from '../registry/logic/governance';
import { appendDecision, type DecisionRecord } from '../server/decision-log';
import type { AgentState } from '../types/financial-analysis';
import type { NodeSurface } from '../registry/logic/shared';

const TMP = path.join(os.tmpdir(), `tc-reflect-${process.pid}-${Date.now()}.jsonl`);
process.env.DECISION_LOG_PATH = TMP;

const node: NodeSurface = {
  updateStep: (s, step) => ({ ...s, current_step: step }),
  addMessage: (s, role, content) => ({ ...s, messages: [...(s.messages || []), { role, content }] }),
  captureTrace: (s, trace) => ({ ...s, analystTraces: [...((s.analystTraces as any) || []), trace] }),
  emitProgress: () => {},
};

function baseState(ingested?: Record<string, number>): AgentState {
  const s = {
    messages: [], current_date: '2026-07-10', tickers: ['AAPL'], company_name: 'Apple',
    investment_thesis: '', final_decision: '', error: null, current_step: 'init', analystTraces: [],
  } as AgentState;
  if (ingested) {
    (s as any).ingested = {
      bars: Object.fromEntries(
        Object.entries(ingested).map(([t, price]) => [t, [{ close: price }]]),
      ),
      market: {}, fundamental: {}, sentiment: {}, source: 'mock' as const,
    };
  }
  return s;
}

afterAll(() => { fs.rmSync(TMP, { force: true }); });

describe('Phase 2: governance decision-log reflection', () => {
  it('PARITY: no prior record => no decision-log note (identical to Phase 1)', async () => {
    fs.rmSync(TMP, { force: true });
    const out = await governanceHandler(baseState({ AAPL: 100 }), node, { horizon: 'LONG_TERM', params: {} });
    const trace = out.analystTraces!.find((t: any) => t.analyst === 'governance')!;
    const decisionNote = trace.notes!.find((n: string) => n.includes('prior') || n.includes('Prior'));
    expect(decisionNote).toBeUndefined();
    const msg = out.messages!.find((m: any) => m.data?.decisionLog);
    expect(msg).toBeUndefined();
  });

  it('with a prior BULLISH/APPROVE record that lost money, flags the miss and adds a revisit condition', async () => {
    fs.rmSync(TMP, { force: true });
    const prior: DecisionRecord = {
      ts: '2026-07-01T00:00:00.000Z',
      tickers: ['AAPL'],
      agencyId: 'long-term',
      decision: 'APPROVE',
      confidence: 75,
      prices: { AAPL: 100 },
    };
    appendDecision(prior);
    // Current run: price dropped to 85 => -15% vs the 100 entry.
    const out = await governanceHandler(baseState({ AAPL: 85 }), node, { horizon: 'LONG_TERM', params: {} });
    const trace = out.analystTraces!.find((t: any) => t.analyst === 'governance')!;
    const note = trace.notes!.find((n: string) => n.includes('Prior AAPL call'));
    expect(note).toBeDefined();
    expect(note).toContain('down 15.0%');
    expect(note).toContain('subsequently lost money');
    expect(note).toContain('revisit the thesis');
    // Also surfaced as a system message + structured on the message data.
    const msg = out.messages!.find((m: any) => m.data?.decisionLog);
    expect(msg).toBeDefined();
    expect(msg!.data.decisionLog.some((n: string) => n.includes('Prior AAPL call'))).toBe(true);
  });

  it('with a prior REJECT that subsequently rose, notes the veto may have been too strict', async () => {
    fs.rmSync(TMP, { force: true });
    appendDecision({
      ts: '2026-07-01T00:00:00.000Z',
      tickers: ['AAPL'], agencyId: 'long-term', decision: 'REJECT', confidence: 80,
      prices: { AAPL: 100 },
    });
    const out = await governanceHandler(baseState({ AAPL: 120 }), node, { horizon: 'LONG_TERM', params: {} });
    const trace = out.analystTraces!.find((t: any) => t.analyst === 'governance')!;
    const note = trace.notes!.find((n: string) => n.includes('Prior AAPL call'));
    expect(note).toBeDefined();
    expect(note).toContain('up 20.0%');
    expect(note).toContain('too strict');
  });

  it('honest asOf: prior record with no price yields a note but no numeric return', async () => {
    fs.rmSync(TMP, { force: true });
    appendDecision({
      ts: '2026-07-01T00:00:00.000Z',
      tickers: ['AAPL'], agencyId: 'long-term', decision: 'APPROVE', confidence: 70,
    });
    const out = await governanceHandler(baseState(), node, { horizon: 'LONG_TERM', params: {} });
    const trace = out.analystTraces!.find((t: any) => t.analyst === 'governance')!;
    const note = trace.notes!.find((n: string) => n.includes('Prior AAPL call'));
    expect(note).toBeDefined();
    expect(note).toContain('No ingested price');
  });

  it('non-fatal: corrupt/!ENABLED log does not break governance', async () => {
    // Disable the feature entirely -> parity regardless of any prior record.
    process.env.DECISION_LOG_ENABLED = 'false';
    appendDecision({
      ts: '2026-07-01T00:00:00.000Z',
      tickers: ['AAPL'], agencyId: 'long-term', decision: 'APPROVE', confidence: 70,
      prices: { AAPL: 100 },
    });
    const out = await governanceHandler(baseState({ AAPL: 50 }), node, { horizon: 'LONG_TERM', params: {} });
    const trace = out.analystTraces!.find((t: any) => t.analyst === 'governance')!;
    expect(trace.notes!.find((n: string) => n.includes('Prior AAPL call'))).toBeUndefined();
    delete process.env.DECISION_LOG_ENABLED;
  });
});

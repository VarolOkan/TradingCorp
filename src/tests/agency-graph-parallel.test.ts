// src/tests/agency-graph-parallel.test.ts
// Phase B — parallel (fan-out/fan-in) graph execution.
import { describe, it, expect } from '@jest/globals';
import { AgencyGraph } from '../orchestration/agency-graph';
import { AGENCIES } from '../registry/agencies';
import type { AgentState } from '../types/financial-analysis';

function seedState(): AgentState {
  return {
    messages: [],
    tickers: ['AAPL'],
    options: { chain: {} as any },
    next: {},
    investment_thesis: '',
    current_step: '',
    dataHealth: null,
    analystTraces: [],
    runtimeConfig: null,
    progress: undefined,
  } as unknown as AgentState;
}

describe('AgencyGraph parallel execution', () => {
  it('serial graph still chains every analyst in order (parity shape)', () => {
    const g = new AgencyGraph(AGENCIES['long-term']!, { parallel: false });
    expect(g.parallel).toBe(false);
    expect(g.nodeOrder).toEqual([
      'orchestrator', 'data_ingestion', 'fundamental', 'technical', 'sentiment',
      'bull_researcher', 'bear_researcher', 'risk', 'governance',
    ]);
  });

  it('parallel graph marks parallel and keeps the same node set', () => {
    const g = new AgencyGraph(AGENCIES['long-term']!, { parallel: true });
    expect(g.parallel).toBe(true);
    expect(g.nodeOrder).toEqual([
      'orchestrator', 'data_ingestion', 'fundamental', 'technical', 'sentiment',
      'bull_researcher', 'bear_researcher', 'risk', 'governance',
    ]);
  });

  it('parallel run produces a completed decision with all analyst traces present', async () => {
    const g = new AgencyGraph(AGENCIES['long-term']!, { parallel: true });
    const result = await g.execute(seedState());
    expect(result.error).toBeFalsy();
    expect(result.final_decision).toBeTruthy();
    const analysts = (result.analystTraces ?? []).map((t: any) => t.analyst).sort();
    // Every analyst in the agency must have produced a trace.
    for (const id of ['data_ingestion', 'fundamental', 'technical', 'sentiment',
      'bull_researcher', 'bear_researcher', 'risk', 'governance']) {
      expect(analysts).toContain(id);
    }
  });

  it('parallel and serial runs yield the same set of analyst traces (parity)', async () => {
    const serial = await new AgencyGraph(AGENCIES['long-term']!, { parallel: false }).execute(seedState());
    const parallel = await new AgencyGraph(AGENCIES['long-term']!, { parallel: true }).execute(seedState());
    const sTraces = (serial.analystTraces ?? []).map((t: any) => t.analyst).sort();
    const pTraces = (parallel.analystTraces ?? []).map((t: any) => t.analyst).sort();
    expect(pTraces).toEqual(sTraces);
    expect(parallel.final_decision).toBe(serial.final_decision);
  });

  it('falls back to serial when a stage-2 analyst has live data sources (dataHealth safety)', () => {
    // Craft an agency where a stage-2 analyst carries a live source.
    const withLive = {
      ...AGENCIES['long-term']!,
      analysts: AGENCIES['long-term']!.analysts.map((a) =>
        a.id === 'fundamental'
          ? { ...a, dataSources: [{ id: 'yahoo', from: 'rest', endpoint: 'https://query1.finance.yahoo.com/v8/finance/quote', fields: ['price'], label: 'Y', sources: ['Yahoo'], type: 'rest' as const, auth: 'none' as const }] }
          : a,
      ),
    };
    const g = new AgencyGraph(withLive, { parallel: true });
    // canRunParallel refuses (live source on a parallel analyst) → serial wiring.
    expect(g.parallel).toBe(false);
  });
});

// src/tests/parity.test.ts
// Single-source-of-truth test for the long-term agency. The legacy
// hard-coded graph has been retired, so the registry `long-term` agency IS the
// pipeline. This test locks in: (1) the agency graph wires the expected node
// order, (2) it emits one trace per analyst, (3) it reaches a final decision,
// and (4) it is deterministic (two runs of the same input are byte-identical),
// which is the property the old legacy-vs-agency parity test guaranteed.

import { AgencyGraph } from '../orchestration/agency-graph';
import { buildLegacyGraph } from '../orchestration/financial-graph';
import { AGENCIES } from '../registry/agencies';
import { AgentState } from '../types/financial-analysis';

// Hermetic: parity locks the PURE agency graph (node order, traces,
// determinism). It must not read a real decision-log file left by other suites
// (e.g. the streaming integration test writes one via the server capture), or
// the Phase 2 governance reflection would change the governance trace. The
// decision-log reflection is covered by decision-log-reflection.test.ts.
beforeAll(() => { process.env.DECISION_LOG_ENABLED = 'false'; });
afterAll(() => { delete process.env.DECISION_LOG_ENABLED; });

function makeInitialState(tickers: string[]): AgentState {
  return {
    messages: [],
    current_date: '2026-07-09',
    tickers,
    company_name: tickers.join(', '),
    investment_thesis: '',
    final_decision: '',
    error: null,
    current_step: 'initializing',
  };
}

function normalize(state: AgentState): any {
  const clone: any = { ...state };
  delete clone.progress;
  return JSON.parse(
    JSON.stringify(clone, (_k, v) => {
      if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) return '<ts>';
      return v;
    }),
  );
}

const tickers = ['AAPL', 'MSFT', 'TSLA'];

describe('long-term agency (single runtime graph)', () => {
  it('wires the expected node order', () => {
    const agency = new AgencyGraph(AGENCIES['long-term']!);
    expect(agency.nodeOrder).toEqual([
      'orchestrator',
      'data_ingestion',
      'fundamental',
      'technical',
      'sentiment',
      'bull_researcher',
      'bear_researcher',
      'risk',
      'governance',
    ]);
  });

  it('runs end-to-end and emits one trace per analyst', async () => {
    const agency = new AgencyGraph(AGENCIES['long-term']!);
    const result = await agency.execute(makeInitialState(tickers));

    const traces = result.analystTraces || [];
    expect(traces.map((t: any) => t.analyst)).toEqual([
      'orchestrator',
      'data_ingestion',
      'fundamental',
      'technical',
      'sentiment',
      'bull_researcher',
      'bear_researcher',
      'risk',
      'governance',
    ]);
    expect(traces.length).toBe(9);
    expect(['APPROVE', 'REJECT']).toContain(result.final_decision);
    expect(result.error).toBeNull();
  });

  it('buildLegacyGraph() is the same long-term agency graph', () => {
    const legacy = buildLegacyGraph();
    expect(legacy).toBeInstanceOf(AgencyGraph);
    expect((legacy as AgencyGraph).nodeOrder).toEqual([
      'orchestrator',
      'data_ingestion',
      'fundamental',
      'technical',
      'sentiment',
      'bull_researcher',
      'bear_researcher',
      'risk',
      'governance',
    ]);
  });

  it('is deterministic (same input -> identical output)', async () => {
    const make = () => new AgencyGraph(AGENCIES['long-term']!);
    const a = await make().execute(makeInitialState(tickers));
    const b = await make().execute(makeInitialState(tickers));
    expect(normalize(b)).toEqual(normalize(a));
  });
});

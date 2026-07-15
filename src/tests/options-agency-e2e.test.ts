// src/tests/options-agency-e2e.test.ts
// Phase D STOP criterion: a request_analysis with agencyId:'options-intraday'
// (modelled here as building + executing the AgencyGraph for that agency)
// returns a populated final_decision AND option traces for every options
// analyst. Proves the full options pipeline runs end-to-end through governance.

import { AgencyGraph } from '../orchestration/agency-graph';
import { AGENCIES } from '../registry/agencies';
import { AgentState } from '../types/financial-analysis';

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

// The per-agency option analysts (everything except the framework
// orchestrator/governance nodes).
function optionAnalysts(agencyId: 'options-swing' | 'options-intraday'): string[] {
  const framework = new Set(['orchestrator', 'governance']);
  return AGENCIES[agencyId]!.analysts.map((r) => r.id).filter((id) => !framework.has(id));
}

describe('Phase D — options agency end-to-end (STOP criterion)', () => {
  it('options-intraday builds a valid 9-node graph (instrument OPTION)', () => {
    const agency = AGENCIES['options-intraday']!;
    expect(agency.instrument).toBe('OPTION');
    expect(agency.analysts.map((r) => r.id)).toEqual([
      'orchestrator', 'options_ingestion', 'options_technical', 'vol_surface',
      'options_pricing', 'options_greeks', 'options_flow', 'options_risk', 'governance',
    ]);
    const graph = new AgencyGraph(agency);
    expect(graph.nodeOrder).toEqual(agency.analysts.map((r) => r.id));
  });

  it('options-swing builds a valid 8-node graph (instrument OPTION)', () => {
    const agency = AGENCIES['options-swing']!;
    expect(agency.instrument).toBe('OPTION');
    const graph = new AgencyGraph(agency);
    expect(graph.nodeOrder).toEqual(agency.analysts.map((r) => r.id));
  });

  it('options-intraday runs end-to-end: populated final_decision + option traces', async () => {
    const graph = new AgencyGraph(AGENCIES['options-intraday']!);
    const result = await graph.execute(makeInitialState(['TSLA']));

    expect(result.error).toBeNull();
    expect(['APPROVE', 'REJECT']).toContain(result.final_decision);

    const traces = result.analystTraces ?? [];
    for (const id of optionAnalysts('options-intraday')) {
      expect(traces.filter((x: any) => x.analyst === id).length).toBe(1);
    }

    const gov = traces.find((x: any) => x.analyst === 'governance');
    expect(gov).toBeTruthy();
    expect(['APPROVE', 'REJECT']).toContain(gov!.output.verdict);
    expect(result.investment_thesis).toMatch(/OPTIONS/);
  });

  it('options-swing runs end-to-end: populated final_decision + option traces', async () => {
    const graph = new AgencyGraph(AGENCIES['options-swing']!);
    const result = await graph.execute(makeInitialState(['AAPL']));
    expect(result.error).toBeNull();
    expect(['APPROVE', 'REJECT']).toContain(result.final_decision);
    const traces = result.analystTraces ?? [];
    for (const id of optionAnalysts('options-swing')) {
      expect(traces.filter((x: any) => x.analyst === id).length).toBe(1);
    }
  });
});

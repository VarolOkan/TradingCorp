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

  it('provenance: options analysts + governance report seeded-parity when no live key (no silent live claim)', async () => {
    const graph = new AgencyGraph(AGENCIES['options-intraday']!);
    const result = await graph.execute(makeInitialState(['TSLA']));
    const traces = result.analystTraces ?? [];
    // No Polygon key in test env → deterministic mock bundle → every options
    // analyst must be honestly flagged seeded-parity (never read as live data).
    for (const id of optionAnalysts('options-intraday')) {
      const t = traces.find((x: any) => x.analyst === id);
      expect(t).toBeTruthy();
      expect(t!.dataProvenance).toBe('seeded-parity');
    }
    const gov = traces.find((x: any) => x.analyst === 'governance');
    expect(gov!.dataProvenance).toBe('seeded-parity');
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

  it('RESILIENCE: a total ingestion failure must NOT abort the pipeline (all analysts run on seeded parity)', async () => {
    // Reproduces the live symptom: when no live chain can be fetched
    // (no Polygon key AND the CBOE/Yahoo fallback throws instead of
    // degrading to mock), options_ingestion throws entirely. Before the
    // fix its catch returned an error state WITHOUT setting
    // state.optionsData, so every downstream options analyst received
    // bundle=undefined and threw too — only the orchestrator "ran"
    // and the rest of the pipeline aborted. Assert the fix: all 9
    // analysts still complete, flagged seeded-parity (honest, not live).
    const mod = await import('../registry/sources/adapters/option-chain');
    const spy = jest.spyOn(mod, 'resolveLiveOptionsBundle').mockRejectedValue(
      new Error('network disabled in test environment'),
    );
    try {
      const graph = new AgencyGraph(AGENCIES['options-intraday']!);
      const result = await graph.execute(makeInitialState(['TSLA']));
      const traces = (result.analystTraces ?? []) as any[];
      // Every analyst (incl. all stage-2/3 options analysts) completed.
      for (const id of optionAnalysts('options-intraday')) {
        const t = traces.filter((x) => x.analyst === id);
        expect(t.length).toBe(1);
        expect(t[0].error).toBeUndefined();
      }
      // The degraded run is honestly flagged, never claimed as live.
      const ing = traces.find((x) => x.analyst === 'options_ingestion');
      expect(ing.dataProvenance).toBe('seeded-parity');
      for (const id of optionAnalysts('options-intraday')) {
        const t = traces.find((x) => x.analyst === id);
        expect(t.dataProvenance).toBe('seeded-parity'); // ${id} must not claim live
      }
      // The pipeline still reaches a decision (not a workflow_error).
      expect(result.error).toBeNull();
      expect(['APPROVE', 'REJECT']).toContain(result.final_decision);
    } finally {
      spy.mockRestore();
    }
  });
});

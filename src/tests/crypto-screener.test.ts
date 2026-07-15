// src/tests/crypto-screener.test.ts
// Phase 4: proves the crypto-screener agency — a 4-node agency with a
// brand-new declarative `onchain` analyst (no TS handler) — builds a valid
// graph and runs end-to-end, emitting well-formed traces including a
// declarative onchain trace with a computed score + verdict.

import { AgencyGraph } from '../orchestration/agency-graph';
import { AGENCIES } from '../registry/agencies';
import { resolveAnalystDef } from '../types/registry';
import { ANALYST_DEFS } from '../registry/analysts';
import { validateAllAgencies, validateAllAnalysts } from '../registry/validate';
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

describe('Phase 4 — crypto-screener agency (variable composition)', () => {
  it('all analysts + agencies still validate (no regressions)', () => {
    expect(validateAllAnalysts()).toEqual([]);
    expect(validateAllAgencies()).toEqual([]);
  });

  it('crypto-screener has exactly 4 nodes, including the new onchain analyst', () => {
    const agency = AGENCIES['crypto-screener']!;
    const ids = agency.analysts.map((r) => r.id);
    expect(ids).toEqual(['data_ingestion', 'onchain', 'sentiment', 'governance']);
    expect(ids).toContain('onchain');
  });

  it('onchain is a declarative analyst with no fn handler', () => {
    const def = ANALYST_DEFS['onchain']!;
    expect(def.logic.mode).toBe('declarative');
    expect(def.logic.fn).toBeUndefined();
    // weighting weights sum to ~1.0 (validation-enforced)
    const total = (def.logic.weighting ?? []).reduce((s, w) => s + w.weight, 0);
    expect(Math.abs(total - 1.0)).toBeLessThan(0.02);
  });

  it('builds a valid graph (node order = agency order)', () => {
    const agency = AGENCIES['crypto-screener']!;
    const graph = new AgencyGraph(agency);
    expect(graph.nodeOrder).toEqual(['data_ingestion', 'onchain', 'sentiment', 'governance']);
  });

  it('runs end-to-end and emits a declarative onchain trace with score + verdict', async () => {
    const agency = AGENCIES['crypto-screener']!;
    const graph = new AgencyGraph(agency);
    const result = await graph.execute(makeInitialState(['BTC', 'ETH']));

    // No error — the run completed.
    expect(result.error).toBeNull();

    // The declarative onchain analyst produced a trace.
    const onchainTraces = (result.analystTraces || []).filter((t: any) => t.analyst === 'onchain');
    expect(onchainTraces.length).toBe(1);
    const trace = onchainTraces[0]!;
    expect(typeof trace.output.score).toBe('number');
    expect(['BULLISH', 'BEARISH', 'NEUTRAL']).toContain(trace.output.verdict);
    expect(trace.output.summary).toContain(String(trace.output.score));
    // weighting steps recorded for traceability
    expect(Array.isArray(trace.weighting)).toBe(true);
    expect(trace.weighting.length).toBe(2);
  });

  it('resolveAnalystDef merges overrides (sentiment social-heavy, governance fail policy)', () => {
    const agency = AGENCIES['crypto-screener']!;
    const sentimentRef = agency.analysts.find((r) => r.id === 'sentiment')!;
    const governanceRef = agency.analysts.find((r) => r.id === 'governance')!;
    const sentiment = resolveAnalystDef(sentimentRef, ANALYST_DEFS);
    const governance = resolveAnalystDef(governanceRef, ANALYST_DEFS);
    expect(governance.onAllSourcesFailed?.action).toBe('fail');
    // (sentiment's sourceMix override is carried on the AgencyAnalystRef.params,
    // not on the resolved AnalystDef — assert on the ref.)
    expect((sentimentRef.params as Record<string, unknown>)).toEqual({ sourceMix: 'social-heavy' });
  });
});

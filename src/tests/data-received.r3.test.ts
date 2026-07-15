// src/tests/data-received.r3.test.ts
// Phase R3 (RAW_DATA_DUMP.md): the options ingestion analyst and the 6 fn
// options analysts record their consumed `optionsData` slices (option_chain /
// greeks / underlying / iv_history) on state.dataReceived, so the export can
// show per-analyst exactly the derivatives data behind each verdict.
import { makeNodeSurface } from '../registry/logic/shared';
import { optionsIngestionHandler } from '../registry/logic/options-handlers';
import { optionsGreeksHandler, optionsPricingHandler, volSurfaceHandler, optionsRiskHandler } from '../registry/logic/options-handlers';
import type { AgentState } from '../types/financial-analysis';

function baseState(tickers: string[]): AgentState {
  return {
    messages: [], current_date: '2026-07-11', tickers, company_name: 'Test',
    investment_thesis: '', final_decision: '', error: null, current_step: 'start',
  };
}

function byAnalyst(state: AgentState): Record<string, any[]> {
  const out: Record<string, any[]> = {};
  for (const e of state.dataReceived ?? []) (out[e.analyst] ??= []).push(e);
  return out;
}

function domainsOf(entry: any): string[] {
  return entry.blocks.map((b: any) => b.domain);
}

describe('Phase R3 — options handlers record dataReceived', () => {
  const node = makeNodeSurface();
  const ticker = 'TSLA';

  it('options_ingestion records the raw derivatives slices it collected', async () => {
    const out = await optionsIngestionHandler(baseState([ticker]), node, { horizon: 'MEDIUM_TERM', params: {} } as any);
    const e = byAnalyst(out)['options_ingestion']![0];
    expect(e.channel).toBe('optionsData');
    const d = domainsOf(e);
    expect(d).toContain('option_chain');
    expect(d).toContain('greeks');
    expect(d).toContain('underlying');
    // rows + barsUsed are populated
    const chain = e.blocks.find((b: any) => b.domain === 'option_chain');
    const und = e.blocks.find((b: any) => b.domain === 'underlying');
    expect(chain.rows).toBeGreaterThan(0);
    expect(und.barsUsed).toBeGreaterThan(0);
    // deterministic mock → provenance 'mock' in this sandbox (no live keys)
    expect(['live', 'mock', 'mixed']).toContain(e.provenance);
  });

  it('a fn options analyst records the optionsData slices it received', async () => {
    // With no upstream options_ingestion, the fn analyst regenerates the
    // deterministic bundle via hist.ts — still records what it received.
    const out = await optionsGreeksHandler(baseState([ticker]), node, { horizon: 'MEDIUM_TERM', params: {} } as any);
    const e = byAnalyst(out)['options_greeks']![0];
    expect(e.channel).toBe('optionsData');
    const d = domainsOf(e);
    expect(d).toContain('option_chain');
    expect(d).toContain('greeks');
    expect(d).toContain('underlying');
    expect(e.provenance).toBe('mock');
  });

  it('all 6 fn options analysts emit an optionsData entry on a run', async () => {
    let state = baseState([ticker]);
    state = await volSurfaceHandler(state, node, { horizon: 'MEDIUM_TERM', params: {} } as any);
    state = await optionsPricingHandler(state, node, { horizon: 'MEDIUM_TERM', params: {} } as any);
    state = await optionsGreeksHandler(state, node, { horizon: 'MEDIUM_TERM', params: {} } as any);
    state = await optionsRiskHandler(state, node, { horizon: 'MEDIUM_TERM', params: {} } as any);
    const seen = Object.keys(byAnalyst(state)).sort();
    expect(seen).toEqual(['options_greeks', 'options_pricing', 'options_risk', 'vol_surface'].sort());
    for (const a of seen) {
      const entry = byAnalyst(state)[a]![0]!;
      expect(entry.channel).toBe('optionsData');
      expect(domainsOf(entry)).toContain('greeks');
    }
  });

  it('downstream fn analysts reuse the ingested bundle (single writer) when ingestion ran first', async () => {
    let state = await optionsIngestionHandler(baseState([ticker]), node, { horizon: 'MEDIUM_TERM', params: {} } as any);
    const before = byAnalyst(state)['options_ingestion']![0];
    state = await optionsGreeksHandler(state, node, { horizon: 'MEDIUM_TERM', params: {} } as any);
    const after = byAnalyst(state)['options_greeks']![0];
    // Both reference the same ingested source
    expect(after.blocks.find((b: any) => b.domain === 'greeks').source)
      .toBe(before.blocks.find((b: any) => b.domain === 'greeks').source);
  });
});

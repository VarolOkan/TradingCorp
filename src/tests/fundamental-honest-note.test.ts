// src/tests/fundamental-honest-note.test.ts
// Verifies the Fundamental Analyst's trace note is SEMANTICALLY HONEST:
// it must reflect the data the analyst actually consumed, never a hardcoded
// "Mock data" label. Mirrors the technical-realbars honest-note test.
import { makeNodeSurface } from '../registry/logic/shared';
import { fundamentalHandler } from '../registry/logic/fundamental';
import type { AgentState } from '../types/financial-analysis';
import type { PriceBar } from '../types/financial-analysis';

function baseState(tickers: string[]): AgentState {
  return {
    messages: [], current_date: '2026-07-17', tickers, company_name: 'Test',
    investment_thesis: '', final_decision: '', error: null, current_step: 'start',
  };
}

function getTrace(out: any) {
  return out.analystTraces?.find((x: any) => x.analyst === 'fundamental');
}

describe('Fundamental Analyst — honest trace notes', () => {
  const node = makeNodeSurface();

  it('reports LIVE when real fundamental data is supplied upstream', async () => {
    const state = baseState(['AAPL']);
    state.ingested = {
      fundamental: { AAPL: { key_ratios: { debt_to_equity: 0.4, current_ratio: 1.8, roe: 0.2, profit_margin: 0.18 }, financial_health_score: 81 } },
      bars: {}, sentiment: {}, source: 'yahoo',
    } as any;
    const out: any = await fundamentalHandler(state, node, { horizon: 'LONG_TERM', params: {} } as any);
    const trace = getTrace(out);
    expect(trace).toBeDefined();
    // No false "Mock data" label.
    expect(trace.notes.some((n: string) => /Mock data/.test(n))).toBe(false);
    // Honest live note + auditable claim.
    expect(trace.notes.some((n: string) => /live market data/.test(n))).toBe(true);
    expect(trace.notes.some((n: string) => /auditable/.test(n))).toBe(true);
    // Input source label must not list a fictional "Finnhub (mock)".
    const src = trace.inputs[0].sources as string[];
    expect(src.some((s: string) => /Finnhub/.test(s))).toBe(false);
    expect(src.some((s: string) => /live fundamentals/.test(s))).toBe(true);
  });

  it('reports a price-proxy note when only bars are ingested', async () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + i); // uptrend
    const barsSeries: PriceBar[] = closes.map((c, i) => ({
      t: `2026-${String((i % 12) + 1).padStart(2, '0')}-01`,
      open: c - 1, high: c + 2, low: c - 2, close: c, volume: 1000 + i,
    }));
    const state = baseState(['AAPL']);
    state.ingested = {
      fundamental: {}, bars: { AAPL: [{ interval: '1d', lookback_days: 365, bars: barsSeries }] },
      sentiment: {}, source: 'yahoo',
    } as any;
    const out: any = await fundamentalHandler(state, node, { horizon: 'LONG_TERM', params: {} } as any);
    const trace = getTrace(out);
    expect(trace.notes.some((n: string) => /price-action proxy/.test(n))).toBe(true);
    expect(trace.notes.some((n: string) => /Mock data/.test(n))).toBe(false);
  });

  it('honestly reports seeded fallback when no data is ingested', async () => {
    const state = baseState(['AAPL']); // no state.ingested
    const out: any = await fundamentalHandler(state, node, { horizon: 'LONG_TERM', params: {} } as any);
    const trace = getTrace(out);
    // Honest seeded-fallback note (still no false "Mock data" fiction that
    // contradicts the data — here it correctly says seeded parity fallback).
    expect(trace.notes.some((n: string) => /seeded parity fallback/.test(n))).toBe(true);
  });

  it('does not emit the legacy hardcoded mock string under any path', async () => {
    const node2 = makeNodeSurface();
    const legacy = 'Mock data — replace performFundamentalAnalysis with a real data source to make findings auditable.';
    for (const ingested of [
      undefined,
      { fundamental: { AAPL: { key_ratios: {}, financial_health_score: 70 } }, bars: {}, sentiment: {}, source: 'yahoo' } as any,
      { fundamental: {}, bars: {}, sentiment: {}, source: 'mock' } as any,
    ]) {
      const s = baseState(['AAPL']);
      (s as any).ingested = ingested;
      const out: any = await fundamentalHandler(s, node2, { horizon: 'LONG_TERM', params: {} } as any);
      const trace = getTrace(out);
      expect(trace.notes).not.toContain(legacy);
    }
  });
});

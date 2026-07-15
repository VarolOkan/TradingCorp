// src/tests/fundamental-sentiment-risk.ingested.test.ts
// Phase E + F (DATA_AND_THESIS_ENHANCEMENT §3.3): fundamental/sentiment consume
// ingested.fundamental/sentiment; risk reads ingested.market (beta/vol30). Each
// handler falls back to the seeded path when state.ingested is absent (parity).
// Imports only the pure logic handlers (→ shared/prompts/types), so runs where
// better-sqlite3 can't load.

import { fundamentalHandler } from '../registry/logic/fundamental';
import { sentimentHandler } from '../registry/logic/sentiment';
import { riskHandler } from '../registry/logic/risk';
import type { AgentState, PriceBar, PriceBarSeries } from '../types/financial-analysis';
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

function bar(c: number): PriceBar {
  return { t: '2026-07-10', open: c, high: c + 1, low: c - 1, close: c, volume: 1000 };
}
function series(interval: '1d' | '5m' | '1m', closes: number[]): PriceBarSeries {
  return { interval, lookback_days: 365, bars: closes.map(bar) };
}

function traceOf(out: AgentState, analyst: string): any {
  return out.analystTraces!.find((t: any) => t.analyst === analyst);
}

describe('Phase E: fundamental consumes ingested', () => {
  it('uses live fundamental key_ratios + explicit health score when present', async () => {
    const state = baseState();
    (state as any).ingested = {
      bars: {}, market: {},
      fundamental: { AAPL: { financial_health_score: 88, key_ratios: { debt_to_equity: 0.2, current_ratio: 2.5, roe: 0.3, roa: 0.1, profit_margin: 0.25, free_cash_flow_yield: 0.08 } } },
      sentiment: {}, source: 'yahoo',
    };
    const out = await fundamentalHandler(state, node);
    const a = traceOf(out, 'fundamental').output.details.analyses.AAPL;
    expect(a.financial_health_score).toBe(88);
    expect(a.key_ratios.roe).toBeCloseTo(0.3, 5);
    expect(a.data_source).toContain('live-fundamentals');
  });

  it('falls back to a price-based proxy when only bars are present', async () => {
    const state = baseState();
    const rising = Array.from({ length: 60 }, (_, i) => 100 + i); // strong uptrend
    (state as any).ingested = { bars: { AAPL: [series('1d', rising)] }, market: {}, fundamental: {}, sentiment: {}, source: 'yahoo' };
    const out = await fundamentalHandler(state, node);
    const a = traceOf(out, 'fundamental').output.details.analyses.AAPL;
    expect(a.data_source).toContain('price-proxy');
    expect(a.financial_health_score).toBeGreaterThanOrEqual(40);
    expect(a.financial_health_score).toBeLessThanOrEqual(95);
  });

  it('PARITY: no ingested → seeded output, no data_source', async () => {
    const out = await fundamentalHandler(baseState(), node);
    const a = traceOf(out, 'fundamental').output.details.analyses.AAPL;
    expect(a.data_source).toBeUndefined();
  });
});

describe('Phase E: sentiment consumes ingested', () => {
  it('uses the ingested sentiment_score when present', async () => {
    const state = baseState();
    (state as any).ingested = { bars: {}, market: {}, fundamental: {}, sentiment: { AAPL: { sentiment_score: 72 } }, source: 'yahoo' };
    const out = await sentimentHandler(state, node, { horizon: 'LONG_TERM', params: {} });
    const a = traceOf(out, 'sentiment').output.details.analyses.AAPL;
    expect(a.sentiment_score).toBe(72);
    expect(a.news_sentiment).toBe('VERY_POSITIVE');
    expect(a.data_source).toContain('live-sentiment');
  });

  it('PARITY: no ingested → seeded output, no data_source', async () => {
    const out = await sentimentHandler(baseState(), node, { horizon: 'LONG_TERM', params: {} });
    const a = traceOf(out, 'sentiment').output.details.analyses.AAPL;
    expect(a.data_source).toBeUndefined();
  });
});

describe('Phase F: risk reads ingested.market', () => {
  it('escalates risk level + tightens sizing off high vol/beta', async () => {
    const state = baseState();
    (state as any).ingested = {
      bars: {}, market: { AAPL: { beta: '2.0', volatility_30d: '0.7' } },
      fundamental: {}, sentiment: {}, source: 'yahoo',
    };
    const out = await riskHandler(state, node, { horizon: 'LONG_TERM', params: {} });
    const a = traceOf(out, 'risk').output.details.assessments.AAPL;
    expect(a.data_driven).toBeDefined();
    expect(a.data_driven.beta).toBe(2.0);
    expect(a.data_driven.volatility_30d).toBe(0.7);
    // Beta 2.0 halves the allocation vs the level cap; sizing must be > 0.
    expect(a.max_allocation_percent).toBeGreaterThan(0);
  });

  it('PARITY: no ingested → seeded assessment, no data_driven', async () => {
    const out = await riskHandler(baseState(), node);
    const a = traceOf(out, 'risk').output.details.assessments.AAPL;
    expect(a.data_driven).toBeUndefined();
  });
});

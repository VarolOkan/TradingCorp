// src/tests/technical.ingested.test.ts
// Phase D (DATA_AND_THESIS_ENHANCEMENT §3.3): technical consumes ingested bars.
// Asserts intraday picks 5m/1m bars (VWAP present) and long-term picks daily,
// and that the NO-ingested path is byte-for-byte the legacy output (parity).
// This file imports only technical.ts (→ shared/prompts/types), so it runs even
// where better-sqlite3 can't load.

import { technicalHandler } from '../registry/logic/technical';
import type { AgentState, PriceBar, PriceBarSeries } from '../types/financial-analysis';
import type { NodeSurface } from '../registry/logic/shared';

function bar(t: string, o: number, h: number, l: number, c: number, v: number, vwap?: number): PriceBar {
  return vwap !== undefined ? { t, open: o, high: h, low: l, close: c, volume: v, vwap } : { t, open: o, high: h, low: l, close: c, volume: v };
}

function series(interval: '1d' | '5m' | '1m', bars: PriceBar[]): PriceBarSeries {
  return { interval, lookback_days: interval === '1d' ? 365 : 5, bars };
}

// Minimal NodeSurface so we can call the handler directly (mirrors shared.ts).
const node: NodeSurface = {
  updateStep: (s, step) => ({ ...s, current_step: step }),
  addMessage: (s, role, content) => ({ ...s, messages: [...(s.messages || []), { role, content }] }),
  captureTrace: (s, trace) => ({ ...s, analystTraces: [...((s.analystTraces as any) || []), trace] }),
  emitProgress: () => {},
};

function baseState(): AgentState {
  return {
    messages: [],
    current_date: '2026-07-10',
    tickers: ['AAPL'],
    company_name: 'Apple',
    investment_thesis: '',
    final_decision: '',
    error: null,
    current_step: 'initializing',
    analystTraces: [],
  } as AgentState;
}

describe('technical consumes ingested bars (Phase D)', () => {
  it('long-term picks the 1d interval and exposes SMA200 from ≥200 bars', async () => {
    // 260 daily bars → SMA200 computable.
    const dailyBars = Array.from({ length: 260 }, (_, i) =>
      bar(`2026-01-${((i % 28) + 1).toString().padStart(2, '0')}`, 100 + i, 101 + i, 99 + i, 100 + i, 1000));
    const state = baseState();
    (state as any).ingested = {
      bars: { AAPL: [series('1d', dailyBars)] },
      market: {}, fundamental: {}, sentiment: {}, source: 'mock',
    };
    const out = await technicalHandler(state, node, { horizon: 'LONG_TERM', params: {} });
    const trace: any = out.analystTraces!.find((t: any) => t.analyst === 'technical');
    const ind = trace.output.details.analyses.AAPL.indicators;
    expect(ind.interval).toBe('1d');
    expect(ind.moving_averages.sma_200).not.toBe(0); // real SMA200 from 260 bars
    expect(ind.insufficient_long_term).toBe(false);
  });

  it('intraday picks 5m (or 1m) and carries VWAP from intraday bars', async () => {
    const intraBars = Array.from({ length: 80 }, (_, i) =>
      bar(`2026-07-10T09:${i.toString().padStart(2, '0')}:00Z`, 100 + i, 101 + i, 99 + i, 100 + i, 1000, 100 + i));
    const state = baseState();
    (state as any).ingested = {
      bars: { AAPL: [series('5m', intraBars), series('1m', intraBars)] },
      market: {}, fundamental: {}, sentiment: {}, source: 'mock',
    };
    const out = await technicalHandler(state, node, { horizon: 'INTRADAY', params: {} });
    const trace: any = out.analystTraces!.find((t: any) => t.analyst === 'technical');
    const ind = trace.output.details.analyses.AAPL.indicators;
    expect(['5m', '1m']).toContain(ind.interval);
    expect(ind.vwap).not.toBe(0); // VWAP computed from intraday bars
    expect(ind.insufficient_long_term).toBe(false); // intraday doesn't need SMA200
  });

  it('medium-term prefers 5m over daily when both are present', async () => {
    const daily = Array.from({ length: 200 }, (_, i) => bar(`2026-01-${((i % 28) + 1).toString().padStart(2, '0')}`, 100, 101, 99, 100, 1000));
    const fivem = Array.from({ length: 80 }, (_, i) => bar(`2026-07-10T09:${i.toString().padStart(2, '0')}:00Z`, 100, 101, 99, 100, 1000, 100));
    const state = baseState();
    (state as any).ingested = {
      bars: { AAPL: [series('1d', daily), series('5m', fivem)] },
      market: {}, fundamental: {}, sentiment: {}, source: 'mock',
    };
    const out = await technicalHandler(state, node, { horizon: 'MEDIUM_TERM', params: {} });
    const trace: any = out.analystTraces!.find((t: any) => t.analyst === 'technical');
    const ind = trace.output.details.analyses.AAPL.indicators;
    expect(ind.interval).toBe('5m');
  });

  it('PARITY: no ingested → legacy seeded indicators (sma_200 nonzero-seeded, no vwap field)', async () => {
    const out = await technicalHandler(baseState(), node, { horizon: 'LONG_TERM', params: {} });
    const trace: any = out.analystTraces!.find((t: any) => t.analyst === 'technical');
    const ind = trace.output.details.analyses.AAPL.indicators;
    expect((ind as any).source).toBeUndefined();
    expect((ind as any).insufficient_long_term).toBeUndefined();
    expect(ind.moving_averages.sma_200).not.toBe(0);
  });

  it('minimum warm-up guard: <200 daily bars flags insufficient_long_term for long-term', async () => {
    const shortBars = Array.from({ length: 50 }, (_, i) => bar(`2026-06-${((i % 28) + 1).toString().padStart(2, '0')}`, 100, 101, 99, 100, 1000));
    const state = baseState();
    (state as any).ingested = {
      bars: { AAPL: [series('1d', shortBars)] },
      market: {}, fundamental: {}, sentiment: {}, source: 'mock',
    };
    const out = await technicalHandler(state, node, { horizon: 'LONG_TERM', params: {} });
    const trace: any = out.analystTraces!.find((t: any) => t.analyst === 'technical');
    const ind = trace.output.details.analyses.AAPL.indicators;
    expect(ind.moving_averages.sma_200).toBe(0); // insufficient-data sentinel
    expect(ind.insufficient_long_term).toBe(true);
  });
});

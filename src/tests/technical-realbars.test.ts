// src/tests/technical-realbars.test.ts
// 2.1 — verifies the technical analyst is fully data-driven from real OHLCV
// bars (trend / momentum / volatility / support-resistance derived from price
// history, not RNG) and that provenance notes are honest. Also verifies the
// ingestion layer honors the horizon profile (real 5m/1m intervals, not a
// hardcoded 1y/1d).
import { makeNodeSurface } from '../registry/logic/shared';
import { technicalHandler } from '../registry/logic/technical';
import { fetchRealFinancialData } from '../registry/logic/data-ingestion';
import type { AgentState } from '../types/financial-analysis';
import type { PriceBar } from '../types/financial-analysis';

function baseState(tickers: string[]): AgentState {
  return {
    messages: [], current_date: '2026-07-11', tickers, company_name: 'Test',
    investment_thesis: '', final_decision: '', error: null, current_step: 'start',
  };
}

// Deterministic daily bars. `shape` controls the close path.
function bars(ticker: string, shape: 'uptrend' | 'downtrend' | 'flat', n = 252): {
  bars: { [k: string]: { interval: '1d'; lookback_days: number; bars: PriceBar[] }[] };
  market: { [k: string]: any };
  fundamental: { [k: string]: any };
  sentiment: { [k: string]: any };
  source: 'yahoo';
} {
  const closes = Array.from({ length: n }, (_, i) => {
    if (shape === 'uptrend') return 100 + i;            // 100 → 351 strictly rising
    if (shape === 'downtrend') return 400 - i;           // 400 → 149 strictly falling
    return 200 + Math.sin(i / 8) * 3;                    // gentle oscillation
  });
  const barsSeries: PriceBar[] = closes.map((c, i) => ({
    t: `2026-${String((i % 12) + 1).padStart(2, '0')}-01`,
    open: c - 1, high: c + 2, low: c - 2, close: c, volume: 1000 + i,
  }));
  return {
    bars: { [ticker]: [{ interval: '1d', lookback_days: 365, bars: barsSeries }] },
    market: { [ticker]: { price: closes[n - 1], day_high: closes[n - 1] + 2, day_low: closes[n - 1] - 2, volume: 1_000_000, interval: '1d', bars_used: n, beta: 1.2, volatility_30d: 0.3 } },
    fundamental: {},
    sentiment: {},
    source: 'yahoo',
  };
}

// Pull the per-ticker analysis map from the technical handler's system message
// (the handler stores results in messages[].data.analyses, not on state).
function getAnalyses(out: any): Record<string, any> {
  const msg = out.messages?.find((m: any) => m.data?.analyses);
  return msg?.data?.analyses ?? {};
}

describe('2.1 — technical analyst is data-driven from real bars', () => {
  const node = makeNodeSurface();

  it('classifies a strictly rising series as uptrend (deterministic, no RNG)', async () => {
    const state = baseState(['AAPL']);
    state.ingested = bars('AAPL', 'uptrend') as any;
    const out: any = await technicalHandler(state, node, { horizon: 'LONG_TERM', params: {} } as any);
    const t = getAnalyses(out)['AAPL'];
    expect(t.trend_analysis).toMatch(/uptrend/i);
    expect(t.trend_analysis).toMatch(/higher highs and higher lows/);
    // Price sits above every MA → bullish score band.
    expect(t.technical_score).toBeGreaterThanOrEqual(60);
  });

  it('classifies a strictly falling series as downtrend', async () => {
    const state = baseState(['AAPL']);
    state.ingested = bars('AAPL', 'downtrend') as any;
    const out: any = await technicalHandler(state, node, { horizon: 'LONG_TERM', params: {} } as any);
    const t = getAnalyses(out)['AAPL'];
    expect(t.trend_analysis).toMatch(/downtrend/i);
    expect(t.technical_score).toBeLessThan(50);
  });

  it('derives support/resistance from actual bar highs/lows (not seeded)', async () => {
    const state = baseState(['AAPL']);
    state.ingested = bars('AAPL', 'uptrend') as any;
    const out: any = await technicalHandler(state, node, { horizon: 'LONG_TERM', params: {} } as any);
    const sr = getAnalyses(out)['AAPL'].support_resistance;
    // Last close = 351; bars range 98..353. Support must be ≤ close, resistance ≥ close.
    sr.support_levels.forEach((s: number) => expect(s).toBeLessThanOrEqual(351.01));
    sr.resistance_levels.forEach((r: number) => expect(r).toBeGreaterThanOrEqual(350.99));
    expect(sr.support_levels.length).toBeGreaterThan(0);
    expect(sr.resistance_levels.length).toBeGreaterThan(0);
  });

  it('produces an honest provenance note when real bars are used', async () => {
    const state = baseState(['AAPL']);
    state.ingested = bars('AAPL', 'uptrend') as any;
    const out: any = await technicalHandler(state, node, { horizon: 'LONG_TERM', params: {} } as any);
    const trace = out.analystTraces?.find((x: any) => x.analyst === 'technical');
    expect(trace?.notes?.some((n: string) => /derived from real Yahoo OHLCV bars/.test(n))).toBe(true);
  });

  it('falls back to seeded parity + honest note when no bars ingested', async () => {
    const state = baseState(['AAPL']); // no state.ingested
    const out: any = await technicalHandler(state, node, { horizon: 'LONG_TERM', params: {} } as any);
    const t = getAnalyses(out)['AAPL'];
    // Seed path still yields a structurally valid verdict.
    expect(t).toHaveProperty('technical_score');
    const trace = out.analystTraces?.find((x: any) => x.analyst === 'technical');
    expect(trace?.notes?.some((n: string) => /seeded fallback/.test(n))).toBe(true);
  });

  it('is deterministic for the same bars (no RNG drift)', async () => {
    const mk = async () => {
      const s = baseState(['AAPL']); s.ingested = bars('AAPL', 'flat') as any;
      const o: any = await technicalHandler(s, node, { horizon: 'LONG_TERM', params: {} } as any);
      return getAnalyses(o)['AAPL'];
    };
    const a = await mk();
    const b = await mk();
    expect(a.trend_analysis).toBe(b.trend_analysis);
    expect(a.technical_score).toBe(b.technical_score);
    expect(JSON.stringify(a.support_resistance)).toBe(JSON.stringify(b.support_resistance));
  });
});

describe('2.1 — ingestion honors the horizon profile (real intervals)', () => {
  it('fetches the profile interval (5m) and range (5d) from Yahoo, not 1y/1d', async () => {
    const closes = Array.from({ length: 60 }, (_, i) => 150 + i * 0.5);
    let calledUrl = '';
    const liveFetch = async (url: string) => {
      calledUrl = url;
      return {
        ok: true, status: 200,
        json: async () => ({
          chart: { result: [{
            meta: { previousClose: 150, fiftyTwoWeekHigh: 200, fiftyTwoWeekLow: 100, currency: 'USD' },
            timestamp: closes.map((_, i) => i + 1),
            indicators: { quote: [{ open: closes.map((c) => c - 1), high: closes.map((c) => c + 2), low: closes.map((c) => c - 2), close: closes, volume: closes.map((_, i) => 1000 + i) }] },
          }] },
        }),
      };
    };
    const out = await fetchRealFinancialData(
      { tickers: ['AAPL'] },
      liveFetch as any,
      { intervals: ['5m'], lookbackDays: 5 },
    );
    expect(calledUrl).toContain('interval=5m');
    expect(calledUrl).toContain('range=5d');
    expect(out.data_quality.liveSources).toContain('yahoo');
    expect(out.market_data.AAPL.price).toBeCloseTo(closes[closes.length - 1], 1);
  });

  it('keeps legacy 1y/1d when no profile is supplied (parity)', async () => {
    let calledUrl = '';
    const liveFetch = async (url: string) => {
      calledUrl = url;
      return { ok: true, status: 200, json: async () => ({ chart: { result: [{
        meta: { previousClose: 150, fiftyTwoWeekHigh: 200, fiftyTwoWeekLow: 100, currency: 'USD' },
        timestamp: [1], indicators: { quote: [{ open: [149], high: [152], low: [148], close: [150], volume: [1000] }] },
      }] } }) };
    };
    await fetchRealFinancialData({ tickers: ['AAPL'] }, liveFetch as any);
    expect(calledUrl).toContain('interval=1d');
    expect(calledUrl).toContain('range=1y');
  });
});

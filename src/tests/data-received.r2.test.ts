// src/tests/data-received.r2.test.ts
// Phase R2 (RAW_DATA_DUMP.md): every equity analyst handler now records a
// `dataReceived` entry describing exactly the slice of `state.ingested` it
// consumed, so the export can render per-analyst "what data did this analyst
// see". Parity: with no `ingested`, entries are still recorded but marked
// `seeded-parity`; analyst numeric/text output is unchanged.
import { makeNodeSurface } from '../registry/logic/shared';
import { dataIngestionHandler } from '../registry/logic/data-ingestion';
import { technicalHandler } from '../registry/logic/technical';
import { fundamentalHandler } from '../registry/logic/fundamental';
import { sentimentHandler } from '../registry/logic/sentiment';
import { riskHandler } from '../registry/logic/risk';
import { governanceHandler } from '../registry/logic/governance';
import type { AgentState } from '../types/financial-analysis';

function baseState(tickers: string[]): AgentState {
  return {
    messages: [], current_date: '2026-07-11', tickers, company_name: 'Test',
    investment_thesis: '', final_decision: '', error: null, current_step: 'start',
  };
}

// A realistic ingested channel: daily bars (enough for long-term) + market meta.
function ingestedFor(ticker: string) {
  return {
    bars: { [ticker]: [{ interval: '1d' as const, lookback_days: 365, bars: Array.from({ length: 252 }, (_, i) => ({ t: `2026-${String((i % 12) + 1).padStart(2, '0')}-01`, open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 1000 })) }] },
    market: { [ticker]: { price: 352, day_high: 355, day_low: 349, volume: 1_000_000, interval: '1d', bars_used: 252, beta: 1.2, volatility_30d: 0.35 } },
    fundamental: { [ticker]: { key_ratios: { debt_to_equity: 0.4, current_ratio: 1.5, roe: 0.18, roa: 0.09, profit_margin: 0.22, free_cash_flow_yield: 0.06 }, financial_health_score: 82 } },
    sentiment: { [ticker]: { sentiment_score: 42, news_sentiment: 'POSITIVE' } },
    source: 'yahoo' as const,
  };
}

function byAnalyst(state: AgentState): Record<string, any[]> {
  const out: Record<string, any[]> = {};
  for (const e of state.dataReceived ?? []) (out[e.analyst] ??= []).push(e);
  return out;
}

describe('Phase R2 — equity handlers record dataReceived', () => {
  const node = makeNodeSurface();
  const ticker = 'AAPL';

  it('data_ingestion records the raw slices it collected', async () => {
    const out = await dataIngestionHandler(baseState([ticker]), node, { horizon: 'LONG_TERM', params: {} } as any);
    const entries = byAnalyst(out)[ 'data_ingestion' ];
    expect(entries).toHaveLength(1);
    const e = entries![0];
    expect(e.ticker).toBe(ticker);
    expect(e.channel).toBe('ingested');
    // bars + market collected; fundamental/sentiment seeded
    const domains = e.blocks.map((b: any) => b.domain);
    expect(domains).toContain('bars');
    expect(domains).toContain('market');
    // In this sandbox fetchPriceBars falls back to the deterministic mock
    // (no global fetch), so provenance is 'mock'; with live keys it would be
    // 'live' / 'mixed'. Both are valid — the annotation just reflects reality.
    expect(['live', 'mock', 'mixed']).toContain(e.provenance);
  });

  it('technical records bars (interval + barsUsed) when ingested present', async () => {
    const seed = baseState([ticker]);
    seed.ingested = ingestedFor(ticker);
    const out = await technicalHandler(seed, node, { horizon: 'LONG_TERM', params: {} } as any);
    const e = byAnalyst(out)['technical']![0];
    expect(e.channel).toBe('ingested');
    expect(e.blocks[0].domain).toBe('bars');
    expect(e.blocks[0].interval).toBe('1d');
    expect(e.blocks[0].barsUsed).toBe(252);
    expect(e.provenance).toBe('live');
  });

  it('fundamental records live fundamentals when ingested.fundamental present', async () => {
    const seed = baseState([ticker]);
    seed.ingested = ingestedFor(ticker);
    const out = await fundamentalHandler(seed, node, { horizon: 'LONG_TERM', params: {} } as any);
    const e = byAnalyst(out)['fundamental']![0];
    expect(e.blocks[0].domain).toBe('fundamental');
    expect(e.blocks[0].source).toBe('yahoo');
    expect(e.note).toMatch(/live fundamentals/);
  });

  it('sentiment records live sentiment when ingested.sentiment present', async () => {
    const seed = baseState([ticker]);
    seed.ingested = ingestedFor(ticker);
    const out = await sentimentHandler(seed, node, { horizon: 'LONG_TERM', params: {} } as any);
    const e = byAnalyst(out)['sentiment']![0];
    expect(e.blocks[0].domain).toBe('sentiment');
    expect(e.note).toMatch(/live sentiment/);
  });

  it('risk records market (beta/vol30) when ingested.market present', async () => {
    const seed = baseState([ticker]);
    seed.ingested = ingestedFor(ticker);
    const out = await riskHandler(seed, node, { horizon: 'LONG_TERM', params: {} } as any);
    const e = byAnalyst(out)['risk']![0];
    expect(e.blocks[0].domain).toBe('market');
    expect(e.note).toMatch(/beta/);
  });

  it('governance records a reflection-only entry', async () => {
    const seed = baseState([ticker]);
    seed.ingested = ingestedFor(ticker);
    const out = await governanceHandler(seed, node, { horizon: 'LONG_TERM', params: {} } as any);
    const e = byAnalyst(out)['governance']![0];
    expect(e.provenance).toBe('seeded-parity');
    expect(e.note).toMatch(/reflection only/);
  });

  it('seeded-parity entries are recorded when NO ingested channel', async () => {
    const out = await technicalHandler(baseState([ticker]), node, { horizon: 'LONG_TERM', params: {} } as any);
    const e = byAnalyst(out)['technical']![0];
    expect(e.provenance).toBe('seeded-parity');
    expect(e.blocks[0].source).toBe('seeded');
    expect(e.note).toMatch(/seeded fallback/);
  });

  it('every equity analyst emits a dataReceived entry on the full long-term run', async () => {
    let state = await dataIngestionHandler(baseState([ticker]), node, { horizon: 'LONG_TERM', params: {} } as any);
    // data_ingestion already wrote `ingested`, so downstreams see it:
    state = await fundamentalHandler(state, node, { horizon: 'LONG_TERM', params: {} } as any);
    state = await technicalHandler(state, node, { horizon: 'LONG_TERM', params: {} } as any);
    state = await sentimentHandler(state, node, { horizon: 'LONG_TERM', params: {} } as any);
    state = await riskHandler(state, node, { horizon: 'LONG_TERM', params: {} } as any);
    state = await governanceHandler(state, node, { horizon: 'LONG_TERM', params: {} } as any);
    const seen = Object.keys(byAnalyst(state)).sort();
    expect(seen).toEqual(['data_ingestion', 'fundamental', 'governance', 'risk', 'sentiment', 'technical'].sort());
    // each analyst appears once per ticker
    for (const a of seen) expect(byAnalyst(state)[a]).toHaveLength(1);
  });
});

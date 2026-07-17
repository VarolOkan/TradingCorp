import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { GenericAnalystNode } from '../nodes/generic-analyst.node';
import { ANALYST_DEFS } from '../registry/analysts';
import { analystConfigStore } from '../server/analyst-config';
import { shouldShowMockDisabledBanner } from '../registry/logic/mockMode';
import type { AgentState } from '../types/financial-analysis';

function seedState(): AgentState {
  return {
    messages: [], tickers: ['AAPL'], options: { chain: {} as any },
    next: {}, investment_thesis: '', current_step: '',
    dataHealth: null, analystTraces: [], runtimeConfig: null, progress: undefined,
  } as unknown as AgentState;
}

describe('RUN-PATH: data_ingestion acquisition populates dataHealth', () => {
  let savedFetch: any;
  beforeAll(() => {
    savedFetch = (globalThis as any).fetch;
    // Stub fetch to return a valid (non-empty) payload for every probed URL.
    (globalThis as any).fetch = async (_url: string, _init: any) => ({
      ok: true, status: 200,
      headers: { get: () => 'application/json' },
      async json() { return { price: 190.5, symbol: 'AAPL', c: 190.5 }; },
    });
  });
  afterAll(() => { (globalThis as any).fetch = savedFetch; });

  beforeEach(() => {
    // Store a token for each data_ingestion source, exactly as the Sources Tab Save would.
    for (const sid of ['yahoo', 'alphaVantage', 'finnhub']) {
      analystConfigStore.set(
        { sessionId: 'default', analystId: 'data_ingestion', sourceId: sid },
        { token: `tok-${sid}`, extra: {} },
      );
    }
  });

  it('data_ingestion run reports sourcesOk>0 and suppresses the mock-disabled banner', async () => {
    const def = (ANALYST_DEFS as any)['data_ingestion'];
    expect(def).toBeDefined();
    const node = new GenericAnalystNode(def as any, { horizon: 'MEDIUM_TERM', instrument: 'EQUITY' });
    const out = await node.process(seedState());
    console.log('RUN-PATH dataHealth =', JSON.stringify(out.dataHealth));
    console.log('RUN-PATH sourceStatus =', JSON.stringify(
      (out.analystTraces as any[])?.find((t: any) => t.analyst === 'data_ingestion')?.sourceStatus,
    ));
    expect(out.dataHealth).toBeDefined();
    expect(out.dataHealth!.sourcesOk).toBeGreaterThan(0);
    expect(shouldShowMockDisabledBanner(out.dataHealth)).toBe(false);
  });
});

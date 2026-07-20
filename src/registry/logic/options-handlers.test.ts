// src/registry/logic/options-handlers.test.ts
// Phase B. Validates the new options handlers: ingestion writes state.optionsData,
// and the 4 fn analysts produce well-formed traces/messages/thesis. Mirrors the
// existing sentiment.test pattern (feeds a minimal AgentState, runs the handler,
// asserts trace + message shape).

import { optionsIngestionHandler, volSurfaceHandler, optionsPricingHandler,
  optionsGreeksHandler, optionsRiskHandler } from './options-handlers';
import { makeNodeSurface } from './shared';
import type { AnalystTuning } from '../../types/registry';
import type { AgentState, HistoricalBundle } from '../../types/financial-analysis';

// The jest runtime has a native globalThis.fetch (node 22 undici). Without a
// key/transport the handlers fall back to the seeded mock bundle — but only if
// the free CBOE/Yahoo feeds are treated as unreachable. Stubbing fetch to
// undefined forces that deterministic mock path and prevents the suite from
// hanging on blocked outbound network (the same guard hist.test.ts uses).
const _prevFetch = (globalThis as any).fetch;
(globalThis as any).fetch = undefined;

type AnyTrace = Record<string, any>;

function baseState(tickers: string[]): AgentState {
  return {
    tickers,
    messages: [],
    analystTraces: [],
    investment_thesis: '' as any,
  } as unknown as AgentState;
}

const surface = makeNodeSurface();

// Deterministic, replayable bundle: ingest AAPL's mock bundle once and reuse a
// deep clone for each fn-analyst test (the Greeks math is ~0.5s per 294-contract
// build — re-ingesting on every test makes the suite cross your 5–10s budget).
// The ingestion tests below exercise the real handler path directly.
async function ingestAAPL(): Promise<AgentState> {
  return optionsIngestionHandler(baseState(['AAPL']), surface);
}
function cloneIngested(src: AgentState): AgentState {
  return JSON.parse(JSON.stringify(src)) as AgentState;
}

describe('Phase B — options handlers', () => {
  // Guard: if the live-feed fallback ever reaches the network again (e.g. the
  // fetch stub drifts), fail fast instead of hanging the suite.
  jest.setTimeout(30000);

  describe('options_ingestion', () => {
    it('loads state.optionsData for every ticker and emits a quality message', async () => {
      const out = await optionsIngestionHandler(baseState(['AAPL']), surface);
      expect(out.error).toBeUndefined();
      expect(out.optionsData).toBeDefined();
      const bundle = out.optionsData!['AAPL'] as HistoricalBundle;
      expect(bundle.underlying_price).toBeGreaterThan(0);
      expect(bundle.option_chain.length).toBeGreaterThan(0);
      expect(bundle.greeks.length).toBeGreaterThan(0);
      expect((out.analystTraces as AnyTrace[]).some((t) => t.analyst === 'options_ingestion')).toBe(true);
      expect((out.messages as AnyTrace[]).some((m) => m.data?.option_chain_data === true)).toBe(true);
    });

    it('is deterministic per ticker (same seed → identical bundle)', async () => {
      const a = await optionsIngestionHandler(baseState(['TSLA']), surface);
      const b = await optionsIngestionHandler(baseState(['TSLA']), surface);
      const aPrice = (a.optionsData!['TSLA'] as HistoricalBundle | undefined)?.underlying_price;
      const bPrice = (b.optionsData!['TSLA'] as HistoricalBundle | undefined)?.underlying_price;
      expect(aPrice).toBe(bPrice);
    });

    it('errors cleanly when no tickers are provided', async () => {
      const out = await optionsIngestionHandler({ ...baseState([]), tickers: [] }, surface);
      expect(out.error).toMatch(/no tickers/i);
    });
  });

  describe('fn options analysts', () => {
    let ingested: AgentState;
    beforeAll(async () => {
      ingested = await ingestAAPL();
    });
    async function runWithData(handler: (s: AgentState, n: any, t?: AnalystTuning) => Promise<AgentState>,
      tuning?: AnalystTuning) {
      return handler(cloneIngested(ingested), surface, tuning);
    }

    it('vol_surface emits a trace + message + thesis note, score in range', async () => {
      const out = await runWithData(volSurfaceHandler);
      const traces = out.analystTraces as AnyTrace[];
      const trace = traces.find((t) => t.analyst === 'vol_surface')!;
      expect(trace).toBeDefined();
      expect(trace.output.score).toBeGreaterThanOrEqual(0);
      expect(trace.output.score).toBeLessThanOrEqual(100);
      expect((out.messages as AnyTrace[]).some((m) => m.data?.channels?.includes('vol_surface_analysis'))).toBe(true);
      expect(String(out.investment_thesis)).toMatch(/VOL SURFACE ANALYSIS/);
    });

    it('options_pricing surfaces an edge verdict', async () => {
      const out = await runWithData(optionsPricingHandler);
      const trace = (out.analystTraces as AnyTrace[]).find((t) => t.analyst === 'options_pricing')!;
      expect(trace.output.details.results['AAPL'].data.edge_pct).toBeDefined();
      expect(['EDGE', 'THIN_EDGE', 'NO_EDGE']).toContain(trace.output.verdict);
    });

    it('options_greeks reports a controlled/ exposed budget', async () => {
      const out = await runWithData(optionsGreeksHandler);
      const trace = (out.analystTraces as AnyTrace[]).find((t) => t.analyst === 'options_greeks')!;
      expect(['CONTROLLED', 'EXPOSED']).toContain(trace.output.verdict);
      expect(trace.output.details.results['AAPL'].data.greek_budget_ok).toBeDefined();
    });

    it('options_risk reports a risk level + max loss (defined risk)', async () => {
      const out = await runWithData(optionsRiskHandler);
      const trace = (out.analystTraces as AnyTrace[]).find((t) => t.analyst === 'options_risk')!;
      expect(['LOW', 'MEDIUM', 'HIGH', 'EXTREME']).toContain(trace.output.verdict);
      expect(trace.output.details.results['AAPL'].data.max_loss).toBeGreaterThan(0);
      expect(trace.output.details.results['AAPL'].data.max_loss).toBeLessThanOrEqual(500);
    });

    it('vol_surface reports seeded-parity with a human description when IV history is not live', async () => {
      const out = await runWithData(volSurfaceHandler);
      const trace = (out.analystTraces as AnyTrace[]).find((t) => t.analyst === 'vol_surface')!;
      // seeded-parity alone is meaningless to a user — the trace must also
      // describe WHAT that means (the IV history readings are not real market data).
      expect(trace.dataProvenance).toBe('seeded-parity');
      const noteText = (trace.notes ?? []).join(' ');
      expect(noteText).toMatch(/IV (percentile|history)|synthetic|NOT (real )?market/i);
    });

    it('intraday horizon tightens options_risk sizing + IV cap', async () => {
      const intraday = await runWithData(optionsRiskHandler, { horizon: 'INTRADAY', params: {} } as AnalystTuning);
      const medium = await runWithData(optionsRiskHandler, { horizon: 'MEDIUM_TERM', params: {} } as AnalystTuning);
      const iTrace = (intraday.analystTraces as AnyTrace[]).find((t) => t.analyst === 'options_risk')!;
      const mTrace = (medium.analystTraces as AnyTrace[]).find((t) => t.analyst === 'options_risk')!;
      expect(iTrace.output.details.results['AAPL'].data.max_allocation)
        .toBeLessThanOrEqual(mTrace.output.details.results['AAPL'].data.max_allocation);
      expect(iTrace.output.details.results['AAPL'].data.iv_crush_risk).toBeDefined();
    });
  });
});

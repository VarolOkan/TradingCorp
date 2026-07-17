// src/tests/options-ingestion-live.test.ts
// Phase 1A — wire the §4.9 acquisition engine into options_ingestion so the
// live Polygon option chain / aggregates / Treasury RFR feed the analysis when a
// key is present, and gracefully degrade to the deterministic hist.ts mock when
// not (parity: no key = mock, byte-identical behaviour to before).
//
// Drives the engine + handler with injected fetch/resolveToken (no real network)
// and asserts (a) the engine honours the fixed specs (401→degrade, 200+valid→ok)
// and (b) the handler consumes the engine's already-acquired live payloads
// (source 'polygon') and falls back to mock when the engine degraded.

import { makeNodeSurface } from '../registry/logic/shared';
import { optionsIngestionHandler } from '../registry/logic/options-handlers';
import { acquireForAnalyst, type AcquireContext, type FetchFn } from '../registry/sources';
import { ANALYST_DEFS } from '../registry/analysts';
import { parseTreasuryRfr } from '../registry/logic/hist';
import { DEFAULT_SOURCE_URIS } from '../registry/analyst-config-schema';
import type { AgentState } from '../types/financial-analysis';

function baseState(tickers: string[]): AgentState {
  return {
    messages: [], current_date: '2026-07-11', tickers, company_name: 'Test',
    investment_thesis: '', final_decision: '', error: null, current_step: 'start',
  };
}

/** A realistic Polygon v3 /snapshot/options payload. Massive/Polygon returns
 *  `{ results: { underlying_asset, options: { calls: [...], puts: [...] } } }`.
 *  The engine projects `results` into `merged.results`. */
function polygonSnapshotPayload(ticker: string) {
  const mk = (expiry: string, strike: number, type: 'call' | 'put', iv: number) => ({
    details: { expiration_date: expiry, strike_price: strike, contract_type: type, open_interest: 1200 },
    greeks: { implied_volatility: iv, last_price: 3.2 },
    last_quote: { bid: 3.1, ask: 3.3 },
    last_trade: { price: 3.2, size: 50 },
    underlying_asset: { last_price: 200 },
  });
  const calls = [
    mk('2026-08-21', 190, 'call', 0.30),
    mk('2026-08-21', 200, 'call', 0.28),
    mk('2026-08-21', 210, 'call', 0.31),
  ];
  const puts = [
    mk('2026-08-21', 190, 'put', 0.33),
    mk('2026-08-21', 200, 'put', 0.29),
  ];
  return {
    ticker,
    results: {
      underlying_asset: { last_price: 200 },
      options: { calls, puts },
    },
  };
}

/** A Polygon v2 aggregates `results` array (daily OHLCV). */
function polygonAggResults() {
  return [
    { t: Date.parse('2026-07-01T00:00:00Z'), o: 198, h: 201, l: 197, c: 200, v: 5_000_000 },
    { t: Date.parse('2026-07-02T00:00:00Z'), o: 200, h: 203, l: 199, c: 202, v: 4_800_000 },
    { t: Date.parse('2026-07-03T00:00:00Z'), o: 202, h: 205, l: 201, c: 204, v: 5_200_000 },
  ];
}

/** A Treasury avg_interest_rates data row. */
const treasuryRow = { record_date: '2026-06-30', security_type_desc: 'Marketable', security_desc: 'Total Marketable', avg_interest_rate_amt: 3.411, src_line_nbr: '7' };

/** Build an injected fetch that returns scripted responses keyed by URL host. */
function engineFetchFn(opts: {
  polygonOk?: boolean;
  treasuryOk?: boolean;
}): FetchFn {
  return async (url) => {
    // Polygon's REST API is served from api.massive.com; accept either host so
    // the fixture is host-agnostic (the endpoints moved polygon.io→massive.com).
    if (url.includes('massive.com') || url.includes('polygon.io')) {
      if (opts.polygonOk) {
        // Both the options snapshot and the aggregates endpoint share the host.
        if (url.includes('/v3/snapshot/options')) {
          return { status: 200, ok: true, json: async () => (polygonSnapshotPayload('TSLA')), headers: { get: () => null } };
        }
        return { status: 200, ok: true, json: async () => ({ results: polygonAggResults() }), headers: { get: () => null } };
      }
      return { status: 401, ok: false, json: async () => ({}), headers: { get: () => null } };
    }
    if (url.includes('fiscaldata.treasury.gov')) {
      if (opts.treasuryOk) {
        return { status: 200, ok: true, json: async () => ({ data: [treasuryRow] }), headers: { get: () => null } };
      }
      return { status: 401, ok: false, json: async () => ({}), headers: { get: () => null } };
    }
    return { status: 404, ok: false, json: async () => ({}), headers: { get: () => null } };
  };
}

const optionsDef = ANALYST_DEFS.options_ingestion!;

describe('Phase 1A — §4.9 engine honours fixed options_ingestion specs', () => {
  it('with a key + live payloads → polygonOptions/aggregates/treasury all ok, raw merged present', async () => {
    const ctx: AcquireContext = {
      fetchFn: engineFetchFn({ polygonOk: true, treasuryOk: true }),
      ticker: 'TSLA',
      resolveToken: () => 'fake-polygon-key',
    };
    const acc = await acquireForAnalyst(optionsDef, ctx);
    expect(acc.sourceStatus.polygonOptions).toBe('ok');
    expect(acc.sourceStatus.polygonHist).toBe('ok');
    expect(acc.sourceStatus.treasuryRfr).toBe('ok');
    expect((acc.merged as any).polygonOptions?.results).toBeDefined();
    expect((acc.merged as any).polygonOptions?.results?.options).toBeDefined();
    expect(Array.isArray((acc.merged as any).polygonHist?.results)).toBe(true);
    expect(Array.isArray((acc.merged as any).treasuryRfr?.data)).toBe(true);
    expect(acc.degraded).toBe(false);
    expect(acc.usedMockFallback).toBe(false);
  });

  it('with NO key → all sources 401 → degrade (skipped) + usedMockFallback', async () => {
    const ctx: AcquireContext = {
      fetchFn: engineFetchFn({ polygonOk: false, treasuryOk: false }),
      ticker: 'TSLA',
      resolveToken: () => '', // no per-source token → auth header absent → 401
    };
    const acc = await acquireForAnalyst(optionsDef, ctx);
    expect(acc.sourceStatus.polygonOptions).toBe('skipped');
    expect(acc.sourceStatus.polygonHist).toBe('skipped');
    expect(acc.sourceStatus.treasuryRfr).toBe('skipped');
    expect(acc.usedMockFallback).toBe(true);
  });
});

describe('Phase 1A — options_ingestion handler consumes engine-acquired live data', () => {
  const node = makeNodeSurface();
  const tuning = { horizon: 'MEDIUM_TERM' as const, instrument: 'OPTION' as const, params: {} };

  it('no engine / no key → deterministic mock (parity unchanged)', async () => {
    const out = await optionsIngestionHandler(baseState(['TSLA']), node, tuning as any);
    const bundle = (out as any).optionsData['TSLA'];
    expect(bundle.source).toBe('mock');
    expect(bundle.mock).toBe(true);
    expect(bundle.option_chain.length).toBeGreaterThan(0);
  });

  it('engine acquired a live Polygon chain → handler reports source polygon + live greeks', async () => {
    const acquired = {
      sourceStatus: { polygonOptions: 'ok' as const, polygonHist: 'ok' as const, treasuryRfr: 'ok' as const },
      notes: [],
      degraded: false,
      usedMockFallback: false,
      hardFailed: false,
      authError: false,
      merged: {
        polygonOptions: polygonSnapshotPayload('TSLA'),
        polygonHist: { results: polygonAggResults() },
        treasuryRfr: { data: [treasuryRow] },
      },
    };
    const out = await optionsIngestionHandler(baseState(['TSLA']), node, tuning as any, acquired as any);
    const bundle = (out as any).optionsData['TSLA'];
    expect(bundle.source).toBe('polygon');
    expect(bundle.mock).toBe(false);
    // Live chain has 5 contracts (3 calls + 2 puts); live bars = 3 daily.
    expect(bundle.option_chain.length).toBe(5);
    expect(bundle.price_bars[0].bars.length).toBe(3);
    expect(bundle.greeks.length).toBe(5);
    // Treasury RFR flowed through (3.411% → 0.03411).
    expect(Math.abs(bundle.rfr - 0.03411)).toBeLessThan(1e-6);
    // Underlying anchored on the live spot ($200), not the random band.
    expect(bundle.underlying_price).toBe(200);
  });

  it('engine degraded (skipped) → handler falls back to mock, source mock', async () => {
    const acquired = {
      sourceStatus: { polygonOptions: 'skipped' as const, polygonHist: 'skipped' as const, treasuryRfr: 'skipped' as const },
      notes: ['all sources unavailable'],
      degraded: true,
      usedMockFallback: true,
      hardFailed: false,
      authError: false,
      merged: {},
    };
    const out = await optionsIngestionHandler(baseState(['TSLA']), node, tuning as any, acquired as any);
    const bundle = (out as any).optionsData['TSLA'];
    expect(bundle.source).toBe('mock');
    expect(bundle.mock).toBe(true);
    expect(bundle.option_chain.length).toBeGreaterThan(0);
  });
});

describe('Phase 1B — Treasury RFR endpoint contract (no API key required)', () => {
  it('treasuryRfr default URL filters on security_type_desc=Marketable + security_desc=Total Marketable, sorted newest-first', () => {
    const url = DEFAULT_SOURCE_URIS.treasuryRfr;
    expect(url).toContain('security_type_desc:eq:Marketable');
    expect(url).toContain('security_desc:eq:Total Marketable');
    expect(url).toContain('sort=-record_date');
    expect(url).toContain('page[size]=1');
    // The OLD (broken) filter targeted the wrong column — must not be present.
    expect(url).not.toContain('security_desc:eq:Marketable');
  });

  it('parseTreasuryRfr reads the latest Total Marketable row into a 0..1 rate', () => {
    // Real shape from api.fiscaldata.treasury.gov (no key needed).
    const row = { record_date: '2026-06-30', security_type_desc: 'Marketable', security_desc: 'Total Marketable', avg_interest_rate_amt: '3.411' };
    expect(parseTreasuryRfr(row)).toBeCloseTo(0.03411, 5);
    // When the engine's `merged.data` is empty, options-handlers keeps DEFAULT_RFR
    // (it only overrides when merged.data.length > 0). parseTreasuryRfr itself
    // falls back to 0 on an unusable row — harmless because it's never reached
    // without a populated data array.
    expect(parseTreasuryRfr({})).toBe(0);
    expect(parseTreasuryRfr(null)).toBe(0);
  });
});

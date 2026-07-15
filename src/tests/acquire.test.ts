// src/tests/acquire.test.ts
// §4.9 multi-source acquisition engine unit tests. Drives every corner case
// from doc §4.9.2 with an injected mock fetch (no real network).

import {
  acquireSource,
  applySourcePolicy,
  type FetchFn,
  type AcquireResult,
} from '../registry/sources/acquire';
import { acquireForAnalyst, isLiveSource, aggregateDataHealth } from '../registry/sources';
import type { DataSourceSpec, AnalystDef } from '../types/registry';

/** Build a mock fetch that returns a scripted sequence (one entry per call). */
function mockFetch(
  script: Array<{ status?: number; body?: any; throw?: string; retryAfter?: string }>,
): FetchFn {
  let i = 0;
  return async (_url, init) => {
    const step = script[Math.min(i, script.length - 1)];
    i += 1;
    if (step.throw) {
      // Simulate an abort/network error.
      const err = new Error(step.throw);
      err.name = step.throw === 'aborted' ? 'AbortError' : 'Error';
      throw err;
    }
    const status = step.status ?? 200;
    return {
      status,
      ok: status >= 200 && status < 300,
      json: async () => step.body ?? {},
      headers: { get: (n: string) => (n.toLowerCase() === 'retry-after' ? step.retryAfter ?? null : null) },
    };
  };
}

const restSource = (over: Partial<DataSourceSpec> = {}): DataSourceSpec => ({
  id: 'yahoo',
  type: 'rest',
  endpoint: 'https://api.example.com/quote',
  fields: ['price'],
  label: 'Yahoo Finance',
  sources: ['Yahoo'],
  timeoutMs: 200,
  retries: 2,
  ...over,
});

describe('acquireSource — §4.9.2 corner cases', () => {
  it('case 0: happy path returns ok + projected fields', async () => {
    const res = await acquireSource(restSource(), {
      fetchFn: mockFetch([{ status: 200, body: { price: 42, extra: 'ignored' } }]),
    });
    expect(res.ok).toBe(true);
    expect(res.status).toBe('ok');
    expect(res.data).toEqual({ price: 42 });
  });

  it('case 1: 500 server error retries then fails', async () => {
    const res = await acquireSource(restSource({ retries: 1 }), {
      fetchFn: mockFetch([{ status: 500 }, { status: 500 }]),
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe('failed');
    expect(res.reason).toMatch(/server error/);
  });

  it('case 1b: 500 then 200 succeeds on retry', async () => {
    const res = await acquireSource(restSource({ retries: 2 }), {
      fetchFn: mockFetch([{ status: 500 }, { status: 200, body: { price: 7 } }]),
    });
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ price: 7 });
  });

  it('case 2: 401 auth error fails FAST (no retry) and flags authError', async () => {
    let calls = 0;
    const fetchFn: FetchFn = async () => {
      calls += 1;
      return { status: 401, ok: false, json: async () => ({}), headers: { get: () => null } };
    };
    const res = await acquireSource(restSource({ retries: 3 }), { fetchFn });
    expect(res.ok).toBe(false);
    expect(res.authError).toBe(true);
    expect(calls).toBe(1); // did NOT retry
  });

  it('case 3: 429 rate-limit backs off then fails after retries', async () => {
    const res = await acquireSource(restSource({ retries: 1 }), {
      fetchFn: mockFetch([{ status: 429, retryAfter: '1' }, { status: 429, retryAfter: '1' }]),
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/429/);
  }, 10000);

  it('case 4: empty / schema-drifted payload fails', async () => {
    const res = await acquireSource(restSource(), {
      fetchFn: mockFetch([{ status: 200, body: { somethingElse: 1 } }]),
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/schema-drifted|empty/);
  });

  it('okPath: nested-envelope payload validates via okPath (Yahoo chart)', async () => {
    const yahooLike = restSource({
      id: 'yahoo',
      fields: ['price', 'volume', 'market', 'technical'],
      okPath: 'chart.result[0].meta.symbol',
    });
    const res = await acquireSource(yahooLike, {
      fetchFn: mockFetch([
        { status: 200, body: { chart: { result: [{ meta: { symbol: 'AAPL' } }] } } },
      ]),
    });
    expect(res.ok).toBe(true);
    expect(res.status).toBe('ok');
  });

  it('okPath: missing envelope still fails validation', async () => {
    const yahooLike = restSource({ id: 'yahoo', okPath: 'chart.result[0].meta.symbol' });
    const res = await acquireSource(yahooLike, {
      fetchFn: mockFetch([{ status: 200, body: { chart: { error: 'no data' } } }]),
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/schema-drifted|empty/);
  });

  it('case 5: network error / timeout retries then fails', async () => {
    const res = await acquireSource(restSource({ retries: 1 }), {
      fetchFn: mockFetch([{ throw: 'aborted' }, { throw: 'aborted' }]),
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/fetch error/);
  });

  it('non-rest source type is skipped (not fetched)', async () => {
    const res = await acquireSource(restSource({ type: 'ws' }), { fetchFn: mockFetch([{ status: 200 }]) });
    expect(res.status).toBe('skipped');
  });

  it('missing endpoint is skipped', async () => {
    const s = restSource();
    delete (s as any).endpoint;
    const res = await acquireSource(s, { fetchFn: mockFetch([{ status: 200 }]) });
    expect(res.status).toBe('skipped');
  });
});

describe('applySourcePolicy — onError semantics', () => {
  const failed: AcquireResult = { id: 'yahoo', ok: false, status: 'failed', reason: 'boom' };

  it("onError='skip' → skipped, no escalate (unless required)", () => {
    const p = applySourcePolicy(failed, restSource({ onError: 'skip' }), [], {});
    expect(p.status).toBe('skipped');
    expect(p.escalate).toBe(false);
  });

  it("onError='skip' + required → escalate", () => {
    const p = applySourcePolicy(failed, restSource({ onError: 'skip', required: true }), [], {});
    expect(p.escalate).toBe(true);
  });

  it("onError='fail' → failed + escalate", () => {
    const p = applySourcePolicy(failed, restSource({ onError: 'fail' }), [], {});
    expect(p.status).toBe('failed');
    expect(p.escalate).toBe(true);
  });

  it("onError='fallback' with existing fallback → status fallback", () => {
    const primary = restSource({ id: 'yahoo', onError: 'fallback', fallbackSourceId: 'alpha' });
    const alpha = restSource({ id: 'alpha' });
    const p = applySourcePolicy(failed, primary, [primary, alpha], {});
    expect(p.status).toBe('fallback');
  });

  it("onError='fallback' with missing fallback → skipped", () => {
    const primary = restSource({ id: 'yahoo', onError: 'fallback', fallbackSourceId: 'nope' });
    const p = applySourcePolicy(failed, primary, [primary], {});
    expect(p.status).toBe('skipped');
  });
});

describe('isLiveSource — parity gate', () => {
  it('rest + endpoint = live', () => {
    expect(isLiveSource(restSource())).toBe(true);
  });
  it('declarative-only (no endpoint) = not live', () => {
    expect(isLiveSource({ fields: ['x'], label: 'internal', sources: ['pipe'] })).toBe(false);
  });
  it('internal handoff (from) = not live', () => {
    expect(isLiveSource({ from: 'orchestrator', fields: ['tickers'], label: 'r', sources: ['pipe'] })).toBe(false);
  });
  it('mock rest without endpoint = not live', () => {
    expect(isLiveSource({ type: 'rest', fields: ['x'], label: 'mock', sources: ['Yahoo (mock)'] })).toBe(false);
  });
});

describe('acquireForAnalyst — analyst-level flow', () => {
  const defWith = (sources: DataSourceSpec[], over: Partial<AnalystDef> = {}): AnalystDef =>
    ({
      id: 'fundamental',
      kind: 'analyst',
      name: 'Fundamental',
      role: 'r',
      stage: 2,
      accent: '#000',
      monogram: 'FA',
      prompt: 'p',
      dependsOn: [],
      dataSources: sources,
      logic: { mode: 'fn', fn: 'fundamentalAnalysis' },
      output: { channels: [] },
      tasks: [],
      mock: { generator: 'seeded', seedFrom: 'ticker' },
      ...over,
    }) as AnalystDef;

  it('no live sources → EMPTY (parity no-op)', async () => {
    const acc = await acquireForAnalyst(
      defWith([{ fields: ['x'], label: 'internal', sources: ['pipe'] }]),
      {},
    );
    expect(acc.sourceStatus).toEqual({});
    expect(acc.degraded).toBe(false);
  });

  it('all sources ok → not degraded, merged data', async () => {
    const acc = await acquireForAnalyst(
      defWith([restSource({ id: 'yahoo', fields: ['price'] }), restSource({ id: 'alpha', fields: ['eps'] })]),
      { fetchFn: mockFetch([{ status: 200, body: { price: 1, eps: 2 } }]) },
    );
    expect(acc.sourceStatus).toEqual({ yahoo: 'ok', alpha: 'ok' });
    expect(acc.degraded).toBe(false);
    expect(acc.merged).toMatchObject({ price: 1, eps: 2 });
  });

  it('Yahoo tokenless nested envelope → yahoo ok; keyed sources degrade (real data_ingestion flow)', async () => {
    // Simulate: Yahoo returns a chart envelope; alphaVantage + finnhub get no
    // token so resolveToken returns undefined → no Authorization → 401 → failed.
    let call = 0;
    const fetchFn: FetchFn = async (_url) => {
      call += 1;
      if (call === 1) {
        // Yahoo (tokenless) — nested envelope
        return {
          status: 200, ok: true,
          json: async () => ({ chart: { result: [{ meta: { symbol: 'AAPL' } }] } }),
          headers: { get: () => null },
        };
      }
      // alphaVantage / finnhub without a token → 401
      return { status: 401, ok: false, json: async () => ({}), headers: { get: () => null } };
    };
    const def = defWith([
      restSource({ id: 'yahoo', auth: 'none', fields: ['price', 'volume', 'market', 'technical'], okPath: 'chart.result[0].meta.symbol', retries: 0 }),
      restSource({ id: 'alphaVantage', auth: 'bearer', fields: ['fundamental'], retries: 0 }),
      restSource({ id: 'finnhub', auth: 'bearer', fields: ['sentiment'], retries: 0 }),
    ], { id: 'data_ingestion', onAllSourcesFailed: { action: 'useMock' } });
    const acc = await acquireForAnalyst(def, { fetchFn, ticker: 'AAPL', resolveToken: () => undefined });
    expect(acc.sourceStatus.yahoo).toBe('ok');
    expect(acc.sourceStatus.alphaVantage).toBe('skipped');
    expect(acc.sourceStatus.finnhub).toBe('skipped');
    // yahoo is live, so it is NOT a full mock fallback
    expect(acc.usedMockFallback).toBe(false);
    expect(acc.degraded).toBe(true);
  });

  it('one of two fails (skip) → degraded', async () => {
    // yahoo ok, alpha 500-fails
    let call = 0;
    const fetchFn: FetchFn = async () => {
      call += 1;
      // first source (yahoo) succeeds, second (alpha) always 500
      if (call === 1) return { status: 200, ok: true, json: async () => ({ price: 1 }), headers: { get: () => null } };
      return { status: 500, ok: false, json: async () => ({}), headers: { get: () => null } };
    };
    const acc = await acquireForAnalyst(
      defWith([
        restSource({ id: 'yahoo', fields: ['price'], retries: 0 }),
        restSource({ id: 'alpha', fields: ['eps'], onError: 'skip', retries: 0 }),
      ]),
      { fetchFn },
    );
    expect(acc.sourceStatus.yahoo).toBe('ok');
    expect(acc.sourceStatus.alpha).toBe('skipped');
    expect(acc.degraded).toBe(true);
  });

  it('all sources fail + onAllSourcesFailed=useMock → usedMockFallback', async () => {
    const acc = await acquireForAnalyst(
      defWith([restSource({ id: 'yahoo', retries: 0, onError: 'skip' })], {
        onAllSourcesFailed: { action: 'useMock' },
      }),
      { fetchFn: mockFetch([{ status: 500 }]) },
    );
    expect(acc.usedMockFallback).toBe(true);
    expect(acc.hardFailed).toBe(false);
  });

  it('all sources fail + onAllSourcesFailed=fail → hardFailed', async () => {
    const acc = await acquireForAnalyst(
      defWith([restSource({ id: 'yahoo', retries: 0, onError: 'skip' })], {
        onAllSourcesFailed: { action: 'fail' },
      }),
      { fetchFn: mockFetch([{ status: 500 }]) },
    );
    expect(acc.hardFailed).toBe(true);
  });

  it('required source fails → hardFailed escalation', async () => {
    const acc = await acquireForAnalyst(
      defWith([
        restSource({ id: 'yahoo', fields: ['price'], retries: 0 }),
        restSource({ id: 'alpha', fields: ['eps'], required: true, onError: 'skip', retries: 0 }),
      ]),
      {
        fetchFn: (() => {
          let c = 0;
          return (async () => {
            c += 1;
            if (c === 1) return { status: 200, ok: true, json: async () => ({ price: 1 }), headers: { get: () => null } };
            return { status: 500, ok: false, json: async () => ({}), headers: { get: () => null } };
          }) as FetchFn;
        })(),
      },
    );
    expect(acc.hardFailed).toBe(true);
  });

  it('fallback chain: primary fails → fallback succeeds', async () => {
    let c = 0;
    const fetchFn: FetchFn = async () => {
      c += 1;
      // primary (yahoo) fails, fallback (alpha) succeeds
      if (c === 1) return { status: 500, ok: false, json: async () => ({}), headers: { get: () => null } };
      return { status: 200, ok: true, json: async () => ({ price: 9 }), headers: { get: () => null } };
    };
    const acc = await acquireForAnalyst(
      defWith([
        restSource({ id: 'yahoo', fields: ['price'], retries: 0, onError: 'fallback', fallbackSourceId: 'alpha' }),
        restSource({ id: 'alpha', fields: ['price'], retries: 0 }),
      ]),
      { fetchFn },
    );
    expect(acc.sourceStatus.yahoo).toBe('fallback');
    expect(acc.merged).toMatchObject({ price: 9 });
  });
});

describe('aggregateDataHealth', () => {
  it('accumulates ok/total/degraded across analysts', () => {
    const a1 = { sourceStatus: { yahoo: 'ok' as const }, notes: [], degraded: false, usedMockFallback: false, hardFailed: false, authError: false, merged: {} };
    const a2 = { sourceStatus: { alpha: 'skipped' as const, finn: 'ok' as const }, notes: [], degraded: true, usedMockFallback: false, hardFailed: false, authError: false, merged: {} };
    let dh = aggregateDataHealth(null, a1, 'fundamental');
    dh = aggregateDataHealth(dh, a2, 'technical');
    expect(dh.sourcesOk).toBe(2);
    expect(dh.sourcesTotal).toBe(3);
    expect(dh.degradedAnalysts).toEqual(['technical']);
    expect(dh.unavailableSources).toEqual(['alpha']);
  });
});

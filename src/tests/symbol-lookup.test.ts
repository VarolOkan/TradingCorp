// src/tests/symbol-lookup.test.ts
// Hermetic: fetchFn + universeCheck are injected so no real network call is made.
// Validation is two-layer: local universe set (universeCheck) as the cheap first
// gate, then a Yahoo chart check (fetchFn) for anything not in the universe.

import { validateTickers } from '../utils/symbol-lookup';

// Helper: build a fake fetch returning a canned Yahoo chart JSON payload.
function yahooFetch(shape: 'ok' | 'error', opts?: { throws?: boolean }) {
  const payload =
    shape === 'ok'
      ? { chart: { result: [{ meta: { regularMarketPrice: 1 } }] } }
      : { chart: { error: { description: 'No data found, symbol may be delisted' } } };
  return (async (_url: string) => {
    if (opts?.throws) throw new Error('network down');
    return { ok: true, status: 200, json: async () => payload } as any;
  }) as unknown as typeof fetch;
}

// Default universe check used by most tests: "unknown" forces everything to the
// Yahoo layer (so the fetch fakes fully determine the outcome).
const UNKNOWN = async () => 'unknown' as const;

describe('validateTickers', () => {
  it('marks a real symbol as valid (Yahoo chart.result present)', async () => {
    const res = await validateTickers(['AAPL'], yahooFetch('ok'), 4000, UNKNOWN);
    expect(res.valid).toEqual(['AAPL']);
    expect(res.invalid).toEqual([]);
  });

  it('marks an unknown symbol as invalid (Yahoo chart.error)', async () => {
    const res = await validateTickers(['GGGGGG'], yahooFetch('error'), 4000, UNKNOWN);
    expect(res.invalid).toEqual(['GGGGGG']);
    expect(res.valid).toEqual([]);
  });

  it('fails OPEN when the Yahoo call throws (never blocks analysis)', async () => {
    const res = await validateTickers(['IRON', 'CAT'], yahooFetch('ok', { throws: true }), 4000, UNKNOWN);
    expect(res.valid.sort()).toEqual(['CAT', 'IRON']);
    expect(res.invalid).toEqual([]);
  });

  it('fails OPEN on a non-OK HTTP status', async () => {
    const fetchFn = (async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch;
    const res = await validateTickers(['NOW'], fetchFn, 4000, UNKNOWN);
    expect(res.valid).toEqual(['NOW']);
    expect(res.invalid).toEqual([]);
  });

  it('de-duplicates inputs', async () => {
    const res = await validateTickers(['aapl', 'AAPL', 'AAPL'], yahooFetch('ok'), 4000, UNKNOWN);
    expect(res.valid).toEqual(['AAPL']);
    expect(res.invalid).toEqual([]);
  });

  it('splits a mixed list into valid + invalid', async () => {
    const fetchFn = ((url: string) => {
      const isBad = /GGGGGG/.test(url);
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () =>
          isBad
            ? { chart: { error: { description: 'No data found' } } }
            : { chart: { result: [{ meta: {} }] } },
      } as any);
    }) as unknown as typeof fetch;
    const res = await validateTickers(['AAPL', 'GGGGGG', 'MSFT'], fetchFn, 4000, UNKNOWN);
    expect(res.valid.sort()).toEqual(['AAPL', 'MSFT']);
    expect(res.invalid).toEqual(['GGGGGG']);
  });

  it('fails OPEN when no fetchFn is available', async () => {
    const res = await validateTickers(['IRON'], undefined, 4000, UNKNOWN);
    expect(res.valid).toEqual(['IRON']);
  });

  describe('local universe gate (layer 1)', () => {
    it('accepts a symbol that is IN the universe with NO Yahoo call', async () => {
      const fetchFn = yahooFetch('error'); // would be invalid via Yahoo
      const universeCheck = async (t: string) => (t === 'AAPL' ? ('in' as const) : ('unknown' as const));
      const res = await validateTickers(['AAPL'], fetchFn, 4000, universeCheck);
      expect(res.valid).toEqual(['AAPL']);
      expect(res.localHits).toEqual(['AAPL']);
      expect(res.invalid).toEqual([]);
    });

    it('forwards an OUT-of-universe symbol to Yahoo and respects Yahoo result', async () => {
      const fetchFn = yahooFetch('error'); // GGGGGG not in universe AND Yahoo says invalid
      const universeCheck = async () => 'out' as const;
      const res = await validateTickers(['GGGGGG'], fetchFn, 4000, universeCheck);
      expect(res.invalid).toEqual(['GGGGGG']);
      expect(res.localHits).toEqual([]);
    });

    it('unknown universe membership falls through to Yahoo (not rejected)', async () => {
      const universeCheck = async () => 'unknown' as const;
      const res = await validateTickers(['BRK.B'], yahooFetch('ok'), 4000, universeCheck);
      // .B is non-equity for the screener but Yahoo may still resolve it; here
      // Yahoo says ok, so it is valid (proves "out" != "invalid").
      expect(res.valid).toEqual(['BRK.B']);
    });
  });
});

// src/tests/live-bundle.test.ts
// Phase I (options ingestion wiring): resolveLiveOptionsBundle upgrades the
// mock bundle to live when a provider key is present, parity-safe otherwise.
import { resolveLiveOptionsBundle } from '../registry/sources/adapters/option-chain';

describe('resolveLiveOptionsBundle (Phase I gateway)', () => {
  it('returns a mock bundle (no key) that is structurally identical to the base mock', async () => {
    const r = await resolveLiveOptionsBundle('AAPL', { lookbackDays: 90, intervals: ['1d'], expiries: 'monthly+weekly' });
    expect(r.mock).toBe(true);
    expect(r.source).toBe('mock');
    expect(r.option_chain.length).toBeGreaterThan(0);
    expect(r.greeks.length).toBeGreaterThan(0);
    expect(r.price_bars.length).toBeGreaterThan(0);
    expect(r.underlying_price).toBeGreaterThan(0);
  });

  it('upgrades to live Massive/Polygon + yahoo when a fetch transport + key are injected', async () => {
    const fetchFn = async (url: string) => {
      if (url.includes('massive.com') || url.includes('polygon.io')) {
        const body = {
          results: {
            underlying_asset: { last_price: 190.5 },
            results: [
              {
                details: { expiration_date: '2026-08-21', strike_price: 190, contract_type: 'call', open_interest: 1234 },
                greeks: { implied_volatility: 0.32, last_price: 5.4 },
                last_quote: { bid: 5.3, ask: 5.5 },
              },
              {
                details: { expiration_date: '2026-08-21', strike_price: 190, contract_type: 'put', open_interest: 987 },
                greeks: { implied_volatility: 0.34, last_price: 4.1 },
                last_quote: { bid: 4.0, ask: 4.2 },
              },
            ],
          },
        };
        return {
          ok: true,
          status: 200,
          // acquireOptionChain reads res.text() first (to capture provider error
          // bodies verbatim), then JSON.parses it — so the mock MUST expose text().
          text: async () => JSON.stringify(body),
          json: async () => body,
        };
      }
      // Yahoo chart for price bars
      return {
        ok: true,
        status: 200,
        json: async () => ({
          chart: {
            result: [
              {
                timestamp: [1700000000, 1700086400],
                indicators: { quote: [{ open: [100, 101], high: [103, 104], low: [99, 100], close: [101, 102], volume: [1000, 1100] }] },
              },
            ],
            error: null,
          },
        }),
      };
    };
    const r = await resolveLiveOptionsBundle(
      'AAPL',
      { lookbackDays: 90, intervals: ['1d'], expiries: 'monthly+weekly' },
      { apiKey: 'demo', fetchFn: fetchFn as any },
    );
    expect(r.source).toBe('polygon');
    expect(r.mock).toBe(false);
    expect(r.underlying_price).toBe(190.5);
    expect(r.option_chain.length).toBe(2);
    expect(r.greeks.length).toBe(2);
    expect(r.price_bars.length).toBeGreaterThan(0);
    expect(r.price_bars[0]?.bars.length).toBe(2);
  });
});

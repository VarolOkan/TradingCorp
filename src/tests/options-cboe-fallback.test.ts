// src/tests/options-cboe-fallback.test.ts
// Regression: when a Massive/Polygon key is configured but the live option-chain
// call returns a non-OK status (e.g. 401 entitlement-not-authorised), the chain
// acquisition MUST still fall back to the FREE CBOE delayed feed (no key
// required) and return source === 'cboe' — NOT a silent mock. This is the
// honest "real bid/ask another way" path and was a user-visible regression
// (Options tab showed MOCK after a Massive 401 instead of CBOE data).
//
// Deterministic (routed mock, no live network) so it locks the contract in CI.
// The live-network behaviour is additionally proven by the (skipped-by-default)
// manual probe in options-cboe-fallback.repro.test.ts.

import { describe, it, expect } from '@jest/globals';
import { acquireOptionChain, resolveLiveOptionsBundle } from '../registry/sources/adapters/option-chain';

// Real-shape CBOE payload with THREE expiries at distinct ATM IVs so we can
// prove iv_history is calibrated from the REAL per-tenor ATM IVs (not seeded).
// Expiry 1 (260717) ATM ~0.77/0.81, Expiry 2 (260821) ATM ~0.55, Expiry 3 (260918) ATM ~0.40.
const CBOE_PAYLOAD_MULTI = {
  timestamp: '2026-07-18 11:40:49',
  data: {
    options: [
      // --- Expiry 1 (2026-07-17), ATM strike 250 → iv 0.79 ---
      { option: 'NVDA260717C00000250', bid: 196.05, ask: 204.45, iv: 0.77, open_interest: 17, volume: 0, delta: 1.0, gamma: 0, vega: 0, theta: 0, rho: 0, theo: 200.635, change: 0 },
      { option: 'NVDA260717P00000250', bid: 0.05, ask: 0.12, iv: 0.81, open_interest: 9, volume: 2, delta: -1.0, gamma: 0, vega: 0, theta: 0, rho: 0, theo: 0.08, change: 0 },
      // --- Expiry 2 (2026-08-21), ATM strike 250 → iv 0.55 ---
      { option: 'NVDA260821C00000250', bid: 80.0, ask: 84.0, iv: 0.54, open_interest: 10, volume: 1, delta: 1.0, gamma: 0, vega: 0, theta: 0, rho: 0, theo: 82.0, change: 0 },
      { option: 'NVDA260821P00000250', bid: 0.5, ask: 0.9, iv: 0.56, open_interest: 8, volume: 1, delta: -1.0, gamma: 0, vega: 0, theta: 0, rho: 0, theo: 0.7, change: 0 },
      // --- Expiry 3 (2026-09-18), ATM strike 250 → iv 0.40 ---
      { option: 'NVDA260918C00000250', bid: 40.0, ask: 43.0, iv: 0.39, open_interest: 5, volume: 0, delta: 1.0, gamma: 0, vega: 0, theta: 0, rho: 0, theo: 41.5, change: 0 },
      { option: 'NVDA260918P00000250', bid: 1.0, ask: 1.5, iv: 0.41, open_interest: 4, volume: 0, delta: -1.0, gamma: 0, vega: 0, theta: 0, rho: 0, theo: 1.25, change: 0 },
    ],
  },
};

const MASSIVE_URL = 'api.massive.com/v3/snapshot/options';
const CBOE_URL = 'cdn.cboe.com/api/global/delayed_quotes/options';

/** fetchFn that returns 401 for Massive (keyed live call fails) and a valid
 *  CBOE payload for the CBOE URL. */
function failedMassiveThenCboeFetch(payload: any = CBOE_PAYLOAD_MULTI) {
  return async (url: string) => {
    if (url.includes(MASSIVE_URL)) {
      return {
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: async () => JSON.stringify({ status: 'NOT_AUTHORIZED', message: 'You are not entitled to this data.' }),
        json: async () => ({ status: 'NOT_AUTHORIZED', message: 'You are not entitled to this data.' }),
      };
    }
    if (url.includes(CBOE_URL)) {
      return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(payload), json: async () => payload };
    }
    // Yahoo tokenless fallback path -> also "unreachable" so the test isolates
    // the Massive->CBOE hop.
    return { ok: false, status: 500, statusText: 'Server Error', text: async () => '', json: async () => ({}) };
  };
}

describe('option-chain CBOE fallback after failed Massive key', () => {
  it('acquireOptionChain returns source=cboe when Massive 401s (key configured)', async () => {
    const r = await acquireOptionChain('NVDA', {
      apiKey: 'SOME_...EY',
      fetchFn: failedMassiveThenCboeFetch() as any,
    });
    expect(r.source).toBe('cboe');
    expect(Array.isArray(r.quotes)).toBe(true);
    expect(r.quotes.length).toBeGreaterThan(0);
  });

  it('resolveLiveOptionsBundle (options ingestion path) also falls back to CBOE', async () => {
    const b = await resolveLiveOptionsBundle(
      'NVDA',
      { lookbackDays: 90, intervals: ['1d'] },
      { apiKey: 'SOME_...EY', fetchFn: failedMassiveThenCboeFetch() as any },
    );
    expect(b.source).toBe('cboe');
    expect((b.option_chain?.length ?? 0)).toBeGreaterThan(0);
  });

  it('calibrates iv_history from the REAL per-tenor ATM IVs (no seeded values)', async () => {
    // With a real CBOE chain, iv_history must be the REAL per-tenor ATM IVs
    // ([0.79, 0.55, 0.40]) — NOT the deterministic seeded series. This is the
    // core of closing §4's BS-assumption: rankings are market-calibrated.
    const b = await resolveLiveOptionsBundle(
      'NVDA',
      { lookbackDays: 90, intervals: ['1d'] },
      { apiKey: 'SOME_...EY', fetchFn: failedMassiveThenCboeFetch() as any },
    );
    expect(b.ivHistorySource).toBe('real-chain');
    expect(b.iv_history).toEqual(expect.arrayContaining([0.79, 0.55, 0.40]));
    // The seeded base.iv_history must NOT have leaked through.
    expect(b.iv_history).toHaveLength(3);
  });

  it('does NOT claim cboe when the CBOE feed is also unreachable (honest mock)', async () => {
    const bothDown = async (url: string) => ({
      ok: false,
      status: url.includes(MASSIVE_URL) ? 401 : 500,
      statusText: 'err',
      text: async () => JSON.stringify({ message: 'not entitled' }),
      json: async () => ({ message: 'not entitled' }),
    });
    const r = await acquireOptionChain('NVDA', { apiKey: 'K', fetchFn: bothDown as any });
    expect(r.source).toBe('mock');
    expect(r.note).toMatch(/live option-chain call failed/);
  });
});

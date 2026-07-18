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

// Real-shape CBOE payload (trimmed). parseCboeOptions reads data.options[].
const CBOE_PAYLOAD = {
  timestamp: '2026-07-18 11:40:49',
  data: {
    options: [
      {
        option: 'NVDA260717C00002500',
        bid: 196.05,
        ask: 204.45,
        iv: 0.77,
        open_interest: 17,
        volume: 0,
        delta: 1.0,
        gamma: 0.0,
        vega: 0.0,
        theta: 0.0,
        rho: 0.0,
        theo: 200.635,
        change: 0,
      },
      {
        option: 'NVDA260717P00002500',
        bid: 0.05,
        ask: 0.12,
        iv: 0.81,
        open_interest: 9,
        volume: 2,
        delta: -1.0,
        gamma: 0.0,
        vega: 0.0,
        theta: 0.0,
        rho: 0.0,
        theo: 0.08,
        change: 0,
      },
    ],
  },
};

const MASSIVE_URL = 'api.massive.com/v3/snapshot/options';
const CBOE_URL = 'cdn.cboe.com/api/global/delayed_quotes/options';

/** fetchFn that returns 401 for Massive (keyed live call fails) and a valid
 *  CBOE payload for the CBOE URL. */
function failedMassiveThenCboeFetch() {
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
      return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(CBOE_PAYLOAD), json: async () => CBOE_PAYLOAD };
    }
    // Yahoo tokenless fallback path -> also "unreachable" so the test isolates
    // the Massive->CBOE hop.
    return { ok: false, status: 500, statusText: 'Server Error', text: async () => '', json: async () => ({}) };
  };
}

describe('option-chain CBOE fallback after failed Massive key', () => {
  it('acquireOptionChain returns source=cboe when Massive 401s (key configured)', async () => {
    const r = await acquireOptionChain('NVDA', {
      apiKey: 'SOME_ENTITLEMENT_401_KEY',
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
      { apiKey: 'SOME_ENTITLEMENT_401_KEY', fetchFn: failedMassiveThenCboeFetch() as any },
    );
    expect(b.source).toBe('cboe');
    expect((b.option_chain?.length ?? 0)).toBeGreaterThan(0);
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

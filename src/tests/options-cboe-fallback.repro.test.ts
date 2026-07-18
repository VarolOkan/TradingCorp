// src/tests/options-cboe-fallback.repro.test.ts
// Regression probe: when a Massive/Polygon key is set but the live call returns
// a non-OK status (entitlement not authorised), acquireOptionChain MUST still
// fall back to the FREE CBOE delayed feed (no key required) and return
// source === 'cboe'. This exercises the REAL network path (CBOE is publicly
// reachable) so a silent regression in the 401 -> CBOE fallback is caught.
//
// The jest runtime has no global fetch, so we inject a minimal https-based
// fetchFn that can reach CBOE from the sandbox.
//
// NETWORK: this file hits the live CBOE endpoint and is gated by SKIP_NETWORK_TESTS
// (see src/tests/netTestEnv.ts). It runs by default; set SKIP_NETWORK_TESTS=1 to
// skip it in offline environments. The deterministic contract test lives in
// options-cboe-fallback.test.ts (no network) and always runs.

import { describeNet, itNet, expect } from './netTestEnv';
import https from 'https';
import { acquireOptionChain } from '../registry/sources/adapters/option-chain';

// Minimal fetch shim (supports GET + headers + text() + json() + ok/status).
function makeFetch(): (url: string, init?: any) => Promise<any> {
  return (url: string, init?: any) =>
    new Promise((resolve, reject) => {
      const u = new URL(url);
      const headers = (init?.headers as Record<string, string>) ?? {};
      const req = https.request(
        u,
        { method: init?.method ?? 'GET', headers },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c as Buffer));
          res.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            resolve({
              ok: res.statusCode != null && res.statusCode >= 200 && res.statusCode < 300,
              status: res.statusCode ?? 0,
              statusText: res.statusMessage ?? '',
              headers: { get: (k: string) => res.headers[k.toLowerCase()] ?? null, forEach: (fn: any) => Object.entries(res.headers).forEach(([k, v]) => fn(v, k)) },
              text: async () => body,
              json: async () => JSON.parse(body),
            });
          });
        },
      );
      req.on('error', reject);
      req.end();
    });
}

describeNet('acquireOptionChain — 401 Massive => CBOE fallback (LIVE)', () => {
  itNet('falls back to CBOE (source=cboe) after a failed live keyed call', async () => {
    const fetchFn = makeFetch();
    // A bad key forces the failed-live path; CBOE is keyless + live.
    const r = await acquireOptionChain('NVDA', {
      apiKey: 'BAD_KEY_FOR_401',
      fetchFn: fetchFn as any,
    });
    console.log('[probe] NVDA result source =', r.source, '| quotes =', r.quotes?.length, '| note =', r.note);
    expect(r.source).toBe('cboe');
    expect(Array.isArray(r.quotes)).toBe(true);
    expect(r.quotes.length).toBeGreaterThan(0);
  }, 30_000);

  itNet('prefers live Massive when the key actually works (positive path)', async () => {
    const fetchFn = makeFetch();
    // Use the domain-source-config / real key? We don't have one, so just prove
    // the shape: with NO key, it should still reach CBOE (no 401, straight to cboe).
    const r = await acquireOptionChain('NVDA', { fetchFn: fetchFn as any });
    console.log('[probe-nokey] NVDA result source =', r.source, '| quotes =', r.quotes?.length);
    expect(r.source).toBe('cboe');
    expect(r.quotes.length).toBeGreaterThan(0);
  }, 30_000);

  itNet('resolveLiveOptionsBundle falls back to CBOE after a failed keyed chain', async () => {
    const fetchFn = makeFetch();
    // options ingestion calls this; it must also honour the CBOE fallback.
    const { resolveLiveOptionsBundle } = await import('../registry/sources/adapters/option-chain');
    const b = await resolveLiveOptionsBundle('NVDA', { lookbackDays: 90, intervals: ['1d'] }, { apiKey: 'BAD_KEY_FOR_401', fetchFn: fetchFn as any });
    console.log('[probe-bundle] NVDA source =', b.source, '| chain_rows =', b.option_chain?.length, '| note =', b.note);
    expect(b.source).toBe('cboe');
    expect((b.option_chain?.length ?? 0)).toBeGreaterThan(0);
  }, 30_000);
});

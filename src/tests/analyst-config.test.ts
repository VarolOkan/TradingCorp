// src/tests/analyst-config.test.ts
// B1: tests for the per-analyst / per-source credential route + store.
// Mirrors config-route.test.ts: exercises the real route registration without
// booting the full Socket.IO server. Asserts tokens are stored server-side and
// NEVER echoed back, and that the catalog reflects live+auth analysts only.

import request from 'supertest';
import express from 'express';
import { registerAnalystConfigRoutes } from '../server/analyst-config-routes';
import { AnalystConfigStore } from '../server/analyst-config';
import { TokenVault, AesCipher } from '../server/llm-vault';
import fs from 'fs';
import os from 'os';
import path from 'path';

function tmpVaultFile(): string {
  return path.join(os.tmpdir(), `analyst-config-vault-${process.pid}.gpg`);
}

/** Build a store backed by a REAL encrypted vault (AES) so we exercise GPG persistence. */
function vaultedStore(file: string): AnalystConfigStore {
  const vault = TokenVault.withCipher(file, 'default', new AesCipher('test-passphrase'));
  return new AnalystConfigStore(vault);
}

describe('POST /analyst-config (B1 per-source credentials)', () => {
  let app: express.Express;
  let store: AnalystConfigStore;
  let vaultFile: string;

  beforeEach(() => {
    vaultFile = tmpVaultFile();
    app = express();
    app.use(express.json());
    store = vaultedStore(vaultFile);
    registerAnalystConfigRoutes(app, store);
  });

  afterEach(() => {
    store.reset();
    try { fs.unlinkSync(vaultFile); } catch {}
  });

  it('GET /analyst-config returns the live+auth catalog with hasToken flags', async () => {
    // Pre-store a token so the catalog reflects a "stored" indicator.
    // Use alphaVantage (a credentialed, auth:'bearer' source) — yahoo is
    // auth:'none' and is intentionally excluded from the catalog.
    store.set({ sessionId: 'default', analystId: 'data_ingestion', sourceId: 'alphaVantage' }, { token: 'pre', extra: {} });
    const res = await request(app).get('/analyst-config');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('analysts');
    expect(Array.isArray(res.body.analysts)).toBe(true);
    // vaultDisabled reflects the (AES) cipher being active in this test store.
    expect(typeof res.body.vaultDisabled).toBe('boolean');
    // Each entry has an analystId + a list of credentialed sources.
    for (const a of res.body.analysts) {
      expect(typeof a.analystId).toBe('string');
      expect(Array.isArray(a.sources)).toBe(true);
      for (const s of a.sources) {
        expect(s).toHaveProperty('id');
        expect(s).toHaveProperty('label');
        expect(s).toHaveProperty('auth');
        expect(typeof s.hasToken).toBe('boolean');
      }
    }
    // The analyst/source we pre-stored must report hasToken: true.
    const di = res.body.analysts.find((a: any) => a.analystId === 'data_ingestion');
    const av = di?.sources.find((s: any) => s.id === 'alphaVantage');
    expect(av?.hasToken).toBe(true);
  });

  it('Treasury RFR (auth:none, no key needed) is excluded from the credentialed catalog so neither dialog shows it', async () => {
    const res = await request(app).get('/analyst-config');
    expect(res.status).toBe(200);
    // Treasury must NOT appear under options_ingestion (nor anywhere).
    const opt = res.body.analysts.find((a: any) => a.analystId === 'options_ingestion');
    const allSourceIds = (res.body.analysts as any[]).flatMap((a) => a.sources.map((s: any) => s.id));
    expect(allSourceIds).not.toContain('treasuryRfr');
    // Polygon options/aggregates (credentialed) must still be present.
    expect(opt?.sources.map((s: any) => s.id)).toEqual(
      expect.arrayContaining(['polygonOptions', 'polygonHist']),
    );
  });

  it('POST /analyst-config stores a token and echoes a safe summary (no token leak)', async () => {
    const res = await request(app)
      .post('/analyst-config?sessionId=ac-1')
      .send({ analystId: 'fundamental', sourceId: 'yahoo', token: 'sk_live_abc123' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.analystId).toBe('fundamental');
    expect(res.body.sourceId).toBe('yahoo');
    expect(res.body.hasToken).toBe(true);
    // The raw token must never be echoed back.
    expect(JSON.stringify(res.body)).not.toContain('sk_live_abc123');
    // And it IS in the server-side store.
    expect(store.get({ sessionId: 'ac-1', analystId: 'fundamental', sourceId: 'yahoo' })?.token).toBe(
      'sk_live_abc123'
    );
  });

  it('POST /analyst-config clears a token only on an explicit clearToken:true (blank token keeps existing)', async () => {
    store.set(
      { sessionId: 'ac-2', analystId: 'fundamental', sourceId: 'yahoo' },
      { token: 'old-token', extra: {} }
    );
    // A blank token WITHOUT clearToken must NOT wipe the stored one.
    const keep = await request(app)
      .post('/analyst-config?sessionId=ac-2')
      .send({ analystId: 'fundamental', sourceId: 'yahoo', token: '' });
    expect(keep.status).toBe(200);
    // Response hasToken reflects the *sent* (blank) token; the stored one is untouched.
    expect(keep.body.hasToken).toBe(false);
    expect(store.get({ sessionId: 'ac-2', analystId: 'fundamental', sourceId: 'yahoo' })?.token).toBe('old-token');

    // An explicit clearToken:true wipes it.
    const res = await request(app)
      .post('/analyst-config?sessionId=ac-2')
      .send({ analystId: 'fundamental', sourceId: 'yahoo', token: '', clearToken: true });
    expect(res.status).toBe(200);
    expect(res.body.hasToken).toBe(false);
    expect(store.get({ sessionId: 'ac-2', analystId: 'fundamental', sourceId: 'yahoo' })?.token).toBe('');
  });

  it('persists the token + URI to the encrypted vault and survives a fresh store instance (restart)', async () => {
    const res = await request(app)
      .post('/analyst-config?sessionId=ac-1')
      .send({ analystId: 'fundamental', sourceId: 'yahoo', token: 'live-key', extra: { uri: 'https://api.example.com' } });
    expect(res.status).toBe(200);
    expect(fs.existsSync(vaultFile)).toBe(true);

    // Simulate a server restart: brand-new store instance, same vault file.
    const restarted = vaultedStore(vaultFile);
    const cred = restarted.get({ sessionId: 'ac-1', analystId: 'fundamental', sourceId: 'yahoo' });
    expect(cred?.token).toBe('live-key');
    expect(cred?.extra.uri).toBe('https://api.example.com');
  });

  it('POST /analyst-config rejects a missing analystId with 400', async () => {
    const res = await request(app)
      .post('/analyst-config?sessionId=ac-3')
      .send({ sourceId: 'yahoo', token: 'x' });
    expect(res.status).toBe(400);
    expect(Array.isArray(res.body.details)).toBe(true);
  });

  it('reports vaultDisabled:true when the vault is not configured', async () => {
    // A store whose vault cipher is null => persistence disabled (in-memory).
    const disabledVault = new TokenVault(tmpVaultFile(), 'default', null);
    const disabledStore = new AnalystConfigStore(disabledVault);
    const app2 = express();
    app2.use(express.json());
    registerAnalystConfigRoutes(app2, disabledStore);

    const res = await request(app2).get('/analyst-config');
    expect(res.status).toBe(200);
    expect(res.body.vaultDisabled).toBe(true);
    // hasToken still computed, but always false without a persisted vault.
    for (const a of res.body.analysts) {
      for (const s of a.sources) expect(s.hasToken).toBe(false);
    }
  });

  it('POST /analyst-config/test probes with the stored token and reports ok on 2xx', async () => {
    await request(app)
      .post('/analyst-config?sessionId=test-1')
      .send({ analystId: 'data_ingestion', sourceId: 'alphaVantage', token: 'av-live', extra: { uri: 'https://www.alphavantage.co/query' } });

    const realFetch = (globalThis as any).fetch;
    (globalThis as any).fetch = async (_url: string, _init: any) => ({
      status: 200,
      ok: true,
      text: async () => JSON.stringify({ 'Global Quote': { '05. price': '123.45' } }),
    });
    try {
      const res = await request(app)
        .post('/analyst-config/test')
        .send({ analystId: 'data_ingestion', sourceId: 'alphaVantage', sessionId: 'test-1' });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.hasToken).toBe(true);
      expect(typeof res.body.latencyMs).toBe('number');
    } finally {
      (globalThis as any).fetch = realFetch;
    }
  });

  it('POST /analyst-config/test reports a clear error when no token is stored', async () => {
    const res = await request(app)
      .post('/analyst-config/test')
      .send({ analystId: 'data_ingestion', sourceId: 'finnhub', sessionId: 'test-2' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.hasToken).toBe(false);
    expect(res.body.error).toMatch(/save a token/i);
  });

  it('POST /analyst-config/test reports auth failure on 401 from the provider', async () => {
    await request(app)
      .post('/analyst-config?sessionId=test-3')
      .send({ analystId: 'data_ingestion', sourceId: 'finnhub', token: 'fh-bad', extra: { uri: 'https://finnhub.io/api/v1' } });

    const realFetch = (globalThis as any).fetch;
    (globalThis as any).fetch = async () => ({ status: 401, ok: false, text: async () => 'unauthorized' });
    try {
      const res = await request(app)
        .post('/analyst-config/test')
        .send({ analystId: 'data_ingestion', sourceId: 'finnhub', sessionId: 'test-3' });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(false);
      expect(res.body.status).toBe(401);
      expect(res.body.error).toMatch(/Authentication failed/i);
    } finally {
      (globalThis as any).fetch = realFetch;
    }
  });

  it('probes polygonOptions with the REAL options snapshot endpoint (honest entitlement check)', async () => {
    // Save a Polygon key under the options_ingestion analyst (where the engine
    // resolves it). Use the default Massive host.
    await request(app)
      .post('/analyst-config?sessionId=test-poly')
      .send({ analystId: 'options_ingestion', sourceId: 'polygonOptions', token: 'poly-live', extra: { uri: 'https://api.massive.com/v3/snapshot/options/{ticker}' } });

    const realFetch = (globalThis as any).fetch;
    let capturedUrl = '';
    let capturedAuth = '';
    (globalThis as any).fetch = async (url: string, init: any) => {
      capturedUrl = url;
      capturedAuth = init?.headers?.Authorization ?? '';
      return { status: 200, ok: true, text: async () => JSON.stringify({ results: [], status: 'OK' }) };
    };
    try {
      const res = await request(app)
        .post('/analyst-config/test')
        .send({ analystId: 'options_ingestion', sourceId: 'polygonOptions', sessionId: 'test-poly' });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      // The probe must NOT carry a literal {ticker}, must hit the REAL options
      // snapshot endpoint (not dividends), and must target the stored host
      // (api.massive.com) with Bearer auth. A green result now honestly means
      // the options entitlement works — not just dividends.
      expect(capturedUrl).not.toMatch(/\{ticker\}/);
      expect(capturedUrl).toMatch(/api\.massive\.com\/v3\/snapshot\/options\/AAPL/);
      expect(capturedAuth).toBe('Bearer poly-live');
    } finally {
      (globalThis as any).fetch = realFetch;
    }
  });
});

describe('AnalystConfigStore.resolveToken (B1 fallback chain)', () => {
  const file = path.join(os.tmpdir(), `analyst-config-rt-${process.pid}.gpg`);
  afterEach(() => { try { fs.unlinkSync(file); } catch {} });

  it('returns the per-source token when set', () => {
    const store = vaultedStore(file);
    store.set({ sessionId: 's', analystId: 'a', sourceId: 'yahoo' }, { token: 'src', extra: {} });
    expect(store.resolveToken({ sessionId: 's', analystId: 'a', sourceId: 'yahoo' }, 'global')).toBe('src');
  });

  it('falls back to the global token when no per-source token set', () => {
    const store = vaultedStore(file);
    expect(store.resolveToken({ sessionId: 's', analystId: 'a', sourceId: 'yahoo' }, 'global')).toBe('global');
  });

  it('falls back to empty string when neither set', () => {
    const store = vaultedStore(file);
    expect(store.resolveToken({ sessionId: 's', analystId: 'a', sourceId: 'yahoo' })).toBe('');
  });
});

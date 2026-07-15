// src/tests/analyst-config.test.ts
// B1: tests for the per-analyst / per-source credential route + store.
// Mirrors config-route.test.ts: exercises the real route registration without
// booting the full Socket.IO server. Asserts tokens are stored server-side and
// NEVER echoed back, and that the catalog reflects live+auth analysts only.

import request from 'supertest';
import express from 'express';
import { registerAnalystConfigRoutes } from '../server/analyst-config-routes';
import { AnalystConfigStore } from '../server/analyst-config';

describe('POST /analyst-config (B1 per-source credentials)', () => {
  let app: express.Express;
  let store: AnalystConfigStore;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    store = new AnalystConfigStore();
    registerAnalystConfigRoutes(app, store);
  });

  afterEach(() => {
    store.reset();
  });

  it('GET /analyst-config returns the live+auth catalog', async () => {
    const res = await request(app).get('/analyst-config');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('analysts');
    expect(Array.isArray(res.body.analysts)).toBe(true);
    // Each entry has an analystId + a list of credentialed sources.
    for (const a of res.body.analysts) {
      expect(typeof a.analystId).toBe('string');
      expect(Array.isArray(a.sources)).toBe(true);
      for (const s of a.sources) {
        expect(s).toHaveProperty('id');
        expect(s).toHaveProperty('label');
        expect(s).toHaveProperty('auth');
      }
    }
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

  it('POST /analyst-config can clear a token by sending an empty string', async () => {
    store.set(
      { sessionId: 'ac-2', analystId: 'fundamental', sourceId: 'yahoo' },
      { token: 'old-token', extra: {} }
    );
    const res = await request(app)
      .post('/analyst-config?sessionId=ac-2')
      .send({ analystId: 'fundamental', sourceId: 'yahoo', token: '' });
    expect(res.status).toBe(200);
    expect(res.body.hasToken).toBe(false);
    expect(store.get({ sessionId: 'ac-2', analystId: 'fundamental', sourceId: 'yahoo' })?.token).toBe('');
  });

  it('POST /analyst-config rejects a missing analystId with 400', async () => {
    const res = await request(app)
      .post('/analyst-config?sessionId=ac-3')
      .send({ sourceId: 'yahoo', token: 'x' });
    expect(res.status).toBe(400);
    expect(Array.isArray(res.body.details)).toBe(true);
  });

  it('POST /analyst-config rejects a missing sourceId with 400', async () => {
    const res = await request(app)
      .post('/analyst-config?sessionId=ac-3')
      .send({ analystId: 'fundamental', token: 'x' });
    expect(res.status).toBe(400);
  });
});

describe('AnalystConfigStore.resolveToken (B1 fallback chain)', () => {
  it('returns the per-source token when set', () => {
    const store = new AnalystConfigStore();
    store.set({ sessionId: 's', analystId: 'a', sourceId: 'yahoo' }, { token: 'src', extra: {} });
    expect(store.resolveToken({ sessionId: 's', analystId: 'a', sourceId: 'yahoo' }, 'global')).toBe('src');
  });

  it('falls back to the global token when no per-source token set', () => {
    const store = new AnalystConfigStore();
    expect(store.resolveToken({ sessionId: 's', analystId: 'a', sourceId: 'yahoo' }, 'global')).toBe('global');
  });

  it('falls back to empty string when neither set', () => {
    const store = new AnalystConfigStore();
    expect(store.resolveToken({ sessionId: 's', analystId: 'a', sourceId: 'yahoo' })).toBe('');
  });
});

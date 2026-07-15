// src/tests/analyst-params.test.ts
// Phase 2 (docs/CARD_SETTINGS_PANEL.md): backend weights store + routes + merge.
//
// Verifies:
//   - AnalystParamsStore validate/set/get/clear + allow-list enforcement
//   - POST /analyst-params rejects unknown keys & non-numbers; accepts valid
//   - GET  /analyst-params returns saved weights for an agency
//   - saved params merge into the resolved AnalystDef (so handlers see them)

import request from 'supertest';
import express from 'express';
import { AnalystParamsStore, ALLOWED_PARAM_KEYS } from '../server/analyst-params';
import { registerAnalystParamsRoutes } from '../server/analyst-params-routes';
import { resolveAnalystDef } from '../types/registry';
import { ANALYST_DEFS } from '../registry/analysts';
import { AGENCIES } from '../registry/agencies';

const makeApp = () => {
  const app = express();
  app.use(express.json());
  registerAnalystParamsRoutes(app, new AnalystParamsStore());
  return app;
};

afterEach(() => {
  // isolated store per test via fresh app; nothing global to reset
});

describe('AnalystParamsStore (Phase 2)', () => {
  it('rejects an unknown weight key for an analyst', () => {
    const v = AnalystParamsStore.validate({
      agencyId: 'long-term',
      analystId: 'technical',
      params: { notARealKey: 1 },
    });
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/notARealKey/);
  });

  it('rejects a non-number weight', () => {
    const v = AnalystParamsStore.validate({
      agencyId: 'long-term',
      analystId: 'risk',
      params: { maxStopLoss: 'tight' },
    });
    expect(v.ok).toBe(false);
  });

  it('accepts valid weights and stores/reads them', () => {
    const store = new AnalystParamsStore();
    const key = { sessionId: 's1', agencyId: 'intraday', analystId: 'risk' };
    store.set(key, { maxStopLoss: 0.03, baseAllocation: 2 });
    expect(store.get(key)).toEqual({ maxStopLoss: 0.03, baseAllocation: 2 });
    expect(store.has(key)).toBe(true);
    store.clear(key);
    expect(store.has(key)).toBe(false);
  });

  it('allow-list is exactly the handler-consumed keys', () => {
    expect((ALLOWED_PARAM_KEYS.technical ?? []).slice().sort()).toEqual(['maxLookbackDays', 'signalSensitivity']);
    expect((ALLOWED_PARAM_KEYS.risk ?? []).slice().sort()).toEqual(['baseAllocation', 'maxStopLoss']);
  });
});

describe('POST /analyst-params (Phase 2)', () => {
  it('saves valid weights and echoes them', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/analyst-params')
      .send({ sessionId: 's1', agencyId: 'intraday', analystId: 'technical', params: { signalSensitivity: 8 } });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.params).toEqual({ signalSensitivity: 8 });
  });

  it('400s on an out-of-allow-list key', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/analyst-params')
      .send({ sessionId: 's1', agencyId: 'long-term', analystId: 'fundamental', params: { weight: 1 } });
    expect(res.status).toBe(400);
    expect(res.body.details.join(' ')).toMatch(/not an adjustable weight/);
  });

  it('404s for an analyst not in the agency', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/analyst-params')
      .send({ sessionId: 's1', agencyId: 'crypto-screener', analystId: 'technical', params: { signalSensitivity: 1 } });
    expect(res.status).toBe(404);
  });
});

describe('GET /analyst-params (Phase 2)', () => {
  it('returns saved weights keyed by analyst for an agency', async () => {
    const store = new AnalystParamsStore();
    store.set({ sessionId: 's2', agencyId: 'intraday', analystId: 'risk' }, { maxStopLoss: 0.04 });
    store.set({ sessionId: 's2', agencyId: 'intraday', analystId: 'technical' }, { maxLookbackDays: 3 });
    const app = express();
    app.use(express.json());
    registerAnalystParamsRoutes(app, store);

    const res = await request(app).get('/analyst-params?sessionId=s2&agencyId=intraday');
    expect(res.status).toBe(200);
    expect(res.body.params).toEqual({
      risk: { maxStopLoss: 0.04 },
      technical: { maxLookbackDays: 3 },
    });
  });

  it('404s on an unknown agency', async () => {
    const app = makeApp();
    const res = await request(app).get('/analyst-params?agencyId=nope');
    expect(res.status).toBe(404);
  });
});

describe('saved params merge into resolved def (Phase 2)', () => {
  it('a saved risk param flows into resolveAnalystDef.params', () => {
    const store = new AnalystParamsStore();
    store.set({ sessionId: 's3', agencyId: 'long-term', analystId: 'risk' }, { maxStopLoss: 0.03 });
    const ref = AGENCIES['long-term']!.analysts.find((a) => a.id === 'risk')!;
    // Simulate the merge the server does at request time.
    const saved = store.get({ sessionId: 's3', agencyId: 'long-term', analystId: 'risk' })!;
    const mergedRef = { ...ref, params: { ...(ref.params ?? {}), ...saved } };
    const def = resolveAnalystDef(mergedRef, ANALYST_DEFS);
    expect(def.params?.maxStopLoss).toBe(0.03);
  });
});

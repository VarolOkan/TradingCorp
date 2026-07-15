// src/tests/config-route.test.ts
// Tests the real /config route registration (Option B) without booting the
// full Socket.IO / LangGraph server — registerConfigRoutes only pulls in
// express + connection-config, so this stays isolated and fast.
import request from 'supertest';
import express from 'express';
import { registerConfigRoutes } from '../server/config-routes';
import { ConnectionConfigStore } from '../server/connection-config';

describe('POST /config (Option B runtime settings)', () => {
  let app: express.Express;
  let store: ConnectionConfigStore;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    store = new ConnectionConfigStore();
    registerConfigRoutes(app, store);
  });

  afterEach(() => {
    store.reset();
  });

  it('GET /config returns the static analysis config', async () => {
    const res = await request(app).get('/config');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('analysis');
    expect(res.body).toHaveProperty('version', '1.0.0');
  });

  it('POST /config stores valid settings and echoes a safe summary (no token leak)', async () => {
    const res = await request(app)
      .post('/config?sessionId=route-valid')
      .send({
        baseUri: 'https://backend.example.com',
        accessToken: 'super-secret-token',
        extra: { region: 'eu' },
      });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.sessionId).toBe('route-valid');
    expect(res.body.baseUri).toBe('https://backend.example.com');
    expect(res.body.hasToken).toBe(true);
    expect(res.body.extraKeys).toEqual(['region']);
    // The raw token must never be echoed back.
    expect(JSON.stringify(res.body)).not.toContain('super-secret-token');
  });

  it('POST /config reads sessionId from body when not in query', async () => {
    const res = await request(app)
      .post('/config')
      .send({ sessionId: 'route-body', baseUri: 'http://localhost:9999' });
    expect(res.status).toBe(200);
    expect(res.body.sessionId).toBe('route-body');
    expect(store.get('route-body').baseUri).toBe('http://localhost:9999');
  });

  it('POST /config rejects an invalid baseUri with 400 + details', async () => {
    const res = await request(app)
      .post('/config?sessionId=route-bad')
      .send({ baseUri: 'not-a-url' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid connection settings');
    expect(Array.isArray(res.body.details)).toBe(true);
    expect(res.body.details.length).toBeGreaterThan(0);
  });

  it('POST /config rejects a non-object body', async () => {
    const res = await request(app)
      .post('/config?sessionId=route-bad2')
      .set('Content-Type', 'text/plain')
      .send('just a string');
    expect(res.status).toBe(400);
  });

  it('stored config is later readable via the store (read-at-analysis time)', () => {
    // Simulate the Settings dialog persisting config.
    store.set('route-valid', {
      baseUri: 'https://backend.example.com',
      accessToken: 'super-secret-token',
      extra: { region: 'eu' },
    });
    const cfg = store.get('route-valid');
    expect(cfg.baseUri).toBe('https://backend.example.com');
    expect(cfg.accessToken).toBe('super-secret-token');
  });
});

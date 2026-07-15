// src/tests/body-limit.test.ts
// Regression for the "PayloadTooLargeError: request entity too large" crash on
// POST /reports. The payload is the full final AgentState (raw-data channels +
// complete LLM message traces) and exceeds Express's 100KB body-parser default.
// This test mounts the SAME express.json({ limit: '25mb' }) middleware the
// server uses and asserts a >100KB body is accepted (not 413). It does NOT boot
// the full server (which would pull the sqlite chain) — it only exercises the
// body-size limit, which is the actual bug surface.
import { describe, it, expect } from '@jest/globals';
import express from 'express';
import http from 'http';
import { AddressInfo } from 'net';

function startApp(): Promise<{ server: http.Server; port: number; gotBody: (() => boolean) }> {
  const app = express();
  app.use(express.json({ limit: '25mb' }));
  let received = false;
  app.post('/reports', (req, res) => {
    received = true;
    res.json({ ok: true, bytes: JSON.stringify(req.body).length });
  });
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, port, gotBody: () => received });
    });
  });
}

function postJson(port: number, payload: unknown): Promise<{ status: number; ok: boolean }> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request(
      { host: '127.0.0.1', port, path: '/reports', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, ok: res.statusCode === 200 }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

describe('POST /reports body-size limit (PayloadTooLargeError regression)', () => {
  it('accepts a payload well above the old 100KB default', async () => {
    const { server, port } = await startApp();
    try {
      // ~5MB payload — comfortably over the 100KB default that crashed, under 25mb.
      const big = { messages: 'x'.repeat(5 * 1024 * 1024), dataReceived: [], ingested: null };
      const r = await postJson(port, big);
      expect(r.status).toBe(200); // was 413 (PayloadTooLargeError) before the fix
    } finally {
      server.close();
    }
  });

  it('still rejects a payload beyond 25mb (sanity that the limit is enforced)', async () => {
    const { server, port } = await startApp();
    try {
      const huge = { messages: 'x'.repeat(30 * 1024 * 1024) };
      const r = await postJson(port, huge);
      expect(r.status).toBe(413);
    } finally {
      server.close();
    }
  });
});

import { describe, it, expect, afterEach } from '@jest/globals';
import http from 'http';
import express from 'express';
import type { Server } from 'http';
import { registerApiDocsRoutes } from './api-docs-routes';

// The backend jest setup stubs global fetch to reject (no network). Use the
// node http module directly to hit the in-process express app.
function get(port: number, path: string): Promise<{ status: number; contentType: string; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: 'localhost', port, path }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          contentType: res.headers['content-type'] ?? '',
          body: data,
        }),
      );
    });
    req.on('error', reject);
  });
}

describe('api-docs-routes', () => {
  let server: Server | null = null;
  const savedHost = process.env.HOST;
  const savedPort = process.env.PORT;

  afterEach(() => {
    server?.close();
    server = null;
    process.env.HOST = savedHost;
    process.env.PORT = savedPort;
  });

  async function start(): Promise<number> {
    const app = express();
    registerApiDocsRoutes(app);
    return await new Promise<number>((resolve) => {
      server = app.listen(0, () => resolve((server!.address() as any).port));
    });
  }

  it('reflects the HOST/PORT env in the servers entry (not localhost:3001)', async () => {
    process.env.HOST = '10.9.200.188';
    process.env.PORT = '8091';
    const port = await start();
    const res = await get(port, '/api-docs/openapi.json');
    const doc = JSON.parse(res.body);
    expect(doc.servers).toEqual([
      { url: 'http://10.9.200.188:8091', description: 'Running server (from HOST/PORT env)' },
    ]);
  });

  it('falls back to localhost:3001 when HOST/PORT are unset', async () => {
    delete process.env.HOST;
    delete process.env.PORT;
    const port = await start();
    const res = await get(port, '/api-docs/openapi.json');
    const doc = JSON.parse(res.body);
    expect(doc.servers).toEqual([
      { url: 'http://localhost:3001', description: 'Running server (from HOST/PORT env)' },
    ]);
  });

  it('serves the Swagger UI HTML page with the dark-mode class', async () => {
    const port = await start();
    const res = await get(port, '/api-docs');
    expect(res.contentType).toContain('text/html');
    expect(res.body).toContain('swagger-ui');
    expect(res.body).toContain('class="dark-mode"');
  });
});

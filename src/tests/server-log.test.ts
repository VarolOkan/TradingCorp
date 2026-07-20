// src/tests/server-log.test.ts
// GET /server-log returns the last N lines of the log file.
//
// The route reads the log path live via getLogFile(), which setLogFile() can
// redirect. Each test points the logger at its OWN unique temp file (never the
// default ./logs/server.log) so parallel workers writing through the shared
// logger can't pollute it. This avoids jest.isolateModules + require, which
// segfaults a worker under the parallel suite.
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { registerServerLogRoutes } from '../server/server-log-routes';
import { setLogFile, getLogFile } from '../utils/logger';

function tmpLog(): string {
  return path.join(os.tmpdir(), `tc-srvlog-${process.pid}-${Math.random().toString(36).slice(2)}.log`);
}

function makeApp() {
  const app = express();
  registerServerLogRoutes(app);
  return app;
}

beforeEach(() => {
  // Point the (shared) logger + route at a fresh, isolated temp file.
  setLogFile(tmpLog());
});

afterAll(() => {
  // Best-effort cleanup of any temp logs we created in this process.
  try {
    for (const f of fs.readdirSync(os.tmpdir())) {
      if (f.startsWith(`tc-srvlog-${process.pid}-`)) fs.rmSync(path.join(os.tmpdir(), f), { force: true });
    }
  } catch { /* ignore */ }
});

describe('GET /server-log', () => {
  it('returns the last N lines of the log file when it exists', async () => {
    fs.writeFileSync(getLogFile(), [
      '[INFO] 2026-01-01T00:00:00.000Z - boot',
      '[INFO] 2026-01-01T00:00:01.000Z - listening',
      '[DEBUG] 2026-01-01T00:00:02.000Z - client connected',
    ].join('\n') + '\n');
    const app = makeApp();
    const res = await request(app).get('/server-log?lines=200');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    const raw = fs.readFileSync(getLogFile(), 'utf8');
    const all = raw.split('\n').filter((l) => l.length);
    const expected = all.slice(Math.max(0, all.length - 200)).join('\n');
    expect(res.text).toBe(expected);
  });

  it('clamps lines to a sane max and accepts a small count', async () => {
    fs.writeFileSync(getLogFile(), 'a\nb\nc\nd\ne\n');
    const app = makeApp();
    const res = await request(app).get('/server-log?lines=5');
    expect(res.status).toBe(200);
    const lineCount = res.text.length ? res.text.split('\n').length : 0;
    expect(lineCount).toBeLessThanOrEqual(5);
  });

  it('falls back gracefully when the log file is missing', async () => {
    fs.rmSync(getLogFile(), { force: true });
    const app = makeApp();
    const res = await request(app).get('/server-log?lines=200');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/no log file yet/);
  });
});

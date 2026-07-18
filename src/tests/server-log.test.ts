// src/tests/server-log.test.ts
// GET /server-log returns the last N lines of the log file.
//
// The route reads LOG_FILE_PATH, a const bound at import time from
// process.env.LOG_FILE (default ./logs/server.log). The shared default log is
// appended to by every parallel jest worker, so comparing against it is racy.
// To make this test deterministic we point LOG_FILE at an isolated temp file
// that nothing else writes to, and import the modules AFTER setting the env so
// their module-level LOG_FILE_PATH binds to the temp path.
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TMP_LOG = path.join(os.tmpdir(), `tc-srvlog-${process.pid}.log`);

// Set the env BEFORE any module that reads it is imported.
process.env.LOG_FILE = TMP_LOG;

// Fresh module graph so logger binds LOG_FILE_PATH to TMP_LOG. Assign inside
// the isolateModules callback (its return value is discarded in this jest version).
let registerServerLogRoutes: (app: import('express').Express) => void;
let LOG_FILE_PATH: string;
jest.isolateModules(() => {
  const m = require('../server/server-log-routes');
  registerServerLogRoutes = m.registerServerLogRoutes;
});
jest.isolateModules(() => {
  const m = require('../utils/logger');
  LOG_FILE_PATH = m.LOG_FILE_PATH;
});

function makeApp() {
  const app = express();
  registerServerLogRoutes(app);
  return app;
}

beforeAll(() => {
  // Ensure a clean, controlled log file with known content.
  fs.writeFileSync(TMP_LOG, [
    '[INFO] 2026-01-01T00:00:00.000Z - boot',
    '[INFO] 2026-01-01T00:00:01.000Z - listening',
    '[DEBUG] 2026-01-01T00:00:02.000Z - client connected',
  ].join('\n') + '\n');
});

afterAll(() => {
  fs.rmSync(TMP_LOG, { force: true });
});

describe('GET /server-log', () => {
  it('returns the last N lines of the log file when it exists', async () => {
    const app = makeApp();
    const res = await request(app).get('/server-log?lines=200');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    const raw = fs.readFileSync(LOG_FILE_PATH, 'utf8');
    const all = raw.split('\n').filter((l) => l.length);
    const expected = all.slice(Math.max(0, all.length - 200)).join('\n');
    expect(res.text).toBe(expected);
  });

  it('clamps lines to a sane max and accepts a small count', async () => {
    const app = makeApp();
    const res = await request(app).get('/server-log?lines=5');
    expect(res.status).toBe(200);
    const lineCount = res.text.length ? res.text.split('\n').length : 0;
    expect(lineCount).toBeLessThanOrEqual(5);
  });

  it('falls back gracefully when the log file is missing', async () => {
    fs.rmSync(TMP_LOG, { force: true });
    const app = makeApp();
    const res = await request(app).get('/server-log?lines=200');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/no log file yet/);
    // Restore for afterAll cleanup.
    fs.writeFileSync(TMP_LOG, '');
  });
});

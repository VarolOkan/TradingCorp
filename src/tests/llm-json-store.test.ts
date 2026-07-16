// src/tests/llm-json-store.test.ts
// Regression for the model-name (agencyModelRole) persisting across restart.
// The production server now uses JsonLlmStore (plain fs, no native module),
// replacing the flaky better-sqlite3 binding. This test proves a set agency
// role + role selection survive a fresh store instance reading the same file.
import { describe, it, expect, afterAll } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { JsonLlmStore } from '../server/llm-json-store';

const tmp = path.join(os.tmpdir(), `llm-json-test-${process.pid}-${Date.now()}`);
fs.mkdirSync(tmp, { recursive: true });
const file = path.join(tmp, 'llm-config.json');

afterAll(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('JsonLlmStore persists selection across restart', () => {
  it('agency role + role config survive a fresh instance', () => {
    const s1 = new JsonLlmStore(file, 'default');
    s1.setAgencyRole('default', 'default', 'long-term', 'deep-thought');
    s1.upsertRoleConfig('default', {
      role: 'deep-thought',
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'claude-opus-4-8',
    });

    // Fresh instance == restart, same file.
    const s2 = new JsonLlmStore(file, 'default');
    expect(s2.getAgencyRole('default', 'default', 'long-term')).toBe('deep-thought');
    const rc = s2.getRoleConfig('default', 'deep-thought');
    expect(rc).not.toBeNull();
    expect(rc!.model).toBe('claude-opus-4-8');
  });

  it('clearUser wipes the persisted selections', () => {
    const file2 = path.join(tmp, 'llm-config-2.json');
    const s1 = new JsonLlmStore(file2, 'default');
    s1.setAgencyRole('default', 'default', 'long-term', 'scanner');
    s1.clearUser('default');

    const s2 = new JsonLlmStore(file2, 'default');
    expect(s2.getAgencyRole('default', 'default', 'long-term')).toBeNull();
  });
});

describe('DATA_DIR relocates llm-config.json + writes are traced', () => {
  const origDataDir = process.env.DATA_DIR;
  afterEach(() => {
    if (origDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = origDataDir;
  });

  it('DATA_DIR env var relocates the default llm-config.json out of cwd/.data', () => {
    const custom = path.join(os.tmpdir(), `data-dir-test-${process.pid}-${Date.now()}`);
    fs.rmSync(custom, { recursive: true, force: true });
    process.env.DATA_DIR = custom;
    try {
      const s = new JsonLlmStore(undefined, 'default');
      s.upsertRoleConfig('default', {
        role: 'deep-thought',
        provider: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        model: 'claude-opus-4-8',
      });
      // The file must land under DATA_DIR.
      const relocated = path.join(custom, 'llm-config.json');
      expect(fs.existsSync(relocated)).toBe(true);
      // And it holds the model we just saved (proves it's THE config file, not a stray).
      const saved = JSON.parse(fs.readFileSync(relocated, 'utf8'));
      expect(saved.roles.default['deep-thought'].model).toBe('claude-opus-4-8');
    } finally {
      fs.rmSync(custom, { recursive: true, force: true });
    }
  });

  it('every write to llm-config.json is traced to the server log with a stack + content', () => {
    // Spy on the shared logger's warn so we capture the audit lines synchronously
    // (the file stream is async and would be racy to read back).
    const { logger } = require('../utils/logger');
    const spy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const s = new JsonLlmStore(file, 'default');
      s.upsertRoleConfig('default', {
        role: 'scanner',
        provider: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        model: 'claude-3.5-sonnet',
      });
      const logged = spy.mock.calls.map((c) => String(c[0])).join('\n');
      // The audit tag is present...
      expect(logged).toContain('[LLM-CONFIG-WRITE]');
      // ...with a stack trace (at least one frame)...
      expect(logged).toMatch(/LLM-CONFIG-WRITE\] writing .* stack:/);
      // ...and the persisted content (the model we just saved).
      expect(logged).toContain('claude-3.5-sonnet');
    } finally {
      spy.mockRestore();
    }
  });
});

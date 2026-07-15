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

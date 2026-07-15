// src/tests/llm-sqlite.test.ts
// Phase G (persistence split) — per-user SQLite selection store.
//
// These tests use REAL on-disk SQLite files in a temp dir (via mkdtemp) so that
// "survives restart" is genuinely exercised: write with one store instance,
// reopen a fresh instance off the same file, and assert the rows are there.
import { describe, it, expect, afterAll } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SqliteLlmStore } from '../server/llm-sqlite';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-sqlite-'));
afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function storeFor(file: string, userId = 'default'): SqliteLlmStore {
  return new SqliteLlmStore(path.join(tmpRoot, file), userId);
}

describe('SqliteLlmStore — per-role selection persistence', () => {
  it('upsertRoleConfig then reopening a fresh instance recovers provider/baseUrl/model', () => {
    const file = 'roles.db';
    const w = storeFor(file, 'default');
    w.upsertRoleConfig('default', {
      role: 'deep-thought',
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
    });
    w.close();

    // Simulate a "server restart" — brand new instance, same file.
    const r = storeFor(file, 'default');
    const row = r.getRoleConfig('default', 'deep-thought');
    expect(row).not.toBeNull();
    expect(row!.provider).toBe('openai');
    expect(row!.baseUrl).toBe('https://api.openai.com/v1');
    expect(row!.model).toBe('gpt-4o');
    r.close();
  });

  it('all three roles persist independently', () => {
    const file = 'roles3.db';
    const w = storeFor(file, 'default');
    w.upsertRoleConfig('default', { role: 'deep-thought', provider: 'openrouter', baseUrl: 'u', model: 'm-dt' });
    w.upsertRoleConfig('default', { role: 'scanner', provider: 'anthropic', baseUrl: 'u', model: 'm-sc' });
    w.upsertRoleConfig('default', { role: 'flexible', provider: 'ollama', baseUrl: 'u', model: 'm-fl' });
    w.close();

    const r = storeFor(file, 'default');
    const all = r.getAllRoleConfigs('default');
    expect(all.map((c) => c.role).sort()).toEqual(['deep-thought', 'flexible', 'scanner']);
    expect(r.getRoleConfig('default', 'scanner')!.model).toBe('m-sc');
    r.close();
  });

  it('upsert overwrites an existing role (no duplicate rows)', () => {
    const file = 'roles-up.db';
    const w = storeFor(file, 'default');
    w.upsertRoleConfig('default', { role: 'scanner', provider: 'openai', baseUrl: 'u', model: 'v1' });
    w.upsertRoleConfig('default', { role: 'scanner', provider: 'openai', baseUrl: 'u', model: 'v2' });
    w.close();

    const r = storeFor(file, 'default');
    const all = r.getAllRoleConfigs('default');
    expect(all.length).toBe(1);
    expect(all[0].model).toBe('v2');
    r.close();
  });
});

describe('SqliteLlmStore — per-agency role override persistence', () => {
  it('setAgencyRole then reopen recovers the override', () => {
    const file = 'agency.db';
    const w = storeFor(file, 'default');
    w.setAgencyRole('default', 'default', 'long-term', 'scanner');
    w.close();

    const r = storeFor(file, 'default');
    expect(r.getAgencyRole('default', 'default', 'long-term')).toBe('scanner');
    r.close();
  });

  it('null override (cleared) round-trips as null', () => {
    const file = 'agency-null.db';
    const w = storeFor(file, 'default');
    w.setAgencyRole('default', 'default', 'options-swing', 'flexible');
    w.setAgencyRole('default', 'default', 'options-swing', null); // user cleared it
    w.close();

    const r = storeFor(file, 'default');
    expect(r.getAgencyRole('default', 'default', 'options-swing')).toBeNull();
    r.close();
  });

  it('getAllAgencyRoles returns all overrides keyed as sessionId:agencyId', () => {
    const file = 'agency-all.db';
    const w = storeFor(file, 'default');
    w.setAgencyRole('default', 'default', 'long-term', 'scanner');
    w.setAgencyRole('default', 'default', 'options-intraday', 'flexible');
    w.close();

    const r = storeFor(file, 'default');
    const all = r.getAllAgencyRoles('default');
    expect(all['default:long-term']).toBe('scanner');
    expect(all['default:options-intraday']).toBe('flexible');
    r.close();
  });
});

describe('SqliteLlmStore — per-user isolation', () => {
  it('two users keep independent selections on the SAME file', () => {
    const file = 'multi.db';
    const a = storeFor(file, 'alice');
    const b = storeFor(file, 'bob');
    a.upsertRoleConfig('alice', { role: 'deep-thought', provider: 'openai', baseUrl: 'u', model: 'a-model' });
    b.upsertRoleConfig('bob', { role: 'deep-thought', provider: 'anthropic', baseUrl: 'u', model: 'b-model' });
    a.close();
    b.close();

    const ra = storeFor(file, 'alice');
    const rb = storeFor(file, 'bob');
    expect(ra.getRoleConfig('alice', 'deep-thought')!.model).toBe('a-model');
    expect(rb.getRoleConfig('bob', 'deep-thought')!.model).toBe('b-model');
    // Isolation is at the row level: reading user 'alice' never returns bob's row.
    expect(ra.getRoleConfig('alice', 'deep-thought')!.model).not.toBe('b-model');
    expect(ra.getAllRoleConfigs('alice').length).toBe(1);
    ra.close();
    rb.close();
  });

  it('clearUser wipes only that user, leaving others intact', () => {
    const file = 'clear.db';
    const a = storeFor(file, 'alice');
    const b = storeFor(file, 'bob');
    a.upsertRoleConfig('alice', { role: 'scanner', provider: 'openai', baseUrl: 'u', model: 'a' });
    b.upsertRoleConfig('bob', { role: 'scanner', provider: 'openai', baseUrl: 'u', model: 'b' });
    a.clearUser('alice');
    a.close();
    b.close();

    const ra = storeFor(file, 'alice');
    const rb = storeFor(file, 'bob');
    expect(ra.getAllRoleConfigs('alice')).toHaveLength(0);
    expect(rb.getAllRoleConfigs('bob')).toHaveLength(1);
    ra.close();
    rb.close();
  });
});

describe('SqliteLlmStore — secrets are NOT stored', () => {
  it('the schema has no token/secret column', () => {
    const file = 'schema.db';
    const s = storeFor(file, 'default');
    // Insert a normal selection to force schema creation.
    s.upsertRoleConfig('default', { role: 'deep-thought', provider: 'openai', baseUrl: 'u', model: 'm' });
    // Reach the underlying db via a fresh connection to introspect the schema.
    const Database = require('better-sqlite3');
    const db = new Database(path.join(tmpRoot, file));
    const roleCols = db.prepare("PRAGMA table_info(llm_role_config)").all().map((c: any) => c.name);
    const agencyCols = db.prepare("PRAGMA table_info(llm_agency_role)").all().map((c: any) => c.name);
    db.close();
    expect(roleCols).not.toContain('token');
    expect(roleCols).not.toContain('secret');
    expect(agencyCols).not.toContain('token');
    s.close();
  });
});

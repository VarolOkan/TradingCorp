// src/tests/llm-config.test.ts
// Phase G — LLM provider/model configuration (docs/EXTENDING_ANALYSTS.md §8).
import { describe, it, expect } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import {
  LlmConfigStore,
  resolveLlmConfig,
  resolveModelRole,
  defaultLlmConfigs,
  type LlmModelConfig,
} from '../server/llm-config';
import { inMemorySqlite, SqliteLlmStore } from '../server/llm-sqlite';
import { registerLlmConfigRoutes } from '../server/llm-config-routes';
import { runAnalystLLM } from '../registry/logic/llm';

describe('LlmConfigStore', () => {
  it('constructs with the three preconfigured roles (openrouter, claude-opus-4-8, empty token)', () => {
    const store = LlmConfigStore.seeded(undefined, inMemorySqlite());
    const list = store.list();
    expect(list.length).toBe(3);
    for (const role of ['deep-thought', 'scanner', 'flexible'] as const) {
      const cfg = list.find((c) => c.role === role)!;
      expect(cfg).toBeDefined();
      expect(cfg.provider).toBe('openrouter');
      expect(cfg.model).toBe('anthropic/claude-opus-4-8');
      expect(cfg.hasToken).toBe(false);
    }
  });

  it('status reports configured:false for all three on a fresh store', () => {
    const status = LlmConfigStore.seeded(undefined, inMemorySqlite()).status();
    expect(status['deep-thought']!.configured).toBe(false);
    expect(status['scanner']!.configured).toBe(false);
    expect(status['flexible']!.configured).toBe(false);
  });

  it('put overrides a role', () => {
    const store = LlmConfigStore.seeded(undefined, inMemorySqlite());
    store.put({
      role: 'scanner',
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      token: 'sk-test',
    });
    const cfg = store.get('scanner');
    expect(cfg.provider).toBe('openai');
    expect(cfg.model).toBe('gpt-4o');
    expect(cfg.token).toBe('sk-test');
    expect(store.list().find((c) => c.role === 'scanner')!.hasToken).toBe(true);
  });

  it('get never echoes the token (returns hasToken only)', () => {
    const store = LlmConfigStore.seeded(undefined, inMemorySqlite());
    store.put({
      role: 'deep-thought',
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'anthropic/claude-opus-4-8',
      token: 'secret',
    });
    const publicCfg = store.list().find((c) => c.role === 'deep-thought')!;
    expect((publicCfg as any).token).toBeUndefined();
    expect(publicCfg.hasToken).toBe(true);
  });

  it('supplying a token flips only that role\'s configured flag', () => {
    const store = LlmConfigStore.seeded(undefined, inMemorySqlite());
    store.put({
      role: 'flexible',
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'anthropic/claude-opus-4-8',
      token: 'fk',
    });
    const status = store.status();
    expect(status['flexible']!.configured).toBe(true);
    expect(status['deep-thought']!.configured).toBe(false);
    expect(status['scanner']!.configured).toBe(false);
  });
});

describe('resolveLlmConfig', () => {
  it('each role maps to its provider/baseUrl/model', () => {
    const store = LlmConfigStore.seeded(undefined, inMemorySqlite());
    const dt = resolveLlmConfig(store, 'deep-thought');
    expect(dt.provider).toBe('openrouter');
    expect(dt.baseUrl).toContain('openrouter.ai');
    expect(dt.model).toBe('anthropic/claude-opus-4-8');
  });

  it('a POSTed OpenAI role resolves to the OpenAI base URL', () => {
    const store = LlmConfigStore.seeded(undefined, inMemorySqlite());
    store.put({
      role: 'deep-thought',
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      token: 'sk',
    });
    const cfg = resolveLlmConfig(store, 'deep-thought');
    expect(cfg.provider).toBe('openai');
    expect(cfg.baseUrl).toBe('https://api.openai.com/v1');
  });
});

describe('resolveModelRole precedence', () => {
  it('flavor.modelRole wins over agency + def', () => {
    expect(resolveModelRole('scanner', 'flexible', 'deep-thought')).toBe('scanner');
  });
  it('agency override wins over def when flavor is unset', () => {
    expect(resolveModelRole(undefined, 'flexible', 'deep-thought')).toBe('flexible');
  });
});

describe('POST /llm-config — empty token preserves existing (no wipe on save)', () => {
  let app: express.Express;
  let store: LlmConfigStore;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    store = LlmConfigStore.seeded(undefined, inMemorySqlite());
    registerLlmConfigRoutes(app, store);
  });

  it('saving with a blank token for untouched roles keeps the stored token', async () => {
    // 1) User stores a real token for deep-thought.
    await request(app)
      .post('/llm-config')
      .send({
        sessionId: 'default',
        configs: [
          { role: 'deep-thought', provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-opus-4-8', token: 'real-secret' },
          { role: 'scanner', provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-opus-4-8', token: '' },
          { role: 'flexible', provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-opus-4-8', token: '' },
        ],
      });
    expect(store.get('deep-thought').token).toBe('real-secret');

    // 2) Later the dialog reopens and re-saves (sending '' for every role whose
    //    Token field was left blank — exactly the SettingsDialog behaviour).
    const res = await request(app)
      .post('/llm-config')
      .send({
        sessionId: 'default',
        configs: [
          { role: 'deep-thought', provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-opus-4-8', token: '' },
          { role: 'scanner', provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-opus-4-8', token: '' },
          { role: 'flexible', provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-opus-4-8', token: '' },
        ],
      });
    expect(res.status).toBe(200);
    // The previously-stored token must survive the blank re-save.
    expect(store.get('deep-thought').token).toBe('real-secret');
    expect(res.body.configs.find((c: any) => c.role === 'deep-thought').hasToken).toBe(true);
  });

  it('a non-empty token still replaces the existing one', async () => {
    await request(app)
      .post('/llm-config')
      .send({
        sessionId: 'default',
        configs: [
          { role: 'deep-thought', provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-opus-4-8', token: 'first' },
          { role: 'scanner', provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-opus-4-8', token: '' },
          { role: 'flexible', provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-opus-4-8', token: '' },
        ],
      });
    const res = await request(app)
      .post('/llm-config')
      .send({
        sessionId: 'default',
        configs: [
          { role: 'deep-thought', provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o', token: 'second' },
          { role: 'scanner', provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-opus-4-8', token: '' },
          { role: 'flexible', provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-opus-4-8', token: '' },
        ],
      });
    expect(res.status).toBe(200);
    expect(store.get('deep-thought').token).toBe('second');
  });
});

describe('POST /llm-config/test — provider probe', () => {
  let app: express.Express;
  let store: LlmConfigStore;
  let fetchImpl: (url: string, init: any) => Promise<any>;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    store = LlmConfigStore.seeded(undefined, inMemorySqlite());
    registerLlmConfigRoutes(app, store);
    // The real probe uses global fetch, which the harness disables. Override it
    // with a controllable stub for this block (restored in afterEach).
    fetchImpl = (globalThis as any).fetch;
    (globalThis as any).fetch = jest.fn(async (url: string, init: any) => {
      const auth = init?.headers?.['Authorization'] ?? init?.headers?.authorization ?? '';
      const isAnthropic = url.includes('anthropic') || (init?.headers && 'x-api-key' in init.headers);
      const good =
        auth === 'Bearer good' ||
        init?.headers?.['x-api-key'] === 'good' ||
        (isAnthropic && init?.headers?.['x-api-key'] === 'good');
      if (good) {
        return {
          status: 200,
          async text() {
            return JSON.stringify({ data: [] });
          },
        };
      }
      return {
        status: 401,
        async text() {
          return JSON.stringify({ error: { message: 'unauthorized' } });
        },
      };
    });
  });

  afterEach(() => {
    (globalThis as any).fetch = fetchImpl;
  });

  it('maps a successful probe (good Bearer token) to ok', async () => {
    const res = await request(app)
      .post('/llm-config/test')
      .send({
        role: 'deep-thought',
        provider: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        model: 'anthropic/claude-opus-4-8',
        token: 'good',
      });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.status).toBe(200);
    expect(res.body.hasToken).toBe(true);
  });

  it('maps a rejected (401) token to an auth-failure message', async () => {
    const res = await request(app)
      .post('/llm-config/test')
      .send({
        role: 'deep-thought',
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o',
        token: 'bad',
      });
    expect(res.body.ok).toBe(false);
    expect(res.body.status).toBe(401);
    expect(res.body.error).toMatch(/Authentication failed/i);
  });

  it('falls back to the stored token when the request body token is blank', async () => {
    store.put({
      role: 'deep-thought',
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'anthropic/claude-opus-4-8',
      token: 'good',
    });
    const res = await request(app)
      .post('/llm-config/test')
      .send({
        role: 'deep-thought',
        provider: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        model: 'anthropic/claude-opus-4-8',
        token: '', // blank → should reuse stored 'good'
      });
    expect(res.body.ok).toBe(true);
  });

  it('rejects an invalid provider', async () => {
    const res = await request(app)
      .post('/llm-config/test')
      .send({ role: 'deep-thought', provider: 'nope', baseUrl: 'http://x', model: '', token: '' });
    expect(res.status).toBe(400);
  });
});

describe('resolveModelRole precedence (continued)', () => {
  it('def default wins when flavor + agency unset', () => {
    expect(resolveModelRole(undefined, null, 'scanner')).toBe('scanner');
  });
  it('falls through to deep-thought when nothing set', () => {
    expect(resolveModelRole(undefined, null, undefined)).toBe('deep-thought');
  });
  it('"assign a model to an agency" makes every flavor in that agency inherit it unless overridden', () => {
    const agencyRole = 'scanner' as const;
    // flavor A has no modelRole → inherits agency
    expect(resolveModelRole(undefined, agencyRole, undefined)).toBe('scanner');
    // flavor B sets its own → keeps its own
    expect(resolveModelRole('flexible', agencyRole, undefined)).toBe('flexible');
  });
});

describe('runAnalystLLM', () => {
  it('no token → deterministic fallback (no network), parity-safe', async () => {
    const res = await runAnalystLLM({
      system: 'You are a careful options analyst.',
      user: 'IV 40, delta 0.5',
      role: 'deep-thought',
    });
    expect(res.usedFallback).toBe(true);
    expect(res.verdict).toBe('NEUTRAL');
    expect(res.text).toContain('You are a careful options analyst.');
  });

  it('resolves the role into the fallback tag', async () => {
    const res = await runAnalystLLM({
      system: 'x',
      user: 'y',
      role: 'scanner',
    });
    expect(res.role).toBe('scanner');
    expect(res.usedFallback).toBe(true);
  });

  it('a configured token attempts the provider (falls back on failure, never throws)', async () => {
    // Point at an unreachable base URL with a fake token → should catch the
    // error and return a fallback result rather than throwing.
    const store = LlmConfigStore.seeded(undefined, inMemorySqlite());
    store.put({
      role: 'deep-thought',
      provider: 'openai',
      baseUrl: 'http://127.0.0.1:9/v1', // nothing listening
      model: 'gpt-4o',
      token: 'sk-fake',
    });
    const res = await runAnalystLLM({
      system: 'be a bull',
      user: 'data',
      role: 'deep-thought',
    });
    expect(res.usedFallback).toBe(true);
    expect(res.verdict).toBe('NEUTRAL');
  });
});

describe('LlmConfigStore — selection survives restart via SQLite (Phase G)', () => {
  const tmp = require('os').tmpdir();
  const dbFile = require('path').join(tmp, `cfg-restart-${Date.now()}.db`);
  const userId = 'default';

  afterAll(() => {
    try { require('fs').rmSync(dbFile, { force: true }); } catch { /* noop */ }
  });

  it('put() selection is recovered by a brand-new store off the same db file', () => {
    // 1) First "process": write a selection to on-disk SQLite.
    const first = new LlmConfigStore(defaultLlmConfigs(), undefined, new SqliteLlmStore(dbFile, userId), userId);
    first.put({ role: 'scanner', provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o', token: 'sk-x' });
    first.setAgencyModelRole('default', 'long-term', 'scanner');
    first['sqlite'].close?.();

    // 2) Simulate a server restart: brand-new store, same db file.
    const second = new LlmConfigStore(defaultLlmConfigs(), undefined, new SqliteLlmStore(dbFile, userId), userId);
    expect(second.get('scanner').provider).toBe('openai');
    expect(second.get('scanner').model).toBe('gpt-4o');
    // Token is NOT in the db (secret), so it must be re-supplied; selection is.
    expect(second.get('scanner').token).toBe('');
    expect(second.getAgencyModelRole('default', 'long-term')).toBe('scanner');
    second['sqlite'].close?.();
  });
});

describe('LlmConfigStore — partial/corrupt llm-config.json never drops a role (regression)', () => {
  const fs = require('fs') as typeof import('fs');
  const os = require('os') as typeof import('os');
  const pathMod = require('path') as typeof import('path');
  const { JsonLlmStore } = require('../server/llm-json-store') as typeof import('../server/llm-json-store');

  let jsonFile: string;

  beforeEach(() => {
    jsonFile = pathMod.join(os.tmpdir(), `llm-config-regress-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  });
  afterEach(() => {
    try { fs.rmSync(jsonFile, { force: true }); } catch { /* noop */ }
  });

  const readDisk = () =>
    JSON.parse(fs.readFileSync(jsonFile, 'utf8')) as {
      roles: Record<string, Record<string, { provider: string; model: string }>>;
      agencyRoles: Record<string, Record<string, string | null>>;
    };

  it('self-heals a file that is missing a canonical role on load', () => {
    // Simulate the wiped state a stale build left behind: scanner is GONE.
    fs.writeFileSync(jsonFile, JSON.stringify({
      roles: {
        default: {
          flexible: { role: 'flexible', provider: 'ollama', baseUrl: 'http://localhost:11434/v1', model: 'llama3' },
          'deep-thought': { role: 'deep-thought', provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'tencent/hy3:free' },
        },
      },
      agencyRoles: {},
    }, null, 2), 'utf8');

    // Booting a store off this file must re-seed scanner from defaults AND
    // persist it back so it can never stay missing.
    const store = new LlmConfigStore(defaultLlmConfigs(), undefined, new JsonLlmStore(jsonFile, 'default'), 'default');
    expect(store.list().map((c) => c.role).sort()).toEqual(['deep-thought', 'flexible', 'scanner']);
    // The user's real selections are preserved (not overwritten by defaults).
    expect(store.get('flexible').model).toBe('llama3');
    expect(store.get('deep-thought').model).toBe('tencent/hy3:free');
    // The healed scanner comes from the seeded default.
    expect(store.get('scanner').provider).toBe('openrouter');

    // And it is now durably on disk.
    const disk = readDisk();
    expect(Object.keys(disk.roles.default).sort()).toEqual(['deep-thought', 'flexible', 'scanner']);
  });

  it('put() of one role never drops the other role selections from disk', () => {
    // Seed all three, restart-style, then update ONLY deep-thought.
    const seed = new LlmConfigStore(defaultLlmConfigs(), undefined, new JsonLlmStore(jsonFile, 'default'), 'default');
    seed.put({ role: 'flexible', provider: 'ollama', baseUrl: 'http://localhost:11434/v1', model: 'llama3', token: '' });
    seed.put({ role: 'scanner', provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-opus-4-8', token: '' });

    // A second process updates deep-thought only.
    const store = new LlmConfigStore(defaultLlmConfigs(), undefined, new JsonLlmStore(jsonFile, 'default'), 'default');
    store.put({ role: 'deep-thought', provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'tencent/hy3:free', token: '' });

    const disk = readDisk();
    // All three roles must still be present — the single put must not clobber
    // flexible/scanner (the exact bug that wiped scanner from llm-config.json).
    expect(Object.keys(disk.roles.default).sort()).toEqual(['deep-thought', 'flexible', 'scanner']);
    expect(disk.roles.default.flexible!.model).toBe('llama3');
    expect(disk.roles.default.scanner!.model).toBe('anthropic/claude-opus-4-8');
    expect(disk.roles.default['deep-thought']!.model).toBe('tencent/hy3:free');
  });
});

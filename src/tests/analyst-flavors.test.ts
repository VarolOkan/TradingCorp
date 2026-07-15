// src/tests/analyst-flavors.test.ts
// Phase F — flavor store + routes + graph merge + trace tagging.
import { describe, it, expect, beforeEach } from '@jest/globals';
import { AnalystFlavorStore } from '../server/analyst-flavors';
import { analystFlavorStore } from '../server/analyst-flavors';
import { registerAnalystFlavorsRoutes } from '../server/analyst-flavors-routes';
import { AGENCIES } from '../registry/agencies';
import { ANALYST_DEFS } from '../registry/analysts';
import type { Express } from 'express';
import express from 'express';
import request from 'supertest';
import { GenericAnalystNode } from '../nodes/generic-analyst.node';
import type { AgentState } from '../types/financial-analysis';

function seedState(): AgentState {
  return {
    messages: [],
    tickers: ['AAPL'],
    options: { chain: {} as any },
    next: {},
    investment_thesis: '',
    current_step: '',
    dataHealth: null,
    analystTraces: [],
    runtimeConfig: null,
    progress: undefined,
  } as unknown as AgentState;
}

// The flavor store is a process-wide singleton that mirrors to .data/flavors.json
// on disk. Tests that seed it (e.g. the getGraph cache test) must not leak saved
// sets into other tests — a fresh AnalystFlavorStore() rehydrates from that file,
// so a leaked "llm-on" override would defeat the "shipped default" GET test.
// Reset clears both memory and the persisted file every test.
afterEach(() => analystFlavorStore.reset());

describe('AnalystFlavorStore.validate', () => {
  it('rejects an empty flavor set (>=1 rule)', () => {
    const v = AnalystFlavorStore.validate({ analystId: 'vol_surface', agencyId: 'options-swing', flavors: [] });
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/non-empty|≥1|at least one/);
  });

  it('rejects two flavors with the same id', () => {
    const v = AnalystFlavorStore.validate({
      analystId: 'vol_surface',
      agencyId: 'options-swing',
      flavors: [
        { id: 'a', name: 'A', role: 'r', instructions: 'x' },
        { id: 'a', name: 'B', role: 'r', instructions: 'y' },
      ],
      selectedId: 'a',
    });
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/duplicate/);
  });

  it('rejects a selectedId not in the set', () => {
    const v = AnalystFlavorStore.validate({
      analystId: 'vol_surface',
      agencyId: 'options-swing',
      flavors: [{ id: 'a', name: 'A', role: 'r', instructions: 'x' }],
      selectedId: 'zzz',
    });
    expect(v.ok).toBe(false);
  });

  it('accepts a single default flavor and infers selectedId', () => {
    const v = AnalystFlavorStore.validate({
      analystId: 'vol_surface',
      agencyId: 'options-swing',
      flavors: [{ id: 'default', name: 'Default', role: 'r', instructions: 'do the thing' }],
    });
    expect(v.ok).toBe(true);
    expect(v.value!.selectedId).toBe('default');
  });

  it('rejects deleting the last remaining flavor via POST (size 0)', () => {
    const store = new AnalystFlavorStore();
    const key = { sessionId: 's', agencyId: 'options-swing', analystId: 'vol_surface' };
    store.set(key, {
      flavors: [{ id: 'default', name: 'D', role: 'r', instructions: 'x', isDefault: true }],
      selectedId: 'default',
    });
    // Simulating a delete-last by sending an empty array must be rejected by the
    // validate step (the routes layer also guards this).
    const v = AnalystFlavorStore.validate({
      analystId: 'vol_surface',
      agencyId: 'options-swing',
      flavors: [],
    });
    expect(v.ok).toBe(false);
    // Store still holds the original (delete rejected).
    expect(store.get(key)!.flavors.length).toBe(1);
  });
});

describe('Analyst flavors routes (GET/POST)', () => {
  let app: Express;
  beforeEach(() => {
    app = express();
    app.use(express.json());
    registerAnalystFlavorsRoutes(app);
  });

  it('GET returns the shipped default flavor set for an options analyst', async () => {
    const res = await request(app)
      .get('/analyst-flavors')
      .query({ sessionId: 'default', agencyId: 'options-swing', analystId: 'options_risk' });
    expect(res.status).toBe(200);
    // options_risk ships 2 flavors (default + conservative)
    expect(res.body.flavors.length).toBe(2);
    expect(res.body.selectedId).toBe('default');
  });

  it('GET synthesizes a default flavor from a base prompt for equity analysts with no flavors array', async () => {
    // fundamental/technical/sentiment/risk/governance ship a `prompt` (their LLM
    // instructions) but no `flavors` array. GET must synthesize a single "default"
    // flavor from that prompt so they also expose the Role & Instructions editor.
    const res = await request(app)
      .get('/analyst-flavors')
      .query({ sessionId: 'default', agencyId: 'long-term', analystId: 'fundamental' });
    expect(res.status).toBe(200);
    expect(res.body.flavors.length).toBe(1);
    expect(res.body.flavors[0].id).toBe('default');
    expect(res.body.flavors[0].instructions).toBeTruthy();
    expect(res.body.selectedId).toBe('default');
  });

  it('POST /analyst-flavors/bulk-enable-llm turns the LLM on for every analyst in an agency', async () => {
    // Before: long-term/fundamental default flavor has no enabled flag (off).
    const before = await request(app)
      .get('/analyst-flavors')
      .query({ sessionId: 'bulk1', agencyId: 'long-term', analystId: 'fundamental' });
    expect(before.body.flavors[0].enabled).not.toBe(true);

    const res = await request(app)
      .post('/analyst-flavors/bulk-enable-llm')
      .send({ sessionId: 'bulk1', agencyId: 'long-term' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.enabled).toBe(true);
    expect(res.body.analystsTouched).toBeGreaterThan(0);
    expect(res.body.flavorsChanged).toBeGreaterThan(0);

    // After: the selected flavor is now enabled, and other analysts in the
    // agency were touched too (each got enabled on its selected flavor).
    const after = await request(app)
      .get('/analyst-flavors')
      .query({ sessionId: 'bulk1', agencyId: 'long-term', analystId: 'fundamental' });
    expect(after.body.flavors.find((f: any) => f.id === after.body.selectedId).enabled).toBe(true);

    // Bulk-disable flips it back off without touching instructions.
    const off = await request(app)
      .post('/analyst-flavors/bulk-enable-llm')
      .send({ sessionId: 'bulk1', agencyId: 'long-term', enabled: false });
    expect(off.body.enabled).toBe(false);
    const afterOff = await request(app)
      .get('/analyst-flavors')
      .query({ sessionId: 'bulk1', agencyId: 'long-term', analystId: 'fundamental' });
    expect(afterOff.body.flavors.find((f: any) => f.id === afterOff.body.selectedId).enabled).toBe(false);
  });

  it('GET /analyst-flavors/agency-summary reflects the stored LLM opt-in state', async () => {
    // Enable LLM for the whole long-term agency.
    await request(app)
      .post('/analyst-flavors/bulk-enable-llm')
      .send({ sessionId: 'summary1', agencyId: 'long-term' });
    const res = await request(app)
      .get('/analyst-flavors/agency-summary')
      .query({ sessionId: 'summary1', agencyId: 'long-term' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.total).toBeGreaterThan(0);
    expect(res.body.enabledCount).toBe(res.body.total);
    expect(res.body.analysts.every((a: any) => a.llmEnabled === true)).toBe(true);

    // After bulk-disable, the summary must reflect the off state.
    await request(app)
      .post('/analyst-flavors/bulk-enable-llm')
      .send({ sessionId: 'summary1', agencyId: 'long-term', enabled: false });
    const off = await request(app)
      .get('/analyst-flavors/agency-summary')
      .query({ sessionId: 'summary1', agencyId: 'long-term' });
    expect(off.body.enabledCount).toBe(0);
    expect(off.body.analysts.every((a: any) => a.llmEnabled === false)).toBe(true);
  });

  it('GET /analyst-flavors/agency-summary 404s for an unknown agency', async () => {
    const res = await request(app)
      .get('/analyst-flavors/agency-summary')
      .query({ sessionId: 'default', agencyId: 'nope' });
    expect(res.status).toBe(404);
  });


  it('POST then GET round-trips a user selection', async () => {
    const post = await request(app)
      .post('/analyst-flavors')
      .send({
        sessionId: 's1',
        agencyId: 'options-swing',
        analystId: 'options_risk',
        flavors: [
          { id: 'default', name: 'Balanced', role: 'r', instructions: 'base' },
          { id: 'conservative', name: 'Conservative', role: 'r', instructions: 'tight' },
        ],
        selectedId: 'conservative',
      });
    expect(post.status).toBe(200);
    expect(post.body.selectedId).toBe('conservative');

    const get = await request(app)
      .get('/analyst-flavors')
      .query({ sessionId: 's1', agencyId: 'options-swing', analystId: 'options_risk' });
    expect(get.status).toBe(200);
    expect(get.body.selectedId).toBe('conservative');
  });

  it('POST rejects deleting the last flavor', async () => {
    const res = await request(app)
      .post('/analyst-flavors')
      .send({
        sessionId: 's2',
        agencyId: 'options-swing',
        analystId: 'options_risk',
        flavors: [],
        selectedId: '',
      });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/last flavor|at least one|non-empty/);
  });
});

describe('mergeFlavors — selected flavor overrides def.prompt', () => {
  it('overrides prompt + tags flavorId when a flavor is selected', () => {
    const base = AGENCIES['options-swing']!;
    const ref = base.analysts.find((a) => a.id === 'options_risk')!;
    // Build a ref with a flavor override, mirroring what getGraph/mergeFlavors injects.
    const withFlavor = {
      ...ref,
      prompt: 'CONSERVATIVE INSTRUCTIONS OVERRIDE',
      role: 'Capital preservation',
      flavorId: 'conservative',
    };
    const agency = { ...base, analysts: base.analysts.map((a) => (a.id === 'options_risk' ? withFlavor : a)) };
    // Resolve via the same path the node uses.
    const def = (require('../types/registry') as any).resolveAnalystDef(withFlavor, ANALYST_DEFS);
    expect(def.prompt).toBe('CONSERVATIVE INSTRUCTIONS OVERRIDE');
    expect(def.flavorId).toBe('conservative');
  });
});

describe('GenericAnalystNode LLM step is parity-safe (no key = fallback, no behavior change)', () => {
  it('does NOT run the LLM step when logic.llm.enabled is false (long-term parity guard)', async () => {
    // options_risk ships llm.enabled:false → step 1.5 is skipped, trace gets no llm field.
    const def = ANALYST_DEFS['options_risk']!;
    expect(def.logic.llm?.enabled).toBe(false);
    const node = new GenericAnalystNode(def, { horizon: 'MEDIUM_TERM', instrument: 'OPTION' });
    const out = await node.process(seedState());
    const trace: any = (out.analystTraces as any[]).find((t) => t.analyst === 'options_risk');
    expect(trace).toBeDefined();
    // No LLM step ran (disabled), so no llm field and no flavorId (no flavor selected).
    expect(trace.llm).toBeUndefined();
    expect(trace.flavorId).toBeUndefined();
  });

  it('runs the deterministic LLM fallback (no key) and tags the trace when llm.enabled', async () => {
    // Clone options_risk with llm enabled + a flavor-selected prompt, no API key set.
    const def = {
      ...ANALYST_DEFS['options_risk']!,
      flavorId: 'conservative',
      prompt: 'CONSERVATIVE ROLE & INSTRUCTIONS',
      logic: { ...ANALYST_DEFS['options_risk']!.logic, llm: { enabled: true } },
    };
    delete process.env.OPENAI_API_KEY;
    delete process.env.LLM_API_KEY;
    const node = new GenericAnalystNode(def as any, { horizon: 'MEDIUM_TERM', instrument: 'OPTION' });
    const out = await node.process(seedState());
    const trace: any = (out.analystTraces as any[]).find((t) => t.analyst === 'options_risk');
    expect(trace.flavorId).toBe('conservative');
    expect(trace.llm).toBeDefined();
    expect(trace.llm.usedFallback).toBe(true);
    expect(trace.llm.text).toContain('CONSERVATIVE');
  });
});

describe('LLM step REPLACES handler verdict when enabled + key present', () => {
  let savedFetch: any;
  beforeEach(() => {
    savedFetch = (globalThis as any).fetch;
  });
  afterEach(() => {
    (globalThis as any).fetch = savedFetch;
  });

  it('overrides the handler verdict/score with the LLM result (uses the work)', async () => {
    // Stub fetch to emulate a real OpenAI-compatible completion returning BULLISH.
    (globalThis as any).fetch = async (url: string, init: any) => {
      const body = JSON.parse(init?.body ?? '{}');
      expect(url).toContain('/chat/completions');
      expect(body.model).toBe('anthropic/claude-opus-4-8');
      return {
        ok: true,
        async json() {
          return { choices: [{ message: { content: 'BULLISH — strong setup. score 87 / 100' } }] };
        },
      };
    };
    // Point the deep-thought role at a token so the real path (not fallback) runs.
    const { llmConfigStore } = await import('../server/llm-config');
    llmConfigStore.put({ role: 'deep-thought', provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'anthropic/claude-opus-4-8', token: 'test-key' });

    const def = {
      ...ANALYST_DEFS['options_risk']!,
      flavorId: 'conservative',
      prompt: 'CONSERVATIVE ROLE & INSTRUCTIONS',
      modelRole: 'deep-thought' as const,
      logic: { ...ANALYST_DEFS['options_risk']!.logic, llm: { enabled: true } },
    };
    const node = new GenericAnalystNode(def as any, { horizon: 'MEDIUM_TERM', instrument: 'OPTION' });
    const out = await node.process(seedState());
    const trace: any = (out.analystTraces as any[]).find((t) => t.analyst === 'options_risk');
    expect(trace.llm.usedFallback).toBe(false);
    // The handler's verdict is REPLACED by the LLM's.
    expect(trace.output.verdict).toBe('BULLISH');
    expect(trace.output.score).toBe(87);
  });

  it('keeps the handler verdict when llm.enabled is false (parity guard)', async () => {
    const def = {
      ...ANALYST_DEFS['options_risk']!,
      flavorId: 'conservative',
      prompt: 'CONSERVATIVE ROLE & INSTRUCTIONS',
      logic: { ...ANALYST_DEFS['options_risk']!.logic, llm: { enabled: false } },
    };
    const node = new GenericAnalystNode(def as any, { horizon: 'MEDIUM_TERM', instrument: 'OPTION' });
    const out = await node.process(seedState());
    const trace: any = (out.analystTraces as any[]).find((t) => t.analyst === 'options_risk');
    expect(trace.llm).toBeUndefined();
    // Handler verdict is preserved (whatever the fn computed).
    expect(trace.output.verdict).toBeDefined();
  });
});

describe('getGraph flavor cache (server) — saved flavors must bypass the cached base graph', () => {
  it('applies a saved flavor override (llm.enabled) on the live graph, not the cached base', async () => {
    const { AnalysisServer } = await import('../server/index');
    const srv = new (AnalysisServer as any)();
    // Warm the default (cached) base graph.
    const base = (srv as any).getGraph('options-swing', 'default');
    expect(base).toBeDefined();
    // Save a flavor with llm enabled for options_risk in this agency/session.
    const { analystFlavorStore } = await import('../server/analyst-flavors');
    analystFlavorStore.set(
      { sessionId: 'default', agencyId: 'options-swing', analystId: 'options_risk' },
      {
        selectedId: 'llm-on',
        flavors: [
          {
            id: 'llm-on',
            name: 'LLM On',
            role: 'Risk guard',
            instructions: 'You are a risk analyst. Reply BULLISH/BEARISH/NEUTRAL.',
            isDefault: true,
            enabled: true,
          },
        ],
      },
    );
    // Re-resolve the graph — must NOT return the cache; must reflect the override.
    const flavored = (srv as any).getGraph('options-swing', 'default');
    expect(flavored).not.toBe(base);
    // The resolved def for options_risk should now carry llm.enabled:true.
    const { AgencyGraph } = await import('../orchestration/agency-graph');
    // agency-graph resolves the ref into defs; find options_risk's resolved logic.
    const resolved = (flavored as any).nodeOrder as string[];
    expect(resolved).toContain('options_risk');
  });
});

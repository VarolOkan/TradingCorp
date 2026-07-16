// src/tests/registry.test.ts
// Phase 1: per-user agency re-org + agency CRUD, BOTH storage drivers.
//   - RegistryJsonStore     (REGISTRY_STORE_DRIVER=json)  -> runs in sandbox
//   - RegistrySqliteStore   (REGISTRY_STORE_DRIVER=sqlite) -> needs working
//     better-sqlite3; the suite detects load failure and skips gracefully.
// Mirrors analyst-config.test.ts: exercises the real routes via supertest
// without booting the full server.

import request from 'supertest';
import express from 'express';
import os from 'os';
import path from 'path';
import fs from 'fs';
import {
  RegistryJsonStore,
  RegistrySqliteStore,
  createRegistryStore,
  applyOverridesToRegistry,
  applyAllOverridesToRegistry,
  type RegistryStore,
} from '../server/registry-store';
import { registerRegistryRoutes } from '../server/registry-routes';
import { AGENCIES, defaultAgency } from '../registry/agencies';
import { ANALYST_DEFS } from '../registry/analysts';

// Snapshot the compiled registry ONCE (before any test mutates the live
// AGENCIES / ANALYST_DEFS objects) so we can restore after each test and keep
// them hermetic across driver iterations.
const SNAPSHOT_AGENCIES = JSON.parse(JSON.stringify(AGENCIES));
const SNAPSHOT_ANALYSTS = JSON.parse(JSON.stringify(ANALYST_DEFS));
function restoreRegistry(): void {
  for (const k of Object.keys(AGENCIES)) delete (AGENCIES as any)[k];
  Object.assign(AGENCIES, JSON.parse(JSON.stringify(SNAPSHOT_AGENCIES)));
  for (const k of Object.keys(ANALYST_DEFS)) delete (ANALYST_DEFS as any)[k];
  Object.assign(ANALYST_DEFS, JSON.parse(JSON.stringify(SNAPSHOT_ANALYSTS)));
}

// Build a fresh store + app per driver for each test. JSON uses a temp dir so
// it's hermetic; sqlite uses the in-memory DB.
function buildFor(driver: 'json' | 'sqlite'): { store: RegistryStore; app: express.Express } {
  let store: RegistryStore;
  if (driver === 'json') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-json-'));
    store = new RegistryJsonStore(dir);
  } else {
    store = new RegistrySqliteStore(':memory:');
  }
  const app = express();
  app.use(express.json());
  registerRegistryRoutes(app, store);
  return { store, app };
}

const drivers: Array<'json' | 'sqlite'> = ['json', 'sqlite'];

// sqlite may be unloadable (ABI native-binding defect). Probe by actually
// opening an in-memory DB, not just require() — require() can succeed while
// `new Database()` throws "Module did not self-register".
let sqliteUsable = false;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const D = require('better-sqlite3');
  const probe = new D(':memory:');
  probe.close();
  sqliteUsable = true;
} catch {
  sqliteUsable = false;
}
if (!sqliteUsable) {
  // eslint-disable-next-line no-console
  console.warn('[registry.test] better-sqlite3 native binding unavailable — skipping sqlite driver suite (JSON path still fully tested).');
}

describe.each(drivers.filter((d) => d === 'json' || sqliteUsable))('registry routes (driver=%s)', (driver) => {
  let app: express.Express;
  let store: RegistryStore;

  beforeEach(() => {
    ({ store, app } = buildFor(driver));
  });
  afterEach(() => {
    try { store.clearUser('user-1'); } catch { /* ignore */ }
    store.close();
    restoreRegistry();
  });

  it('GET /registry lists the compiled catalog + agencies', async () => {
    const res = await request(app).get('/registry');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.catalog)).toBe(true);
    expect(res.body.catalog.map((a: any) => a.id)).toContain('orchestrator');
    expect(Array.isArray(res.body.agencies)).toBe(true);
    const longTerm = res.body.agencies.find((a: any) => a.id === 'long-term');
    expect(longTerm.isDefault).toBe(true);
    // The summary must carry the ordered analyst ids (not just analystCount),
    // or the frontend mirror cannot re-populate a created agency's members on
    // reopen — the "saved analysts disappear after reopen" bug.
    expect(Array.isArray(longTerm.analysts)).toBe(true);
    expect(longTerm.analysts.length).toBe(longTerm.analystCount);
    expect(res.body.driver).toBe(driver);
  });

  it('GET /registry hides agencies flagged hidden (crypto-screener) by default', async () => {
    const res = await request(app).get('/registry');
    expect(res.status).toBe(200);
    const ids = res.body.agencies.map((a: any) => a.id);
    expect(ids).toContain('long-term');
    expect(ids).not.toContain('crypto-screener');
  });

  it('GET /registry reveals hidden agencies when ENABLE_CRYPTO_AGENCY=true', async () => {
    const prev = process.env.ENABLE_CRYPTO_AGENCY;
    process.env.ENABLE_CRYPTO_AGENCY = 'true';
    try {
      // Build a fresh app so the env flag is read at route-registration time
      // of the request (the filter reads it per-request, so a fresh build is
      // not strictly required, but keeps the intent explicit).
      const { app: envApp } = buildFor(driver);
      const res = await request(envApp).get('/registry');
      expect(res.status).toBe(200);
      const ids = res.body.agencies.map((a: any) => a.id);
      expect(ids).toContain('crypto-screener');
      const crypto = res.body.agencies.find((a: any) => a.id === 'crypto-screener');
      expect(crypto.hidden).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.ENABLE_CRYPTO_AGENCY;
      else process.env.ENABLE_CRYPTO_AGENCY = prev;
    }
  });

  it('PUT /registry/agency/:id reorders + adds an existing analyst', async () => {
    const analysts = [
      { id: 'orchestrator' }, { id: 'data_ingestion' },
      { id: 'fundamental' }, { id: 'technical' },
    ];
    const res = await request(app).put('/registry/agency/long-term?userId=user-1').send({ analysts });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const stored = store.getAgencyMembership('user-1', 'long-term');
    expect(stored?.map((r) => r.id)).toEqual(['orchestrator', 'data_ingestion', 'fundamental', 'technical']);

    applyOverridesToRegistry(store, 'user-1');
    expect(AGENCIES['long-term']!.analysts.map((r) => r.id)).toEqual([
      'orchestrator', 'data_ingestion', 'fundamental', 'technical',
    ]);
  });

  it('PUT /registry/agency/:id persists Phase 22 screener settings (assetClass/interval/lookback) and GET reflects them', async () => {
    const analysts = AGENCIES['long-term']!.analysts.map((r) => ({ id: r.id }));
    const res = await request(app)
      .put('/registry/agency/long-term?userId=user-1')
      .send({
        analysts,
        assetClass: 'OPTION',
        screenerInterval: '5m',
        screenerLookbackDays: 12,
      });
    expect(res.status).toBe(200);

    // Stored def carries the new fields.
    const stored = store.getAgencyDef('user-1', 'long-term');
    expect(stored?.assetClass).toBe('OPTION');
    expect(stored?.screenerInterval).toBe('5m');
    expect(stored?.screenerLookbackDays).toBe(12);

    // GET summary exposes them (so the dialog + mirror can round-trip).
    const get = await request(app).get('/registry?userId=user-1');
    const summ = get.body.agencies.find((a: any) => a.id === 'long-term');
    expect(summ.assetClass).toBe('OPTION');
    expect(summ.screenerInterval).toBe('5m');
    expect(summ.screenerLookbackDays).toBe(12);
  });

  it('POST /registry/agency persists Phase 22 fields and survives a restart', async () => {
    const def = {
      id: 'swing-crypto', name: 'Swing Crypto', description: 'test',
      horizon: 'MEDIUM_TERM', assetClass: 'CRYPTO', screenerInterval: '1d', screenerLookbackDays: 60,
      analysts: [{ id: 'orchestrator' }, { id: 'data_ingestion' }, { id: 'fundamental' }],
    };
    const res = await request(app).post('/registry/agency?userId=session-abc').send(def);
    expect(res.status).toBe(201);
    const stored = store.getAgencyDef('session-abc', 'swing-crypto');
    expect(stored?.assetClass).toBe('CRYPTO');
    expect(stored?.screenerInterval).toBe('1d');
    expect(stored?.screenerLookbackDays).toBe(60);

    // Restart + boot-merge: fields survive.
    restoreRegistry();
    applyAllOverridesToRegistry(store);
    expect(AGENCIES['swing-crypto']?.assetClass).toBe('CRYPTO');
    expect(AGENCIES['swing-crypto']?.screenerInterval).toBe('1d');
    expect(AGENCIES['swing-crypto']?.screenerLookbackDays).toBe(60);
  });


  it('PUT rejects an unknown analyst id', async () => {
    const res = await request(app)
      .put('/registry/agency/long-term?userId=user-1')
      .send({ analysts: [{ id: 'nonexistent_analyst' }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unknown analyst/i);
  });

  it('PUT wires feedInto into consumer dependsOn', async () => {
    const base = AGENCIES['long-term']!.analysts.map((r) => ({ id: r.id }));
    const res = await request(app).put('/registry/agency/long-term?userId=user-1').send({
      analysts: base, feedInto: { fundamental: ['risk', 'governance'] },
    });
    expect(res.status).toBe(200);

    applyOverridesToRegistry(store, 'user-1');
    const riskRef = AGENCIES['long-term']!.analysts.find((r) => r.id === 'risk')!;
    const govRef = AGENCIES['long-term']!.analysts.find((r) => r.id === 'governance')!;
    // Resolved dependsOn = ref's own field merged over the base analyst def.
    const riskDeps = riskRef.dependsOn ?? ANALYST_DEFS['risk']!.dependsOn ?? [];
    const govDeps = govRef.dependsOn ?? ANALYST_DEFS['governance']!.dependsOn ?? [];
    expect(riskDeps).toContain('fundamental');
    expect(govDeps).toContain('fundamental');
  });

  it('POST creates a new agency under a non-default userId and it survives a restart', async () => {
    const def = {
      id: 'my-custom-agency', name: 'My Custom Agency', description: 'test',
      horizon: 'LONG_TERM',
      analysts: [{ id: 'orchestrator' }, { id: 'data_ingestion' }, { id: 'fundamental' }],
    };
    // Create under a NON-default userId (the frontend sends sessionId here).
    const res = await request(app).post('/registry/agency?userId=session-abc').send(def);
    expect(res.status).toBe(201);
    expect(store.getAgencyDef('session-abc', 'my-custom-agency')?.id).toBe('my-custom-agency');

    // Simulate a server restart: live registry is reset to the compiled base,
    // then a fresh boot-merge runs (mirrors registerRegistryRoutes' startup).
    restoreRegistry();
    applyAllOverridesToRegistry(store);
    expect(AGENCIES['my-custom-agency']).toBeDefined();
    expect(AGENCIES['my-custom-agency']!.analysts.length).toBe(3);

    // Regression guard: the OLD boot path (merge only the default user) would
    // have left the agency invisible after restart.
    restoreRegistry();
    applyOverridesToRegistry(store, 'default');
    expect(AGENCIES['my-custom-agency']).toBeUndefined();
  });

  it('PUT adds analysts to an existing agency and it survives a restart', async () => {
    // Add two extra analysts to the built-in long-term agency under a
    // non-default userId (the frontend sends sessionId here).
    const analysts = [
      { id: 'orchestrator' }, { id: 'data_ingestion' },
      { id: 'fundamental' }, { id: 'technical' }, { id: 'sentiment' },
    ];
    const res = await request(app)
      .put('/registry/agency/long-term?userId=session-xyz')
      .send({ analysts });
    expect(res.status).toBe(200);

    // Both buckets must carry the new membership (the merge uses
    // agency_membership as the effective override over agency_def).
    expect(store.getAgencyMembership('session-xyz', 'long-term')?.map((r) => r.id))
      .toEqual(['orchestrator', 'data_ingestion', 'fundamental', 'technical', 'sentiment']);
    expect(store.getAgencyDef('session-xyz', 'long-term')?.analysts.map((r) => r.id))
      .toEqual(['orchestrator', 'data_ingestion', 'fundamental', 'technical', 'sentiment']);

    // Simulate a server restart: live registry reset to compiled base, then a
    // fresh boot-merge re-loads every user's overrides.
    restoreRegistry();
    applyAllOverridesToRegistry(store);
    expect(AGENCIES['long-term']!.analysts.map((r) => r.id))
      .toEqual(['orchestrator', 'data_ingestion', 'fundamental', 'technical', 'sentiment']);
  });

  it('POST refuses a duplicate agency id', async () => {
    const def = { id: 'long-term', name: 'dup', horizon: 'LONG_TERM', analysts: [{ id: 'orchestrator' }] };
    const res = await request(app).post('/registry/agency?userId=user-1').send(def);
    expect(res.status).toBe(409);
  });

  it('DELETE refuses the default agency but allows others', async () => {
    const def = {
      id: 'deletable', name: 'Deletable', horizon: 'LONG_TERM',
      analysts: [{ id: 'orchestrator' }, { id: 'data_ingestion' }],
    };
    await request(app).post('/registry/agency?userId=user-1').send(def);

    const delDefault = await request(app).delete(`/registry/agency/${defaultAgency().id}?userId=user-1`);
    expect(delDefault.status).toBe(400);
    expect(delDefault.body.error).toMatch(/default/i);

    const delOk = await request(app).delete('/registry/agency/deletable?userId=user-1');
    expect(delOk.status).toBe(200);
    expect(store.getAgencyDef('user-1', 'deletable')).toBeNull();

    // Regression: after a re-apply the deleted key must be GONE from the
    // live AGENCIES (the merge resets to compiled base, then re-applies
    // store overrides — it does not let a stale POST key linger).
    applyOverridesToRegistry(store, 'user-1');
    expect(AGENCIES['deletable']).toBeUndefined();
    expect(Object.keys(AGENCIES)).not.toContain('deletable');
  });

  it('isolation: user-2 does not see user-1 overrides', async () => {
    await request(app).put('/registry/agency/long-term?userId=user-1')
      .send({ analysts: [{ id: 'orchestrator' }, { id: 'data_ingestion' }] });
    const u2 = new (driver === 'json' ? RegistryJsonStore : RegistrySqliteStore)(
      driver === 'json' ? fs.mkdtempSync(path.join(os.tmpdir(), 'reg-json2-')) : ':memory:',
    );
    expect(u2.getAgencyMembership('user-2', 'long-term')).toBeNull();
    // Restore the compiled registry, then the default agency must be whole again
    // (boot-merge only applied user-1's 2-analyst override; it did not leak).
    restoreRegistry();
    expect(AGENCIES['long-term']!.analysts.length)
      .toBe(SNAPSHOT_AGENCIES['long-term'].analysts.length);
    u2.close();
  });

  // ---- Analyst CRUD (Phase: dedicated Analysts tab) ----
  const sampleAnalyst = () => ({
    id: 'contrarian',
    name: 'Contrarian',
    kind: 'analyst' as const,
    role: 'Fades crowded positions',
    stage: 2 as const,
    accent: '#a855f7',
    dependsOn: ['data_ingestion'],
    dataSources: [{ id: 'yahoo', from: 'yahoo', fields: ['price', 'volume'], label: 'Yahoo', sources: ['Yahoo'] }],
    logic: { mode: 'declarative' as const, weighting: [], score: { from: 'weightedSum', range: [0, 100] } },
    output: { channels: ['contrarian_view'], verdictField: 'verdict', scoreField: 'score' },
  });

  it('POST /registry/analyst creates a custom analyst and it shows in GET', async () => {
    const res = await request(app).post('/registry/analyst?userId=user-1').send(sampleAnalyst());
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(store.getCustomAnalyst('user-1', 'contrarian')?.id).toBe('contrarian');

    applyOverridesToRegistry(store, 'user-1');
    expect(ANALYST_DEFS['contrarian']).toBeDefined();

    const getRes = await request(app).get('/registry');
    expect(getRes.body.catalog.map((a: any) => a.id)).toContain('contrarian');
  });

  it('POST refuses to recreate a built-in analyst', async () => {
    const builtin = sampleAnalyst();
    builtin.id = 'orchestrator';
    const res = await request(app).post('/registry/analyst?userId=user-1').send(builtin);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/built-in/i);
  });

  it('POST refuses an invalid analyst (missing required fields)', async () => {
    const res = await request(app).post('/registry/analyst?userId=user-1')
      .send({ id: 'bad', name: 'Bad' }); // no kind/stage/logic
    expect(res.status).toBe(400);
  });

  it('PUT /registry/analyst/:id edits a custom analyst', async () => {
    await request(app).post('/registry/analyst?userId=user-1').send(sampleAnalyst());
    const edited = sampleAnalyst();
    edited.name = 'Contrarian (edited)';
    edited.output = { channels: ['contrarian_view_v2'], verdictField: 'verdict' };
    const res = await request(app).put('/registry/analyst/contrarian?userId=user-1').send(edited);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(store.getCustomAnalyst('user-1', 'contrarian')?.name).toBe('Contrarian (edited)');
    applyOverridesToRegistry(store, 'user-1');
    expect(ANALYST_DEFS['contrarian']!.output?.channels).toEqual(['contrarian_view_v2']);
  });

  it('PUT refuses to edit a built-in analyst', async () => {
    const builtin = sampleAnalyst();
    builtin.id = 'orchestrator';
    const res = await request(app).put('/registry/analyst/orchestrator?userId=user-1').send(builtin);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/built-in/i);
  });

  it('DELETE /registry/analyst removes a custom analyst', async () => {
    await request(app).post('/registry/analyst?userId=user-1').send(sampleAnalyst());
    const del = await request(app).delete('/registry/analyst/contrarian?userId=user-1');
    expect(del.status).toBe(200);
    expect(store.getCustomAnalyst('user-1', 'contrarian')).toBeNull();
    applyOverridesToRegistry(store, 'user-1');
    expect(ANALYST_DEFS['contrarian']).toBeUndefined();
  });

  it('DELETE refuses a built-in analyst', async () => {
    const res = await request(app).delete('/registry/analyst/orchestrator?userId=user-1');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/built-in/i);
  });
});

// ---------------------------------------------------------------------------
// Factory fallback: when the resolved driver is `sqlite` but the better-sqlite3
// native binding can't load (ABI mismatch -> ERR_DLOPEN_FAILED), createRegistryStore
// must DEGRADE to the JSON store instead of crashing the server at boot.
// ---------------------------------------------------------------------------
describe('createRegistryStore graceful fallback', () => {
  it('returns a JSON store when SQLite is unusable', () => {
    if (sqliteUsable) {
      // On machines where SQLite DOES load, the factory returns sqlite — that
      // path is covered by the driver=sqlite suite above. Skip here so the
      // assertion only runs in the exact broken-binding environment it guards.
      // eslint-disable-next-line no-console
      console.warn('[registry.test] better-sqlite3 usable — skipping JSON-fallback assertion (covered by sqlite suite).');
      expect(true).toBe(true);
      return;
    }
    // Force the default (sqlite) driver and confirm it falls back to JSON.
    const prev = process.env.REGISTRY_STORE_DRIVER;
    delete process.env.REGISTRY_STORE_DRIVER;
    try {
      const store = createRegistryStore();
      expect(store.driver).toBe('json');
    } finally {
      if (prev === undefined) delete process.env.REGISTRY_STORE_DRIVER;
      else process.env.REGISTRY_STORE_DRIVER = prev;
    }
  });

  it('the JSON fallback still persists a created agency', () => {
    if (sqliteUsable) {
      // Covered by the sqlite-path suite; this asserts the JSON fallback works
      // end-to-end where it actually matters (broken native binding).
      expect(true).toBe(true);
      return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-fallback-'));
    const store = new RegistryJsonStore(dir);
    store.setAgencyDef('u', { id: 'my-wheel', name: 'My Wheel', description: 'fallback test agency', horizon: 'LONG_TERM', analysts: [{ id: 'fundamental' }] });
    expect(store.getAgencyDef('u', 'my-wheel')?.name).toBe('My Wheel');
    expect(fs.existsSync(path.join(dir, 'registry-u.json'))).toBe(true);
  });
});

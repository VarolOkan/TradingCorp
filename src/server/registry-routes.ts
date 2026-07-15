// src/server/registry-routes.ts
// REST surface for per-user agency re-org + agency CRUD.
// Backend is env-selected (REGISTRY_STORE_DRIVER=json|sqlite) via createRegistryStore().
//
//   GET    /registry                 -> { catalog: AnalystDef[], agencies: AgencySummary[] }
//   PUT    /registry/agency/:id      -> body { analysts: AgencyAnalystRef[], feedInto?: Record<string,string[]> }
//   POST   /registry/agency          -> body AgencyDef  (create a new agency)
//   DELETE /registry/agency/:id      -> 200 ok | 400 if it is the default agency
//   POST   /registry/analyst         -> body AnalystDef (create a custom analyst)
//   PUT    /registry/analyst/:id     -> body AnalystDef (edit a custom analyst)
//   DELETE /registry/analyst/:id     -> 200 ok | 400 if it is a built-in analyst
//
// userId is taken from ?userId (resolves to 'default' via resolveVaultUserId()
// when absent). Real multi-user isolation requires an auth layer to populate
// userId; the keying is multi-user-ready today.

import type { Express } from 'express';
import type { AgencyAnalystRef, AgencyDef, AnalystDef, AnalysisHorizon } from '../types/registry';
import { AGENCIES, defaultAgency } from '../registry/agencies';
import { ANALYST_DEFS } from '../registry/analysts';
import { resolveVaultUserId } from './llm-vault';
import {
  createRegistryStore,
  applyOverridesToRegistry,
  applyAllOverridesToRegistry,
  type RegistryStore,
} from './registry-store';
// Pristine compiled analyst snapshot (before any override) — used to guard
// against editing/deleting built-in analysts. Defined in registry-store.ts.
import { COMPILED_ANALYST_DEFS } from './registry-store';

export interface AgencySummary {
  id: string;
  name: string;
  horizon: string;
  instrument?: 'EQUITY' | 'OPTION';
  /** Ordered analyst ids that make up this agency. */
  analysts?: string[];
  analystCount: number;
  isDefault: boolean;
}

function resolveUserId(req: Express.Request): string {
  const q = (req.query as Record<string, unknown>).userId;
  if (typeof q === 'string' && q.length > 0) return q;
  const b = (req.body as Record<string, unknown> | undefined)?.userId;
  if (typeof b === 'string' && b.length > 0) return b;
  return resolveVaultUserId();
}

function isValidAnalystRef(r: unknown): r is AgencyAnalystRef {
  return typeof r === 'object' && r !== null && typeof (r as AgencyAnalystRef).id === 'string';
}
function isValidAgencyDef(d: unknown): d is AgencyDef {
  if (typeof d !== 'object' || d === null) return false;
  const a = d as AgencyDef;
  return typeof a.id === 'string' && typeof a.name === 'string' &&
    typeof a.horizon === 'string' && Array.isArray(a.analysts);
}
function isValidAnalystDef(d: unknown): d is AnalystDef {
  if (typeof d !== 'object' || d === null) return false;
  const a = d as AnalystDef;
  // Required: id + name + kind + stage + (logic is non-optional). Everything
  // else (role/accent/monogram/dataSources/output/etc.) is optional.
  if (typeof a.id !== 'string' || !a.id.trim()) return false;
  if (typeof a.name !== 'string' || !a.name.trim()) return false;
  if (typeof a.kind !== 'string') return false;
  if (typeof a.stage !== 'number') return false;
  if (typeof a.logic !== 'object' || a.logic === null) return false;
  return true;
}
function summarize(agency: AgencyDef, isDefault: boolean): AgencySummary {
  const out: AgencySummary = {
    id: agency.id, name: agency.name, horizon: agency.horizon,
    analysts: agency.analysts.map((r) => r.id),
    analystCount: agency.analysts.length, isDefault,
  };
  if (agency.instrument) out.instrument = agency.instrument;
  return out;
}

export function registerRegistryRoutes(
  app: Express,
  store: RegistryStore = createRegistryStore(),
): void {
  // Boot-merge: reflect ALL persisted overrides (every user, not just the
  // default) over the compiled registry, so data saved under a non-default
  // userId (e.g. the frontend sessionId) survives a restart.
  try {
    applyAllOverridesToRegistry(store);
  } catch (err) {
    // A driver that can't open at boot (e.g. better-sqlite3 compiled for a
    // different Node ABI → ERR_DLOPEN_FAILED) must not take down the whole
    // server. Start with the compiled registry and warn loudly so it's clear
    // that persistence is OFFLINE until the driver is fixed.
    // eslint-disable-next-line no-console
    console.error(
      '[registry] boot-merge FAILED — starting with COMPILED defaults (persistence OFFLINE):',
      err instanceof Error ? err.message : String(err),
    );
  }

  // Catalog = every analyst that can be placed in a flow (compiled + custom).
  // `custom: true` marks analysts the user created (and may edit/delete); built-in
  // analysts are NOT custom and must be guarded from edit/delete in the UI.
  app.get('/registry', (req, res) => {
    const userId = resolveUserId(req);
    try {
      const catalog: Array<AnalystDef & { custom: boolean }> = Object.values(ANALYST_DEFS).map(
        (a) => ({ ...a, custom: !COMPILED_ANALYST_DEFS[a.id] }),
      );
      const agencies: AgencySummary[] = Object.values(AGENCIES).map((a) =>
        summarize(a, a.default === true),
      );
      res.json({ catalog, agencies, driver: store.driver });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Update an agency's analyst flow (add / remove / reorder) + feeds-into,
  // and optionally its display name / horizon.
  app.put('/registry/agency/:id', (req, res) => {
    const userId = resolveUserId(req);
    const agencyId = req.params.id;
    const body = req.body as {
      analysts?: AgencyAnalystRef[];
      name?: string;
      horizon?: string;
      feedInto?: Record<string, string[]>;
    };

    if (!Array.isArray(body.analysts) || !body.analysts.every(isValidAnalystRef)) {
      res.status(400).json({ error: 'analysts must be an array of { id, ... }' });
      return;
    }
    for (const ref of body.analysts) {
      if (!ANALYST_DEFS[ref.id]) {
        res.status(400).json({ error: `unknown analyst id: ${ref.id}` });
        return;
      }
    }
    if (body.feedInto) {
      for (const consumers of Object.values(body.feedInto)) {
        for (const c of consumers) {
          if (!ANALYST_DEFS[c]) {
            res.status(400).json({ error: `unknown feed-into consumer: ${c}` });
            return;
          }
        }
      }
    }

    // Persist optional name/horizon by writing a full agency def override that
    // merges onto the existing base (compiled or previously overridden).
    const base =
      store.getAgencyDef(userId, agencyId) ??
      (AGENCIES[agencyId]
        ? { id: agencyId, name: AGENCIES[agencyId].name, description: AGENCIES[agencyId].description, horizon: AGENCIES[agencyId].horizon, analysts: AGENCIES[agencyId].analysts }
        : null);
    if (!base) {
      res.status(404).json({ error: `agency '${agencyId}' not found` });
      return;
    }
    const updated: AgencyDef = {
      ...base,
      id: agencyId,
      name: body.name?.trim() || base.name,
      description: base.description ?? '',
      horizon: (body.horizon as AnalysisHorizon) || base.horizon,
      analysts: body.analysts,
    };
    store.setAgencyDef(userId, updated);
    // Keep the membership bucket in sync with the saved flow. The boot-merge
    // (applyAllOverridesToRegistry) treats agency_membership as the effective
    // override over agency_def, so a stale membership would otherwise clobber
    // newly-added analysts after a restart ("added analysts not persistent").
    store.setAgencyMembership(userId, agencyId, body.analysts);
    if (body.feedInto) {
      for (const [analystId, consumers] of Object.entries(body.feedInto)) {
        store.setFeedInto(userId, analystId, consumers);
      }
    }
    // Live-merge so the next graph read uses the new flow immediately.
    applyAllOverridesToRegistry(store);
    res.json({ ok: true, id: agencyId, analysts: body.analysts, driver: store.driver });
  });

  // Create a new agency.
  app.post('/registry/agency', (req, res) => {
    const userId = resolveUserId(req);
    const def = req.body as AgencyDef;
    if (!isValidAgencyDef(def)) {
      res.status(400).json({ error: 'agency must have id, name, horizon, and analysts[]' });
      return;
    }
    if (AGENCIES[def.id]) {
      res.status(409).json({ error: `agency '${def.id}' already exists` });
      return;
    }
    for (const ref of def.analysts) {
      if (!ANALYST_DEFS[ref.id]) {
        res.status(400).json({ error: `unknown analyst id: ${ref.id}` });
        return;
      }
    }
    store.setAgencyDef(userId, def);
    store.setAgencyMembership(userId, def.id, def.analysts);
    applyAllOverridesToRegistry(store);
    res.status(201).json({ ok: true, id: def.id, agency: summarize(def, false), driver: store.driver });
  });

  // Delete a (non-default) agency.
  app.delete('/registry/agency/:id', (req, res) => {
    const userId = resolveUserId(req);
    const agencyId = req.params.id;
    const existing = AGENCIES[agencyId];
    if (!existing) {
      res.status(404).json({ error: `agency '${agencyId}' not found` });
      return;
    }
    if (existing.default === true || agencyId === defaultAgency().id) {
      res.status(400).json({ error: 'cannot delete the default agency' });
      return;
    }
    store.deleteAgencyDef(userId, agencyId);
    store.setAgencyMembership(userId, agencyId, []);
    applyAllOverridesToRegistry(store);
    res.json({ ok: true, id: agencyId, driver: store.driver });
  });

  // Create a new custom analyst.
  app.post('/registry/analyst', (req, res) => {
    const userId = resolveUserId(req);
    const def = req.body as AnalystDef;
    if (!isValidAnalystDef(def)) {
      res.status(400).json({ error: 'analyst must have id, name, kind, stage, and logic' });
      return;
    }
    if (COMPILED_ANALYST_DEFS[def.id]) {
      res.status(409).json({ error: `analyst '${def.id}' is built-in and cannot be recreated` });
      return;
    }
    if (ANALYST_DEFS[def.id]) {
      res.status(409).json({ error: `analyst '${def.id}' already exists` });
      return;
    }
    store.setCustomAnalyst(userId, def);
    applyAllOverridesToRegistry(store);
    res.status(201).json({ ok: true, id: def.id, analyst: def, driver: store.driver });
  });

  // Edit a custom analyst.
  app.put('/registry/analyst/:id', (req, res) => {
    const userId = resolveUserId(req);
    const analystId = req.params.id;
    const def = req.body as AnalystDef;
    if (!isValidAnalystDef(def)) {
      res.status(400).json({ error: 'analyst must have id, name, kind, stage, and logic' });
      return;
    }
    if (def.id !== analystId) {
      res.status(400).json({ error: 'analyst id in body must match the :id param' });
      return;
    }
    if (COMPILED_ANALYST_DEFS[analystId]) {
      res.status(400).json({ error: `analyst '${analystId}' is built-in and cannot be edited` });
      return;
    }
    if (!ANALYST_DEFS[analystId]) {
      res.status(404).json({ error: `analyst '${analystId}' not found` });
      return;
    }
    store.setCustomAnalyst(userId, def);
    applyAllOverridesToRegistry(store);
    res.json({ ok: true, id: analystId, analyst: def, driver: store.driver });
  });

  // Delete a custom analyst.
  app.delete('/registry/analyst/:id', (req, res) => {
    const userId = resolveUserId(req);
    const analystId = req.params.id;
    if (COMPILED_ANALYST_DEFS[analystId]) {
      res.status(400).json({ error: `analyst '${analystId}' is built-in and cannot be deleted` });
      return;
    }
    if (!ANALYST_DEFS[analystId]) {
      res.status(404).json({ error: `analyst '${analystId}' not found` });
      return;
    }
    store.deleteCustomAnalyst(userId, analystId);
    applyAllOverridesToRegistry(store);
    res.json({ ok: true, id: analystId, driver: store.driver });
  });
}

// src/server/analyst-flavors-routes.ts
// REST surface for per-analyst FLAVORS (docs/OPTIONS_AND_AGENCY_EXPANSION.md §10.5).
//
// GET  /analyst-flavors?sessionId=&agencyId=&analystId=
//      → { flavors: AnalystFlavor[], selectedId } (resolved shipped set overlaid
//        with any user override).
// POST /analyst-flavors
//      body { sessionId, agencyId, analystId, flavors, selectedId }
//      → full replace of the user's flavor set + selection (validated: ≥1
//        flavor, no dup ids, selectedId ∈ set, every flavor has instructions).
//
// Split out of index.ts so it is unit-testable without booting socket.io.
// Saved flavors are never echoed in a way that leaks secrets.

import { Express } from 'express';
import { AnalystFlavorStore } from './analyst-flavors';
import { AGENCIES } from '../registry/agencies';
import { ANALYST_DEFS } from '../registry/analysts';
import { logger } from '../utils/logger';

function sessionOf(req: { query: any; body?: any }): string {
  return (
    (req.query && (req.query.sessionId as string)) ||
    (req.body && (req.body as any).sessionId) ||
    'default'
  );
}

/** Resolve an analyst's shipped default flavor set (from ANALYST_DEFS). */
function shippedFlavors(analystId: string): { flavors: any[]; selectedId: string } | null {
  const def = ANALYST_DEFS[analystId];
  if (!def) return null;
  // Explicit flavor set declared on the def (e.g. the options analysts).
  if (Array.isArray(def.flavors) && def.flavors.length > 0) {
    const flavors = def.flavors.map((f) => ({ ...f }));
    const selected = flavors.find((f) => f.isDefault)?.id ?? flavors[0]!.id;
    return { flavors, selectedId: selected };
  }
  // No explicit flavors, but the analyst has a base instruction `prompt` (the
  // equity analysts: fundamental/technical/sentiment/risk/governance). Synthesize
  // a single "default" flavor from it so those LLM-backed analysts also expose
  // the Role & Instructions editor (they otherwise ship no flavor array and the
  // gear never appears). Instructions may be a string or a string[].
  if (def.prompt) {
    const instructions = Array.isArray(def.prompt) ? def.prompt.join('\n') : String(def.prompt);
    if (instructions.trim().length > 0) {
      const flavor = {
        id: 'default',
        name: def.name ?? analystId,
        role: def.role ?? '',
        instructions,
        isDefault: true,
      };
      return { flavors: [flavor], selectedId: 'default' };
    }
  }
  return null;
}

/** Register the per-analyst flavors routes. */
export function registerAnalystFlavorsRoutes(
  app: Express,
  store: AnalystFlavorStore = new AnalystFlavorStore(),
): void {
  // GET /analyst-flavors — resolved flavor set for one analyst.
  app.get('/analyst-flavors', (req, res) => {
    const sessionId = sessionOf(req);
    const agencyId = (req.query.agencyId as string) || 'long-term';
    const analystId = (req.query.analystId as string) || '';
    const agency = AGENCIES[agencyId];
    if (!agency) {
      res.status(404).json({ error: `Unknown agency: ${agencyId}` });
      return;
    }
    if (!agency.analysts.some((a) => a.id === analystId)) {
      res.status(404).json({ error: `Analyst ${analystId} not in agency ${agencyId}` });
      return;
    }

    const saved = store.get({ sessionId, agencyId, analystId });
    const shipped = shippedFlavors(analystId);
    const payload = saved ?? shipped;
    if (!payload) {
      res.status(404).json({ error: `No flavors defined for analyst ${analystId}` });
      return;
    }
    res.status(200).json({
      sessionId,
      agencyId,
      analystId,
      flavors: payload.flavors,
      selectedId: payload.selectedId,
    });
  });

  // POST /analyst-flavors — full replace of the user's flavor set + selection.
  app.post('/analyst-flavors', (req, res) => {
    const sessionId = sessionOf(req);
    const validation = AnalystFlavorStore.validate(req.body);
    if (!validation.ok || !validation.value) {
      res.status(400).json({ error: 'Invalid analyst flavors', details: validation.errors });
      return;
    }
    const { analystId, agencyId } = req.body as { analystId: string; agencyId: string };
    const agency = AGENCIES[agencyId];
    if (!agency || !agency.analysts.some((a) => a.id === analystId)) {
      res.status(404).json({ error: `Analyst ${analystId} not in agency ${agencyId}` });
      return;
    }

    // The "≥1 flavor" rule is also enforced at the API boundary: deleting the
    // last remaining flavor is rejected (the store's validate already rejects
    // an empty array; this guards against a client sending size-0).
    if (validation.value.flavors.length < 1) {
      res.status(400).json({ error: 'cannot delete the last flavor', details: ['at least one flavor required'] });
      return;
    }

    store.set({ sessionId, agencyId, analystId }, validation.value);

    logger.info(
      `Stored flavors for session=${sessionId} agency=${agencyId} analyst=${analystId} ` +
        `(${validation.value.flavors.length} flavors, selected ${validation.value.selectedId})`,
    );

    res.status(200).json({
      ok: true,
      sessionId,
      agencyId,
      analystId,
      flavors: validation.value.flavors,
      selectedId: validation.value.selectedId,
    });
  });

  // GET /analyst-flavors/agency-summary?sessionId=&agencyId=
  //   Returns, for every analyst in the agency, whether its SELECTED flavor has
  //   the LLM opt-in enabled. Used by the Agency settings dialog to REFLECT the
  //   currently-stored "Enable LLM for all analysts" state (so the user can see
  //   it is persisted) rather than only offering blind enable/disable buttons.
  app.get('/analyst-flavors/agency-summary', (req, res) => {
    const sessionId = sessionOf(req);
    const agencyId = (req.query && (req.query.agencyId as string)) || '';
    const agency = AGENCIES[agencyId];
    if (!agency) {
      res.status(404).json({ error: `Unknown agency: ${agencyId}` });
      return;
    }
    const analysts = agency.analysts.map((ref) => {
      const saved = store.get({ sessionId, agencyId, analystId: ref.id });
      const base = saved ?? shippedFlavors(ref.id);
      const selectedId = saved?.selectedId ?? base?.selectedId ?? '';
      const sel = base?.flavors.find((f) => f.id === selectedId) ?? base?.flavors[0];
      return {
        analystId: ref.id,
        llmEnabled: sel ? sel.enabled === true : false,
      };
    });
    const enabledCount = analysts.filter((a) => a.llmEnabled).length;
    res.status(200).json({
      ok: true,
      sessionId,
      agencyId,
      analysts,
      enabledCount,
      total: analysts.length,
    });
  });

  // POST /analyst-flavors/bulk-enable-llm
  //   body { sessionId, agencyId, enabled?: boolean }
  //   For EVERY analyst in the agency, ensure a flavor set exists (seeding from
  //   the shipped defaults when the user has not customized yet) and flip
  //   `enabled` on the SELECTED flavor only. This turns the LLM step on for all
  //   analysts without clobbering the user's existing instructions/selection —
  //   it merely toggles the opt-in flag (§10.7) on the flavor that will run.
  //   `enabled` defaults to true; pass false to bulk-DISABLE.
  app.post('/analyst-flavors/bulk-enable-llm', (req, res) => {
    const sessionId = sessionOf(req);
    const agencyId = (req.body && (req.body as any).agencyId) || '';
    const enabled = (req.body && (req.body as any).enabled) !== false; // default true
    const agency = AGENCIES[agencyId];
    if (!agency) {
      res.status(404).json({ error: `Unknown agency: ${agencyId}` });
      return;
    }
    let changed = 0;
    const touched: string[] = [];
    for (const ref of agency.analysts) {
      const analystId = ref.id;
      const saved = store.get({ sessionId, agencyId, analystId });
      const base = saved ?? shippedFlavors(analystId);
      if (!base) continue; // analyst ships no flavor (shouldn't happen) — skip
      const flavors = base.flavors.map((f) => ({ ...f }));
      const selectedId = saved?.selectedId ?? base.selectedId;
      // Flip enabled on the selected flavor (preserve everything else).
      const sel = flavors.find((f) => f.id === selectedId) ?? flavors[0];
      if (sel && sel.enabled !== enabled) {
        sel.enabled = enabled;
        changed += 1;
      }
      store.set({ sessionId, agencyId, analystId }, { flavors, selectedId });
      touched.push(analystId);
    }
    logger.info(
      `Bulk ${enabled ? 'enabled' : 'disabled'} LLM for agency=${agencyId} session=${sessionId} ` +
        `(${changed} flavors changed across ${touched.length} analysts)`,
    );
    res.status(200).json({
      ok: true,
      agencyId,
      sessionId,
      enabled,
      analystsTouched: touched.length,
      flavorsChanged: changed,
    });
  });
}

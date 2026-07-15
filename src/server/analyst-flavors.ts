// src/server/analyst-flavors.ts
// Per-analyst FLAVOR store (docs/OPTIONS_AND_AGENCY_EXPANSION.md §10 — the
// "multi-flavor Role & Instructions" capability).
//
// A flavor is a named Role & Instructions bundle for an analyst. The shipped
// defaults live on `AnalystDef.flavors` (code); this store holds the USER's
// current flavor set + selection for a given (session, agency, analyst), keyed
// by `${sessionId}:${agencyId}:${analystId}`. The selection is merged into the
// resolved `AnalystDef.prompt` inside `getGraph()` (sibling to mergeSavedParams),
// so it flows into both the trace AND the LLM call.
//
// PERSISTENCE (added to fix the "settings lost on restart" bug): the store is
// mirrored to a JSON file under `.data/flavors.json` (path overridable via
// FLAVOR_STORE_PATH). The in-memory Map remains the source of truth at runtime;
// every mutation is flushed to disk (best-effort). This makes the
// "Enable LLM for all analysts" bulk toggle AND per-analyst flavor edits
// survive a server restart. We deliberately use plain fs + JSON (NOT
// better-sqlite3) so this store never depends on the native binding that has
// been flaky in this environment.

import fs from 'fs';
import path from 'path';
import type { AnalystFlavor } from '../types/registry';

/** Composite key for a saved flavor set. */
export interface FlavorKey {
  sessionId: string;
  agencyId: string;
  analystId: string;
}

function composeKey(k: FlavorKey): string {
  return `${k.sessionId}:${k.agencyId}:${k.analystId}`;
}

export interface FlavorSet {
  flavors: AnalystFlavor[];
  selectedId: string;
}

export interface FlavorValidation {
  ok: boolean;
  errors: string[];
  value?: FlavorSet;
}

export class AnalystFlavorStore {
  private store = new Map<string, FlavorSet>();
  private readonly dataPath: string;

  constructor(dataPath?: string) {
    this.dataPath = dataPath || process.env.FLAVOR_STORE_PATH ||
      path.join(process.cwd(), '.data', 'flavors.json');
    this.load();
  }

  /** Best-effort load of the persisted flavor sets from disk. */
  private load(): void {
    try {
      if (!fs.existsSync(this.dataPath)) return;
      const raw = fs.readFileSync(this.dataPath, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, FlavorSet>;
      for (const [k, v] of Object.entries(parsed)) {
        if (v && Array.isArray(v.flavors) && typeof v.selectedId === 'string') {
          this.store.set(k, {
            flavors: v.flavors.map((f) => ({ ...f })),
            selectedId: v.selectedId,
          });
        }
      }
    } catch {
      // Corrupt/unreadable store is non-fatal: fall back to in-memory only.
    }
  }

  /** Best-effort flush of the entire store to disk. */
  private persist(): void {
    try {
      const dir = path.dirname(this.dataPath);
      if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const out: Record<string, FlavorSet> = {};
      for (const [k, v] of this.store.entries()) out[k] = v;
      fs.writeFileSync(this.dataPath, JSON.stringify(out, null, 2), 'utf8');
    } catch {
      // Persistence is best-effort; never break the request path on disk errors.
    }
  }

  /**
   * Validate + normalize an incoming full-replace payload
   * `{ sessionId, agencyId, analystId, flavors: AnalystFlavor[], selectedId }`.
   * Enforces: ≥1 flavor, no duplicate ids, exactly one `isDefault` (or implicit
   * default = first), `selectedId` present in the set, every flavor has
   * non-empty `instructions`.
   */
  static validate(input: unknown): FlavorValidation {
    const errors: string[] = [];
    if (typeof input !== 'object' || input === null) {
      return { ok: false, errors: ['Request body must be a JSON object'] };
    }
    const body = input as Record<string, unknown>;

    if (typeof body.analystId !== 'string' || !body.analystId) {
      errors.push('analystId is required');
    }
    if (typeof body.agencyId !== 'string' || !body.agencyId) {
      errors.push('agencyId is required');
    }

    const flavorsRaw = body.flavors;
    if (!Array.isArray(flavorsRaw) || flavorsRaw.length === 0) {
      errors.push('flavors must be a non-empty array (≥1 flavor required)');
      return { ok: false, errors };
    }

    const flavors: AnalystFlavor[] = [];
    const seen = new Set<string>();
    let defaultCount = 0;
    for (const f of flavorsRaw as Record<string, unknown>[]) {
      const id = typeof f.id === 'string' ? f.id : '';
      const name = typeof f.name === 'string' ? f.name : '';
      const role = typeof f.role === 'string' ? f.role : '';
      const instructions = typeof f.instructions === 'string' ? f.instructions : '';
      if (!id) errors.push('each flavor must have an id');
      if (seen.has(id)) errors.push(`duplicate flavor id: ${id}`);
      seen.add(id);
      if (!instructions.trim()) errors.push(`flavor ${id || '(unnamed)'} has empty instructions`);
      const isDefault = f.isDefault === true;
      const enabled = f.enabled === true;
      const modelRole = (f.modelRole === 'deep-thought' || f.modelRole === 'scanner' || f.modelRole === 'flexible')
        ? f.modelRole
        : undefined;
      if (isDefault) defaultCount += 1;
      flavors.push({ id, name, role, instructions, isDefault, enabled, modelRole });
    }

    if (defaultCount > 1) errors.push('at most one flavor may be isDefault');

    // Implicit default = first flavor when none marked.
    if (defaultCount === 0 && flavors.length > 0) flavors[0]!.isDefault = true;

    const selectedId = typeof body.selectedId === 'string' ? body.selectedId : flavors[0]!.id;
    if (!flavors.some((f) => f.id === selectedId)) {
      errors.push(`selectedId ${selectedId} is not in the flavor set`);
    }

    if (errors.length > 0) return { ok: false, errors };
    return { ok: true, errors: [], value: { flavors, selectedId } };
  }

  /** Store a flavor set + selection for a (session, agency, analyst) triple. */
  set(key: FlavorKey, set: FlavorSet): void {
    this.store.set(composeKey(key), {
      flavors: set.flavors.map((f) => ({ ...f })),
      selectedId: set.selectedId,
    });
    this.persist();
  }

  /** Read a saved flavor set (or undefined if none). */
  get(key: FlavorKey): FlavorSet | undefined {
    const v = this.store.get(composeKey(key));
    return v ? { flavors: v.flavors.map((f) => ({ ...f })), selectedId: v.selectedId } : undefined;
  }

  /** True if a saved flavor set exists. */
  has(key: FlavorKey): boolean {
    return this.store.has(composeKey(key));
  }

  /** Remove one flavor set. */
  clear(key: FlavorKey): void {
    this.store.delete(composeKey(key));
    this.persist();
  }

  /** Reset all stored flavor sets (primarily for tests). */
  reset(): void {
    this.store.clear();
    this.persist();
  }
}

/** A single shared store instance for the running server. */
export const analystFlavorStore = new AnalystFlavorStore();

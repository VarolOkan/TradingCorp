// src/server/analyst-params.ts
// Per-analyst tunable WEIGHTS store (the "adjustable params" half of the
// per-card Settings panel, docs/CARD_SETTINGS_PANEL.md).
//
// The token+URI half already lives in AnalystConfigStore (POST /analyst-config,
// with the URI carried in `extra`). This store holds the SAVED `params` map
// (e.g. { signalSensitivity, maxLookbackDays, maxStopLoss, baseAllocation })
// keyed by `${session}:${agencyId}:${analystId}`. At request time the server
// merges these overrides into the agency def before building the graph, so the
// next run reflects the user's weights.
//
// In-memory only (never on disk, never echoed to the client). Pattern mirrors
// AnalystConfigStore.

/** A saved weight override for one analyst within one agency/session. */
export type AnalystParams = Record<string, number>;

/** Composite key for a saved param set. */
export interface ParamsKey {
  sessionId: string;
  agencyId: string;
  analystId: string;
}

function composeKey(k: ParamsKey): string {
  return `${k.sessionId}:${k.agencyId}:${k.analystId}`;
}

/**
 * Allowed weight keys per analyst. Must stay in sync with the schema's
 * TUNABLE_WEIGHTS (src/registry/analyst-config-schema.ts) and the keys the
 * handlers actually read. Rejecting unknown keys keeps a bad save from
 * smuggling arbitrary fields into def.params.
 */
export const ALLOWED_PARAM_KEYS: Record<string, string[]> = {
  technical: ['signalSensitivity', 'maxLookbackDays'],
  risk: ['maxStopLoss', 'baseAllocation'],
};

export interface AnalystParamsValidation {
  ok: boolean;
  errors: string[];
  value?: AnalystParams;
}

export class AnalystParamsStore {
  private store = new Map<string, AnalystParams>();

  /** Validate + normalize an incoming params payload. */
  static validate(input: unknown): AnalystParamsValidation {
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
    const params = body.params;
    if (typeof params !== 'object' || params === null || Array.isArray(params)) {
      errors.push('params must be an object map of string keys to number values');
    }

    const normalized: AnalystParams = {};
    if (params && typeof params === 'object' && !Array.isArray(params)) {
      const allowed = ALLOWED_PARAM_KEYS[body.analystId as string] ?? [];
      const paramsObj = params as Record<string, unknown>;
      for (const [key, v] of Object.entries(paramsObj)) {
        if (!allowed.includes(key)) {
          errors.push(`params.${key} is not an adjustable weight for this analyst`);
          continue;
        }
        if (typeof v !== 'number' || !Number.isFinite(v)) {
          errors.push(`params.${key} must be a finite number`);
          continue;
        }
        normalized[key] = v;
      }
    }

    if (errors.length > 0) return { ok: false, errors };
    return { ok: true, errors: [], value: normalized };
  }

  /** Store a param set for a (session, agency, analyst) triple. */
  set(key: ParamsKey, params: AnalystParams): void {
    this.store.set(composeKey(key), { ...params });
  }

  /** Read a saved param set (or undefined if none). */
  get(key: ParamsKey): AnalystParams | undefined {
    const v = this.store.get(composeKey(key));
    return v ? { ...v } : undefined;
  }

  /** True if a saved param set exists. */
  has(key: ParamsKey): boolean {
    return this.store.has(composeKey(key));
  }

  /** Remove one param set. */
  clear(key: ParamsKey): void {
    this.store.delete(composeKey(key));
  }

  /** Reset all stored param sets (primarily for tests). */
  reset(): void {
    this.store.clear();
  }
}

/** A single shared store instance for the running server. */
export const analystParamsStore = new AnalystParamsStore();

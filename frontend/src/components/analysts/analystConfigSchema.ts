// frontend/src/components/analysts/analystConfigSchema.ts
// Frontend mirror of the backend per-card Settings schema (docs/EXTENDING_ANALYSTS.md).
//
// Declares which analysts expose tunable WEIGHTS and which expose credentialed
// SOURCES (driven by the GET /analyst-config catalog). The Settings dialog
// renders ONLY these fields, so a card with nothing adjustable shows no gear.
//
// Weight keys + defaults MUST stay in sync with the backend
// src/server/analyst-params.ts ALLOWED_PARAM_KEYS and the handler-consumed
// params (technical: signalSensitivity/maxLookbackDays, risk: maxStopLoss/baseAllocation).

export interface WeightField {
  key: string;
  label: string;
  type: 'number';
  min: number;
  max: number;
  step: number;
  default: number;
  hint?: string;
}

export interface SourceCredField {
  sourceId: string;
  label: string;
  auth: 'bearer' | 'apikey' | 'finnhub' | 'token';
  uriRequired: boolean;
  uriLabel: string;
  uriDefault: string;
  /** True if a token/URI has already been stored for this source. */
  hasToken: boolean;
  /**
   * The analyst the token is actually STORED + RESOLVED under. Usually the
   * same as the tab's `analystId`, but the General dialog reuses this one
   * component for sources that belong to a DIFFERENT analyst (e.g. Polygon
   * options sources live under `options_ingestion`, even though they are
   * shown in the global Data Ingestion → Sources tab). When set, the POST
   * + health-probe use THIS id so the saved key lands where the engine
   * resolves it — not under the tab's display analyst.
   */
  analystId?: string;
  /**
   * Optional KEY-SHARING group. Sources that share the SAME upstream API key
   * (e.g. Polygon/Massive's options snapshot AND daily aggregates both use one
   * Massive key) declare the same `keyGroup`. The Sources editor then renders a
   * SINGLE token field for the group and lists each member's endpoint beneath
   * it. On save the one token is written to EVERY member (under each member's
   * own sourceId + analystId), so the engine resolves it for all of them.
   */
  keyGroup?: string;
  /** Heading shown for a collapsed key group (e.g. 'Massive/Polygon Options'). */
  keyGroupLabel?: string;
  /** Short human label for THIS source's endpoint within a group row
   *  (e.g. 'Options snapshot', 'Daily aggregates'). Falls back to `label`. */
  endpointLabel?: string;
}

export interface AnalystConfigSchema {
  analystId: string;
  name: string;
  weights: WeightField[];
  sources: SourceCredField[];
  /** Phase F: selectable flavor (Role & Instructions) bundles for this analyst. */
  flavors: AnalystFlavorField[];
  hasConfig: boolean;
}

export interface AnalystFlavorField {
  id: string;
  name: string;
  role: string;
}

/**
 * Canonical per-source Base URIs (mirrors the backend
 * src/registry/analyst-config-schema.ts DEFAULT_SOURCE_URIS). The Settings
 * UI pre-fills this as the default Base URI for a credentialed source so the
 * user only confirms it. Keyed by source id.
 */
const DEFAULT_SOURCE_URIS: Record<string, string> = {
  alphaVantage: 'https://www.alphavantage.co/query',
  finnhub: 'https://finnhub.io/api/v1',
  polygonOptions: 'https://api.massive.com/v3/snapshot/options/{ticker}',
  polygonHist: 'https://api.massive.com/v2/aggs/ticker/{ticker}/range/1/day/{from}/{to}',
  treasuryRfr: 'https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v2/accounting/od/avg_interest_rates',
};

/** Static tunable weights per analyst (mirrors backend ALLOWED_PARAM_KEYS). */
const TUNABLE_WEIGHTS: Record<string, Omit<WeightField, 'kind' | 'default'>[]> = {
  technical: [
    {
      key: 'signalSensitivity',
      label: 'Signal sensitivity',
      type: 'number',
      min: -10,
      max: 20,
      step: 0.5,
      hint: 'Added to the technical score. Intraday already runs hotter; raise to amplify momentum.',
    },
    {
      key: 'maxLookbackDays',
      label: 'Max lookback (days)',
      type: 'number',
      min: 1,
      max: 250,
      step: 1,
      hint: '≤ 5 sets the volatility call to "High volatility" (fast/intraday feel).',
    },
  ],
  risk: [
    {
      key: 'maxStopLoss',
      label: 'Max stop-loss',
      type: 'number',
      min: 0.01,
      max: 0.5,
      step: 0.01,
      hint: 'Clamp on the suggested stop-loss. Smaller = tighter risk for short horizons.',
    },
    {
      key: 'baseAllocation',
      label: 'Base allocation (%)',
      type: 'number',
      min: 1,
      max: 20,
      step: 1,
      hint: 'Recommended max position size. Smaller = more conservative.',
    },
  ],
};

const WEIGHT_DEFAULTS: Record<string, Record<string, number>> = {
  technical: { signalSensitivity: 0, maxLookbackDays: 20 },
  risk: { maxStopLoss: 0.15, baseAllocation: 5 },
};

/**
 * Build the per-card config schema for one analyst.
 * @param analystId   e.g. 'technical'
 * @param name        display name
 * @param catalogSources  credentialed sources for this analyst (from GET /analyst-config)
 */
export function buildAnalystConfigSchema(
  analystId: string,
  name: string,
  catalogSources: Array<{ id: string; label: string; auth: string }> = [],
): AnalystConfigSchema {
  const weights: WeightField[] = (TUNABLE_WEIGHTS[analystId] ?? []).map((w) => ({
    ...w,
    default: WEIGHT_DEFAULTS[analystId]?.[w.key] ?? 0,
  }));

  const sources: SourceCredField[] = catalogSources
    .filter((s) => s.id && s.label)
    .map((s) => ({
      sourceId: s.id,
      label: s.label,
      auth: (s.auth === 'bearer' || s.auth === 'apikey' || s.auth === 'finnhub' ? s.auth : 'token') as SourceCredField['auth'],
      uriRequired: true,
      uriLabel: 'Base URI',
      // Pre-fill each known source's canonical endpoint (mirrors backend
      // DEFAULT_SOURCE_URIS) so the user only confirms.
      uriDefault: DEFAULT_SOURCE_URIS[s.id] ?? '',
      hasToken: s.hasToken === true,
    }));

  return { analystId, name, weights, sources, flavors: [], hasConfig: weights.length + sources.length > 0 };
}

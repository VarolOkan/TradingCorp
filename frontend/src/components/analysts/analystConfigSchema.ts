// frontend/src/components/analysts/analystConfigSchema.ts
// Frontend mirror of the backend per-card Settings schema (docs/CARD_SETTINGS_PANEL.md).
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
  auth: 'bearer' | 'apikey' | 'token';
  uriRequired: boolean;
  uriLabel: string;
  uriDefault: string;
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
      auth: (s.auth === 'bearer' || s.auth === 'apikey' ? s.auth : 'token') as SourceCredField['auth'],
      uriRequired: true,
      uriLabel: 'Base URI',
      uriDefault: '',
    }));

  return { analystId, name, weights, sources, flavors: [], hasConfig: weights.length + sources.length > 0 };
}

// src/registry/analyst-config-schema.ts
// Schema-driven descriptor for the per-card Settings panel (docs/EXTENDING_ANALYSTS.md).
//
// The panel shows ONLY the items an analyst can actually adjust:
//   - tunable WEIGHTS: the per-analyst `params` the handlers actually read
//     (see src/registry/logic/{technical,risk,governance}.ts). These bias the
//     generated output. Declared via a STATIC allow-list so internal-only keys
//     are never exposed.
//   - credentialed SOURCES: live+auth dataSources (declared on the AnalystDef).
//     Each carries a token + a base URI (stored in the existing `extra` map).
//
// `buildAnalystConfigSchema` derives the descriptor from a resolved AnalystDef
// plus the source catalog. If BOTH lists are empty, the panel is empty and the
// card shows no settings affordance ("if no adjustments can be made, the
// settings part remains empty").

import type { AnalystDef } from '../types/registry';

/**
 * Analyst id union. Mirrors frontend/src/components/analysts/analysts.ts
 * `AnalystId` but is declared here to keep the backend module free of a
 * frontend path import (separate tsconfig / vitest scope).
 */
export type AnalystId =
  | 'orchestrator'
  | 'data_ingestion'
  | 'fundamental'
  | 'technical'
  | 'sentiment'
  | 'risk'
  | 'governance'
  | 'onchain';

/** A tunable weight the user can edit on the card. */
export interface WeightField {
  kind: 'weight';
  /** Key into the analyst's `params` map (also the handler-consumed name). */
  key: string;
  label: string;
  type: 'number';
  min: number;
  max: number;
  step: number;
  /** True → the panel must show it (drives "only required items"). */
  required: boolean;
  /** Current/default value, read from the resolved def's params. */
  default: number;
  /** Short help text shown under the field. */
  hint?: string;
}

/** A credentialed source the user can supply a token + URI for. */
export interface SourceCredField {
  kind: 'source';
  /** Source id (e.g. 'alphaVantage'), stable key for the store. */
  sourceId: string;
  label: string;
  auth: 'bearer' | 'apikey' | 'token';
  /** Most live sources need a base URI alongside the token. */
  uriRequired: boolean;
  uriLabel: string;
  uriDefault: string;
}

export interface AnalystConfigSchema {
  analystId: AnalystId;
  weights: WeightField[];
  sources: SourceCredField[];
  /** Convenience: true when there is anything to configure. */
  hasConfig: boolean;
}

/**
 * Static allow-list of tunable weight keys, per analyst id.
 *
 * These are EXACTLY the `params` keys the handlers read (verified by grep):
 *   - technical:   signalSensitivity (adds to score when >0), maxLookbackDays (<=5 => High volatility)
 *   - risk:        maxStopLoss (0..1, clamps stop-loss), baseAllocation (position sizing %)
 *   - governance:  reads risk's maxStopLoss via the upstream assessment, not set directly here
 *
 * Defaults are the no-tuning fallbacks the handlers use, so the panel shows the
 * value that will actually apply when nothing is saved.
 */
const TUNABLE_WEIGHTS: Record<string, Omit<WeightField, 'kind' | 'default'>[]> = {
  technical: [
    {
      key: 'signalSensitivity',
      label: 'Signal sensitivity',
      type: 'number',
      min: -10,
      max: 20,
      step: 0.5,
      required: true,
      hint: 'Added to the technical score. Intraday already runs hotter; raise this to amplify momentum.',
    },
    {
      key: 'maxLookbackDays',
      label: 'Max lookback (days)',
      type: 'number',
      min: 1,
      max: 250,
      step: 1,
      required: true,
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
      required: true,
      hint: 'Clamp on the suggested stop-loss. Smaller = tighter risk for short horizons.',
    },
    {
      key: 'baseAllocation',
      label: 'Base allocation (%)',
      type: 'number',
      min: 1,
      max: 20,
      step: 1,
      required: true,
      hint: 'Recommended max position size. Smaller = more conservative.',
    },
  ],
};

/** Tunable horizon labels for documentation; not user-editable (set by agency). */
export const HORIZON_PARAM_KEYS = new Set(['horizon', 'timeHorizon', 'sourceMix', 'lookbackBars', 'rsiThreshold']);

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * Build the per-card settings schema for one resolved AnalystDef.
 * `catalogSources` is the list of credentialed sources for this analyst from
 * GET /analyst-config (id + label + auth). When omitted, no source fields are
 * shown (the def's declared dataSources may not be auth-required).
 */
export function buildAnalystConfigSchema(
  def: AnalystDef,
  catalogSources: Array<{ id: string; label: string; auth: string }> = [],
): AnalystConfigSchema {
  const weights: WeightField[] = (TUNABLE_WEIGHTS[def.id] ?? []).map((w) => ({
    ...w,
    kind: 'weight',
    default: num(def.params?.[w.key], fallbackFor(def.id, w.key)),
  }));

  const sources: SourceCredField[] = catalogSources
    .filter((s) => s.id && s.label)
    .map((s) => ({
      kind: 'source',
      sourceId: s.id,
      label: s.label,
      auth: (s.auth === 'bearer' || s.auth === 'apikey' ? s.auth : 'token') as SourceCredField['auth'],
      uriRequired: true,
      uriLabel: 'Base URI',
      uriDefault: '',
    }));

  return {
    analystId: def.id as AnalystId,
    weights,
    sources,
    hasConfig: weights.length + sources.length > 0,
  };
}

/** The handler fallback used when no override is present (keeps panel honest). */
function fallbackFor(analystId: string, key: string): number {
  if (analystId === 'technical') {
    if (key === 'signalSensitivity') return 0;
    if (key === 'maxLookbackDays') return 20;
  }
  if (analystId === 'risk') {
    if (key === 'maxStopLoss') return 0.15;
    if (key === 'baseAllocation') return 5;
  }
  return 0;
}

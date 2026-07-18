// src/registry/validate.ts
// Validation utilities for AnalystDef and AgencyDef documents.
// Returns an array of error messages; empty array = valid.

import type { AnalystDef, AgencyDef, ValidationResult } from '../types/registry';
import { ANALYST_DEFS, defaultAnalystIds } from './analysts';
import { AGENCIES } from './agencies';
import { resolveAnalystDef } from '../types/registry';

// ---- AnalystDef validation ----

export function validateAnalystDef(def: AnalystDef | Record<string, unknown>, idHint?: string): ValidationResult {
  const errors: string[] = [];
  const label = idHint ? `analyst "${idHint}"` : `analyst`;

  if (!def || typeof def !== 'object') {
    errors.push(`${label}: must be a non-null object`);
    return errors;
  }

  // id
  if (!def.id || typeof def.id !== 'string') {
    errors.push(`${label}: missing or non-string id`);
  }

  // kind
  const validKinds = ['orchestrator', 'ingestion', 'analyst', 'gatekeeper'];
  if (!def.kind || !validKinds.includes(def.kind as string)) {
    errors.push(`${label}: kind must be one of ${validKinds.join(', ')}, got ${def.kind}`);
  }

  // name
  if (!def.name || typeof def.name !== 'string') {
    errors.push(`${label}: missing or non-string name`);
  }

  // stage
  if (def.stage === undefined || ![1, 2, 3, 4].includes(def.stage as number)) {
    errors.push(`${label}: stage must be 1, 2, 3, or 4, got ${def.stage}`);
  }

  // accent — optional but must be hex-like if present
  if (def.accent !== undefined && typeof def.accent !== 'string') {
    errors.push(`${label}: accent must be a string`);
  }

  // logic
  if (!def.logic || typeof def.logic !== 'object') {
    errors.push(`${label}: logic must be an object`);
  } else {
    const logic = def.logic as Record<string, unknown>;
    if (logic.mode !== 'declarative' && logic.mode !== 'fn') {
      errors.push(`${label}: logic.mode must be 'declarative' or 'fn', got ${logic.mode}`);
    }

    if (logic.mode === 'declarative') {
      // weighting optional for declarative
      if (logic.weighting !== undefined) {
        if (!Array.isArray(logic.weighting)) {
          errors.push(`${label}: logic.weighting must be an array`);
        } else {
          const totalWeight = (logic.weighting as Array<Record<string, unknown>>).reduce(
            (s, w) => s + (typeof w.weight === 'number' ? w.weight : 0), 0
          );
          if (Math.abs(totalWeight - 1.0) > 0.02 && (logic.weighting as any[]).length > 0) {
            errors.push(`${label}: logic.weighting weights sum to ${totalWeight.toFixed(3)}, expected ≈1.0`);
          }
        }
      }
      // verdict mapping should have threshold entries
      if (logic.verdict) {
        const v = logic.verdict as Record<string, unknown>;
        if (v.mapping && !Array.isArray(v.mapping)) {
          errors.push(`${label}: verdict.mapping must be an array`);
        }
      }
    }

    if (logic.mode === 'fn') {
      if (!logic.fn || typeof logic.fn !== 'string') {
        errors.push(`${label}: logic.fn must be a non-empty string when mode='fn'`);
      }
    }
  }

  return errors;
}

// ---- AgencyDef validation ----

export function validateAgencyDef(agency: AgencyDef): ValidationResult {
  const errors: string[] = [];

  if (!agency.id || typeof agency.id !== 'string') {
    errors.push(`agency: missing or non-string id`);
  }

  if (!agency.name || typeof agency.name !== 'string') {
    errors.push(`agency "${agency.id ?? '?'}": missing or non-string name`);
  }

  if (!Array.isArray(agency.analysts) || agency.analysts.length === 0) {
    errors.push(`agency "${agency.id}": analysts must be a non-empty array`);
  } else {
    for (const [i, ref] of agency.analysts.entries()) {
      if (!ref.id || typeof ref.id !== 'string') {
        errors.push(`agency "${agency.id}": analysts[${i}] missing id`);
      } else if (!ANALYST_DEFS[ref.id]) {
        errors.push(`agency "${agency.id}": analysts[${i}] references unknown id "${ref.id}"`);
      }
    }
  }

  return errors;
}

// ---- Bulk validators ----

export function validateAllAnalysts(): ValidationResult {
  const errors: ValidationResult = [];
  for (const [id, def] of Object.entries(ANALYST_DEFS)) {
    errors.push(...validateAnalystDef(def, id));
  }
  return errors;
}

export function validateAllAgencies(): ValidationResult {
  const errors: ValidationResult = [];
  for (const [id, agency] of Object.entries(AGENCIES)) {
    errors.push(...validateAgencyDef(agency));
  }
  return errors;
}

// ---- Check that the default agency resolves to exactly the 7 reference ids ----

export function validateDefaultAgencyIntegrity(): ValidationResult {
  const errors: ValidationResult = [];
  const defaultAgency = AGENCIES['long-term'];
  if (!defaultAgency) {
    errors.push('long-term agency not found');
    return errors;
  }
  if (!defaultAgency.default) {
    errors.push('long-term agency must have default: true');
  }

  const expected = defaultAnalystIds();
  const actual = defaultAgency.analysts.map((r) => r.id);
  for (const id of expected) {
    if (!actual.includes(id)) {
      errors.push(`long-term agency missing expected analyst "${id}"`);
    }
  }
  for (const id of actual) {
    if (!expected.includes(id)) {
      errors.push(`long-term agency has unexpected analyst "${id}"`);
    }
  }

  // Verify no overrides on long-term (pure defaults)
  for (const ref of defaultAgency.analysts) {
    const overrideKeys = Object.keys(ref).filter((k) => k !== 'id');
    if (overrideKeys.length > 0) {
      errors.push(`long-term agency analyst "${ref.id}" has unexpected overrides: ${overrideKeys.join(', ')}`);
    }
  }

  return errors;
}

// ---- Check agency override resolution ----

export function validateIntradayOverrides(): ValidationResult {
  const errors: ValidationResult = [];
  const intraday = AGENCIES['intraday'];
  if (!intraday) return ['intraday agency not found'];

  const technicalRef = intraday.analysts.find((r) => r.id === 'technical');
  if (!technicalRef) {
    errors.push('intraday agency missing "technical" analyst');
    return errors;
  }

  if (!technicalRef.params || (technicalRef.params as Record<string, unknown>).horizon !== 'INTRADAY') {
    errors.push('intraday technical analyst missing params.horizon=INTRADAY');
  }
  if (!technicalRef.params || (technicalRef.params as Record<string, unknown>).lookbackBars !== 5) {
    errors.push('intraday technical analyst missing params.lookbackBars=5');
  }

  const fundamentalRef = intraday.analysts.find((r) => r.id === 'fundamental');
  if (!fundamentalRef) {
    errors.push('intraday agency missing "fundamental" analyst');
    return errors;
  }

  if (!fundamentalRef.params || (fundamentalRef.params as Record<string, unknown>).horizon !== 'INTRADAY') {
    errors.push('intraday fundamental analyst missing params.horizon=INTRADAY');
  }

  return errors;
}

export function validateMediumTermOverrides(): ValidationResult {
  const errors: ValidationResult = [];
  const medium = AGENCIES['medium-term'];
  if (!medium) return ['medium-term agency not found'];

  const fundamentalRef = medium.analysts.find((r) => r.id === 'fundamental');
  if (!fundamentalRef) {
    errors.push('medium-term agency missing "fundamental" analyst');
    return errors;
  }

  if (!fundamentalRef.params || (fundamentalRef.params as Record<string, unknown>).timeHorizon !== 'MEDIUM_TERM') {
    errors.push('medium-term fundamental analyst missing params.timeHorizon=MEDIUM_TERM');
  }

  return errors;
}

// ---- Frontend derivation check ----

export interface FrontendAnalystMeta {
  id: string;
  name: string;
  role: string;
  accent: string;
  monogram: string;
  stage: number;
}

export function deriveAnalystMetaFromDefs(): FrontendAnalystMeta[] {
  const ids = defaultAnalystIds().filter((id) => id !== 'data_ingestion'); // frontend currently excludes DI
  return ids.map((id) => {
    const def = ANALYST_DEFS[id];
    if (!def) throw new Error(`Unrecognised analyst id: ${id}`);
    return {
      id: def.id,
      name: def.name,
      role: def.role,
      accent: def.accent,
      monogram: def.monogram ?? def.id.slice(0, 2).toUpperCase(),
      stage: def.stage,
    };
  });
}
// frontend/src/components/analysts/agencies.ts
// Frontend mirror of the backend AGENCIES registry (src/registry/agencies.ts).
//
// The catalog data (AGENCIES / AGENCY_IDS / DEFAULT_AGENCY) is now GENERATED
// from the backend source of truth by scripts/gen-frontend-registry.ts — no
// manual duplicate edit when an agency is added/renamed. This file keeps the
// runtime HELPER functions (they mutate the generated AGENCIES at runtime when
// hydrated from GET /registry) and re-exports the generated data.
//
// The dropdown reads from here; the wall/analyst set is derived from the
// SELECTED agency (not hardcoded), so agencies with fewer/different analysts
// (e.g. the 4-node crypto-screener) render correctly.
//
// AgencyId is widened to string so user-created agencies (ids not known at
// compile time) are valid.

import {
  AgencyMeta,
  AGENCIES,
  AGENCY_IDS,
  DEFAULT_AGENCY,
  agencyById,
} from './agencies.generated';
import type { AgencyId } from './agencies.generated';

export type { AgencyId, AgencyMeta } from './agencies.generated';
export {
  AGENCIES,
  AGENCY_IDS,
  DEFAULT_AGENCY,
  agencyById,
};

// Agencies whose decisions are made on intraday horizons get a 5m default chart
// interval; the rest (long/medium-term, crypto/options swing) default to 1D.
const INTRADAY_AGENCIES: string[] = ['intraday', 'options-intraday'];

export function isIntradayAgency(id: string): boolean {
  return INTRADAY_AGENCIES.includes(id);
}

/**
 * Phase 22: timeframe + instrument are AGENCY-LEVEL settings, not panel inputs.
 * Resolve the screener's bar interval + lookback from an agency's explicit
 * (editable) defaults, falling back to the implicit horizon rule.
 */
export function resolveScreenerProfile(agencyId: string): { interval: '1m' | '5m' | '1h' | '4h' | '1d'; lookbackDays: number; minVolumeDaily: number } {
  const def = AGENCIES[agencyId];
  if (def?.screenerInterval && def?.screenerLookbackDays) {
    return { interval: def.screenerInterval, lookbackDays: def.screenerLookbackDays, minVolumeDaily: def.minVolumeDaily ?? 100_000 };
  }
  return isIntradayAgency(agencyId)
    ? { interval: '5m', lookbackDays: 5, minVolumeDaily: 100_000 }
    : { interval: '1d', lookbackDays: 90, minVolumeDaily: 100_000 };
}

/** Resolve the asset class from an agency (OPTION if declared, else EQUITY).
 *  CRYPTO is shown as a selectable category but screens equity underlyings
 *  today (the crypto universe source is still TBD). */
export function resolveAssetClass(agencyId: string): 'EQUITY' | 'OPTION' | 'CRYPTO' {
  return AGENCIES[agencyId]?.assetClass ?? AGENCIES[agencyId]?.instrument ?? 'EQUITY';
}

/**
 * Rebuild the frontend mirror from the backend's GET /registry payload so a
 * re-org or agency CRUD shows up in the dropdown/wall immediately.
 */
export function applyRegistryAgencies(
  agencies: Array<{ id: string; name: string; description?: string; analystCount?: number; isDefault?: boolean; horizon?: string; instrument?: 'EQUITY' | 'OPTION'; assetClass?: 'EQUITY' | 'OPTION' | 'CRYPTO'; screenerInterval?: '1m' | '5m' | '1d'; screenerLookbackDays?: number; minVolumeDaily?: number; hidden?: boolean; analysts?: string[] }>,
): void {
  // Preserve full analyst id lists where the backend summary lacks them
  // (the GET /registry `agencies` list carries analystCount, not the ids).
  const known = AGENCIES;
  const next: Record<string, AgencyMeta> = {};
  for (const a of agencies) {
    const prev = known[a.id];
    next[a.id] = {
      id: a.id,
      name: a.name,
      description: a.description ?? prev?.description ?? '',
      // Prefer the backend's authoritative ordered ids; fall back to a prior
      // known list only if the payload omitted them (older servers).
      analysts: a.analysts ?? prev?.analysts ?? [],
      isDefault: a.isDefault,
      horizon: a.horizon,
      instrument: a.instrument,
      assetClass: a.assetClass ?? a.instrument,
      screenerInterval: a.screenerInterval ?? prev?.screenerInterval,
      screenerLookbackDays: a.screenerLookbackDays ?? prev?.screenerLookbackDays,
      minVolumeDaily: a.minVolumeDaily ?? prev?.minVolumeDaily,
      hidden: a.hidden ?? prev?.hidden,
    };
  }
  // Drop any agency that existed locally but is no longer reported (deleted).
  for (const id of Object.keys(AGENCIES)) {
    if (!next[id]) delete AGENCIES[id];
  }
  Object.assign(AGENCIES, next);
  AGENCY_IDS.length = 0;
  AGENCY_IDS.push(...Object.keys(AGENCIES));
}

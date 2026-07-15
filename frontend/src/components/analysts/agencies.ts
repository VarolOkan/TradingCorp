// frontend/src/components/analysts/agencies.ts
// Frontend mirror of the backend AGENCIES registry (src/registry/agencies.ts).
// The dropdown reads from here; the wall/analyst set is derived from the
// SELECTED agency (not hardcoded), so agencies with fewer/different analysts
// (e.g. the 4-node crypto-screener) render correctly.
//
// The mirror is REFRESHABLE: after a re-org or agency CRUD (persisted on the
// backend via /registry), call applyRegistryAgencies() so the dropdown + wall
// reflect the change IMMEDIATELY (no "next run" deferral). AgencyId is widened
// to string so user-created agencies (ids not known at compile time) are valid.

export type AgencyId = string;

export interface AgencyMeta {
  id: string;
  name: string;
  description: string;
  /** Ordered analyst ids that make up this agency (defines the wall order). */
  analysts: string[];
  /** true for the one default agency (cannot be deleted). */
  isDefault?: boolean;
  /** horizon label for display. */
  horizon?: string;
  instrument?: 'EQUITY' | 'OPTION';
}

// Static defaults — overwritten by applyRegistryAgencies() at runtime.
export const AGENCIES: Record<string, AgencyMeta> = {
  'long-term': {
    id: 'long-term',
    name: 'Long-Term Investment',
    description: 'Full 7-node pipeline for long-term equity analysis. Matches the current production pipeline exactly — each analyst uses its default fn handler with long-term horizons.',
    analysts: [
      'orchestrator',
      'data_ingestion',
      'fundamental',
      'technical',
      'sentiment',
      'risk',
      'governance',
    ],
  },
  'medium-term': {
    id: 'medium-term',
    name: 'Medium-Term (1–3 mo)',
    description: 'Same 7 equity analysts, medium-term tuning.',
    analysts: [
      'orchestrator',
      'data_ingestion',
      'fundamental',
      'technical',
      'sentiment',
      'risk',
      'governance',
    ],
  },
  intraday: {
    id: 'intraday',
    name: 'Intraday',
    description: '7 equity analysts tuned for 5m–1h horizons. Technical gets faster lookback, sentiment is high-frequency.',
    analysts: [
      'orchestrator',
      'data_ingestion',
      'fundamental',
      'technical',
      'sentiment',
      'risk',
      'governance',
    ],
  },
  'crypto-screener': {
    id: 'crypto-screener',
    name: 'Crypto Screener',
    description: '4-node crypto triage: ingestion + on-chain flow + sentiment + governance.',
    analysts: ['data_ingestion', 'onchain', 'sentiment', 'governance'],
  },
  'options-swing': {
    id: 'options-swing',
    name: 'Options Swing (days–weeks)',
    description: '8-node options pipeline (MEDIUM_TERM): options ingestion → vol surface → pricing → greeks → flow → risk → governance. Instrument: OPTION.',
    analysts: [
      'orchestrator',
      'options_ingestion',
      'vol_surface',
      'options_pricing',
      'options_greeks',
      'options_flow',
      'options_risk',
      'governance',
    ],
  },
  'options-intraday': {
    id: 'options-intraday',
    name: 'Options Intraday (minutes–hours)',
    description: '9-node options pipeline (INTRADAY): adds options_technical underlying timing. 0DTE / gamma scalping. Instrument: OPTION.',
    analysts: [
      'orchestrator',
      'options_ingestion',
      'options_technical',
      'vol_surface',
      'options_pricing',
      'options_greeks',
      'options_flow',
      'options_risk',
      'governance',
    ],
  },
};

export const AGENCY_IDS: string[] = Object.keys(AGENCIES);

export const DEFAULT_AGENCY: AgencyId = 'long-term';

// Agencies whose decisions are made on intraday horizons get a 5m default chart
// interval; the rest (long/medium-term, crypto/options swing) default to 1D.
const INTRADAY_AGENCIES: string[] = ['intraday', 'options-intraday'];

export function isIntradayAgency(id: string): boolean {
  return INTRADAY_AGENCIES.includes(id);
}

export function agencyById(id: string): AgencyMeta {
  const found = AGENCIES[id];
  if (!found) throw new Error(`Unknown agency: ${id}`);
  return found;
}

/**
 * Rebuild the frontend mirror from the backend's GET /registry payload so a
 * re-org or agency CRUD shows up in the dropdown/wall immediately.
 */
export function applyRegistryAgencies(
  agencies: Array<{ id: string; name: string; description?: string; analystCount?: number; isDefault?: boolean; horizon?: string; instrument?: 'EQUITY' | 'OPTION'; analysts?: string[] }>,
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

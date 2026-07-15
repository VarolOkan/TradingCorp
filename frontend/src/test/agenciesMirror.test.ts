// frontend/src/test/agenciesMirror.test.ts
// Unit tests for the refreshable frontend AGENCIES mirror (Phase 1).
import { describe, it, expect, beforeEach } from 'vitest';
import { AGENCIES, AGENCY_IDS, agencyById, applyRegistryAgencies } from '../components/analysts/agencies';

describe('applyRegistryAgencies', () => {
  // Snapshot the built-in defaults so each test starts from a known state.
  const defaults = Object.values(AGENCIES).map((a) => ({
    id: a.id,
    name: a.name,
    description: a.description,
    analystCount: a.analysts.length,
    isDefault: a.id === 'long-term',
    horizon: 'LONG_TERM',
    analysts: [...a.analysts],
  }));

  beforeEach(() => {
    applyRegistryAgencies(defaults);
  });

  it('adds a newly-created agency to the mirror + id list', () => {
    applyRegistryAgencies([
      ...defaults,
      { id: 'my-agency', name: 'My Agency', analystCount: 2, isDefault: false, horizon: 'LONG_TERM', analysts: ['orchestrator', 'data_ingestion'] },
    ]);
    expect(AGENCY_IDS).toContain('my-agency');
    expect(agencyById('my-agency').analysts).toEqual(['orchestrator', 'data_ingestion']);
  });

  it('drops a deleted agency from the mirror + id list', () => {
    const withoutCrypto = defaults.filter((a) => a.id !== 'crypto-screener');
    applyRegistryAgencies(withoutCrypto);
    expect(AGENCY_IDS).not.toContain('crypto-screener');
    expect(AGENCIES['crypto-screener']).toBeUndefined();
  });

  it('updates an agency membership in place (re-org reflected live)', () => {
    const reorged = defaults.map((a) =>
      a.id === 'long-term' ? { ...a, analysts: ['orchestrator', 'data_ingestion', 'risk'] } : a,
    );
    applyRegistryAgencies(reorged);
    expect(agencyById('long-term').analysts).toEqual(['orchestrator', 'data_ingestion', 'risk']);
  });

  it('preserves prior analyst ids when an older server summary omits them', () => {
    // Backward-compat: servers that only send analystCount (no `analysts`)
    // must not blank a previously-known flow.
    const summaryOnly = defaults.map(({ analysts, ...rest }) => rest);
    applyRegistryAgencies(summaryOnly);
    expect(agencyById('long-term').analysts.length).toBeGreaterThan(0);
  });

  it('retains analysts for a freshly-created agency (no prior ids to fall back to)', () => {
    // Regression: a brand-new agency has no `prev` in the mirror, so the
    // backend MUST send its ordered ids. Without them the reopen would show
    // zero analysts assigned. This mirrors the user report where creating an
    // agency, saving, then reopening showed no analysts.
    applyRegistryAgencies([
      { id: 'my-agency', name: 'My Agency', analystCount: 3, isDefault: false, horizon: 'LONG_TERM', analysts: ['orchestrator', 'data_ingestion', 'fundamental'] },
    ]);
    expect(agencyById('my-agency').analysts).toEqual(['orchestrator', 'data_ingestion', 'fundamental']);
  });
});

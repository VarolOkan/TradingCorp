// frontend/src/test/agency-mirror.test.ts
// Registry mirror test: keeps the hardcoded frontend agency/analyst catalogs
// in sync with the backend registry. The frontend does NOT read the backend
// registry dynamically, so this test is the guard that catches drift when a
// backend agency/analyst is added or renamed.
//
// Phase C added options-swing + options-intraday agencies and 7 options
// analysts to BOTH the backend and the frontend mirror — this test asserts
// they agree exactly.

import { AGENCIES as backendAgencies, AGENCY_IDS as backendAgencyIds } from '../../../src/registry/agencies';
import { optionsAnalystIds } from '../../../src/registry/analysts';
import { AGENCIES as frontendAgencies } from '../components/analysts/agencies';
import { ANALYSTS as frontendAnalysts } from '../components/analysts/analysts';

describe('frontend/backend agency mirror sync', () => {
  it('every backend agency id is present in the frontend agencies mirror', () => {
    const frontendIds = Object.keys(frontendAgencies) as string[];
    for (const id of backendAgencyIds) {
      expect(frontendIds).toContain(id);
    }
  });

  it('every frontend agency id maps to a backend agency with the same analyst order', () => {
    for (const [id, fe] of Object.entries(frontendAgencies)) {
      const be = backendAgencies[id];
      expect(be, `backend missing agency ${id}`).toBeDefined();
      expect(be.analysts.map((r) => r.id)).toEqual(fe.analysts);
    }
  });

  it('every backend options analyst id resolves to a frontend AnalystMeta', () => {
    const metaIds = new Set(frontendAnalysts.map((a) => a.id));
    for (const id of optionsAnalystIds()) {
      expect(metaIds.has(id), `frontend meta missing options analyst ${id}`).toBe(true);
    }
  });

  it('options-swing / options-intraday analyst lists match the frontend mirror', () => {
    expect(backendAgencies['options-swing'].analysts.map((r) => r.id))
      .toEqual(frontendAgencies['options-swing'].analysts);
    expect(backendAgencies['options-intraday'].analysts.map((r) => r.id))
      .toEqual(frontendAgencies['options-intraday'].analysts);
  });
});

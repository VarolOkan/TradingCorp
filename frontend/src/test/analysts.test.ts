// frontend/src/test/analysts.test.ts
import { ANALYSTS, analystById, AnalystId } from '../components/analysts/analysts';

describe('analysts metadata', () => {
  it('defines the 17 pipeline analysts in order (10 equity + 7 options)', () => {
    const ids = ANALYSTS.map((a) => a.id);
    expect(ids).toEqual([
      'orchestrator',
      'data_ingestion',
      'fundamental',
      'technical',
      'sentiment',
      'bull_researcher',
      'bear_researcher',
      'risk',
      'governance',
      'onchain',
      // ---- Phase B/C: options analysts ----
      'options_ingestion',
      'vol_surface',
      'options_pricing',
      'options_greeks',
      'options_flow',
      'options_technical',
      'options_risk',
    ]);
  });

  it('each analyst has a non-empty name, role, accent, monogram, and tasks', () => {
    for (const a of ANALYSTS) {
      expect(a.name.length).toBeGreaterThan(0);
      expect(a.role.length).toBeGreaterThan(0);
      expect(a.accent).toMatch(/^#/);
      expect(a.monogram.length).toBe(2);
      expect(a.tasks.length).toBeGreaterThan(0);
    }
  });

  it('stages follow the intake/analysis/debate/decision shape (2 intake, analysis, 2 debate, 1 decision + 7 options)', () => {
    const stages = ANALYSTS.map((a) => a.stage);
    // equity: [1,1,2,2,2,3,3,2,4,2]; options: ingestion=1, 5 analysis=2, risk=3
    expect(stages).toEqual([1, 1, 2, 2, 2, 3, 3, 2, 4, 2, 1, 2, 2, 2, 2, 2, 3]);
  });

  it('analystById returns the right record', () => {
    expect(analystById('governance' as AnalystId).name).toBe('Governance');
  });

  it('analystById throws on unknown id', () => {
    expect(() => analystById('nope' as AnalystId)).toThrow(/Unknown analyst/);
  });
});

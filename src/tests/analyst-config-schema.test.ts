// src/tests/analyst-config-schema.test.ts
// Phase 1 (docs/EXTENDING_ANALYSTS.md): schema-driven per-card settings.
//
// Asserts the descriptor shows ONLY the items an analyst can actually adjust:
//   - tunable WEIGHTS (handler-consumed params) for technical & risk
//   - NO weights for analysts that have none (e.g. data_ingestion)
//   - SOURCE fields when a credentialed source catalog entry is supplied
//   - empty schema (hasConfig=false) when an analyst has nothing adjustable

import { ANALYST_DEFS } from '../registry/analysts';
import { resolveAnalystDef } from '../types/registry';
import { buildAnalystConfigSchema } from '../registry/analyst-config-schema';

const defFor = (id: string) => resolveAnalystDef({ id }, ANALYST_DEFS);

describe('analyst-config-schema (Phase 1)', () => {
  it('technical exposes its two tunable weights with handler-fallback defaults', () => {
    const schema = buildAnalystConfigSchema(defFor('technical'));
    expect(schema.weights.map((w) => w.key).sort()).toEqual(['maxLookbackDays', 'signalSensitivity']);
    const sig = schema.weights.find((w) => w.key === 'signalSensitivity')!;
    expect(sig.default).toBe(0);
    expect(sig.min).toBe(-10);
    expect(sig.max).toBe(20);
    const look = schema.weights.find((w) => w.key === 'maxLookbackDays')!;
    expect(look.default).toBe(20);
    expect(look.max).toBe(250);
  });

  it('risk exposes maxStopLoss + baseAllocation with horizon-fallback defaults', () => {
    const schema = buildAnalystConfigSchema(defFor('risk'));
    expect(schema.weights.map((w) => w.key).sort()).toEqual(['baseAllocation', 'maxStopLoss']);
    const stop = schema.weights.find((w) => w.key === 'maxStopLoss')!;
    expect(stop.default).toBe(0.15); // long-term horizon fallback
    const alloc = schema.weights.find((w) => w.key === 'baseAllocation')!;
    expect(alloc.default).toBe(5);
  });

  it('an analyst with no tunable weights shows none (data_ingestion)', () => {
    const schema = buildAnalystConfigSchema(defFor('data_ingestion'));
    expect(schema.weights).toEqual([]);
  });

  it('a saved param overrides the default shown in the schema', () => {
    const def = resolveAnalystDef({ id: 'risk', params: { maxStopLoss: 0.03, baseAllocation: 2 } }, ANALYST_DEFS);
    const schema = buildAnalystConfigSchema(def);
    expect(schema.weights.find((w) => w.key === 'maxStopLoss')!.default).toBe(0.03);
    expect(schema.weights.find((w) => w.key === 'baseAllocation')!.default).toBe(2);
  });

  it('adds a source credential field with a pre-filled Base URI (user confirms, no typing)', () => {
    const schema = buildAnalystConfigSchema(defFor('fundamental'), [
      { id: 'alphaVantage', label: 'Alpha Vantage', auth: 'apikey' },
    ]);
    expect(schema.sources).toHaveLength(1);
    expect(schema.sources[0]).toMatchObject({
      sourceId: 'alphaVantage',
      label: 'Alpha Vantage',
      auth: 'apikey',
      uriRequired: true,
      uriLabel: 'Base URI',
    });
    // Pre-filled canonical endpoint so the user only confirms.
    expect(schema.sources[0].uriDefault).toBe('https://www.alphavantage.co/query');
  });

  it('pre-fills the Finnhub Base URI too', () => {
    const schema = buildAnalystConfigSchema(defFor('data_ingestion'), [
      { id: 'finnhub', label: 'Finnhub', auth: 'bearer' },
    ]);
    expect(schema.sources[0].sourceId).toBe('finnhub');
    expect(schema.sources[0].uriDefault).toBe('https://finnhub.io/api/v1');
  });

  it('hasConfig is false when an analyst has nothing adjustable (no weights, no sources)', () => {
    const schema = buildAnalystConfigSchema(defFor('governance'));
    expect(schema.weights).toEqual([]);
    expect(schema.sources).toEqual([]);
    expect(schema.hasConfig).toBe(false);
  });

  it('does not expose internal-only horizon keys as editable weights', () => {
    const schema = buildAnalystConfigSchema(defFor('technical'));
    expect(schema.weights.some((w) => ['horizon', 'timeHorizon', 'sourceMix'].includes(w.key))).toBe(false);
  });
});

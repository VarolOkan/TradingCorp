// src/tests/mockMode.test.ts
// Verifies the DISABLE_MOCK_DATA gate:
//   - when ON, seededRandom emits 0 (so no fabricated numbers flow through),
//   - the declarative handler emits an honest "mock disabled" note and collapses
//     to an empty/neutral output instead of invented figures,
//   - when OFF (default) behaviour is unchanged.
//
// This is the user's explicit request: they do not want to be able to confuse
// "purely imagination" mock data with real data. With no live sources
// configured (the default app), disabling mock => a run produces NO seeded
// numbers, only an honest empty state + a UI banner (frontend test covers the banner).

import { seededRandom } from '../registry/logic/shared';
import { declarativeHandler } from '../registry/logic/declarative';
import { isMockDisabled, setMockDisabled } from '../registry/logic/mockMode';
import { makeNodeSurface } from '../registry/logic/shared';
import type { AgentState, AnalystTrace } from '../types/financial-analysis';
import type { AnalystDef } from '../types/registry';

// A minimal declarative analyst with two weighted features + mock ranges.
const DEF: AnalystDef = {
  id: 'fundamental',
  name: 'Fundamental',
  role: 'FUNDAMENTAL',
  kind: 'analyst',
  stage: 2,
  logic: {
    mode: 'declarative',
    features: [
      { key: 'debt_to_equity', label: 'D/E' },
      { key: 'roe', label: 'ROE' },
    ],
    weighting: [
      { label: 'Leverage', inputs: ['debt_to_equity'], weight: 0.5, rationale: 'r' },
      { label: 'Profitability', inputs: ['roe'], weight: 0.5, rationale: 'r' },
    ],
    score: { range: [0, 100], round: true },
    verdict: {
      from: 'score',
      mapping: [
        { if: '>=', value: 60, then: 'BULLISH' },
        { if: '>=', value: 40, then: 'NEUTRAL' },
      ],
      default: 'NEUTRAL',
    },
    summaryTemplate: '{role} {score}/100 → {verdict}',
  },
  mock: { generator: 'seeded', seedFrom: 'ticker', ranges: { debt_to_equity: [0.2, 1.0], roe: [0.05, 0.4] } },
} as AnalystDef;

function freshState(): AgentState {
  return {
    messages: [],
    current_date: '2026-07-11',
    tickers: ['AAPL'],
    company_name: 'Apple',
    investment_thesis: '',
    final_decision: '',
    error: null,
    current_step: 'init',
    analystTraces: [],
  } as unknown as AgentState;
}

describe('mockMode gate', () => {
  afterEach(() => setMockDisabled(null)); // restore default (env-driven)

  it('default: mock enabled, seededRandom produces non-zero (parity) values', () => {
    setMockDisabled(false);
    expect(isMockDisabled()).toBe(false);
    const rng = seededRandom(123);
    const draws = [rng(), rng(), rng()];
    expect(draws.some((d) => d !== 0)).toBe(true);
  });

  it('when disabled: seededRandom emits 0 for every draw', () => {
    setMockDisabled(true);
    expect(isMockDisabled()).toBe(true);
    const rng = seededRandom(123);
    expect(rng()).toBe(0);
    expect(rng()).toBe(0);
  });

  it('when disabled: declarative analyst emits an honest "mock disabled" note and NO fabricated score', async () => {
    setMockDisabled(true);
    const surface = makeNodeSurface();
    const updated = await declarativeHandler(freshState(), surface, DEF);
    const trace = (updated.analystTraces as AnalystTrace[])[0]!;
    // The note must explain the output is empty, not invented.
    expect(trace.notes?.join(' ')).toMatch(/mock data disabled/i);
    expect(trace.notes?.join(' ')).toMatch(/not fabricated/i);
    // With seeded=0, both features are 0 => weighted score 0 => NEUTRAL, score 0.
    // i.e. it is NOT a plausible-looking invented number.
    expect(trace.output.score).toBe(0);
    expect(trace.output.verdict).toBe('NEUTRAL');
  });

  it('when enabled (default): declarative analyst runs normally and emits NO "mock disabled" note', async () => {
    setMockDisabled(false);
    expect(isMockDisabled()).toBe(false);
    const surface = makeNodeSurface();
    const updated = await declarativeHandler(freshState(), surface, DEF);
    const trace = (updated.analystTraces as AnalystTrace[])[0]!;
    // No "mock disabled" note in the normal path.
    expect(trace.notes?.join(' ') ?? '').not.toMatch(/mock data disabled/i);
    // And the run produced a real verdict/score (not the empty/honest stub).
    expect(typeof trace.output.verdict).toBe('string');
    expect(trace.output.verdict!.length).toBeGreaterThan(0);
  });
});

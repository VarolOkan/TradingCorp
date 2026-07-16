// src/registry/logic/declarative.ts
// Phase 4: execution engine for declarative (no-LLM) analysts.
//
// A declarative analyst is defined PURELY in JSON (see AnalystDef.logic):
//   - features:     inputs to read (from prior pipeline state / mocks)
//   - weighting:    per-feature weights (sum ≈ 1.0)
//   - score:        weightedSum → clamped/rounded score in `range`
//   - verdict:      score/field → threshold mapping → label
//   - summaryTemplate: "{role} {score}/100 → {verdict}"
//
// The handler builds an AnalystTrace (instructions / inputs / weighting /
// output / notes) so the drill-down drawer renders identically to fn analysts.
// It attaches the score/verdict to `state.messages[].data` and writes the
// declared output channels. No LLM call — deterministic given the inputs.

import type { AgentState, AnalystTrace } from '../../types/financial-analysis';
import type { AnalystDef, LogicSpec, AnalystTuning } from '../../types/registry';
import { stringToSeed, seededRandom, type NodeSurface } from './shared';
import { isMockDisabled } from './mockMode';

export type { NodeSurface };

/** Resolve a feature's numeric value. Declarative inputs come from two places:
 *  (1) mock data previously attached by the ingestion stage, or
 *  (2) the analyst's own deterministic mock spec for this ticker.
 * This keeps the default (no live sources) run well-formed and parity-safe. */
function resolveFeatureValues(def: AnalystDef, ticker: string): Record<string, number> {
  const out: Record<string, number> = {};
  const mock = def.mock;
  const rng = seededRandom(stringToSeed(`${ticker}:${def.id}`));

  for (const feat of def.features ?? []) {
    let value: number | undefined;
    // If a prior node stashed mock feature data on the state, prefer it.
    const stash = (def as any).__mockFeatures as Record<string, Record<string, number>> | undefined;
    if (stash && stash[ticker] && stash[ticker][feat.key] !== undefined) {
      value = stash[ticker][feat.key];
    }
    if (value === undefined && mock?.ranges) {
      const entry = mock.ranges[feat.key];
      if (entry) {
        const [min, max] = entry;
        value = Math.round(min + rng() * (max - min));
      }
    }
    if (value === undefined) value = 0;
    out[feat.key] = value;
  }
  return out;
}

function applyVerdict(logic: LogicSpec, score: number): string {
  const verdict = logic.verdict;
  if (!verdict) return 'NEUTRAL';
  if (verdict.from === 'score') {
    for (const m of verdict.mapping) {
      if (m.if === '>=' && score >= m.value) return m.then;
      if (m.if === '<' && score < m.value) return m.then;
      if (m.if === '==' && score === m.value) return m.then;
    }
    return verdict.default ?? 'NEUTRAL';
  }
  return verdict.default ?? 'NEUTRAL';
}

export async function declarativeHandler(
  state: AgentState,
  node: NodeSurface,
  def: AnalystDef,
  _tuning?: AnalystTuning,
): Promise<AgentState> {
  const mockDisabled = isMockDisabled();
  let updatedState = node.updateStep(state, `${def.id}_start`);
  node.emitProgress(updatedState, 'analyst:start', def.id as any, { stage: def.stage });

  updatedState = node.addMessage(updatedState, 'system',
    `Starting ${def.name} for ${state.tickers.length} ticker(s): ${state.tickers.join(', ')}`);

  const logic = def.logic;
  if (logic.mode !== 'declarative') {
    throw new Error(`declarativeHandler called for non-declarative analyst ${def.id}`);
  }

  const results: Record<string, { score: number; verdict: string; summary: string }> = {};
  const perTickerInputs: Array<{ ticker: string; label: string; data: Record<string, any>; sources: string[] }> = [];
  // Shared weighting steps are computed from the first ticker's feature layout
  // (weights are ticker-independent); we compute once and reuse.
  let weightingSteps: Array<{ label: string; inputs: string[]; weight: number; contribution: number; rationale: string }> = [];

  for (const ticker of state.tickers) {
    const features = resolveFeatureValues(def, ticker);

    // Weighted sum of feature values.
    let weighted = 0;
    const steps = (logic.weighting ?? []).map((w) => {
      const inputVal = w.inputs.reduce((s, key) => s + (features[key] ?? 0), 0);
      const contribution = inputVal * w.weight;
      weighted += contribution;
      return {
        label: w.label,
        inputs: w.inputs,
        weight: w.weight,
        contribution: Math.round(contribution * 100) / 100,
        rationale: w.rationale,
      };
    });
    if (weightingSteps.length === 0) weightingSteps = steps;

    // Score: weightedSum, clamped to range, optionally rounded.
    const [min, max] = logic.score?.range ?? [0, 100];
    let score = Math.max(min, Math.min(max, weighted));
    if (logic.score?.round) score = Math.round(score);

    const verdict = applyVerdict(logic, score);
    const summary = (logic.summaryTemplate ?? '{role} {score}/100 → {verdict}')
      .replace('{role}', def.role)
      .replace('{score}', String(score))
      .replace('{verdict}', verdict);

    results[ticker] = { score, verdict, summary };
    perTickerInputs.push({
      ticker,
      label: def.dataSources?.[0]?.label ?? 'Inputs',
      data: features as Record<string, any>,
      sources: def.dataSources?.[0]?.sources ?? [],
    });
  }

  // ONE trace per analyst (mirrors fn-handler convention), carrying all tickers.
  const first = Object.values(results)[0];
  const trace: AnalystTrace = {
    analyst: def.id as any,
    name: def.name,
    stage: def.stage,
    instructions: def.prompt ?? `${def.name} (declarative)`,
    inputs: perTickerInputs,
    weighting: weightingSteps,
    output: {
      verdict: first?.verdict ?? 'NEUTRAL',
      score: first?.score,
      summary: first?.summary ?? logic.summaryTemplate ?? 'declarative',
      details: { results },
    },
    // Honest signal when mock data is globally disabled: the output reflects NO
    // real data, so we must not let it read as a genuine analysis.
    notes: mockDisabled
      ? [`mock data disabled (DISABLE_MOCK_DATA): no live source configured for ${def.id} — output is empty, not fabricated`]
      : undefined,
  };

  // Attach results to messages[].data on the declared output channels.
  const channels = def.output?.channels ?? [`${def.id}_analysis`];
  updatedState = {
    ...updatedState,
    messages: [
      ...(updatedState.messages || []),
      {
        role: 'system',
        content: `${def.name} completed for ${state.tickers.length} ticker(s)`,
        timestamp: new Date().toISOString(),
        data: { analyses: results, summary: logic.summaryTemplate ?? 'declarative', channels },
      },
    ],
    investment_thesis: node && state.investment_thesis
      ? `${state.investment_thesis}\n[${def.name}] ${JSON.stringify(results)}`
      : state.investment_thesis,
  };

  // Append the single analyst trace.
  const prior = Array.isArray(updatedState.analystTraces) ? updatedState.analystTraces : [];
  updatedState = { ...updatedState, analystTraces: [...prior, trace] };

  return updatedState;
}

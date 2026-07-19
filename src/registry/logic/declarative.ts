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

/** Read a REAL per-ticker score off an upstream analyst's trace.
 *  `analyst:<id>:<field>` → state.analystTraces[analyst=<id>].output.details.analyses[ticker][<field>].
 *  When <field> is omitted, the analyst's top-level output.score is used.
 *  Returns undefined when the upstream trace / field is absent, so the caller
 *  falls back to the seeded mock spec (parity). */
function readUpstreamScore(
  state: AgentState,
  ticker: string,
  source: string,
): number | undefined {
  const parts = source.split(':'); // ['analyst', '<id>', '<field>'?]
  const analystId = parts[1];
  const field = parts[2];
  if (!analystId) return undefined;
  const traces = Array.isArray(state.analystTraces) ? state.analystTraces : [];
  const trace: any = traces.find((t: any) => t.analyst === analystId);
  if (!trace) return undefined;
  // Prefer the per-ticker score in output.details.analyses[ticker][field].
  if (field) {
    const perTicker = trace.output?.details?.analyses?.[ticker];
    const v = perTicker ? perTicker[field] : undefined;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    return undefined;
  }
  // No explicit field → use the analyst's headline score.
  const s = trace.output?.score;
  return typeof s === 'number' && Number.isFinite(s) ? s : undefined;
}

/** Resolve a feature's numeric value. Declarative inputs come from, in order:
 *  (1) a REAL upstream analyst score, when the feature's source is
 *      `analyst:<id>:<field>` (Stage-3 researchers reading the Stage-2 pillars);
 *  (2) the analyst's own deterministic mock spec for this ticker (parity when
 *      no upstream trace exists, e.g. a researcher run in isolation);
 *  (3) 0 (also the mock-disabled path — seededRandom returns 0).
 * Returns the resolved values plus the set of feature keys that were filled
 * from a REAL upstream score, so the trace can report provenance honestly. */
function resolveFeatureValues(
  def: AnalystDef,
  ticker: string,
  state: AgentState,
): { values: Record<string, number>; upstreamKeys: Set<string>; seededFallback: boolean } {
  const out: Record<string, number> = {};
  const upstreamKeys = new Set<string>();
  const mock = def.mock;
  const rng = seededRandom(stringToSeed(`${ticker}:${def.id}`));
  let seededFallback = false;

  for (const feat of def.features ?? []) {
    let value: number | undefined;

    // (1) Real upstream analyst score wins when declared + available.
    if (typeof feat.source === 'string' && feat.source.startsWith('analyst:')) {
      const upstream = readUpstreamScore(state, ticker, feat.source);
      if (upstream !== undefined) {
        value = upstream;
        upstreamKeys.add(feat.key);
      }
    }

    // (2) Seeded mock fallback (parity) — also covers the isolated-run case
    //     where no upstream trace exists yet. Skipped entirely when mock is
    //     globally disabled so features collapse to a genuine 0 (NOT the range
    //     minimum `min + 0*(max-min) = min`, which would leak a fabricated-looking
    //     number while the trace claims the output is empty).
    if (value === undefined && !isMockDisabled() && mock?.ranges) {
      const entry = mock.ranges[feat.key];
      if (entry) {
        const [min, max] = entry;
        value = Math.round(min + rng() * (max - min));
        seededFallback = true;
      }
    }
    if (value === undefined) value = 0;
    out[feat.key] = value;
  }
  return { values: out, upstreamKeys, seededFallback };
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

/** Pull REAL debate evidence for a ticker from the ingested bundle, when the
 *  analyst declares a `dataSources` entry with `from: 'ingested'`. Returns a
 *  structured, citable summary (price vs SMA, RSI regime, recent headlines) or
 *  undefined when no ingested evidence is available. This is annotation only —
 *  it never changes the score/verdict, so the parity of the weighted-sum output
 *  is preserved; it makes the debate evidence-anchored and auditable.
 *
 *  Signals:
 *   - technical indicators (sma_20/50/200, rsi) + last price → "price $X above/
 *     below its 50d SMA", "RSI Y (overbought/oversold)".
 *   - real news headlines (sentiment.headlines) → up to 2 recent headlines.
 *   - bars-derived momentum (last close vs first close of the 1d series).
 */
function extractIngestedEvidence(
  def: AnalystDef,
  state: AgentState,
  ticker: string,
): { priceVsSma: string | null; rsi: number | null; rsiRegime: string | null; headlines: string[]; momentum: string | null } | undefined {
  const wantsIngested = (def.dataSources ?? []).some(
    (d) => d.from === 'ingested' && Array.isArray(d.fields) && d.fields.length > 0,
  );
  if (!wantsIngested) return undefined;
  const ingested = state.ingested;
  if (!ingested) return undefined;

  const tech = ingested.technical?.[ticker]?.indicators ?? {};
  const market = ingested.market?.[ticker] ?? {};
  const price = typeof market.price === 'number' ? market.price : (typeof market.price === 'string' ? Number(market.price) : null);
  const sma50 = tech.sma_50 ?? null;
  const rsi = typeof tech.rsi === 'number' ? tech.rsi : (typeof tech.rsi === 'string' ? Number(tech.rsi) : null);
  const sma200 = tech.sma_200 ?? null;

  let priceVsSma: string | null = null;
  if (price !== null && sma50 !== null && Number.isFinite(sma50)) {
    const pct = ((price - sma50) / sma50) * 100;
    priceVsSma = `price $${price.toFixed(2)} ${pct >= 0 ? 'above' : 'below'} 50d SMA ($${sma50.toFixed(2)}, ${pct.toFixed(1)}%)`;
  } else if (price !== null && sma200 !== null && Number.isFinite(sma200)) {
    const pct = ((price - sma200) / sma200) * 100;
    priceVsSma = `price $${price.toFixed(2)} ${pct >= 0 ? 'above' : 'below'} 200d SMA (${pct.toFixed(1)}%)`;
  }

  let rsiRegime: string | null = null;
  if (rsi !== null && Number.isFinite(rsi)) {
    rsiRegime = rsi >= 70 ? 'overbought' : rsi <= 30 ? 'oversold' : 'neutral';
  }

  // Momentum from the 1d bar series (last close vs first close).
  let momentum: string | null = null;
  const daily = (ingested.bars?.[ticker] ?? []).find((s: any) => s.interval === '1d') ?? (ingested.bars?.[ticker] ?? [])[0];
  const closes: number[] = (daily?.bars ?? []).map((b: any) => Number(b.close)).filter((n: number) => Number.isFinite(n));
  if (closes.length >= 2) {
    const chg = ((closes[closes.length - 1] - closes[0]) / closes[0]) * 100;
    momentum = `${chg >= 0 ? '+' : ''}${chg.toFixed(1)}% over ${closes.length} sessions`;
  }

  const sentiment = ingested.sentiment?.[ticker];
  const headlines: string[] = Array.isArray(sentiment?.headlines)
    ? sentiment.headlines.slice(0, 2)
    : (typeof sentiment?.data?.headlines === 'string' ? [sentiment.data.headlines] : []);

  if (priceVsSma === null && rsiRegime === null && momentum === null && headlines.length === 0) {
    return undefined; // ingested present but no usable evidence → no note
  }
  return { priceVsSma, rsi, rsiRegime, headlines, momentum };
}

/** Turn extracted ingested evidence into a single honest, citable note for the
 *  debate trace (e.g. "Evidence: price $210.50 above 50d SMA (+3.2%); RSI 68
 *  (overbought); recent news: '…', '…'"). */
function buildEvidenceNote(
  def: AnalystDef,
  ev: NonNullable<ReturnType<typeof extractIngestedEvidence>>,
): string {
  const bits: string[] = [];
  if (ev.priceVsSma) bits.push(ev.priceVsSma);
  if (ev.rsi !== null && Number.isFinite(ev.rsi)) {
    bits.push(`RSI ${ev.rsi.toFixed(0)}${ev.rsiRegime ? ` (${ev.rsiRegime})` : ''}`);
  }
  if (ev.momentum) bits.push(`momentum ${ev.momentum}`);
  if (ev.headlines.length > 0) {
    bits.push(`recent news: ${ev.headlines.map((h) => `"${h.slice(0, 80)}"`).join('; ')}`);
  }
  return `Evidence (live ingested): ${bits.join('; ')}`;
}

/** Build honest provenance notes for a declarative analyst's trace. Rules:
 *  - The output is "empty / not fabricated" ONLY when (a) mock is disabled AND
 *    (b) the analyst had NO real inputs available (no upstream score filled and
 *    no other live source). Critically, an analyst that reads REAL upstream
 *    scores (e.g. the Stage-3 bull/bear researchers reading Stage-2 scores) is
 *    NOT "empty" just because DISABLE_MOCK_DATA is on — its inputs are real
 *    pipeline data, never fabricated. Reporting it as empty was a bug: it made
 *    a genuinely data-driven debate look like it produced nothing.
 *  - has features declared to read upstream analyst scores (`analyst:*`):
 *      • ALL such features filled from real upstream → "derived from live
 *        upstream analyst scores" (auditable); same message whether or not
 *        mock is globally disabled, because the data is real either way.
 *      • SOME filled → mixed note naming the seeded-fallback keys;
 *      • NONE filled → seeded parity fallback (upstream traces absent).
 *  - no upstream-sourced features → undefined (parity: no note, as before). */
function buildProvenanceNotes(
  def: AnalystDef,
  mockDisabled: boolean,
  declaredUpstreamKeys: Set<string>,
  upstreamKeysAll: Set<string>,
): string[] | undefined {
  // No upstream-sourced features at all (pure mock/llm analysts): only the
  // global-disable note applies.
  if (declaredUpstreamKeys.size === 0) {
    if (mockDisabled) {
      return [
        `mock data disabled (DISABLE_MOCK_DATA): no live source configured for ${def.id} — output is empty, not fabricated`,
      ];
    }
    return undefined;
  }

  // This analyst DOES consume real upstream scores. Whatever mock-mode says, if
  // any real score was filled this run the output is genuine — report it as
  // derived from real data, never as "empty".
  const filled = [...declaredUpstreamKeys].filter((k) => upstreamKeysAll.has(k));
  const missing = [...declaredUpstreamKeys].filter((k) => !upstreamKeysAll.has(k));

  if (missing.length === 0) {
    return [
      `Inputs derived from live upstream analyst scores (${filled.join(', ')}). ` +
        `Findings reflect the actual Stage-2 analysis, not seeded data — auditable via those analysts' traces.`,
    ];
  }
  if (filled.length === 0) {
    // No upstream score available this run. Honest message depends on mock mode:
    // if disabled, we must NOT fabricate → empty & labelled; otherwise seeded fallback.
    if (mockDisabled) {
      return [
        `mock data disabled (DISABLE_MOCK_DATA): no upstream analyst output available for ${def.id} — output is empty, not fabricated`,
      ];
    }
    return [
      `No upstream analyst output available this run — ran on seeded parity fallback ` +
        `for ${missing.join(', ')}. Values are illustrative, not auditable.`,
    ];
  }
  // Mixed: some real, some absent. The real ones are genuine; name the gap.
  if (mockDisabled) {
    // Real inputs present → still genuine, not "empty". Report the mix honestly.
    return [
      `Mixed inputs: live upstream scores for ${filled.join(', ')}; no upstream trace for ` +
        `${missing.join(', ')} (left at 0, not fabricated — mock data disabled). ` +
        `Findings reflect the actual Stage-2 analysis where available.`,
    ];
  }
  return [
    `Mixed inputs: live upstream scores for ${filled.join(', ')}; seeded parity fallback for ` +
      `${missing.join(', ')} (upstream trace absent). Wire the missing upstream analyst(s) for fully auditable output.`,
  ];
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
  // Track which feature keys were filled from a REAL upstream analyst score
  // (vs seeded fallback), aggregated across tickers, for honest trace notes.
  const upstreamKeysAll = new Set<string>();
  // Feature keys declared to source from an upstream analyst (whether or not the
  // upstream trace was present this run) — lets us report a seeded fallback honestly.
  const declaredUpstreamKeys = new Set<string>(
    (def.features ?? [])
      .filter((f) => typeof f.source === 'string' && f.source.startsWith('analyst:'))
      .map((f) => f.key),
  );
  // Collected live-debate evidence notes (real price/RSI/news) for honest trace.
  const evidenceNotesAll: string[] = [];
  // Whether ANY feature across ANY ticker fell to the seeded fallback path
  // (i.e. some driving input was NOT from a live source).
  let seededFallbackAny = false;
  // Shared weighting steps are computed from the first ticker's feature layout
  // (weights are ticker-independent); we compute once and reuse.
  let weightingSteps: Array<{ label: string; inputs: string[]; weight: number; contribution: number; rationale: string }> = [];

  for (const ticker of state.tickers) {
    const { values: features, upstreamKeys, seededFallback } = resolveFeatureValues(def, ticker, state);
    if (seededFallback) seededFallbackAny = true;
    for (const k of upstreamKeys) upstreamKeysAll.add(k);

    // Weighted sum of feature values. `invert:true` steps use the complement
    // (100 - v) on the 0..100 verdict scale, so a WEAK pillar score strengthens
    // an inverted case (e.g. the Bear researcher). Without this the bull and
    // bear researchers computed identical scores from identical inputs.
    let weighted = 0;
    const steps = (logic.weighting ?? []).map((w) => {
      const raw = w.inputs.reduce((s, key) => s + (features[key] ?? 0), 0);
      const inputVal = w.invert ? (100 - raw) : raw;
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

    // §Live debate evidence: real technical + news signals from the ingested
    // bundle, attached as annotation (does NOT change the score/verdict).
    const evidence = extractIngestedEvidence(def, state, ticker);
    if (evidence) evidenceNotesAll.push(buildEvidenceNote(def, evidence));

    perTickerInputs.push({
      ticker,
      label: def.dataSources?.[0]?.label ?? 'Inputs',
      data: {
        ...(features as Record<string, any>),
        ...(evidence ? { evidence } : {}),
      },
      sources: def.dataSources?.[0]?.sources ?? [],
    });
  }

  // ONE trace per analyst (mirrors fn-handler convention), carrying all tickers.
  const first = Object.values(results)[0];

  // Honest provenance: did this output come from live sources, seeded fallback,
  // or a mix? (semantic-honesty rule — never let fabricated data read as live).
  const realUsed = upstreamKeysAll.size > 0 || evidenceNotesAll.length > 0;
  let dataProvenance: AnalystTrace['dataProvenance'];
  if (realUsed && seededFallbackAny) dataProvenance = 'mixed';
  else if (realUsed) dataProvenance = 'live';
  else if (seededFallbackAny) dataProvenance = 'seeded-parity';
  else dataProvenance = 'none';

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
    dataProvenance,
    // Honest signal when mock data is globally disabled: the output reflects NO
    // real data, so we must not let it read as a genuine analysis.
    notes: [
      ...(buildProvenanceNotes(def, mockDisabled, declaredUpstreamKeys, upstreamKeysAll) ?? []),
      ...(dataProvenance === 'seeded-parity'
        ? ['⚑ Data is NOT from live online sources — output is seeded/parity (fabricated for parity).']
        : []),
      ...evidenceNotesAll,
    ],
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

// src/registry/logic/fuse.ts
// P2a of the multi-source architecture (docs/MULTI_SOURCE_ARCHITECTURE.md §P2).
//
// The PURE fusion engine: given several NormalizedRecord<T> for the SAME domain
// (one per source), combine a numeric signal across them into a single weighted
// value plus a consensus assessment. No I/O, no domain knowledge — it takes a
// value-extractor so it works for any domain (sentiment_score, health score,
// implied vol, rfr, ...). This is the reusable "weigh ALL sources" core.
//
// Design invariants (so it can sit under resolveDomain without breaking P0/P1):
//   * ONE live record in  => output value === that record's value (parity).
//   * ZERO usable records  => { ok:false }, caller keeps its existing fallback.
//   * effective weight of a source = configuredWeight * confidence, so a live
//     source (confidence 1) dominates a degraded/fallback one (confidence 0),
//     and a source that returned mock (confidence 0) contributes nothing even
//     if it is in the weight map. This keeps fusion HONEST.
//   * agreement: 1 - normalizedDispersion across contributing sources. When it
//     drops below `consensusThreshold` we flag low_consensus (+ a human note)
//     so the analyst trace can surface "sources disagree" instead of hiding it.

import type { NormalizedRecord } from '../types/domains';
import type { NewsResult } from './news';
import { scoreToLabel } from './news';

export interface FuseWeights {
  /** sourceId -> configured weight (any positive scale; normalized internally). */
  [sourceId: string]: number;
}

export interface FuseContribution {
  sourceId: string;
  value: number;
  /** configured weight for this source (post-default). */
  weight: number;
  confidence: number;
  /** normalized effective weight actually applied (sums to 1 across contributors). */
  effectiveWeight: number;
  /** effectiveWeight * value — this source's additive share of the blend. */
  contribution: number;
}

export interface FuseResult {
  ok: boolean;
  /** Weighted blended value (only meaningful when ok). */
  value: number;
  /** 0..1 consensus: 1 = all contributors identical, →0 = maximally dispersed. */
  agreement: number;
  /** true when agreement < threshold AND >1 source contributed. */
  low_consensus: boolean;
  /** ids of sources that actually contributed (confidence>0, finite value). */
  contributors: string[];
  /** per-source breakdown for the trace drawer. */
  contributions: FuseContribution[];
  /** honest human-readable summary for the analyst note / side pane. */
  note: string;
}

export interface FuseOptions<T> {
  /** pull the numeric signal out of a record's payload (null => skip source). */
  extract: (rec: NormalizedRecord<T>) => number | null | undefined;
  /** per-source configured weights; missing source defaults to `defaultWeight`. */
  weights?: FuseWeights;
  defaultWeight?: number;
  /** flag low_consensus when agreement drops below this (default 0.7). */
  consensusThreshold?: number;
  /** expected spread of the signal, used to normalize dispersion (default 100,
   *  matching the 0..100 sentiment / health score scale). */
  scale?: number;
}

/**
 * Weight-blend a numeric signal across multiple source records.
 * Pure + deterministic. See invariants at top of file.
 */
export function fuseNumeric<T>(
  records: ReadonlyArray<NormalizedRecord<T>>,
  opts: FuseOptions<T>,
): FuseResult {
  const defaultWeight = opts.defaultWeight ?? 1;
  const threshold = opts.consensusThreshold ?? 0.7;
  const scale = opts.scale && opts.scale > 0 ? opts.scale : 100;

  // 1) Keep only records that yield a finite value AND have positive confidence.
  //    confidence 0 (mock/seed/failed) must not sway a live blend.
  const usable: Array<{ rec: NormalizedRecord<T>; value: number }> = [];
  for (const rec of records) {
    const v = opts.extract(rec);
    if (v === null || v === undefined || !Number.isFinite(v)) continue;
    if (!(rec.confidence > 0)) continue;
    usable.push({ rec, value: v });
  }

  if (usable.length === 0) {
    return {
      ok: false,
      value: 0,
      agreement: 0,
      low_consensus: false,
      contributors: [],
      contributions: [],
      note: 'no source produced a usable value',
    };
  }

  // 2) effective weight = configuredWeight * confidence.
  const raw = usable.map(({ rec, value }) => {
    const weight = opts.weights?.[rec.sourceId] ?? defaultWeight;
    const eff = Math.max(0, weight) * Math.max(0, Math.min(1, rec.confidence));
    return { rec, value, weight, confidence: rec.confidence, eff };
  });
  const totalEff = raw.reduce((s, r) => s + r.eff, 0);

  // Degenerate: all effective weights zero (e.g. all weights set to 0) — fall
  // back to an equal-weight mean so we still return an honest number.
  const useEqual = totalEff <= 0;
  const denom = useEqual ? raw.length : totalEff;

  const contributions: FuseContribution[] = raw.map((r) => {
    const effectiveWeight = useEqual ? 1 / raw.length : r.eff / denom;
    return {
      sourceId: r.rec.sourceId,
      value: r.value,
      weight: r.weight,
      confidence: r.confidence,
      effectiveWeight,
      contribution: effectiveWeight * r.value,
    };
  });

  const value = contributions.reduce((s, c) => s + c.contribution, 0);

  // 3) agreement = 1 - (weighted dispersion / scale), clamped 0..1.
  //    Dispersion = weighted mean absolute deviation from the blended value.
  const dispersion = contributions.reduce(
    (s, c) => s + c.effectiveWeight * Math.abs(c.value - value),
    0,
  );
  const agreement = usable.length === 1 ? 1 : Math.max(0, Math.min(1, 1 - dispersion / scale));
  const low_consensus = usable.length > 1 && agreement < threshold;

  const contributors = contributions.map((c) => c.sourceId);
  const note = usable.length === 1
    ? `single source (${contributors[0]})`
    : low_consensus
      ? `low consensus: ${contributors.length} sources disagree (agreement ${agreement.toFixed(2)})`
      : `${contributors.length} sources blended (agreement ${agreement.toFixed(2)})`;

  return { ok: true, value, agreement, low_consensus, contributors, contributions, note };
}

// ---- domain wrapper: sentiment fan-in --------------------------------------
// Blends several news_sentiment records (Finnhub / Yahoo / Google / social...)
// into ONE NewsResult: headlines are unioned (de-dupe left to callers that
// already do it), and sentiment_score is the weighted blend. The consensus note
// is appended honestly so the trace drawer shows WHY the score is what it is.

export interface FuseSentimentResult {
  blended: NewsResult;
  fusion: FuseResult;
}

export function fuseSentiment(
  records: ReadonlyArray<NormalizedRecord<NewsResult>>,
  opts: { weights?: FuseWeights; consensusThreshold?: number } = {},
): FuseSentimentResult | null {
  const live = records.filter((r) => r.data && typeof r.data.sentiment_score === 'number');
  if (live.length === 0) return null;

  const fusion = fuseNumeric(records, {
    extract: (r) => (r.data ? r.data.sentiment_score : null),
    scale: 100, // sentiment_score is 0..100
    ...(opts.weights ? { weights: opts.weights } : {}),
    ...(opts.consensusThreshold !== undefined ? { consensusThreshold: opts.consensusThreshold } : {}),
  });

  // Single usable source => passthrough (parity with P0/P1 single-source path).
  if (!fusion.ok || fusion.contributors.length <= 1) {
    const only = live[0]!;
    return { blended: only.data, fusion };
  }

  const score = Math.round(fusion.value);
  // Union headlines newest-first (callers already de-dupe within a source).
  const headlines = live
    .flatMap((r) => r.data.headlines ?? [])
    .sort((a, b) => +new Date(b.timestamp) - +new Date(a.timestamp))
    .slice(0, 30);

  const baseNote = live.map((r) => `${r.sourceId}=${r.data.sentiment_score}`).join(' ');
  const blended: NewsResult = {
    ticker: live[0]!.data.ticker,
    headlines,
    sentiment_score: score,
    sentiment_label: scoreToLabel(score),
    source: 'mixed' as NewsResult['source'],
    note: `${baseNote} | ${fusion.note}`,
    consensus: {
      agreement: fusion.agreement,
      low_consensus: fusion.low_consensus,
      contributors: fusion.contributors,
      contributions: fusion.contributions,
    },
  };
  return { blended, fusion };
}


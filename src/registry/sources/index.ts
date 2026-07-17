// src/registry/sources/index.ts
// Orchestrates §4.9 acquisition for ONE analyst: acquires every declared
// source, applies each source's onError policy, resolves fallback chains,
// and produces the per-analyst status + the analyst-level onAllSourcesFailed
// escalation. Pure / testable; no transport dependency (fetch is injected).
//
// Parity note: when an analyst declares NO dataSources (the default mock-only
// config), this is a no-op returning empty status — so the data-driven graph
// behaves identically to the legacy graph.

import type { AnalystDef } from '../../types/registry';
import { acquireSource, applySourcePolicy, type AcquireContext, type FetchFn } from './acquire';
import type { DataSourceSpec } from '../../types/registry';

/**
 * A source is "live" (fetchable by the engine) only if it declares a REST /
 * GraphQL type AND a concrete endpoint. Everything else — internal pipeline
 * handoffs (`from`), mock feeds, ws/ingestion placeholders — is declarative
 * metadata that the engine must ignore to preserve legacy parity.
 */
export function isLiveSource(s: DataSourceSpec): boolean {
  return (s.type === 'rest' || s.type === 'graphql') && typeof s.endpoint === 'string' && s.endpoint.length > 0;
}

export interface AnalystAcquisition {
  /** Per-source status keyed by source id (feeds AnalystTrace.sourceStatus). */
  sourceStatus: Record<string, 'ok' | 'skipped' | 'failed' | 'fallback'>;
  /** Human-readable notes for trace.notes (skips/fallbacks/failures). */
  notes: string[];
  /** True if ran on fewer than the full source set. */
  degraded: boolean;
  /** True if onAllSourcesFailed triggered and we fell back to mock. */
  usedMockFallback: boolean;
  /** True if a required source hard-failed (analyst-level escalation). */
  hardFailed: boolean;
  /** True if any source hit an auth error (drives "Check API key" hint). */
  authError: boolean;
  /** Merged field data across all ok sources. */
  merged: Record<string, any>;
  /**
   * Resolved Finnhub API key for the live `company-news` sentiment feed,
   * attached by GenericAnalystNode when this analyst is the ingestion node.
   * The handler uses it to populate `ingested.sentiment` with REAL news.
   */
  finnhubKey?: string;
  /**
   * Resolved Alpha Vantage API key for the live `OVERVIEW` fundamental feed,
   * attached by GenericAnalystNode when this analyst is the ingestion node.
   * The handler uses it to populate `ingested.fundamental` with REAL ratios.
   */
  alphaVantageKey?: string;
}

const EMPTY: AnalystAcquisition = {
  sourceStatus: {},
  notes: [],
  degraded: false,
  usedMockFallback: false,
  hardFailed: false,
  authError: false,
  merged: {},
};

/**
 * Run §4.9.1 acquisition flow for a single analyst definition.
 * @param def         the resolved AnalystDef (may have empty dataSources)
 * @param ctx         fetch + runtimeConfig
 */
export async function acquireForAnalyst(
  def: AnalystDef,
  ctx: AcquireContext = {},
): Promise<AnalystAcquisition> {
  // Only genuinely fetchable sources activate the engine. Declarative-only
  // sources (internal pipeline handoffs, mock feeds with no endpoint) are
  // ignored so the data-driven graph stays byte-identical to the legacy graph
  // in the default mock-only setup (parity, doc §7).
  const sources = (def.dataSources ?? []).filter(isLiveSource);
  if (sources.length === 0) return EMPTY;

  const sourceStatus: AnalystAcquisition['sourceStatus'] = {};
  const notes: string[] = [];
  const merged: Record<string, any> = {};
  let hardFailed = false;
  let authError = false;
  for (const source of sources) {
    let res = await acquireSource(source, ctx);
    let policy = applySourcePolicy(res, source, sources, ctx);

    // Resolve fallback chain (onError='fallback' → try fallbackSourceId once).
    if (policy.status === 'fallback') {
      const fb = sources.find((s) => s.id === source.fallbackSourceId);
      if (fb) {
        const fbRes = await acquireSource(fb, ctx);
        if (fbRes.ok) {
          res = fbRes;
          policy = { status: 'fallback', escalate: false, note: `${source.label}: fell back to ${fb.label}` };
        } else {
          policy = {
            status: 'skipped',
            escalate: source.required === true,
            note: `${source.label}: fallback ${fb.label} also failed`,
          };
        }
      }
    }

    const key = source.id ?? source.label;
    sourceStatus[key] = policy.status === 'ok' ? 'ok' : policy.status;
    if (policy.note) notes.push(policy.note);
    if (res.authError) authError = true;
    if (policy.status === 'ok' || policy.status === 'fallback') {
      // Key each source's acquired payload under its SOURCE ID so two sources
      // that both return the same top-level field name (e.g. Polygon's v2
      // aggregates AND v3 options snapshot both use `results`) don't clobber
      // each other in `merged`. The per-source payload keeps its own field
      // shape (e.g. `{ results: [...] }`), so consumers read
      // `merged[sourceId].results`.
      merged[source.id ?? source.label] = policy.data ?? res.data ?? {};
    }
    if (policy.escalate) hardFailed = true;
  }

  const okCount = Object.values(sourceStatus).filter((s) => s === 'ok' || s === 'fallback').length;
  const degraded = okCount > 0 && okCount < sources.length;
  const allFailed = okCount === 0;

  let usedMockFallback = false;
  if (allFailed) {
    const action = def.onAllSourcesFailed?.action ?? 'useMock';
    if (action === 'useMock') {
      usedMockFallback = true;
      notes.push('fallback: mock data; live sources down');
    } else if (action === 'fail') {
      hardFailed = true;
      notes.push('all sources failed — analyst hard-failed');
    } else {
      // degrade
      notes.push('all sources failed — analyst degraded');
    }
  } else if (degraded) {
    notes.push(`degraded: ${okCount}/${sources.length} sources available`);
  }

  return { sourceStatus, notes, degraded, usedMockFallback, hardFailed, authError, merged };
}

/**
 * Aggregate per-analyst acquisitions into the pipeline-wide dataHealth summary
 * (§4.9.3 / §4.9.4). `prior` is the running dataHealth accumulator (or null on
 * the first analyst).
 */
export function aggregateDataHealth(
  prior: {
    sourcesOk: number;
    sourcesTotal: number;
    degradedAnalysts: string[];
    unavailableSources: string[];
    usedMockFallback: boolean;
  } | null,
  acc: AnalystAcquisition,
  analystId: string,
): {
  sourcesOk: number;
  sourcesTotal: number;
  degradedAnalysts: string[];
  unavailableSources: string[];
  usedMockFallback: boolean;
} {
  const base = prior ?? {
    sourcesOk: 0,
    sourcesTotal: 0,
    degradedAnalysts: [] as string[],
    unavailableSources: [] as string[],
    usedMockFallback: false,
  };
  return {
    sourcesOk: base.sourcesOk + Object.values(acc.sourceStatus).filter((s) => s === 'ok' || s === 'fallback').length,
    sourcesTotal: base.sourcesTotal + Object.keys(acc.sourceStatus).length,
    degradedAnalysts: [
      ...base.degradedAnalysts,
      ...(acc.degraded || acc.usedMockFallback || acc.hardFailed ? [analystId] : []),
    ],
    unavailableSources: [
      ...base.unavailableSources,
      ...Object.entries(acc.sourceStatus)
        .filter(([, s]) => s === 'skipped' || s === 'failed')
        .map(([id]) => id),
    ],
    usedMockFallback: base.usedMockFallback || acc.usedMockFallback,
  };
}

export type { AcquireContext, FetchFn };

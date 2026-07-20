// src/registry/logic/options-shared.ts
// Phase B. Shared helpers for the options fn-analyst handlers so each handler
// stays small and the trace/message/state plumbing is written once (mirrors the
// convention of the equity fn handlers: one trace per analyst carrying all
// tickers, a system message with results on the declared channels, and a
// thesis append).

import type { AgentState, HistoricalBundle } from '../../types/financial-analysis';
import type { AnalystTuning } from '../../types/registry';
import type { NodeSurface } from './shared';
import { annotateDataReceived, recordDataReceived } from './shared';
import { fetchHistoricalBundle, type HistProfile } from './hist';
import { resolveLiveOptionsBundle } from '../sources/adapters/option-chain';

/**
 * Build the hist.ts profile for a ticker from the agency tuning. The two option
 * agencies pass explicit params (§4.1/§4.2); when a handler runs in isolation
 * (no tuning) we fall back to a swing-style daily profile so unit tests are
 * deterministic without an upstream ingestion node.
 */
export function profileFromTuning(tuning?: AnalystTuning): HistProfile {
  const params = tuning?.params ?? {};
  const horizon = tuning?.horizon;
  const base: HistProfile =
    horizon === 'INTRADAY'
      ? { lookbackDays: 5, intervals: ['5m', '1m'], expiries: 'weekly+0dte' }
      : { lookbackDays: 90, intervals: ['1d'], expiries: 'monthly+weekly' };
  // Explicit agency params win over the horizon default.
  if (typeof params.lookbackDays === 'number') base.lookbackDays = params.lookbackDays;
  if (Array.isArray(params.intervals)) base.intervals = params.intervals;
  if (typeof params.expiries === 'string') base.expiries = params.expiries;
  return base;
}

/**
 * Resolve the HistoricalBundle for a ticker: prefer the bundle the ingestion
 * node stashed on `state.optionsData`; otherwise regenerate the deterministic
 * mock via hist.ts. Either path yields byte-identical data for a given
 * (ticker, profile), so a handler behaves the same with or without ingestion.
 */
export async function resolveBundle(
  state: AgentState,
  ticker: string,
  tuning?: AnalystTuning,
): Promise<HistoricalBundle> {
  const existing = state.optionsData?.[ticker];
  if (existing) return existing;
  return fetchHistoricalBundle(ticker, profileFromTuning(tuning));
}

/** Clamp a number to [min, max]. */
export function clamp(x: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, x));
}

export interface PerTickerResult {
  /** Per-ticker structured output stored under details.results[ticker]. */
  data: Record<string, any>;
  score: number;
  verdict: string;
  summary: string;
}

export interface FnAnalystConfig {
  id: string;
  name: string;
  stage: 1 | 2 | 3;
  instructions: string;
  /** Channels to write on the completion message (doc OUTPUT CONTRACT). */
  channels: string[];
  /** UPPERCASE label for the investment-thesis block. */
  thesisLabel: string;
  /** Trace weighting steps (ticker-independent; shown in the drawer). */
  weighting: Array<{ label: string; inputs: string[]; weight: number; rationale: string; contribution: number; scale?: string }>;
  /** Trace input label + source names. */
  inputLabel: string;
  sources: string[];
  notes?: string[];
  /** Per-ticker compute over the resolved bundle. */
  compute: (ticker: string, bundle: HistoricalBundle, tuning?: AnalystTuning) => PerTickerResult;
}

/**
 * Run a fn options analyst: resolve each ticker's bundle, call `compute`, then
 * emit exactly ONE trace + one completion message on the declared channels and
 * append to the thesis. Errors are surfaced on state exactly like the equity
 * fn handlers so the pipeline degrades gracefully.
 */
export async function runFnOptionsAnalyst(
  state: AgentState,
  node: NodeSurface,
  cfg: FnAnalystConfig,
  tuning?: AnalystTuning,
): Promise<AgentState> {
  let updatedState = node.updateStep(state, `${cfg.id}_start`);
  node.emitProgress(updatedState, 'analyst:start', cfg.id as any, { stage: cfg.stage });
  updatedState = node.addMessage(updatedState, 'system',
    `Starting ${cfg.name} for ${state.tickers.length} ticker(s): ${state.tickers.join(', ')}`);

  try {
    if (!Array.isArray(state.tickers) || state.tickers.length === 0) {
      throw new Error(`No tickers specified for ${cfg.name}`);
    }

    const results: Record<string, PerTickerResult> = {};
    const perTickerInputs: Array<{ ticker: string; label: string; data: Record<string, any>; sources: string[] }> = [];
    let anyMockBundle = false;
    let anyLiveBundle = false;
    for (const ticker of state.tickers) {
      const bundle = await resolveBundle(updatedState, ticker, tuning);
      const r = cfg.compute(ticker, bundle, tuning);
      results[ticker] = r;
      perTickerInputs.push({ ticker, label: cfg.inputLabel, data: r.data, sources: cfg.sources });
      if (bundle.mock === true) anyMockBundle = true; else anyLiveBundle = true;

      // Phase R3 (RAW_DATA_DUMP.md): record exactly which optionsData slices
      // this analyst received, so the per-analyst export annotation shows the
      // raw derivatives data behind its verdict. All fn options analysts read
      // the full HistoricalBundle (chain + greeks + underlying + IV history).
      const src = bundle.mock === true ? 'mock' : 'live';
      const provenance: 'live' | 'mock' | 'mixed' = src === 'mock' ? 'mock' : 'live';
      const underlying = bundle.price_bars.find((s) => s.interval === '1d') ?? bundle.price_bars[0];
      const blocks: Array<{ domain: 'option_chain' | 'greeks' | 'underlying' | 'iv_history'; interval?: string; source: string; rows?: number; barsUsed?: number }> = [];
      if (Array.isArray(bundle.option_chain) && bundle.option_chain.length > 0) {
        blocks.push({ domain: 'option_chain', source: src, rows: bundle.option_chain.length });
      }
      if (Array.isArray(bundle.greeks) && bundle.greeks.length > 0) {
        blocks.push({ domain: 'greeks', source: src, rows: bundle.greeks.length });
      }
      if (underlying && Array.isArray(underlying.bars) && underlying.bars.length > 0) {
        blocks.push({ domain: 'underlying', interval: underlying.interval, source: src, barsUsed: underlying.bars.length });
      }
      if (Array.isArray(bundle.iv_history) && bundle.iv_history.length > 0) {
        blocks.push({ domain: 'iv_history', source: src, rows: bundle.iv_history.length });
      }
      updatedState = recordDataReceived(updatedState, annotateDataReceived(
        cfg.id, ticker, 'optionsData', blocks, provenance,
        `received HistoricalBundle (${src}); chain/greeks/underlying/iv history`,
      ));
    }

    const scores = Object.values(results).map((r) => r.score);
    const avgScore = scores.length ? Math.round(scores.reduce((s, v) => s + v, 0) / scores.length) : 0;
    const first = Object.values(results)[0];
    const summary = `${cfg.name}: avg score ${avgScore}/100 across ${state.tickers.length} ticker(s)`;

    updatedState = {
      ...updatedState,
      messages: [
        ...(updatedState.messages || []),
        {
          role: 'system',
          content: `${cfg.name} completed for ${state.tickers.length} ticker(s)`,
          timestamp: new Date().toISOString(),
          data: { analyses: results, summary, channels: cfg.channels },
        },
      ],
      investment_thesis: updatedState.investment_thesis
        ? `${updatedState.investment_thesis}\n[${cfg.thesisLabel} ANALYSIS] ${summary}`
        : `[${cfg.thesisLabel} ANALYSIS] ${summary}`,
    };

    updatedState = node.captureTrace(updatedState, {
      analyst: cfg.id,
      name: cfg.name,
      stage: cfg.stage,
      instructions: cfg.instructions,
      inputs: perTickerInputs,
      weighting: cfg.weighting,
      output: {
        score: avgScore,
        verdict: first?.verdict ?? 'NEUTRAL',
        summary,
        details: { results },
      },
      // Semantic honesty: surface the bundle's live/mock provenance so a
      // deterministic mock options run is never mistaken for live Polygon data.
      // Aggregate across tickers: if every bundle was mock → seeded-parity;
      // if every bundle live → live; if mixed → mixed.
      dataProvenance: anyLiveBundle && !anyMockBundle ? 'live'
        : anyLiveBundle && anyMockBundle ? 'mixed'
        : 'seeded-parity',
      notes: cfg.notes ?? [],
    });

    node.emitProgress(updatedState, 'analyst:done', cfg.id as any, { stage: cfg.stage, tickers: state.tickers, summary });
    return updatedState;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      ...updatedState,
      error: `${cfg.name} error: ${errorMessage}`,
      current_step: `${cfg.id}_error`,
      messages: [
        ...(updatedState.messages || []),
        { role: 'error', content: `Failed to run ${cfg.name}: ${errorMessage}`, timestamp: new Date().toISOString() },
      ],
    };
  }
}

/** Front-expiry helper: return the nearest expiry present in the bundle. */
export function frontExpiry(bundle: HistoricalBundle): string | undefined {
  return [...bundle.expiries].sort()[0];
}

/** Strike nearest to spot within a given expiry (ATM). */
export function atmStrike(bundle: HistoricalBundle, expiry: string): number {
  const spot = bundle.underlying_price;
  const strikes = Array.from(new Set(bundle.greeks.filter((g) => g.expiry === expiry).map((g) => g.strike)));
  if (strikes.length === 0) return Math.round(spot);
  return strikes.reduce((best, k) => (Math.abs(k - spot) < Math.abs(best - spot) ? k : best), strikes[0]!);
}

// src/nodes/generic-analyst.node.ts
// Data-driven analyst node. A single class runs ANY analyst defined in the
// registry: given an AnalystDef it looks up the registered fn handler and
// executes it. This is how a new analyst can be added purely via JSON —
// define it in src/registry/analysts.ts (+ register its fn in logic.ts) and
// it flows through here with no new node class.
//
// The node no longer extends BaseNode: it builds its own NodeSurface via
// makeNodeSurface() (the single implementation of the progress/message/trace
// contract) and passes it to the handler. Declarative analysts run through the
// declarative engine. §4.9 multi-source acquisition is appended afterwards.
//
// NOTE: fn handlers are registered as `(state) => handler(state, surface)` in
// registry/logic.ts, so calling `handler(state)` already supplies the surface.
// Declarative analysts still need the live surface, so we pass `this`.

import { AgentState } from '../types/financial-analysis';
import type { AnalystDef, AnalysisHorizon, AnalystTuning } from '../types/registry';
import { getLogicHandler } from '../registry/logic';
import { makeNodeSurface, type NodeSurface } from '../registry/logic/shared';
import { acquireForAnalyst, aggregateDataHealth, isLiveSource, type AcquireContext, type AnalystAcquisition } from '../registry/sources';
import { declarativeHandler } from '../registry/logic/declarative';
import { analystConfigStore } from '../server/analyst-config';
import { runAnalystLLM } from '../registry/logic/llm';
import { logger } from '../utils/logger';

/** Phase F — build a compact summary of an analyst's just-computed output
 *  channel to feed the LLM as the user message. */
function summarizeAnalystOutput(state: AgentState, analystId: string): string {
  const traces = Array.isArray(state.analystTraces) ? state.analystTraces : [];
  const trace: any = traces.find((t: any) => t.analyst === analystId);
  if (!trace) return `(no output yet for ${analystId})`;
  const out = trace.output ?? {};
  return [
    `summary: ${out.summary ?? ''}`,
    out.verdict ? `verdict: ${out.verdict}` : '',
    out.score !== undefined ? `score: ${out.score}` : '',
    out.details ? `details: ${JSON.stringify(out.details)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export class GenericAnalystNode {
  /** The analyst definition this node will run. */
  public readonly def: AnalystDef;
  private readonly surface: NodeSurface;
  /** Horizon of the owning agency — forwarded to handlers as `tuning`. */
  private readonly horizon: AnalysisHorizon;
  /** Instrument of the owning agency — forwarded to handlers as `tuning` (Phase C). */
  private readonly instrument: 'EQUITY' | 'OPTION';

  constructor(def: AnalystDef, opts: { horizon: AnalysisHorizon; instrument: 'EQUITY' | 'OPTION' }) {
    this.def = def;
    this.surface = makeNodeSurface();
    this.horizon = opts.horizon;
    this.instrument = opts.instrument;
  }

  public async process(state: AgentState): Promise<AgentState> {
    // Build per-run tuning: agency horizon + instrument + resolved per-analyst params.
    // When an agency hangs a params object on its analyst refs, those are
    // merged into the resolved def (see resolveAnalystDef) and forwarded here.
    const tuning: AnalystTuning = {
      horizon: this.horizon,
      instrument: this.instrument,
      params: this.def.params ?? {},
    };

    // capturedDone is held in a mutable container (not a `let`) because TS's
    // control-flow analysis does not track assignments made inside a deferred
    // closure, which would otherwise narrow the variable to `never`.
    const captureHolder: { done: { analyst: string; payload: Record<string, any> } | null } = {
      done: null,
    };
    const surface: NodeSurface = {
      ...this.surface,
      emitProgress: (s, event, analyst, extra) => {
        if (event === 'analyst:done') {
          captureHolder.done = { analyst: String(analyst), payload: (extra as Record<string, any>) ?? {} };
          return;
        }
        this.surface.emitProgress(s, event, analyst, extra);
      },
    };

    // 1) Run the actual analysis. Declarative analysts (mode='declarative') have
    //    NO fn handler — they execute via the declarative engine. fn analysts
    //    delegate to the registered handler (which closes over the shared
    //    surface), so we call it with state + tuning.
    //
    // 1.0) §4.9 multi-source acquisition runs BEFORE the handler so its result
    //      can be passed into ingestion handlers (which consume live payloads).
    //      No-op for declarative/mock-only analysts → legacy parity preserved.
    const sources = (this.def.dataSources ?? []).filter(isLiveSource);
    const ctx = this.buildAcquireContext(state);
    const acquisition: AnalystAcquisition | null = sources.length > 0
      ? await acquireForAnalyst(this.def, ctx)
      : null;
    // Attach the resolved Finnhub key so the ingestion handler can fetch live
    // company-news for the Sentiment analyst (keeps it data-driven, not seeded).
    if (acquisition && ctx.finnhubKey) acquisition.finnhubKey = ctx.finnhubKey;
    // Attach the resolved Alpha Vantage key so the ingestion handler can fetch
    // live OVERVIEW fundamentals for the Fundamental analyst (real ratios, not
    // seeded), gated on the alphaVantage source token being configured.
    if (acquisition && ctx.alphaVantageKey) acquisition.alphaVantageKey = ctx.alphaVantageKey;

    let updated: AgentState;
    if (this.def.logic.mode === 'declarative') {
      updated = await declarativeHandler(state, surface, this.def, tuning);
    } else {
      const handler = getLogicHandler(this.def.logic.fn ?? this.def.id);
      updated = await handler(state, tuning, surface, acquisition ?? undefined);
    }

    // 1.5) Phase F — optional LLM "does the work" step. Runs ONLY when the
    //      analyst's logic.llm is enabled AND a flavor is selected (the selected
    //      flavor's instructions are in def.prompt). With NO provider key the
    //      LLM call degrades to a deterministic fallback, so output shape stays
    //      parity-safe (no behavior change when no flavor/key is configured).
    //      Long-term agency ships llm.enabled:false → never reaches here.
    const llmCfg = this.def.logic.llm;
    let llmResult: Awaited<ReturnType<typeof runAnalystLLM>> | null = null;
    if (llmCfg?.enabled && this.def.prompt) {
      logger.info(
        `LLM step ENTER ${this.def.id}: role=${this.def.modelRole ?? 'deep-thought'} ` +
          `promptLen=${String(this.def.prompt).length} hasPrompt=${Boolean(this.def.prompt)}`,
      );
      const dataSummary = summarizeAnalystOutput(updated, this.def.id);
      // §12.4 — run as the resolved model role (flavor.modelRole → agency
      // override), defaulting to deep-thought. runAnalystLLM resolves the
      // provider/baseUrl/model/token from the LlmConfigStore by role.
      llmResult = await runAnalystLLM({
        system: this.def.prompt,
        user: dataSummary,
        role: this.def.modelRole ?? 'deep-thought',
      });
      logger.info(
        `LLM step DONE ${this.def.id}: usedFallback=${llmResult.usedFallback} ` +
          `verdict=${llmResult.verdict ?? 'null'} score=${llmResult.score ?? 'null'} ` +
          `textLen=${llmResult.text.length}`,
      );

      // §10.3 — when the LLM actually ran (a token was configured and the call
      // succeeded, i.e. NOT the deterministic fallback), its verdict/score
      // REPLACES the handler's computed verdict/score so the LLM "does the
      // work." The fallback keeps the handler output untouched (parity).
      if (llmResult && !llmResult.usedFallback) {
        const traces: any[] = Array.isArray(updated.analystTraces) ? [...updated.analystTraces] : [];
        const idx = traces.findIndex((t: any) => t.analyst === this.def.id);
        if (idx >= 0) {
          const out = traces[idx].output ?? {};
          const newOut = { ...out };
          if (llmResult.verdict) newOut.verdict = llmResult.verdict;
          if (llmResult.score !== null && llmResult.score !== undefined) newOut.score = llmResult.score;
          if (llmResult.text) newOut.summary = llmResult.text;
          traces[idx] = { ...traces[idx], output: newOut };
          updated = { ...updated, analystTraces: traces };
        }
      }
    }

    // Tag this analyst's trace with the selected flavor id + optional LLM result.
    if (this.def.flavorId || llmResult) {
      const traces: any[] = Array.isArray(updated.analystTraces) ? [...updated.analystTraces] : [];
      const idx = traces.findIndex((t: any) => t.analyst === this.def.id);
      if (idx >= 0) {
        const base: any = traces[idx];
        const tagged: any = { ...base };
        if (this.def.flavorId) tagged.flavorId = this.def.flavorId;
        if (llmResult) tagged.llm = llmResult;
        traces[idx] = tagged;
        updated = { ...updated, analystTraces: traces };
      }
    }

    // 2) §4.9 multi-source acquisition result (computed in step 1.0, before the
    //    handler) is now attached to the trace + accumulated into dataHealth.
    if (acquisition) {
      // Attach source status to this analyst's trace, if one exists.
      const traces = Array.isArray(updated.analystTraces) ? [...updated.analystTraces] : [];
      const idx = traces.findIndex((t: any) => t.analyst === this.def.id);
      const existing = idx >= 0 ? traces[idx] : undefined;
      if (existing) {
        traces[idx] = {
          ...existing,
          sourceStatus: acquisition.sourceStatus,
          degraded: acquisition.degraded || acquisition.usedMockFallback,
          notes: [...(existing.notes ?? []), ...acquisition.notes],
        };
      }

      // Accumulate pipeline-wide dataHealth.
      // CRITICAL: handlers (declarative + fn) return a NEW state object that
      // does NOT copy `state.dataHealth`, so by the time we get here `updated`
      // may have dropped it. If we read prior from `updated` we'd reset the
      // running count to 0 every node, and the LAST source-less node would emit
      // dataHealth=undefined — making the "no live source" banner fire even on
      // a green run. Fall back to the INPUT state's dataHealth so the count
      // propagates across nodes regardless of handler behaviour.
      const priorHealth = updated.dataHealth ?? state.dataHealth ?? null;
      const dataHealth = aggregateDataHealth(priorHealth, acquisition, this.def.id);

      updated = {
        ...updated,
        analystTraces: traces,
        dataHealth,
      };
    } else if (state.dataHealth) {
      // No acquisition on this node, but a prior node accumulated dataHealth that
      // the handler may have dropped. Re-attach it so it still propagates to the
      // final emitted state (otherwise the last source-less node wipes it).
      updated = {
        ...updated,
        dataHealth: state.dataHealth,
      };
    }

    // 3) Emit `analyst:done` exactly once, enriched with acquisition metadata.
    const captured = captureHolder.done;
    const donePayload: Record<string, any> = captured ? { ...captured.payload } : {};
    if (acquisition) {
      donePayload.degraded = acquisition.degraded || acquisition.usedMockFallback || acquisition.hardFailed;
      donePayload.sources = {
        ok: Object.values(acquisition.sourceStatus).filter((s) => s === 'ok' || s === 'fallback').length,
        total: Object.keys(acquisition.sourceStatus).length,
      };
    }
    this.surface.emitProgress(updated, 'analyst:done', this.def.id, donePayload);

    // IMPORTANT: `analystTraces` has a *concat* reducer on the graph channel.
    // So a node must return ONLY the trace(s) it *itself* produced, NOT the
    // full accumulated array — otherwise LangGraph appends the whole array on
    // top of what's already in the channel (double-counting every step,
    // compounding across analysts). We return just this analyst's trace(s);
    // the reducer assembles the complete set in both serial and parallel modes.
    const myTraces = Array.isArray(updated.analystTraces)
      ? updated.analystTraces.filter((t: any) => t.analyst === this.def.id)
      : [];
    return { ...updated, analystTraces: myTraces };
  }

  /** Build the acquire context (token resolver + runtime config). */
  private buildAcquireContext(state: AgentState) {
    const sessionId = 'default'; // B1: single shared session for REST clients (mirrors /config).
    const g: any = typeof globalThis !== 'undefined' ? globalThis : {};
    return {
      // Inject the runtime fetch so tokenless sources (Yahoo) can be acquired
      // without a credential. Keyed sources still receive their token via
      // resolveToken below.
      fetchFn: typeof g.fetch === 'function' ? ((url: string, init: any) => g.fetch(url, init)) : undefined,
      // First ticker drives the engine's per-source URL substitution ({ticker}).
      ticker: Array.isArray(state.tickers) && state.tickers.length > 0 ? state.tickers[0] : undefined,
      runtimeConfig: state.runtimeConfig ?? null,
      resolveToken: (sourceId: string) =>
        analystConfigStore.resolveToken(
          { sessionId, analystId: this.def.id, sourceId },
          state.runtimeConfig?.accessToken,
        ),
      // Finnhub key for the live company-news sentiment feed (consumed by the
      // data_ingestion handler to populate ingested.sentiment with REAL news).
      finnhubKey: analystConfigStore.resolveToken(
        { sessionId, analystId: this.def.id, sourceId: 'finnhub' },
        state.runtimeConfig?.accessToken,
      ) as string | undefined,
      // Alpha Vantage key for the live OVERVIEW fundamental feed (consumed by
      // the data_ingestion handler to populate ingested.fundamental with REAL ratios).
      alphaVantageKey: analystConfigStore.resolveToken(
        { sessionId, analystId: this.def.id, sourceId: 'alphaVantage' },
        state.runtimeConfig?.accessToken,
      ) as string | undefined,
    };
  }
}

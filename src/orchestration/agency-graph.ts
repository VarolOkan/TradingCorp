// src/orchestration/agency-graph.ts
// Data-driven graph builder. Given an AgencyDef it resolves each analyst ref
// into a fully-merged AnalystDef and wires a GenericAnalystNode per analyst.
//
// Two wiring modes (selected per build via `parallel`):
//  * serial (default) — a strict chain entry → a0 → a1 → … → END. Mirrors the
//    legacy graph exactly, so baseline output is unchanged (parity).
//  * parallel — analysts that don't depend on one another run concurrently
//    after data ingestion (fan-out) and fan back in before the decision
//    (governance) node. Dependency edges come from `AnalystDef.dependsOn`
//    (falling back to stage semantics: stage-2 depends on ingestion, stage-3
//    depends on all stage-2). LangGraph runs independent branches at the same
//    depth simultaneously, so a 5-analyst stage runs in ~max(latency) instead
//    of ~sum(latency).
//
// All graphs produce the SAME output as the legacy FinancialAnalysisGraph for
// the long-term agency (every GenericAnalystNode delegates to the same legacy
// node instances). Parity is verified by the parity test.

import { StateGraph, Annotation, END } from '@langchain/langgraph';
import { AgentState } from '../types/financial-analysis';
import { GenericAnalystNode } from '../nodes/generic-analyst.node';
import { AgencyDef, resolveAnalystDef, AnalystDef, AnalysisHorizon } from '../types/registry';
import { ANALYST_DEFS } from '../registry/analysts';
import { isLiveSource } from '../registry/sources';
import { mergeDataReceived } from '../registry/logic/shared';
import { logger } from '../utils/logger';

// The graph state schema is identical to the legacy graph so that the same
// channels (messages, progress, analystTraces, runtimeConfig, ...) survive.
const GraphState = Annotation.Root({
  messages: Annotation<any[]>({
    reducer: (a: any[], b: any[]) => a.concat(b),
    default: () => [],
  }),
  // Pass-through scalar channels. In PARALLEL (fan-out) mode, multiple
  // analysts each return the full state, so these channels receive >1 update
  // in a single super-step. A `LastValue` (no reducer) channel rejects that
  // ("can only receive one value per step"); a `(a,b)=>b` reducer makes
  // concurrent writes safe (all write the same value). In SERIAL mode each
  // update is its own step, so the reducer is a no-op and parity holds.
  current_date: Annotation<string>({ reducer: (a: string, b: string) => b }),
  tickers: Annotation<string[]>({ reducer: (a: string[], b: string[]) => b }),
  company_name: Annotation<string>({ reducer: (a: string, b: string) => b }),
  investment_thesis: Annotation<string>({ reducer: (a: string, b: string) => b }),
  final_decision: Annotation<string>({ reducer: (a: string, b: string) => b }),
  error: Annotation<string | null>({ reducer: (a: any, b: any) => b }),
  current_step: Annotation<string>({ reducer: (a: string, b: string) => b }),
  progress: Annotation<any>({ reducer: (a: any, b: any) => b }),
  runtimeConfig: Annotation<any>({ reducer: (a: any, b: any) => b }),
  analystTraces: Annotation<any[]>({
    reducer: (a: any[], b: any[]) => a.concat(b),
    default: () => [],
  }),
  // Phase R (RAW_DATA_DUMP.md): raw-data channels so the export can recover
  // exactly what each analyst ingested/consumed. These MUST be declared here or
  // LangGraph silently drops them during state reduction (each node returns the
  // full AgentState, but only declared channels survive `invoke`).
  //   * ingested / optionsData: single-writer (data_ingestion /
  //     options_ingestion), so last-value is safe and deterministic.
  //   * dataReceived: MULTI-writer — every analyst appends its own entry, so a
  //     concatenating reducer is required; a last-value reducer would keep only
  //     the final analyst's entries and the per-analyst annotation would be lost.
  ingested: Annotation<any>({ reducer: (a: any, b: any) => b, default: () => null }),
  optionsData: Annotation<any>({ reducer: (a: any, b: any) => b, default: () => null }),
  dataReceived: Annotation<any[]>({
    // CONCATENATE across all writers (every analyst appends its own entry), but
    // DEDUPE by a stable key. Without dedup, a node that receives prior entries
    // in its state and re-appends them would double-count each analyst under
    // LangGraph's reduction (channel value + node-return are both concatenated).
    // Delegates to mergeDataReceived (shared.ts) so the logic is unit-tested.
    reducer: (a: any[], b: any[]) => mergeDataReceived(a, b),
    default: () => [],
  }),
  // §4.9 pipeline-wide data-health summary (sourcesOk/sourcesTotal/...). MUST be
  // a declared channel or LangGraph silently drops it during state reduction —
  // the ingestion node accumulates it, but the next node would receive the
  // default (null) and the emitted result's dataHealth (hence the "no live
  // source" banner) would be wrong. Single-writer-per-step: data_ingestion is
  // stage-1 (runs BEFORE the stage-2 fan-out) and governance fans IN after, so
  // no two nodes write it in the same super-step → last-value reducer is safe
  // even in parallel mode (canRunParallel already disables parallel when any
  // stage-2 analyst has live sources).
  dataHealth: Annotation<any>({ reducer: (a: any, b: any) => b, default: () => null }),
});

export class AgencyGraph {
  private workflow: any; // CompiledGraph instance
  public readonly agencyId: string;
  public readonly nodeOrder: string[]; // resolved analyst ids, in pipeline order
  public readonly parallel: boolean;

  constructor(agency: AgencyDef, opts: { parallel?: boolean } = {}) {
    this.agencyId = agency.id;
    this.workflow = new StateGraph(GraphState);

    const horizon: AnalysisHorizon = agency.horizon;
    const instrument = agency.instrument ?? 'EQUITY';
    const resolved: AnalystDef[] = agency.analysts.map((ref) =>
      resolveAnalystDef(ref, ANALYST_DEFS),
    );
    this.nodeOrder = resolved.map((d) => d.id);

    // Parallel is only applied when explicitly requested AND safe (no live
    // sources on concurrent analysts — see canRunParallel). Record the actual
    // decision so callers/tests can assert which wiring was used.
    this.parallel = opts.parallel === true && this.canRunParallel(resolved);

    // A LangGraph node NAME must be a valid identifier; we use the analyst id.
    for (const def of resolved) {
      const node = new GenericAnalystNode(def, { horizon, instrument });
      this.workflow.addNode(def.id, node.process.bind(node));
    }

    if (this.parallel) {
      this.wireParallel(resolved);
    } else {
      this.wireSerial(resolved);
    }

    this.workflow = this.workflow.compile();
  }

  /**
   * Parallel (fan-out/fan-in) is only safe when no concurrently-running analyst
   * writes a mutable, non-reducer shared channel. The only channel that is
   * mutated (not replaced) by a node is `dataHealth` — touched by analysts with
   * LIVE dataSources (multi-source acquisition). Stage-2 analysts fan OUT and
   * run concurrently, so a live source on any of them forces a serial fallback
   * so the dataHealth aggregation can't race. Stage-1 (ingestion) runs BEFORE
   * the fan-out and stage-3 (governance) fans IN after it, so their live
   * sources never race the concurrent set and don't block parallel. Shipped
   * long-term analysts use derived (`from: 'data_ingestion'`) stage-2 sources,
   * so parallel is used.
   */
  private canRunParallel(resolved: AnalystDef[]): boolean {
    const stage2 = resolved.filter((d) => (d.stage ?? 2) === 2);
    if (stage2.some((d) => (d.dataSources ?? []).some(isLiveSource))) return false;
    // Even with no live sources, parallel is only safe when every node has a
    // single uniform-depth fan-in. LangGraph's Pregel scheduler re-executes a
    // node whose predecessors complete in different super-steps (mixed-depth
    // fan-in), duplicating its traces. Reject such topologies and fall back to
    // serial so parity holds.
    return this.parallelTopologySafe(resolved);
  }

  /**
   * Derive the directed edges the parallel wiring would create, using the same
   * rules as wireParallel. Returns [from, to] pairs (excluding the final
   * END edge). Shared so canRunParallel and wireParallel never diverge.
   */
  private buildEdges(resolved: AnalystDef[]): Array<[string, string]> {
    const ids = resolved.map((d) => d.id);
    const stage1 = resolved.filter((d) => (d.stage ?? 1) === 1);
    const stage2 = resolved.filter((d) => (d.stage ?? 2) === 2);
    const stage3 = resolved.filter((d) => (d.stage ?? 3) === 3);
    const lastStage1 = stage1.length > 0 ? stage1[stage1.length - 1]!.id : resolved[0]!.id;
    const stage2Leaves = stage2.filter(
      (d) => !stage2.some((other) => (other.dependsOn ?? []).includes(d.id)),
    );
    const edges: Array<[string, string]> = [];
    for (const def of resolved) {
      const id = def.id;
      const explicit = (def.dependsOn ?? []).filter((d) => ids.includes(d));
      if (explicit.length > 0) {
        for (const f of explicit) edges.push([f, id]);
        continue;
      }
      const stage = def.stage ?? 2;
      if (stage === 1) {
        // Chain stage-1 nodes in array order. The first stage-1 node is the
        // entry point, so it gets no incoming edge; later ones link from the
        // previous stage-1 node. (Avoid a self-loop on the entry point.)
        const prev = stage1.slice(0, stage1.indexOf(def)).pop();
        if (prev) edges.push([prev.id, id]);
      } else if (stage === 2) {
        edges.push([lastStage1, id]);
      } else {
        for (const d of stage2Leaves) edges.push([d.id, id]);
      }
    }
    return edges;
  }

  /**
   * True iff no node would receive a mixed-depth fan-in under the parallel
   * wiring. Compute longest-path depth from the entry point; a node with >=2
   * predecessors at DIFFERENT depths re-executes in Pregel. The long-term
   * agency (uniform-depth leaf fan-in) passes; deep DAGs like the options
   * agencies fail and fall back to serial.
   */
  private parallelTopologySafe(resolved: AnalystDef[]): boolean {
    const ids = resolved.map((d) => d.id);
    const entry = resolved[0]!.id;
    const edges = this.buildEdges(resolved).filter(([, t]) => t !== END);
    const incoming = new Map<string, string[]>();
    const adj = new Map<string, string[]>();
    for (const [f, t] of edges) {
      incoming.set(t, [...(incoming.get(t) ?? []), f]);
      adj.set(f, [...(adj.get(f) ?? []), t]);
    }
    // Kahn topological order, then single longest-path depth pass (O(V+E)).
    const indeg = new Map<string, number>(ids.map((id) => [id, 0]));
    for (const [, t] of edges) indeg.set(t, (indeg.get(t) ?? 0) + 1);
    const queue = ids.filter((id) => (indeg.get(id) ?? 0) === 0);
    const order: string[] = [];
    const q = [...queue];
    while (q.length) {
      const n = q.shift()!;
      order.push(n);
      for (const m of adj.get(n) ?? []) {
        indeg.set(m, (indeg.get(m) ?? 0) - 1);
        if ((indeg.get(m) ?? 0) === 0) q.push(m);
      }
    }
    // Cycle (or disconnected node) → not safe to parallelize.
    if (order.length < ids.length) return false;
    const depth = new Map<string, number>([[entry, 0]]);
    for (const n of order) {
      const preds = incoming.get(n) ?? [];
      if (preds.length === 0) continue;
      depth.set(n, Math.max(...preds.map((p) => (depth.get(p) ?? 0) + 1)));
    }
    for (const id of ids) {
      const preds = incoming.get(id) ?? [];
      if (preds.length < 2) continue;
      const ds = new Set(preds.map((p) => depth.get(p) ?? -1));
      if (ds.size > 1) return false;
    }
    return true;
  }

  /** Strict serial chain — legacy parity path. */
  private wireSerial(resolved: AnalystDef[]): void {
    this.workflow.setEntryPoint(resolved[0]!.id);
    for (let i = 1; i < resolved.length; i++) {
      this.workflow.addEdge(resolved[i - 1]!.id, resolved[i]!.id);
    }
    this.workflow.addEdge(resolved[resolved.length - 1]!.id, END);
  }

  /**
   * Dependency-aware wiring. Edges are derived from `dependsOn` when present,
   * otherwise from stage semantics:
   *   stage 1 (intake) → chained in array order, starting from the entry point
   *   stage 2 (analysis) → fan out from the LAST stage-1 node (ingestion)
   *   stage 3 (decision) → fan in from ALL stage-2 analysts
   * Independent stage-2 analysts share a single predecessor, so LangGraph
   * executes them concurrently.
   */
  private wireParallel(resolved: AnalystDef[]): void {
    this.workflow.setEntryPoint(resolved[0]!.id);
    for (const [f, t] of this.buildEdges(resolved)) {
      if (t === END) continue;
      this.workflow.addEdge(f, t);
    }
    // Final node → END. Prefer the last stage-3 (decision); else the last node.
    const stage3 = resolved.filter((d) => (d.stage ?? 3) === 3);
    const endNode = stage3.length > 0 ? stage3[stage3.length - 1]!.id : resolved[resolved.length - 1]!.id;
    this.workflow.addEdge(endNode, END);
  }

  async execute(initialState: AgentState): Promise<AgentState> {
    try {
      return await this.workflow.invoke(initialState);
    } catch (error) {
      logger.error(`[${this.agencyId}] workflow execution failed:`, error);
      return {
        ...initialState,
        error: error instanceof Error ? error.message : String(error),
        current_step: 'workflow_error',
        final_decision: 'ERROR: Workflow execution failed',
      };
    }
  }
}

export default AgencyGraph;

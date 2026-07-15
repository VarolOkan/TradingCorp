// src/orchestration/financial-graph.ts
// Backwards-compatible entry point. The hardcoded legacy graph has been
// retired; the single runtime graph is now the data-driven AgencyGraph built
// from the registry. The `long-term` agency is the 1:1 successor of the old
// hardcoded pipeline, so this wrapper returns an AgencyGraph for it.
//
// All analyst behaviour lives in registry/logic/*.ts handlers; the graph is
// purely the wiring (order + edges) derived from the agency definition.

import { AgencyGraph } from './agency-graph';
import { AGENCIES } from '../registry/agencies';
import { AgentState } from '../types/financial-analysis';

export interface AnalysisGraph {
  execute(initialState: AgentState): Promise<AgentState>;
}

/** Build the legacy-equivalent graph (the `long-term` agency). */
export function buildLegacyGraph(): AnalysisGraph {
  return new AgencyGraph(AGENCIES['long-term']!);
}

/**
 * @deprecated Use buildLegacyGraph() / AgencyGraph directly. Kept as a thin
 * alias so any outstanding references resolve to the registry-driven graph.
 */
export class FinancialAnalysisGraph {
  private graph: AnalysisGraph;
  constructor() {
    this.graph = buildLegacyGraph();
  }
  async execute(initialState: AgentState): Promise<AgentState> {
    return this.graph.execute(initialState);
  }
  getWorkflowDiagram(): string {
    return 'graph TD\n  A[Orchestrator] --> B[Data Ingestion] --> C[Fundamental] --> D[Technical] --> E[Sentiment] --> F[Risk] --> G[Governance] --> H[END]';
  }
}

export default FinancialAnalysisGraph;

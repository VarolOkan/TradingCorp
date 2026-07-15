// frontend/src/visualizations/types.ts
// Shared data model for graph-style visualizations. A RelationGraphModel is a
// generic nodes + edges structure the D3 RelationsGraph can render. The
// AnalysisResult relations (per-ticker decisions, risk linkages) are mapped
// into this shape by the React wrapper.

export interface GraphNode {
  id: string;
  label: string;
  group?: string;
  /** Optional numeric weight used for node radius. */
  weight?: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  /** Optional label, e.g. "risky", "correlated". */
  label?: string;
}

export interface RelationGraphModel {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export type VisualizationType = 'relations';

export interface VisualizationOptions {
  width?: number;
  height?: number;
  /** Background color for the SVG. */
  background?: string;
}

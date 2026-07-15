// frontend/src/visualizations/registry.ts
// Registry mapping a VisualizationType name to its implementation class. Lets
// the app instantiate a visualization by string without importing concrete
// classes everywhere, and makes it easy to add more (e.g. 'timeline') later.

import { Visualization } from './Visualization';
import { RelationsGraph } from './RelationsGraph';
import type { RelationGraphModel, VisualizationOptions, VisualizationType } from './types';

type Ctor = new (
  container: HTMLElement,
  options?: VisualizationOptions
) => Visualization<unknown>;

const registry: Record<VisualizationType, Ctor> = {
  relations: RelationsGraph as unknown as Ctor,
};

export function registerVisualization(type: VisualizationType, ctor: Ctor): void {
  registry[type] = ctor;
}

export function createVisualization(
  type: VisualizationType,
  container: HTMLElement,
  options?: VisualizationOptions
): Visualization<unknown> {
  const Ctor = registry[type];
  if (!Ctor) {
    throw new Error(`Unknown visualization type: ${type}`);
  }
  return new Ctor(container, options);
}

export function getVisualizationTypes(): VisualizationType[] {
  return Object.keys(registry) as VisualizationType[];
}

/** Convenience helper: build a RelationsGraph model from an analysis result. */
export function relationsFromResult(result: {
  tickers?: string[];
  risk_assessment?: Record<string, unknown> | null;
  decisions?: Record<string, unknown>;
}): RelationGraphModel {
  const nodes: RelationGraphModel['nodes'] = [];
  const edges: RelationGraphModel['edges'] = [];

  (result.tickers ?? []).forEach((t) => {
    nodes.push({ id: `t:${t}`, label: t, group: 'ticker', weight: 2 });
    edges.push({ source: 'governance', target: `t:${t}`, label: 'decides' });
  });

  const riskKeys = Object.keys(result.risk_assessment ?? {});
  riskKeys.forEach((k) => {
    const id = `r:${k}`;
    nodes.push({ id, label: k, group: 'risk', weight: 1 });
    edges.push({ source: 'governance', target: id, label: 'assesses' });
  });

  // Central governance node (added last so it sits on the radial layout center
  // only if positions are empty; here it's just another node).
  nodes.push({ id: 'governance', label: 'Governance', group: 'governance', weight: 3 });

  return { nodes, edges };
}

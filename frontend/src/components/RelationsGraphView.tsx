// frontend/src/components/RelationsGraphView.tsx
import { useEffect, useRef } from 'react';
import { createVisualization, relationsFromResult } from '../visualizations/registry';
import type { AnalysisResult } from '../types';

export interface RelationsGraphViewProps {
  result: AnalysisResult | null;
  width?: number;
  height?: number;
}

export function RelationsGraphView({ result, width, height }: RelationsGraphViewProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    if (!result) {
      host.innerHTML = '';
      return;
    }

    const model = relationsFromResult(result);
    if (model.nodes.length === 0) {
      host.innerHTML = '';
      return;
    }

    const viz = createVisualization('relations', host, { width, height });
    viz.mount();
    viz.update(model);

    return () => viz.destroy();
  }, [result, width, height]);

  if (!result) return null;

  return (
    <div className="relations-graph-view">
      <h3>Relations</h3>
      <div ref={hostRef} className="relations-graph-host" aria-label="Relations graph" />
    </div>
  );
}

export default RelationsGraphView;

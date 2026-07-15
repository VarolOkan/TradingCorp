// frontend/src/visualizations/RelationsGraph.ts
// D3-based relations visualization. Renders a node + edge graph (the "relations"
// view of an analysis: tickers, risk nodes, governance node, and the linkages
// between them). This is a Phase 4 stub: it draws nodes/edges from a
// RelationGraphModel and applies a static radial-ish layout. A full
// force-directed simulation can be layered in later without changing the
// public mount/update/destroy contract.

import * as d3 from 'd3';
import { Visualization } from './Visualization';
import type { RelationGraphModel, VisualizationOptions } from './types';

export class RelationsGraph extends Visualization<RelationGraphModel> {
  private svg: d3.Selection<SVGSVGElement, unknown, null, undefined> | null = null;
  private current: RelationGraphModel | null = null;
  /** Layout positions keyed by node id, for stable re-renders. */
  private positions = new Map<string, { x: number; y: number }>();

  mount(): void {
    if (this.disposed) return;
    const width = this.options.width ?? 600;
    const height = this.options.height ?? 360;
    const background = this.options.background ?? '#0b1220';
    this.container.innerHTML = '';
    this.svg = d3
      .select(this.container)
      .append('svg')
      .attr('class', 'relations-graph')
      .attr('width', width)
      .attr('height', height)
      .attr('viewBox', `0 0 ${width} ${height}`)
      .style('background', background);
    this.svg.append('g').attr('class', 'edges');
    this.svg.append('g').attr('class', 'nodes');
  }

  update(data: RelationGraphModel): void {
    if (this.disposed || !this.svg) return;
    this.current = data;
    this.layout(data);
    this.renderEdges(data);
    this.renderNodes(data);
  }

  /** Compute stable radial positions for nodes (stub for a real simulation). */
  private layout(data: RelationGraphModel): void {
    const { width = 600, height = 360 } = this.options;
    const cx = width / 2;
    const cy = height / 2;
    const r = Math.min(width, height) / 2 - 40;
    const n = data.nodes.length || 1;
    data.nodes.forEach((node, i) => {
      if (!this.positions.has(node.id)) {
        const angle = (i / n) * 2 * Math.PI;
        this.positions.set(node.id, {
          x: cx + r * Math.cos(angle),
          y: cy + r * Math.sin(angle),
        });
      }
    });
  }

  private renderEdges(data: RelationGraphModel): void {
    const edges = this.svg!.select('.edges');
    const sel = edges
      .selectAll<SVGLineElement, (typeof data.edges)[number]>('line')
      .data(data.edges, (d) => `${d.source}->${d.target}`);
    sel.exit().remove();
    sel
      .enter()
      .append('line')
      .merge(sel)
      .attr('x1', (d) => this.positions.get(d.source)?.x ?? 0)
      .attr('y1', (d) => this.positions.get(d.source)?.y ?? 0)
      .attr('x2', (d) => this.positions.get(d.target)?.x ?? 0)
      .attr('y2', (d) => this.positions.get(d.target)?.y ?? 0)
      .attr('stroke', '#475569')
      .attr('stroke-width', 1.5);
  }

  private renderNodes(data: RelationGraphModel): void {
    const nodes = this.svg!.select('.nodes');
    const sel = nodes
      .selectAll<SVGGElement, (typeof data.nodes)[number]>('g.node')
      .data(data.nodes, (d) => d.id);
    sel.exit().remove();

    const enter = sel.enter().append('g').attr('class', 'node');
    enter.append('circle');
    enter.append('text');

    const merged = enter.merge(sel);
    merged
      .attr('transform', (d) => {
        const p = this.positions.get(d.id) ?? { x: 0, y: 0 };
        return `translate(${p.x},${p.y})`;
      });
    merged
      .select('circle')
      .attr('r', (d) => 6 + (d.weight ?? 1) * 3)
      .attr('fill', (d) => this.colorFor(d.group));
    merged
      .select('text')
      .attr('dx', 10)
      .attr('dy', 4)
      .attr('fill', '#e2e8f0')
      .attr('font-size', 11)
      .text((d) => d.label);
  }

  private colorFor(group?: string): string {
    switch (group) {
      case 'ticker':
        return '#3b82f6';
      case 'risk':
        return '#ef4444';
      case 'governance':
        return '#f59e0b';
      default:
        return '#94a3b8';
    }
  }

  getCurrent(): RelationGraphModel | null {
    return this.current;
  }

  destroy(): void {
    super.destroy();
    this.svg = null;
    this.positions.clear();
  }
}

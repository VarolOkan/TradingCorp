// frontend/src/test/RelationsGraph.test.ts
import { RelationsGraph } from '../visualizations/RelationsGraph';
import type { RelationGraphModel } from '../visualizations/types';

function model(): RelationGraphModel {
  return {
    nodes: [
      { id: 'governance', label: 'Governance', group: 'governance', weight: 3 },
      { id: 't:AAPL', label: 'AAPL', group: 'ticker', weight: 2 },
      { id: 'r:overall', label: 'overall', group: 'risk', weight: 1 },
    ],
    edges: [
      { source: 'governance', target: 't:AAPL', label: 'decides' },
      { source: 'governance', target: 'r:overall', label: 'assesses' },
    ],
  };
}

describe('RelationsGraph (D3)', () => {
  it('mounts an svg into the container', () => {
    const el = document.createElement('div');
    const g = new RelationsGraph(el, { width: 400, height: 300 });
    g.mount();
    const svg = el.querySelector('svg.relations-graph');
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute('width')).toBe('400');
    expect(svg!.getAttribute('height')).toBe('300');
  });

  it('renders node and edge elements', () => {
    const el = document.createElement('div');
    const g = new RelationsGraph(el);
    g.mount();
    g.update(model());
    expect(g.getCurrent()?.nodes.length).toBe(3);
    expect(el.querySelectorAll('g.node').length).toBe(3);
    expect(el.querySelectorAll('line').length).toBe(2);
    // node groups have a circle + text
    expect(el.querySelectorAll('g.node circle').length).toBe(3);
    expect(el.querySelectorAll('g.node text').length).toBe(3);
  });

  it('applies group color to circles', () => {
    const el = document.createElement('div');
    const g = new RelationsGraph(el);
    g.mount();
    g.update(model());
    const fills = Array.from(el.querySelectorAll('g.node circle')).map((c) =>
      c.getAttribute('fill')
    );
    expect(fills).toContain('#3b82f6'); // ticker
    expect(fills).toContain('#ef4444'); // risk
    expect(fills).toContain('#f59e0b'); // governance
  });

  it('does nothing when disposed', () => {
    const el = document.createElement('div');
    const g = new RelationsGraph(el);
    g.destroy();
    g.mount();
    g.update(model());
    expect(el.querySelector('svg')).toBeNull();
    expect(g.getCurrent()).toBeNull();
  });

  it('removes stale nodes on update (data join exit)', () => {
    const el = document.createElement('div');
    const g = new RelationsGraph(el);
    g.mount();
    g.update(model());
    expect(el.querySelectorAll('g.node').length).toBe(3);
    g.update({ nodes: [{ id: 'governance', label: 'G', group: 'governance' }], edges: [] });
    expect(el.querySelectorAll('g.node').length).toBe(1);
  });
});

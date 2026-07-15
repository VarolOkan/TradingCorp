// frontend/src/test/registry.test.ts
import {
  createVisualization,
  registerVisualization,
  getVisualizationTypes,
  relationsFromResult,
} from '../visualizations/registry';
import { Visualization } from '../visualizations/Visualization';
import type { VisualizationType } from '../visualizations/types';

class FakeViz extends Visualization<unknown> {
  mount() {}
  update(_d: unknown) {}
}

describe('visualization registry', () => {
  it('lists the registered types', () => {
    expect(getVisualizationTypes()).toContain('relations');
  });

  it('creates a RelationsGraph instance by type', () => {
    const el = document.createElement('div');
    const viz = createVisualization('relations', el, { width: 300, height: 200 });
    expect(viz.getOptions().width).toBe(300);
    viz.mount();
    expect(el.querySelector('svg.relations-graph')).not.toBeNull();
    viz.destroy();
  });

  it('throws on unknown type', () => {
    const el = document.createElement('div');
    expect(() => createVisualization('nope' as VisualizationType, el)).toThrow(
      /Unknown visualization type/
    );
  });

  it('supports registering a custom type', () => {
    registerVisualization('custom' as VisualizationType, FakeViz as any);
    expect(getVisualizationTypes()).toContain('custom');
    const el = document.createElement('div');
    const viz = createVisualization('custom' as VisualizationType, el);
    expect(viz).toBeInstanceOf(FakeViz);
    viz.destroy();
  });
});

describe('relationsFromResult', () => {
  it('builds nodes for tickers, risk, and governance with edges', () => {
    const m = relationsFromResult({
      tickers: ['AAPL', 'MSFT'],
      risk_assessment: { overall: 'MODERATE', downside: '15%' },
      decisions: {},
    });
    const ids = m.nodes.map((n) => n.id);
    expect(ids).toContain('t:AAPL');
    expect(ids).toContain('t:MSFT');
    expect(ids).toContain('r:overall');
    expect(ids).toContain('r:downside');
    expect(ids).toContain('governance');
    expect(m.edges.length).toBe(4); // 2 tickers + 2 risk
    expect(m.edges.every((e) => e.source === 'governance')).toBe(true);
  });

  it('handles empty result gracefully (still shows governance hub)', () => {
    const m = relationsFromResult({});
    expect(m.nodes.length).toBe(1);
    expect(m.nodes[0].id).toBe('governance');
    expect(m.edges.length).toBe(0);
  });
});

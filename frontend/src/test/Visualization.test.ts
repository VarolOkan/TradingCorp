// frontend/src/test/Visualization.test.ts
import { Visualization } from '../visualizations/Visualization';

class StubViz extends Visualization<{ n: number }> {
  mounted = false;
  lastData: { n: number } | null = null;
  mount() {
    this.mounted = true;
  }
  update(data: { n: number }) {
    this.lastData = data;
  }
}

describe('Visualization base', () => {
  it('defaults width/height/background from container', () => {
    const el = document.createElement('div');
    Object.defineProperty(el, 'clientWidth', { value: 800 });
    const v = new StubViz(el);
    expect(v.getOptions().width).toBe(800);
    expect(v.getOptions().height).toBe(360);
    expect(v.getOptions().background).toBe('#0b1220');
  });

  it('honors explicit options', () => {
    const el = document.createElement('div');
    const v = new StubViz(el, { width: 1200, height: 700, background: '#111' });
    expect(v.getOptions()).toEqual({ width: 1200, height: 700, background: '#111' });
  });

  it('mount + update + destroy lifecycle', () => {
    const el = document.createElement('div');
    const v = new StubViz(el);
    v.mount();
    expect(v.mounted).toBe(true);
    v.update({ n: 5 });
    expect(v.lastData).toEqual({ n: 5 });
    expect(v.isDisposed()).toBe(false);
    v.destroy();
    expect(v.isDisposed()).toBe(true);
  });

  it('destroy is idempotent and clears container', () => {
    const el = document.createElement('div');
    el.innerHTML = '<span>x</span>';
    const v = new StubViz(el);
    v.destroy();
    v.destroy();
    expect(v.isDisposed()).toBe(true);
    expect(el.innerHTML).toBe('');
  });
});

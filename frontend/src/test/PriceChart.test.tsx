// Item 3 (analysis-grade chart): overlays, S/R annotations, RSI pane, studies.
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import PriceChart from '../components/PriceChart';

function makeBars(n: number, start = 100) {
  const bars = [];
  const t0 = Date.UTC(2026, 0, 1);
  for (let i = 0; i < n; i++) {
    const c = start + i; // strictly rising → clean SMA/EMA trends
    bars.push({
      t: new Date(t0 + i * 3600_000).toISOString(),
      open: c - 1,
      high: c + 2,
      low: c - 2,
      close: c,
      volume: 1000 + i,
    });
  }
  return bars;
}

describe('PriceChart analysis-grade overlays', () => {
  it('renders SMA + Bollinger overlays by default (studies sma+bb on)', () => {
    render(<PriceChart bars={makeBars(120)} />);
    expect(screen.getByTestId('indicator-sma20')).toBeTruthy();
    expect(screen.getByTestId('indicator-sma50')).toBeTruthy();
    expect(screen.getByTestId('indicator-sma200')).toBeTruthy();
    expect(screen.getByTestId('indicator-bbu')).toBeTruthy();
    expect(screen.getByTestId('indicator-bbl')).toBeTruthy();
    // EMA/VWAP/RSI off by default
    expect(screen.queryByTestId('indicator-ema12')).toBeNull();
    expect(screen.queryByTestId('indicator-vwap')).toBeNull();
    expect(screen.queryByTestId('indicator-rsi')).toBeNull();
    expect(screen.queryByTestId('rsi-pane')).toBeNull();
  });

  it('renders EMA + VWAP + RSI when those studies are enabled', () => {
    render(<PriceChart bars={makeBars(120)} studies={{ ema: true, vwap: true, rsi: true }} />);
    expect(screen.getByTestId('indicator-ema12')).toBeTruthy();
    expect(screen.getByTestId('indicator-ema26')).toBeTruthy();
    expect(screen.getByTestId('indicator-vwap')).toBeTruthy();
    expect(screen.getByTestId('indicator-rsi')).toBeTruthy();
    expect(screen.getByTestId('rsi-pane')).toBeTruthy();
  });

  it('draws support + resistance annotation lines from the prop', () => {
    render(
      <PriceChart
        bars={makeBars(120)}
        supportResistance={{ support_levels: [40, 60], resistance_levels: [200, 220] }}
      />,
    );
    expect(screen.getAllByTestId('sr-support').length).toBe(2);
    expect(screen.getAllByTestId('sr-resistance').length).toBe(2);
    expect(screen.getByText(/S 40/)).toBeTruthy();
    expect(screen.getByText(/R 220/)).toBeTruthy();
  });

  it('skips S/R annotations when supportResistance is null', () => {
    render(<PriceChart bars={makeBars(50)} supportResistance={null} />);
    expect(screen.queryByTestId('sr-support')).toBeNull();
    expect(screen.queryByTestId('sr-resistance')).toBeNull();
  });

  it('keeps wheel-zoom working with overlays present', () => {
    render(<PriceChart bars={makeBars(120)} />);
    const svg = screen.getByTestId('price-chart');
    // Default view opens at ~70% (84 bars). Zoom in → window shrinks.
    const before = /(\d+)–(\d+) of 120 bars/.exec(screen.getByTestId('chart-legend').textContent ?? '')!;
    const beforeLen = Number(before[2]) - (Number(before[1]) - 1);
    expect(beforeLen).toBeLessThan(120);
    fireEvent.wheel(svg, { deltaY: -100 });
    const legend = screen.getByTestId('chart-legend');
    const m = /(\d+)–(\d+) of 120 bars/.exec(legend.textContent ?? '');
    expect(m).toBeTruthy();
    // Zoomed-in window is strictly smaller than the default window.
    expect(Number(m![2]) - (Number(m![1]) - 1)).toBeLessThan(beforeLen);
  });

  it('opens zoomed ~30% in (recent ~70%) by default, not full history', () => {
    render(<PriceChart bars={makeBars(200)} />);
    const legend = screen.getByTestId('chart-legend');
    const m = /(\d+)–(\d+) of 200 bars/.exec(legend.textContent ?? '');
    expect(m).toBeTruthy();
    // Default window starts ~30% in, so vs > 0 and we are not showing all 200.
    expect(Number(m![1]) - 1).toBeGreaterThan(0);
    expect(Number(m![2])).toBe(200);
  });

  it('computes SMA200 across the FULL series, so it is visible in the default window', () => {
    // 250 bars: enough for SMA200 to warm up (index 199), and the default
    // window (last 70% ≈ indices 75..249) includes the warmed-up region.
    render(<PriceChart bars={makeBars(250)} showTime={false} />);
    const path = screen.getByTestId('indicator-sma200') as unknown as SVGPolylineElement;
    const d = path.getAttribute('d') ?? '';
    // A continuous SMA200 line means it has warmed up and is being drawn
    // (multiple vertices), i.e. it no longer only appears at the far right.
    expect(d.includes('L')).toBe(true);
    // Spot-check: at least one numeric coordinate is present in the path.
    expect(/\d/.test(d)).toBe(true);
  });

  it('renders a TradingView-style date axis at the bottom', () => {
    render(<PriceChart bars={makeBars(120)} showTime={false} />);
    const axis = screen.getByTestId('chart-xaxis');
    const labels = axis.querySelectorAll('text.chart-axis-x');
    expect(labels.length).toBeGreaterThanOrEqual(2);
    // Daily view → labels are ISO dates (YYYY-MM-DD), no time component.
    expect(labels[0]!.textContent).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('shows date+time on the axis for intraday intervals', () => {
    // makeBars uses hourly timestamps (i*3600_000) → intraday shape.
    render(<PriceChart bars={makeBars(120)} showTime />);
    const axis = screen.getByTestId('chart-xaxis');
    const labels = axis.querySelectorAll('text.chart-axis-x');
    expect(labels[0]!.textContent).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it('pans left/right via drag and clamps to the first and last bar', () => {
    render(<PriceChart bars={makeBars(120)} />);
    const svg = screen.getByTestId('price-chart');
    const legend = () => screen.getByTestId('chart-legend');
    const win = () => {
      const txt = legend().textContent ?? '';
      const mm = /(\d+)–(\d+) of 120 bars/.exec(txt);
      expect(mm).toBeTruthy();
      return { vs: Number(mm![1]) - 1, ve: Number(mm![2]) };
    };

    // Pan only makes sense when the window is smaller than the full dataset, so
    // zoom in first (wheel deltaY < 0 shrinks the window around its center).
    fireEvent.wheel(svg, { deltaY: -100 });
    const z = win();
    expect(z.ve - z.vs).toBeLessThan(120); // zoomed in → pannable

    // Drag RIGHT (+clientX) → the window slides toward the FIRST bar.
    fireEvent.pointerDown(svg, { clientX: 400, pointerId: 1 });
    fireEvent.pointerMove(svg, { clientX: 600, pointerId: 1 });
    fireEvent.pointerUp(svg, { pointerId: 1 });
    const afterRight = win();
    expect(afterRight.vs).toBeLessThan(z.vs); // moved earlier in time
    expect(afterRight.ve).toBeLessThanOrEqual(z.ve);

    // Far RIGHT drag → clamps to the very FIRST bar (vs === 0).
    fireEvent.pointerDown(svg, { clientX: 0, pointerId: 1 });
    fireEvent.pointerMove(svg, { clientX: 5000, pointerId: 1 });
    fireEvent.pointerUp(svg, { pointerId: 1 });
    expect(win().vs).toBe(0);

    // Far LEFT drag → clamps to the very LAST bar (ve === 120).
    fireEvent.pointerDown(svg, { clientX: 0, pointerId: 1 });
    fireEvent.pointerMove(svg, { clientX: -5000, pointerId: 1 });
    fireEvent.pointerUp(svg, { pointerId: 1 });
    expect(win().ve).toBe(120);

    // data-dragging flag toggles during a drag.
    fireEvent.pointerDown(svg, { clientX: 0, pointerId: 1 });
    expect(svg.getAttribute('data-dragging')).toBe('on');
    fireEvent.pointerUp(svg, { pointerId: 1 });
    expect(svg.getAttribute('data-dragging')).toBe('off');
  });

  it('pinch-zooms in (fingers apart) and out (fingers together) on touch', () => {
    render(<PriceChart bars={makeBars(120)} />);
    const svg = screen.getByTestId('price-chart');
    const legend = () => screen.getByTestId('chart-legend');
    const winLen = () => {
      const txt = legend().textContent ?? '';
      const mm = /(\d+)–(\d+) of 120 bars/.exec(txt);
      if (mm) return Number(mm[2]) - (Number(mm[1]) - 1);
      // Zoomed all the way out → legend shows the plain "120 bars" form.
      const full = /120 bars/.exec(txt);
      expect(full).toBeTruthy();
      return 120;
    };
    const initial = winLen();
    expect(initial).toBeLessThan(120); // default view is zoomed ~30% in

    // Two fingers down 100px apart, then spread to 350px apart → zoom IN.
    fireEvent.pointerDown(svg, { clientX: 100, clientY: 50, pointerId: 1 });
    fireEvent.pointerDown(svg, { clientX: 200, clientY: 50, pointerId: 2 });
    fireEvent.pointerMove(svg, { clientX: 50, clientY: 50, pointerId: 1 });
    fireEvent.pointerMove(svg, { clientX: 400, clientY: 50, pointerId: 2 });
    const zoomedIn = winLen();
    expect(zoomedIn).toBeLessThan(initial); // window shrank → zoomed in further
    fireEvent.pointerUp(svg, { pointerId: 1 });
    fireEvent.pointerUp(svg, { pointerId: 2 });

    // Fresh pinch: fingers far apart then brought together → zoom OUT.
    fireEvent.pointerDown(svg, { clientX: 20, clientY: 50, pointerId: 3 });
    fireEvent.pointerDown(svg, { clientX: 480, clientY: 50, pointerId: 4 });
    fireEvent.pointerMove(svg, { clientX: 220, clientY: 50, pointerId: 3 });
    fireEvent.pointerMove(svg, { clientX: 260, clientY: 50, pointerId: 4 });
    expect(winLen()).toBeGreaterThan(zoomedIn); // window grew → zoomed out
    fireEvent.pointerUp(svg, { pointerId: 3 });
    fireEvent.pointerUp(svg, { pointerId: 4 });
  });
});

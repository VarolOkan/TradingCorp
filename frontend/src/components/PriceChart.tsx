// frontend/src/components/PriceChart.tsx
// Phase M / item 3 (analysis-grade chart): D3 candlestick + volume chart with a
// TradingView-style crosshair + hover tooltip, PLUS analysis-grade overlays:
//   - Moving averages (SMA 20/50/200, EMA 12/26) + Bollinger Bands + VWAP drawn
//     as lines on the price pane (computed client-side from the bars).
//   - An RSI(14) oscillator sub-pane (0..100) below the volume pane.
//   - Dashed support / resistance annotation lines from the technical analyst's
//     verdict (passed via `supportResistance`), labelled on the right axis.
//
// Design notes:
// - Pure D3 for scales + path generation; React owns the <svg> + lifecycle.
// - All overlays are recomputed from the *visible* slice so they zoom with the
//   wheel-zoom window. Indicator arrays are aligned 1:1 to `priced`.
// - Renders into inline SVG (no canvas) so it stays unit-testable.

import { useEffect, useMemo, useRef, useState } from 'react';
import * as d3 from 'd3';

export interface ChartBar {
  t: string; // ISO timestamp
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  vwap?: number;
}

export interface SupportResistance {
  support_levels: number[];
  resistance_levels: number[];
}

export interface PriceChartProps {
  bars: ChartBar[];
  /** Height of the full chart in px; price/volume/RSI panes are derived. */
  height?: number;
  ariaLabel?: string;
  /** Support/resistance levels from the technical analyst's verdict. */
  supportResistance?: SupportResistance | null;
  /** Which overlay studies are enabled (default: SMA + Bollinger). */
  studies?: Partial<Record<StudyId, boolean>>;
  /** When true the bottom axis shows date+time (intraday); else date only. */
  showTime?: boolean;
}

const MARGIN = { top: 8, right: 64, bottom: 22, left: 8 };
const VOLUME_RATIO = 0.16; // fraction of (price+volume) given to volume
const RSI_H = 56; // fixed RSI sub-pane height when enabled

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(0, 16).replace('T', ' ');
}
function fmtNum(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

// ---- Indicator math (computed client-side from the FULL series, then sliced
//      to the visible window so SMAs warm up across history, not within-view) ----

function fmtAxis(iso: string, showTime: boolean): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const date = d.toISOString().slice(0, 10);
  if (showTime) return `${date} ${d.toISOString().slice(11, 16)}`;
  return date;
}
function sma(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    out.push(i >= period - 1 ? sum / period : null);
  }
  return out;
}
function ema(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = [];
  const k = 2 / (period + 1);
  let prev: number | null = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    if (prev === null) {
      // seed with SMA of the first `period` values
      if (i >= period - 1) {
        let s = 0;
        for (let j = i - period + 1; j <= i; j++) s += values[j]!;
        prev = s / period;
      }
      out.push(prev);
    } else {
      prev = v * k + prev * (1 - k);
      out.push(prev);
    }
  }
  return out;
}
function bollinger(values: number[], period = 20): { upper: (number | null)[]; middle: (number | null)[]; lower: (number | null)[] } {
  const mid = sma(values, period);
  const upper: (number | null)[] = [];
  const lower: (number | null)[] = [];
  for (let i = 0; i < values.length; i++) {
    if (mid[i] === null) { upper.push(null); lower.push(null); continue; }
    let variance = 0;
    for (let j = i - period + 1; j <= i; j++) variance += (values[j]! - mid[i]!) ** 2;
    const sd = Math.sqrt(variance / period);
    upper.push(mid[i]! + 2 * sd);
    lower.push(mid[i]! - 2 * sd);
  }
  return { upper, middle: mid, lower };
}
function rsi14(values: number[]): (number | null)[] {
  const out: (number | null)[] = [];
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 0; i < values.length; i++) {
    if (i === 0) { out.push(null); continue; }
    const diff = values[i]! - values[i - 1]!;
    const gain = Math.max(0, diff);
    const loss = Math.max(0, -diff);
    if (i <= 14) {
      avgGain += gain; avgLoss += loss;
      if (i === 14) {
        avgGain /= 14; avgLoss /= 14;
        const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
        out.push(100 - 100 / (1 + rs));
      } else out.push(null);
    } else {
      avgGain = (avgGain * 13 + gain) / 14;
      avgLoss = (avgLoss * 13 + loss) / 14;
      const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
      out.push(100 - 100 / (1 + rs));
    }
  }
  return out;
}
function cumVolVwap(bars: ChartBar[]): (number | null)[] {
  const out: (number | null)[] = [];
  let cumPV = 0;
  let cumV = 0;
  for (const b of bars) {
    const v = b.volume || 0;
    cumPV += b.close * v;
    cumV += v;
    out.push(cumV > 0 ? cumPV / cumV : null);
  }
  return out;
}

/** Build an SVG path `d` string for a series of {x,y} points, skipping nulls. */
function linePath(points: { x: number; y: number | null }[]): string {
  let d = '';
  let pen = false;
  for (const p of points) {
    if (p.y === null || Number.isNaN(p.y)) { pen = false; continue; }
    d += `${pen ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)} `;
    pen = true;
  }
  return d.trim();
}

export function PriceChart({
  bars,
  height = 360,
  ariaLabel,
  supportResistance,
  studies,
  showTime = false,
}: PriceChartProps) {
  const hostRef = useRef<SVGSVGElement | null>(null);
  const [width, setWidth] = useState(800);
  const [hover, setHover] = useState<{ bar: ChartBar; i: number; x: number; y: number } | null>(null);
  const MIN_BARS = 10;
  const [view, setView] = useState<[number, number]>([0, bars.length]);
  const viewRef = useRef<[number, number]>([0, bars.length]);
  viewRef.current = view;
  // Drag-to-pan state. `dragRef` holds the pointer origin + the window at
  // drag start so pointermove can compute a clipped shift without re-rendering.
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ x0: number; s0: number; e0: number } | null>(null);

  const enabled: Record<StudyId, boolean> = {
    sma: studies?.sma ?? true,
    ema: studies?.ema ?? false,
    bb: studies?.bb ?? true,
    vwap: studies?.vwap ?? false,
    rsi: studies?.rsi ?? false,
  };
  const showRsi = enabled.rsi;

  const pricedAll = useMemo(
    () => bars.filter((b) => Number.isFinite(b.high) && Number.isFinite(b.low)),
    [bars],
  );
  const total = pricedAll.length;
  const [vs, ve] = view[1] > total ? [0, total] : view;
  const priced = pricedAll.slice(vs, ve);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const parent = el.parentElement;
    if (!parent) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w && w > 0) setWidth(Math.floor(w));
    });
    ro.observe(parent);
    setWidth(Math.floor(parent.getBoundingClientRect().width) || 800);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    // Open zoomed-in to the most recent ~70% of history (≈30% trimmed from the
    // left). This keeps recent price action prominent while still leaving enough
    // left-hand history for long SMAs (e.g. SMA200) to be warmed up and visible
    // trailing into the view. Full history is one drag/pan away.
    const start = Math.max(0, Math.floor(total * 0.3));
    setView([start, total]);
  }, [total]);

  const innerW = Math.max(10, width - MARGIN.left - MARGIN.right);
  // Height partition: price pane gets the remainder after volume + (optional) RSI.
  const rsiH = showRsi ? RSI_H : 0;
  const volH = Math.floor((height - rsiH - MARGIN.top - MARGIN.bottom) * VOLUME_RATIO);
  const priceH = Math.floor(height - rsiH - MARGIN.top - MARGIN.bottom - volH);
  const innerH = priceH + volH + rsiH;

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const handler = (ev: WheelEvent) => {
      if (total <= MIN_BARS) return;
      ev.preventDefault();
      const [s, e] = viewRef.current[1] > total ? [0, total] : viewRef.current;
      const center = Math.floor((s + e) / 2);
      const len = e - s;
      const factor = ev.deltaY < 0 ? 0.8 : 1.25;
      let newLen = Math.round(len * factor);
      newLen = Math.max(MIN_BARS, Math.min(total, newLen));
      let ns = center - Math.floor(newLen / 2);
      let ne = ns + newLen;
      if (ns < 0) { ns = 0; ne = newLen; }
      if (ne > total) { ne = total; ns = total - newLen; }
      setView([ns, ne]);
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, [total, MIN_BARS]);

  // ---- Pointer interactions: drag-to-pan (1 pointer) + pinch-zoom (2 pointers) ----
  // Both mutate the same [viewStart, viewEnd] index window, so all overlays
  // (candles, SMA/BB/RSI, S/R lines) keep working unchanged.
  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchRef = useRef<{ dist: number; s0: number; e0: number; anchor: number } | null>(null);

  // Map a screen clientX to the data index currently under it (for pinch anchoring).
  const screenXToIndex = (clientX: number): number => {
    const el = hostRef.current;
    if (!el) return vs;
    const rect = el.getBoundingClientRect();
    const localX = clientX - rect.left - MARGIN.left;
    const frac = innerW > 0 ? localX / innerW : 0;
    const idx = Math.round(vs + frac * (ve - vs));
    return Math.max(0, Math.min(total - 1, idx));
  };

  const onPointerDown = (ev: React.PointerEvent<SVGSVGElement>) => {
    if (priced.length === 0) return;
    pointersRef.current.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (pointersRef.current.size === 2) {
      // Second finger down -> begin a pinch; freeze the initial geometry.
      const pts = [...pointersRef.current.values()];
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
      const midX = (pts[0].x + pts[1].x) / 2;
      pinchRef.current = { dist, s0: vs, e0: ve, anchor: screenXToIndex(midX) };
      dragRef.current = null; // a pinch overrides an in-progress pan
      setDragging(false);
    } else if (pointersRef.current.size === 1) {
      // Single pointer -> drag-to-pan.
      const [s, e] = viewRef.current[1] > total ? [0, total] : viewRef.current;
      (ev.target as Element).setPointerCapture?.(ev.pointerId);
      dragRef.current = { x0: ev.clientX, s0: s, e0: e };
      setDragging(true);
    }
  };

  const onPointerDragOrPinch = (ev: React.PointerEvent<SVGSVGElement>) => {
    const p = pointersRef.current.get(ev.pointerId);
    if (p) { p.x = ev.clientX; p.y = ev.clientY; }
    const pinch = pinchRef.current;
    if (pinch && pointersRef.current.size >= 2) {
      // Two fingers: zoom the window, keeping the anchor index fixed.
      const pts = [...pointersRef.current.values()];
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
      const factor = pinch.dist / dist; // >1 = fingers apart = zoom in
      let newLen = Math.round((pinch.e0 - pinch.s0) * factor);
      newLen = Math.max(MIN_BARS, Math.min(total, newLen));
      let ns = Math.round(pinch.anchor - (pinch.anchor - pinch.s0) * factor);
      let ne = ns + newLen;
      if (ns < 0) { ns = 0; ne = newLen; }
      if (ne > total) { ne = total; ns = total - newLen; }
      setView([ns, ne]);
      return;
    }
    if (dragRef.current) {
      const d = dragRef.current;
      const len = d.e0 - d.s0;
      const barsPerPx = len / Math.max(1, innerW);
      const shift = Math.round((ev.clientX - d.x0) * barsPerPx);
      let ns = d.s0 - shift;
      ns = Math.max(0, Math.min(total - len, ns));
      setView([ns, ns + len]);
    }
  };

  const endPointer = (ev: React.PointerEvent<SVGSVGElement>) => {
    pointersRef.current.delete(ev.pointerId);
    if (pointersRef.current.size < 2) pinchRef.current = null;
    if (pointersRef.current.size === 0) { dragRef.current = null; setDragging(false); }
  };

  const x = d3
    .scaleBand<number>()
    .domain(d3.range(priced.length))
    .range([0, innerW])
    .padding(0.25);
  const yMin = d3.min(priced, (b) => b.low) ?? 0;
  const yMax = d3.max(priced, (b) => b.high) ?? 1;
  const yPad = (yMax - yMin) * 0.05 || 1;
  const y = d3.scaleLinear().domain([yMin - yPad, yMax + yPad]).range([priceH, 0]);
  const maxVol = d3.max(priced, (b) => b.volume) ?? 1;
  const yVol = d3.scaleLinear().domain([0, maxVol]).range([volH, 0]);
  const bandW = x.bandwidth();
  const px = (i: number) => (x(i) ?? 0) + bandW / 2 + MARGIN.left;

  // ---- Overlay indicator series ----
  // Computed on the FULL series (`pricedAll`) so long SMAs warm up across all of
  // history, then sliced to the visible window [vs, ve]. This is the key fix for
  // SMA200 previously appearing only at the far right: it now draws across the
  // whole series and is visible wherever the window is panned.
  const closesAll = pricedAll.map((b) => b.close);
  const sma20All = useMemo(() => sma(closesAll, 20), [pricedAll]);
  const sma50All = useMemo(() => sma(closesAll, 50), [pricedAll]);
  const sma200All = useMemo(() => sma(closesAll, 200), [pricedAll]);
  const ema12All = useMemo(() => ema(closesAll, 12), [pricedAll]);
  const ema26All = useMemo(() => ema(closesAll, 26), [pricedAll]);
  const bbAll = useMemo(() => bollinger(closesAll, 20), [pricedAll]);
  const vwapAll = useMemo(() => cumVolVwap(pricedAll), [pricedAll]);
  const rsiAll = useMemo(() => rsi14(closesAll), [pricedAll]);
  const sma20 = sma20All.slice(vs, ve);
  const sma50 = sma50All.slice(vs, ve);
  const sma200 = sma200All.slice(vs, ve);
  const ema12 = ema12All.slice(vs, ve);
  const ema26 = ema26All.slice(vs, ve);
  const bb = {
    upper: bbAll.upper.slice(vs, ve),
    middle: bbAll.middle.slice(vs, ve),
    lower: bbAll.lower.slice(vs, ve),
  };
  const vwapArr = vwapAll.slice(vs, ve);
  const rsiArr = rsiAll.slice(vs, ve);

  const overlays: { id: string; color: string; values: (number | null)[]; dashed?: boolean }[] = [];
  if (enabled.sma) {
    overlays.push({ id: 'sma20', color: '#fbbf24', values: sma20 });
    overlays.push({ id: 'sma50', color: '#38bdf8', values: sma50 });
    overlays.push({ id: 'sma200', color: '#c084fc', values: sma200 });
  }
  if (enabled.ema) {
    overlays.push({ id: 'ema12', color: '#f472b6', values: ema12 });
    overlays.push({ id: 'ema26', color: '#fb923c', values: ema26 });
  }
  if (enabled.vwap) overlays.push({ id: 'vwap', color: '#2dd4bf', values: vwapArr });
  if (enabled.bb) {
    overlays.push({ id: 'bbu', color: 'rgba(148,163,184,0.7)', values: bb.upper, dashed: true });
    overlays.push({ id: 'bbl', color: 'rgba(148,163,184,0.7)', values: bb.lower, dashed: true });
  }

  const onMove = (ev: React.MouseEvent<SVGSVGElement>) => {
    if (priced.length === 0) return;
    const rect = ev.currentTarget.getBoundingClientRect();
    const pxpos = ev.clientX - rect.left - MARGIN.left;
    const idx = Math.max(0, Math.min(priced.length - 1, Math.floor(pxpos / (bandW + x.step() - bandW))));
    const i = Math.max(0, Math.min(priced.length - 1, Math.round(idx)));
    const b = priced[i]!;
    setHover({ bar: b, i, x: px(i), y: MARGIN.top + y(b.close) });
  };

  const rsiY = d3.scaleLinear().domain([0, 100]).range([rsiH, 0]);
  const rsiTop = MARGIN.top + priceH + volH;

  return (
    <div className="price-chart-wrap" data-testid="price-chart-wrap">
      <svg
        ref={hostRef}
        className="price-chart"
        width={width}
        height={height}
        role="img"
        aria-label={ariaLabel ?? 'Price chart'}
        data-testid="price-chart"
        data-dragging={dragging ? 'on' : 'off'}
        data-study-sma={enabled.sma ? 'on' : 'off'}
        data-study-ema={enabled.ema ? 'on' : 'off'}
        data-study-bb={enabled.bb ? 'on' : 'off'}
        data-study-vwap={enabled.vwap ? 'on' : 'off'}
        data-study-rsi={enabled.rsi ? 'on' : 'off'}
        style={{ cursor: dragging ? 'grabbing' : 'grab', touchAction: 'none' }}
        onPointerDown={onPointerDown}
        onPointerMove={(ev) => { if (dragRef.current || pinchRef.current) onPointerDragOrPinch(ev); else onMove(ev); }}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onPointerLeave={(ev) => { if (pointersRef.current.size === 0) { dragRef.current = null; setDragging(false); } else { endPointer(ev); } setHover(null); }}
        onMouseLeave={() => { if (!dragRef.current && !pinchRef.current) setHover(null); }}
      >
        {/* Price grid + right-axis labels */}
        {y.ticks(5).map((t) => (
          <g key={`grid-${t}`}>
            <line className="chart-grid" x1={MARGIN.left} x2={MARGIN.left + innerW} y1={MARGIN.top + y(t)} y2={MARGIN.top + y(t)} />
            <text className="chart-axis" x={MARGIN.left + innerW + 6} y={MARGIN.top + y(t) + 3}>{fmtNum(t)}</text>
          </g>
        ))}

        {/* Support / resistance annotation lines (from the technical analyst) */}
        {supportResistance?.support_levels.map((lvl, i) => (
          <g key={`sup-${i}`} className="sr-line sr-support" data-testid="sr-support">
            <line x1={MARGIN.left} x2={MARGIN.left + innerW} y1={MARGIN.top + y(lvl)} y2={MARGIN.top + y(lvl)} />
            <text className="sr-label" x={MARGIN.left + innerW + 6} y={MARGIN.top + y(lvl) + 3}>S {fmtNum(lvl)}</text>
          </g>
        ))}
        {supportResistance?.resistance_levels.map((lvl, i) => (
          <g key={`res-${i}`} className="sr-line sr-resistance" data-testid="sr-resistance">
            <line x1={MARGIN.left} x2={MARGIN.left + innerW} y1={MARGIN.top + y(lvl)} y2={MARGIN.top + y(lvl)} />
            <text className="sr-label" x={MARGIN.left + innerW + 6} y={MARGIN.top + y(lvl) + 3}>R {fmtNum(lvl)}</text>
          </g>
        ))}

        {/* Indicator overlay lines */}
        {overlays.map((o) => (
          <path
            key={o.id}
            className={`indicator-line indicator-${o.id}`}
            data-testid={`indicator-${o.id}`}
            d={linePath(o.values.map((v, i) => ({ x: px(i), y: v === null ? null : MARGIN.top + y(v) })))}
            style={{ stroke: o.color, strokeDasharray: o.dashed ? '4 3' : undefined }}
          />
        ))}

        {/* Candles */}
        {priced.map((b, i) => {
          const up = b.close >= b.open;
          const cx = px(i);
          const yo = MARGIN.top + y(b.open);
          const yc = MARGIN.top + y(b.close);
          const yh = MARGIN.top + y(b.high);
          const yl = MARGIN.top + y(b.low);
          const bodyTop = Math.min(yo, yc);
          const bodyH = Math.max(1, Math.abs(yc - yo));
          const vTop = MARGIN.top + priceH + yVol(b.volume);
          return (
            <g key={b.t} className={`candle ${up ? 'up' : 'down'}`} data-testid="candle">
              <line className="candle-wick" x1={cx} x2={cx} y1={yh} y2={yl} />
              <rect className="candle-body" x={cx - bandW / 2} y={bodyTop} width={bandW} height={bodyH} data-testid="candle-body" />
              <rect className="candle-vol" x={cx - bandW / 2} y={vTop} width={bandW} height={MARGIN.top + priceH + volH - vTop} data-testid="candle-vol" />
            </g>
          );
        })}

        {/* Volume pane separator */}
        <line className="chart-grid" x1={MARGIN.left} x2={MARGIN.left + innerW} y1={MARGIN.top + priceH} y2={MARGIN.top + priceH} />

        {/* RSI sub-pane */}
        {showRsi && (
          <g className="rsi-pane" data-testid="rsi-pane">
            <line className="chart-grid" x1={MARGIN.left} x2={MARGIN.left + innerW} y1={rsiTop} y2={rsiTop} />
            {[30, 50, 70].map((lvl) => (
              <g key={`rsi-${lvl}`}>
                <line className="chart-grid" x1={MARGIN.left} x2={MARGIN.left + innerW} y1={rsiTop + rsiY(lvl)} y2={rsiTop + rsiY(lvl)} />
                <text className="chart-axis" x={MARGIN.left + innerW + 6} y={rsiTop + rsiY(lvl) + 3}>{lvl}</text>
              </g>
            ))}
            <path
              className="indicator-line indicator-rsi"
              data-testid="indicator-rsi"
              d={linePath(rsiArr.map((v, i) => ({ x: px(i), y: v === null ? null : rsiTop + rsiY(v) })))}
              style={{ stroke: '#a78bfa' }}
            />
            <text className="rsi-label" x={MARGIN.left + 4} y={rsiTop + 12}>RSI 14</text>
          </g>
        )}

        {/* Bottom date/time axis (TradingView-style) */}
        {(() => {
          const axisY = MARGIN.top + priceH + volH + rsiH + 14;
          const ticks = 6;
          const idxs: number[] = [];
          for (let k = 0; k < ticks; k++) {
            const idx = Math.round((k / (ticks - 1)) * (priced.length - 1));
            idxs.push(Math.max(0, Math.min(priced.length - 1, idx)));
          }
          return (
            <g className="chart-xaxis" data-testid="chart-xaxis">
              <line className="chart-grid" x1={MARGIN.left} x2={MARGIN.left + innerW} y1={axisY - 4} y2={axisY - 4} />
              {idxs.map((i, k) => {
                const anchor = k === 0 ? 'start' : k === ticks - 1 ? 'end' : 'middle';
                return (
                  <text
                    key={`x-${k}`}
                    className="chart-axis chart-axis-x"
                    x={px(i)}
                    y={axisY}
                    textAnchor={anchor}
                  >
                    {fmtAxis(priced[i]!.t, showTime)}
                  </text>
                );
              })}
            </g>
          );
        })()}

        {/* Crosshair */}
        {hover && (
          <g className="chart-crosshair" data-testid="chart-crosshair">
            <line x1={hover.x} x2={hover.x} y1={MARGIN.top} y2={MARGIN.top + priceH + volH + rsiH} />
            <line x1={MARGIN.left} x2={MARGIN.left + innerW} y1={hover.y} y2={hover.y} />
          </g>
        )}
      </svg>

      {hover && (
        <div className="chart-tooltip" data-testid="chart-tooltip" style={{ left: Math.min(hover.x + 12, width - 150), top: 8 }}>
          <div className="chart-tt-date">{fmtDate(hover.bar.t)}</div>
          <div>O <span>{fmtNum(hover.bar.open)}</span></div>
          <div>H <span>{fmtNum(hover.bar.high)}</span></div>
          <div>L <span>{fmtNum(hover.bar.low)}</span></div>
          <div>C <span>{fmtNum(hover.bar.close)}</span></div>
          <div>Vol <span>{fmtNum(hover.bar.volume)}</span></div>
          {enabled.sma && <div>SMA20 <span>{sma20[hover.i] != null ? fmtNum(sma20[hover.i]!) : '—'}</span></div>}
          {enabled.bb && <div>BB mid <span>{bb.middle[hover.i] != null ? fmtNum(bb.middle[hover.i]!) : '—'}</span></div>}
          {enabled.rsi && <div>RSI <span>{rsiArr[hover.i] != null ? fmtNum(rsiArr[hover.i]!) : '—'}</span></div>}
        </div>
      )}

      <div className="chart-legend" data-testid="chart-legend">
        {vs > 0 || ve < total ? `${vs + 1}–${ve} of ${total} bars` : `${priced.length} bars`}
        {total > MIN_BARS && <span className="chart-zoom-hint"> · scroll or pinch to zoom · drag to pan</span>}
      </div>
    </div>
  );
}

export default PriceChart;

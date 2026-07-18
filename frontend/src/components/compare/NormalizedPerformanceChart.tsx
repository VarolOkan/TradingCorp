// frontend/src/components/compare/NormalizedPerformanceChart.tsx
// Phase 5: relative-performance line chart. Each ticker is normalized to 100 at
// the first point (see compareUtils.normalizeToBase) and drawn as its own line
// over a shared 0..100+ x-axis (index). Pure SVG so it is deterministic and
// trivial to test (no canvas / D3 runtime needed).
import { useMemo } from 'react';
import { normalizeToBase } from './compareUtils';
import type { ClosePoint } from './compareUtils';

export interface NormalizedSeries {
  ticker: string;
  color: string;
  points: ClosePoint[];
}

export interface NormalizedPerformanceChartProps {
  series: NormalizedSeries[];
  width?: number;
  height?: number;
  /** Cap the y-axis a little above the max normalized value (default 110). */
  yMax?: number;
}

// Deterministic color palette (up to 5 tickers) — same order as the legend.
const PALETTE = ['#38bdf8', '#34d399', '#f472b6', '#fbbf24', '#a78bfa'];

export function colorForIndex(i: number): string {
  return PALETTE[i % PALETTE.length]!;
}

export function NormalizedPerformanceChart({
  series,
  width = 640,
  height = 280,
  yMax = 110,
}: NormalizedPerformanceChartProps) {
  const padL = 38;
  const padR = 12;
  const padT = 12;
  const padB = 22;
  const innerW = width - padL - padR;
  const innerH = height - padT - padB;

  // Compute the y-axis range from the ACTUAL normalized data so lines that dip
  // below 100 (a normal loss) or spike above 110 are not clipped. Baseline 100
  // is always included; we pad a little beyond the extremes for breathing room.
  const { paths, yTicks, minLen, yLo, yHi } = useMemo(() => {
    const norm = series.map((s) => normalizeToBase(s.points));
    const minLen = norm.reduce(
      (m, arr) => (arr.length ? Math.min(m, arr.length) : m),
      Infinity,
    );
    const safeLen = minLen === Infinity ? 0 : minLen;
    let dataMin = 100;
    let dataMax = 100;
    for (const arr of norm) {
      for (const v of arr) {
        if (v < dataMin) dataMin = v;
        if (v > dataMax) dataMax = v;
      }
    }
    // Pad 8% beyond the extremes (and at least a couple points) so the lines
    // aren't glued to the top/bottom edges.
    const pad = Math.max((dataMax - dataMin) * 0.08, 2);
    const yMin = Math.min(100, dataMin) - pad;
    const yMaxReal = Math.max(100, dataMax) + pad;
    const lo = yMin;
    const hi = yMaxReal;
    const paths = norm.map((arr) => {
      const sliced = safeLen ? arr.slice(0, safeLen) : arr;
      return sliced
        .map((v, i) => {
          const x = padL + (safeLen <= 1 ? 0 : (i / (safeLen - 1)) * innerW);
          const y = padT + innerH - ((v - lo) / (hi - lo)) * innerH;
          return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
        })
        .join(' ');
    });
    // Y ticks: baseline 100 plus a couple of round-ish reference lines.
    const yTicks = [Math.round(lo), 100, Math.round(hi)].filter(
      (v, i, a) => a.indexOf(v) === i && v >= lo && v <= hi,
    );
    return { paths, yTicks, minLen: safeLen, yLo: lo, yHi: hi };
  }, [series, innerW, innerH, padL, padT]);

  return (
    <div className="norm-chart" data-testid="norm-chart">
      <svg
        width={width}
        height={height}
        role="img"
        aria-label="Normalized relative performance"
        data-testid="norm-chart-svg"
      >
        {/* baseline at 100 */}
        <line
          x1={padL}
          y1={padT + innerH - ((100 - yLo) / (yHi - yLo)) * innerH}
          x2={width - padR}
          y2={padT + innerH - ((100 - yLo) / (yHi - yLo)) * innerH}
          stroke="rgba(148,163,184,0.35)"
          strokeDasharray="3 3"
          data-testid="norm-baseline"
        />
        {yTicks.map((v) => {
          const y = padT + innerH - ((v - yLo) / (yHi - yLo)) * innerH;
          return (
            <g key={v}>
              <text x={padL - 6} y={y + 3} textAnchor="end" className="norm-axis-label" data-testid="norm-y-tick">
                {v}
              </text>
            </g>
          );
        })}
        {paths.map((d, i) => (
          <path
            key={series[i]!.ticker}
            d={d}
            fill="none"
            stroke={series[i]!.color}
            strokeWidth={2}
            data-testid={`norm-path-${series[i]!.ticker}`}
          />
        ))}
        {minLen > 1 && (
          <text x={width - padR} y={height - 4} textAnchor="end" className="norm-axis-label">
            {minLen} periods
          </text>
        )}
      </svg>
      <div className="norm-legend" data-testid="norm-legend">
        {series.map((s) => (
          <span key={s.ticker} className="norm-legend-item">
            <span className="norm-swatch" style={{ background: s.color }} data-testid={`norm-swatch-${s.ticker}`} />
            {s.ticker}
          </span>
        ))}
      </div>
    </div>
  );
}

export { PALETTE };

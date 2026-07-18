// frontend/src/components/compare/CompareView.tsx
// Phase 5 (Comparable / multi-ticker analysis): the centerpiece compare view.
// When 2-5 tickers are present it shows:
//   1. a normalized relative-performance chart (each ticker rebased to 100),
//   2. a pairwise return-correlation matrix,
//   3. side-by-side analyst verdicts (technical + sentiment) per ticker.
// Price series are fetched live via GET /history (real when reachable, shaped
// mock otherwise) — identical degradation pattern to the other market cards.
import { useEffect, useState } from 'react';
import { getPriceHistory, type PriceBarsResult } from '../../api/historyClient';
import { NormalizedPerformanceChart, colorForIndex } from './NormalizedPerformanceChart';
import { CorrelationMatrix } from './CorrelationMatrix';
import { dailyReturns, alignTail } from './compareUtils';
import type { AnalysisResult } from '../../types';

export interface CompareViewProps {
  tickers: string[];
  result: AnalysisResult | null;
  /** Override history fetch (tests). */
  fetchHistory?: (symbol: string) => Promise<PriceBarsResult>;
  interval?: '1d' | '5m' | '1m' | '1wk' | '1h';
  lookbackDays?: number;
}

interface SeriesState {
  [ticker: string]: PriceBarsResult | 'error' | undefined;
}

// ---- Per-ticker comparison metrics (computed from price history) ----
// These give the user something genuinely comparable across tickers so they
// can pick the "best" stock on a concrete metric, rather than a per-analyst
// verdict table that merely duplicates the Results panel.
function totalReturn(closes: number[]): number {
  if (closes.length < 2) return 0;
  const first = closes[0];
  const last = closes[closes.length - 1];
  return ((last - first) / first) * 100;
}
function annualizedVol(returns: number[]): number {
  if (returns.length < 2) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (returns.length - 1);
  const daily = Math.sqrt(variance);
  // scale to an annual figure assuming ~252 trading days
  return daily * Math.sqrt(252) * 100;
}
function sharpe(returns: number[], rfAnnual = 0): number {
  if (returns.length < 2) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (returns.length - 1);
  const daily = Math.sqrt(variance);
  if (daily === 0) return 0;
  const annualReturn = mean * 252 * 100;
  return (annualReturn - rfAnnual) / (daily * Math.sqrt(252) * 100);
}
function maxDrawdown(closes: number[]): number {
  if (closes.length === 0) return 0;
  let peak = closes[0];
  let maxDd = 0;
  for (const c of closes) {
    if (c > peak) peak = c;
    const dd = (c - peak) / peak;
    if (dd < maxDd) maxDd = dd;
  }
  return maxDd * 100;
}
// Higher-is-better metrics vs lower-is-better (risk) metrics.
const HIGHER_BETTER = new Set(['return', 'sharpe']);

interface TickerMetric {
  ticker: string;
  price: number | null;
  return: number;
  vol: number;
  sharpe: number;
  drawdown: number;
}

export function CompareView({
  tickers,
  result: _result,
  fetchHistory,
  interval = '1d',
  lookbackDays = 90,
}: CompareViewProps) {
  const [series, setSeries] = useState<SeriesState>({});
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const doFetch = fetchHistory ?? getPriceHistory;

  useEffect(() => {
    if (tickers.length < 2) return;
    let cancelled = false;
    setLoading(true);
    setErr(null);
    Promise.all(
      tickers.map(async (t) => {
        try {
          const r = await doFetch(t, { interval, lookbackDays });
          return [t, r] as const;
        } catch (e) {
          return [t, 'error' as const] as const;
        }
      }),
    ).then((entries) => {
      if (cancelled) return;
      const next: SeriesState = {};
      for (const [t, r] of entries) next[t] = r;
      setSeries(next);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [tickers, doFetch, interval, lookbackDays]);

  if (tickers.length < 2) {
    return (
      <div className="compare-empty" data-testid="compare-empty">
        Analyze at least 2 tickers to enable compare mode.
      </div>
    );
  }

  const loaded = tickers.filter((t) => series[t] && series[t] !== 'error');
  const allFailed = loaded.length === 0 && Object.keys(series).length > 0;

  // Build normalized series + return series for correlation.
  const closesByTicker: Record<string, number[]> = {};
  for (const t of tickers) {
    const r = series[t];
    if (r && r !== 'error') closesByTicker[t] = r.bars.map((b) => b.close);
  }
  const aligned = alignTail(Object.values(closesByTicker));
  const tickersAligned = Object.keys(closesByTicker);
  const normSeries = tickersAligned.map((t, i) => ({
    ticker: t,
    color: colorForIndex(i),
    points: (series[t] as PriceBarsResult).bars.map((b) => ({ t: b.t, close: b.close })),
  }));
  const returns: Record<string, number[]> = {};
  tickersAligned.forEach((t, i) => {
    returns[t] = dailyReturns(aligned[i]!);
  });

  // Per-ticker metrics from the loaded price history.
  const metrics: TickerMetric[] = tickersAligned.map((t) => {
    const closes = closesByTicker[t];
    const ret = totalReturn(closes);
    const vol = annualizedVol(returns[t]);
    const sh = sharpe(returns[t]);
    const dd = maxDrawdown(closes);
    const price = closes.length ? closes[closes.length - 1] : null;
    return { ticker: t, price, return: ret, vol, sharpe: sh, drawdown: dd };
  });
  const bestBy = (key: 'return' | 'vol' | 'sharpe' | 'drawdown'): string | null => {
    if (metrics.length === 0) return null;
    const higher = HIGHER_BETTER.has(key);
    let best = metrics[0];
    for (const m of metrics) {
      if (higher ? m[key] > best[key] : m[key] < best[key]) best = m;
    }
    return best.ticker;
  };

  return (
    <div className="compare-view" data-testid="compare-view">
      <div className="compare-section">
        <h4 className="compare-h">Relative performance (rebased to 100)</h4>
        {loading && <p className="compare-loading" data-testid="compare-loading">Loading price series…</p>}
        {allFailed && (
          <p className="compare-error" role="alert" data-testid="compare-error">
            Could not load price history for any ticker.
          </p>
        )}
        {loaded.length >= 2 && <NormalizedPerformanceChart series={normSeries} />}
      </div>

      <div className="compare-section">
        <h4 className="compare-h">Return correlation</h4>
        <CorrelationMatrix returns={returns} />
      </div>

      <div className="compare-section">
        <h4 className="compare-h">Per-ticker comparison</h4>
        <p className="compare-sub">
          Risk/return metrics computed from {lookbackDays}-day price history for {tickers.join(', ')}.
          The best value in each row is highlighted.
        </p>
        {metrics.length === 0 ? (
          <p className="compare-empty" data-testid="metrics-none">
            No price history available to compute comparison metrics.
          </p>
        ) : (
          <table className="verdict-compare" data-testid="metrics-table">
            <thead>
              <tr>
                <th data-testid="metric-col-ticker">Ticker</th>
                <th data-testid="metric-col-price">Price</th>
                <th data-testid="metric-col-return">Return %</th>
                <th data-testid="metric-col-vol">Volatility %</th>
                <th data-testid="metric-col-sharpe">Sharpe</th>
                <th data-testid="metric-col-drawdown">Max DD %</th>
              </tr>
            </thead>
            <tbody>
              {metrics.map((m) => (
                <tr key={m.ticker} data-testid={`metric-row-${m.ticker}`}>
                  <th data-testid={`metric-ticker-${m.ticker}`}>{m.ticker}</th>
                  <td data-testid={`metric-price-${m.ticker}`}>
                    {m.price != null ? m.price.toFixed(2) : '—'}
                  </td>
                  <td
                    className={m.ticker === bestBy('return') ? 'metric-best' : ''}
                    data-testid={`metric-return-${m.ticker}`}
                  >
                    {m.return.toFixed(1)}
                  </td>
                  <td
                    className={m.ticker === bestBy('vol') ? 'metric-best' : ''}
                    data-testid={`metric-vol-${m.ticker}`}
                  >
                    {m.vol.toFixed(1)}
                  </td>
                  <td
                    className={m.ticker === bestBy('sharpe') ? 'metric-best' : ''}
                    data-testid={`metric-sharpe-${m.ticker}`}
                  >
                    {m.sharpe.toFixed(2)}
                  </td>
                  <td
                    className={m.ticker === bestBy('drawdown') ? 'metric-best' : ''}
                    data-testid={`metric-drawdown-${m.ticker}`}
                  >
                    {m.drawdown.toFixed(1)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {metrics.length > 0 && (
          <p className="compare-best" data-testid="metrics-best">
            Best return: <strong>{bestBy('return')}</strong> · Best risk-adjusted (Sharpe):{' '}
            <strong>{bestBy('sharpe')}</strong> · Lowest volatility:{' '}
            <strong>{bestBy('vol')}</strong> · Smallest drawdown: <strong>{bestBy('drawdown')}</strong>
          </p>
        )}
      </div>
    </div>
  );
}

export default CompareView;

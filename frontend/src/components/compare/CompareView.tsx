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

function verdictLabel(score: number | null | undefined): string {
  if (score == null || !isFinite(score)) return '—';
  if (score >= 60) return 'BULLISH';
  if (score >= 45) return 'NEUTRAL';
  return 'BEARISH';
}
function verdictClass(score: number | null | undefined): string {
  const l = verdictLabel(score).toLowerCase();
  return `verdict-${l}`;
}

export function CompareView({
  tickers,
  result,
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
        {loaded.length >= 2 && (
          <NormalizedPerformanceChart series={normSeries} />
        )}
      </div>

      <div className="compare-section">
        <h4 className="compare-h">Return correlation</h4>
        <CorrelationMatrix returns={returns} />
      </div>

      <div className="compare-section">
        <h4 className="compare-h">Side-by-side verdicts</h4>
        <table className="verdict-compare" data-testid="verdict-compare">
          <thead>
            <tr>
              <th data-testid="verdict-col-ticker">Ticker</th>
              <th data-testid="verdict-col-technical">Technical</th>
              <th data-testid="verdict-col-sentiment">Sentiment</th>
              <th data-testid="verdict-col-source">Source</th>
            </tr>
          </thead>
          <tbody>
            {tickers.map((t) => {
              const tech = result?.technical_analysis?.[t];
              const sent = result?.sentiment_analysis?.[t];
              const techScore = tech?.technical_score ?? tech?.score ?? null;
              const sentScore = sent?.sentiment_score ?? sent?.news_sentiment != null
                ? sent.sentiment_score
                : null;
              const source = tech?.data_source ?? sent?.data_source ?? '—';
              return (
                <tr key={t} data-testid={`verdict-row-${t}`}>
                  <th data-testid={`verdict-ticker-${t}`}>{t}</th>
                  <td className={verdictClass(techScore)} data-testid={`verdict-tech-${t}`}>
                    {verdictLabel(techScore)}
                    {techScore != null && <span className="verdict-score"> ({Math.round(techScore)})</span>}
                  </td>
                  <td className={verdictClass(sentScore)} data-testid={`verdict-sent-${t}`}>
                    {sent ? verdictLabel(sentScore) : '—'}
                    {sentScore != null && <span className="verdict-score"> ({Math.round(sentScore)})</span>}
                  </td>
                  <td className="verdict-source" data-testid={`verdict-source-${t}`}>{source}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default CompareView;

// frontend/src/components/ScreenerPanel.tsx
// Phase 6: Stock Screener UI. A collapsible panel with a "Run screener" button
// that calls GET /screener for the currently selected agency and shows the
// top-N most promising tickers (promise score + per-axis breakdown + verdict),
// plus how long the screen took. Each row has a "→ Analyze" button that sends
// the ticker straight into the analysis tool.
import { useState, useRef, useEffect } from 'react';
import { getScreener, type ScreenerResult, type ScreenerRow, type UniverseTrace } from '../api/screenerClient';
import { isIntradayAgency } from './analysts/agencies';

export interface ScreenerPanelProps {
  agencyId: string;
  /** Called when the user picks a ticker to analyze. */
  onPick: (ticker: string) => void;
  limit?: number;
  /** Controlled open state. When provided, the parent owns expand/collapse. */
  open?: boolean;
  /** Called on every expand/collapse toggle when controlled via `open`. */
  onOpenChange?: (v: boolean) => void;
}

function axisLabel(axis: ScreenerRow['topAxis']): string {
  return axis.charAt(0).toUpperCase() + axis.slice(1);
}

function verdictClass(v: ScreenerRow['verdict']): string {
  return `screener-verdict screener-verdict-${v.toLowerCase()}`;
}

/** Sortable column header — click toggles ASC -> DESC -> ASC. Shows ▲/▼. */
function SortableTh({
  label,
  testId,
  colKey,
  sortKey,
  dir,
  onSort,
}: {
  label: string;
  testId: string;
  colKey: keyof ScreenerRow;
  sortKey: keyof ScreenerRow | null;
  dir: 'asc' | 'desc';
  onSort: (k: keyof ScreenerRow) => void;
}) {
  const active = sortKey === colKey;
  const indicator = active ? (dir === 'asc' ? ' ▲' : ' ▼') : '';
  return (
    <th
      className={`screener-sortable${active ? ' screener-sort-active' : ''}`}
      data-testid={testId}
      data-sort-key={colKey}
      aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      onClick={() => onSort(colKey)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSort(colKey);
        }
      }}
    >
      {label}
      <span className="screener-sort-indicator">{indicator}</span>
    </th>
  );
}

/**
 * "Data Lineage" — your visibility ask. Shows the exact universe pipeline the
 * backend ran this screen: which source won, the funnel (listed -> parsed ->
 * pre-filtered -> final), and an explicit warning when we fell back to the
 * hardcoded 25-ticker DEFAULT_UNIVERSE (so GOOGL showing up is explainable).
 */
function UniverseLineage({ trace }: { trace: UniverseTrace }) {
  const funnel = [
    { label: 'Listed', value: trace.listedCount },
    { label: 'Parsed', value: trace.parsedCount },
    { label: 'Pre-filtered', value: trace.prefilteredCount },
    { label: 'Final pool', value: trace.finalCount },
  ];
  return (
    <div className="screener-lineage" data-testid="screener-lineage">
      <div className="screener-lineage-head">
        <span className="screener-lineage-title">Data lineage</span>
        <span
          className={`screener-source-badge screener-source-${trace.origin}`}
          data-testid="screener-lineage-origin"
          title={
            trace.origin === 'live'
              ? 'Live universe pulled from a real source.'
              : trace.origin === 'cache'
                ? 'Universe served from daily cache (no network).'
                : 'No live source reachable — fell back to the hardcoded 25-ticker list.'
          }
        >
          {trace.origin.toUpperCase()}
        </span>
        <span className="screener-lineage-src">source: {trace.provider}</span>
      </div>

      {trace.usedFallback && (
        <div className="screener-lineage-warn" data-testid="screener-lineage-warn" role="alert">
          ⚠ The live universe source was unreachable, so the screener fell back to the hardcoded
          25-ticker DEFAULT_UNIVERSE. Mega-caps like GOOGL appear from this fallback, <strong>not</strong> the
          broad pool. Give the server egress (Node 18+) and set <code>UNIVERSE_PROVIDER</code>.
        </div>
      )}

      <ol className="screener-funnel" data-testid="screener-funnel">
        {funnel.map((f, i) => (
          <li key={f.label} className="screener-funnel-step" data-testid={`screener-funnel-${f.label.toLowerCase().replace(/\s+/g, '-')}`}>
            {i > 0 && <span className="screener-funnel-arrow">→</span>}
            <span className="screener-funnel-label">{f.label}</span>
            <span className="screener-funnel-value" data-testid={`screener-funnel-val-${f.label.toLowerCase().replace(/\s+/g, '-')}`}>{f.value.toLocaleString()}</span>
          </li>
        ))}
      </ol>

      {trace.gates && (
        <div className="screener-gates" data-testid="screener-gates">
          {Object.entries(trace.gates)
            .filter(([, v]) => (v ?? 0) > 0)
            .map(([k, v]) => (
              <span key={k} className="screener-gate-chip" data-testid={`screener-gate-${k}`}>
                {k}: -{v}
              </span>
            ))}
          {Object.values(trace.gates).every((v) => !v) && (
            <span className="screener-gate-chip">no gates tripped</span>
          )}
        </div>
      )}

      <details className="screener-steps">
        <summary>steps</summary>
        <ul data-testid="screener-steps">
          {trace.steps.map((s, i) => (
            <li key={i} className={`screener-step screener-step-${s.kind}`} data-testid={`screener-step-${i}`}>
              <code>{s.source}</code> ({s.kind}): {s.result}
              {s.parsed != null && <> · parsed {s.parsed}</>}
            </li>
          ))}
        </ul>
      </details>

      {trace.note && !trace.usedFallback && <p className="screener-lineage-note">{trace.note}</p>}
    </div>
  );
}

export function ScreenerPanel({ agencyId, onPick, limit = 15, open: openProp, onOpenChange }: ScreenerPanelProps) {
  // Internal fallback so the panel still works when uncontrolled (no open prop).
  const [internalOpen, setInternalOpen] = useState(false);
  const open = openProp ?? internalOpen;
  const setOpen = (v: boolean) => {
    setInternalOpen(v);
    onOpenChange?.(v);
  };
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [data, setData] = useState<ScreenerResult | null>(null);
  // Live elapsed timer shown while a screen is running (can take 30-40s).
  const [runMs, setRunMs] = useState(0);
  const timerRef = useRef<number | null>(null);
  // Click-to-sort: column key + direction. null key = backend ranking order.
  const [sort, setSort] = useState<{ key: keyof ScreenerRow | null; dir: 'asc' | 'desc' }>({
    key: null,
    dir: 'asc',
  });

  const toggleSort = (key: keyof ScreenerRow) => {
    setSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: 'asc' },
    );
  };

  const sortedRows = (() => {
    if (!data || !sort.key) return data?.rows ?? [];
    const rows = [...data.rows];
    const key = sort.key;
    rows.sort((a, b) => {
      const av = a[key];
      const bv = b[key];
      let cmp = 0;
      if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv;
      else cmp = String(av).localeCompare(String(bv));
      return sort.dir === 'asc' ? cmp : -cmp;
    });
    return rows;
  })();

  const run = async () => {
    setOpen(true); // expand the results section (so the run's output is visible)
    setLoading(true);
    setErr(null);
    setRunMs(0);
    // Live running timer: tick every 100ms so the user sees progress during the
    // 30-40s screen instead of a frozen "Screening…" label.
    if (timerRef.current) clearInterval(timerRef.current);
    const startedAt = Date.now();
    timerRef.current = setInterval(() => setRunMs(Date.now() - startedAt), 100) as unknown as number;
    try {
      // Intraday agencies screen on short, granular bars; everyone else on
      // daily bars. This is what makes intraday vs long-term produce different
      // rankings instead of the same list.
      const profile = isIntradayAgency(agencyId)
        ? { interval: '5m' as const, lookbackDays: 5 }
        : { interval: '1d' as const, lookbackDays: 90 };
      const res = await getScreener(agencyId, { limit, ...profile });
      setData(res);
    } catch (e: any) {
      setErr(e?.message ?? 'Screener request failed');
    } finally {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
      setLoading(false);
    }
  };

  // Clear any in-flight timer on unmount.
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  return (
    <div className="screener-panel" data-testid="screener-panel">
      <div className="screener-header">
        <button
          type="button"
          className="screener-toggle"
          aria-expanded={open}
          data-testid="screener-toggle"
          onClick={() => setOpen(!open)}
        >
          {open ? '▾' : '▸'} Stock Screener
        </button>
        <span className="screener-sub">
          most promising for <strong>{agencyId}</strong>
        </span>
        {!open && (
          <button type="button" className="screener-run" data-testid="screener-run-collapsed" onClick={run}>
            Run
          </button>
        )}
        {data && data.dataSource && (
          <span
            className={`screener-source-badge screener-source-${data.dataSource.toLowerCase()}`}
            data-testid="screener-source-badge"
            title={
              data.dataSource === 'MOCK'
                ? 'No live market data at all — universe fell back and all rows on mock bars. Check server egress.'
                : data.dataSource === 'DELAYED'
                  ? `Real market data (Yahoo, tokenless), delayed ~15-20 min. ${data.liveRows}/${data.rows.length} rows on live bars` +
                    (data.liveRows < data.rows.length
                      ? `; ${data.rows.length - data.liveRows} on mock bars (chart endpoint throttled).`
                      : '.')
                  : 'Live sub-second feed.'
            }
          >
            {data.dataSource}
            {data.dataSource === 'DELAYED' && data.liveRows < data.rows.length && (
              <span className="screener-source-sub">
                {' '}
                {data.liveRows}/{data.rows.length} live
              </span>
            )}
          </span>
        )}
      </div>

      {/* Body is always mounted and toggled via the .collapsible wrapper's
          aria-expanded so it animates BOTH open and closed. */}
      <div className="screener-body collapsible" aria-expanded={open}>
        <div className="collapsible-inner">
            <div className="screener-actions">
              <button
                type="button"
                className="screener-run"
                data-testid="screener-run"
                onClick={run}
                disabled={loading}
              >
                {loading ? `Screening… ${(runMs / 1000).toFixed(1)}s` : 'Run screener'}
              </button>
              {loading && (
                <span className="screener-elapsed screener-running" data-testid="screener-running">
                  {Math.floor(runMs / 1000)}s elapsed
                </span>
              )}
              {!loading && data && (
                <span className="screener-elapsed" data-testid="screener-elapsed">
                  {data.rows.length} of {data.universeSize} · {data.elapsedMs} ms
                </span>
              )}
            </div>

            {err && (
              <p className="screener-error" role="alert" data-testid="screener-error">
                {err}
              </p>
            )}

            {data && data.rows.length > 0 && (
              <div className="screener-scroll">
                <table className="screener-table" data-testid="screener-table">
                <thead>
                  <tr>
                    <SortableTh label="Ticker" testId="screener-col-ticker" colKey="ticker" sortKey={sort.key} dir={sort.dir} onSort={toggleSort} />
                    <SortableTh label="Promise" testId="screener-col-promise" colKey="promise" sortKey={sort.key} dir={sort.dir} onSort={toggleSort} />
                    <SortableTh label="Tech" testId="screener-col-technical" colKey="technical" sortKey={sort.key} dir={sort.dir} onSort={toggleSort} />
                    <SortableTh label="Sent" testId="screener-col-sentiment" colKey="sentiment" sortKey={sort.key} dir={sort.dir} onSort={toggleSort} />
                    <SortableTh label="Mom" testId="screener-col-momentum" colKey="momentum" sortKey={sort.key} dir={sort.dir} onSort={toggleSort} />
                    <SortableTh label="Verdict" testId="screener-col-verdict" colKey="verdict" sortKey={sort.key} dir={sort.dir} onSort={toggleSort} />
                    <th data-testid="screener-col-action">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedRows.map((r) => (
                    <tr key={r.ticker} data-testid={`screener-row-${r.ticker}`}>
                      <th data-testid={`screener-ticker-${r.ticker}`}>
                        {r.ticker}
                        <span
                          className={`screener-source-dot screener-source-${r.barsSource}`}
                          data-testid={`screener-barsource-${r.ticker}`}
                          title={r.barsSource === 'mock' ? 'mock bars' : 'real (delayed) bars'}
                        />
                      </th>
                      <td data-testid={`screener-promise-${r.ticker}`}>
                        <span className="screener-promise-bar" style={{ width: `${r.promise}%` }} />
                        <span className="screener-promise-val">{r.promise}</span>
                        <span className="screener-topaxis" data-testid={`screener-topaxis-${r.ticker}`}>
                          {axisLabel(r.topAxis)}
                        </span>
                      </td>
                      <td data-testid={`screener-tech-${r.ticker}`}>{r.technical}</td>
                      <td data-testid={`screener-sent-${r.ticker}`}>{r.sentiment}</td>
                      <td data-testid={`screener-mom-${r.ticker}`}>{r.momentum}</td>
                      <td className={verdictClass(r.verdict)} data-testid={`screener-verdict-${r.ticker}`}>
                        {r.verdict}
                      </td>
                      <td>
                        <button
                          type="button"
                          className="screener-analyze"
                          data-testid={`screener-analyze-${r.ticker}`}
                          onClick={() => onPick(r.ticker)}
                        >
                          → Analyze
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {data.universeTrace && (
                <UniverseLineage trace={data.universeTrace} />
              )}
              </div>
            )}

            {data && data.rows.length > 0 && (
              <div className="screener-legend" data-testid="screener-legend">
                <span className="screener-legend-title">Fields</span>
                <span><strong>Promise</strong> — blended 0–100 score for this agency (higher = more promising).</span>
                <span><strong>Tech</strong> — technical axis: trend + low volatility quality.</span>
                <span><strong>Sent</strong> — news sentiment (−100..100, averaged headline polarity).</span>
                <span><strong>Mom</strong> — momentum: trailing return, normalized.</span>
                <span><strong>Verdict</strong> — STRONG (≥62) / WATCH (48–61) / WEAK (&lt;48).</span>
              </div>
            )}
        </div>
      </div>
    </div>
  );
}

export default ScreenerPanel;

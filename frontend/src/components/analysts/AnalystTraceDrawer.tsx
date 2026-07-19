// frontend/src/components/analysts/AnalystTraceDrawer.tsx
// Right-side slide-in drawer (NOT a modal) that opens when an analyst panel is
// clicked. Shows the four drill-down pillars for that analyst:
//   1. Instructions  — the TradingAgents-style role prompt it ran under
//   2. Data received — per-ticker inputs (expandable rows, with sources)
//   3. Weighting → output — visual weighting bars + breadcrumb traceability
//      back to the source datum that fed each step
//   4. Sources — a flat set of every source consulted
// Styled dark/glass to match the rest of the app (see index.css .trace-drawer*).

import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { AnalystTrace } from '../../types';
import type { AnalystId } from './analysts';
import { analystById } from './analysts';
import type { GetAnalystFlavorsResponse } from '../../api/analystFlavorsClient';

type Tab = 'instructions' | 'data' | 'weighting' | 'sources';

/** Map a verdict label to a color class (reuses the global .verdict-* palette). */
function verdictClass(v: string | null | undefined): string {
  if (!v) return '';
  const s = v.toUpperCase();
  if (s.includes('APPROVE') || s.includes('BULLISH') || s.includes('POSITIVE') || s.includes('EDGE'))
    return 'verdict-bullish';
  if (s.includes('REJECT') || s.includes('BEARISH') || s.includes('NEGATIVE') || s.includes('THIN'))
    return 'verdict-bearish';
  return 'verdict-neutral';
}

/** A drill path: analyst -> ticker -> datum, for traceability breadcrumbs. */
export interface TraceBreadcrumb {
  analyst: AnalystId;
  ticker?: string;
  field?: string;
}

export interface AnalystTraceDrawerProps {
  traces: AnalystTrace[];
  analystId: AnalystId | null;
  onClose: () => void;
  onSelect: (id: AnalystId) => void;
  /** Optional external breadcrumb; if omitted the drawer manages its own. */
  breadcrumb?: TraceBreadcrumb | null;
  onBreadcrumb?: (b: TraceBreadcrumb | null) => void;
  /**
   * Phase I: the LIVE (just-saved) flavor set per analyst, fetched by the
   * parent. When present for the open analyst, the Instructions tab shows the
   * saved Role & Instructions immediately after an edit — instead of the stale
   * last-run `trace.instructions`, which only changed on a re-run.
   */
  liveFlavorsById?: Record<string, GetAnalystFlavorsResponse>;
}

const TABS: { id: Tab; label: string }[] = [
  { id: 'instructions', label: 'Instructions' },
  { id: 'data', label: 'Data Received' },
  { id: 'weighting', label: 'Weighting → Output' },
  { id: 'sources', label: 'Sources' },
];

export function AnalystTraceDrawer({
  traces,
  analystId,
  onClose,
  onSelect,
  breadcrumb: externalCrumb,
  onBreadcrumb,
  liveFlavorsById,
}: AnalystTraceDrawerProps) {
  const [tab, setTab] = useState<Tab>('instructions');
  // Per-ticker collapse state on the Data tab (default: all expanded).
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // Internal breadcrumb when the parent does not own one.
  const [internalCrumb, setInternalCrumb] = useState<TraceBreadcrumb | null>(null);
  const crumb = externalCrumb !== undefined ? externalCrumb : internalCrumb;
  const setCrumb = (b: TraceBreadcrumb | null) => {
    if (onBreadcrumb) onBreadcrumb(b);
    else setInternalCrumb(b);
  };

  const open = analystId !== null;
  const trace = traces.find((t) => t.analyst === analystId) ?? null;
  const meta = analystId ? analystById(analystId) : null;

  // Phase I: prefer the LIVE saved flavor (so edits show immediately). Fall back
  // to the last-run trace.instructions only when no live flavor is loaded yet.
  const liveFlavor = analystId
    ? (() => {
        const resp = liveFlavorsById?.[analystId];
        if (!resp || !resp.flavors?.length) return null;
        const sel = resp.flavors.find((f) => f.id === resp.selectedId) ?? resp.flavors[0];
        return sel ?? null;
      })()
    : null;
  const instructionsText = liveFlavor?.instructions?.trim() || trace?.instructions || '';

  // Reset to the first tab + clear breadcrumb each time a new analyst opens.
  useEffect(() => {
    if (open) {
      setTab('instructions');
      setCollapsed(new Set());
      if (!onBreadcrumb) setInternalCrumb(null);
    }
  }, [analystId, open, onBreadcrumb]);

  // Close on Escape for keyboard users.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // When a breadcrumb pins a field, jump to the Data tab and highlight it.
  // (Must run before any early return to keep hook order stable.)
  useEffect(() => {
    if (open && crumb?.field) setTab('data');
  }, [open, crumb]);

  if (!open || !trace || !meta) return null;

  const allSources = Array.from(new Set(trace.inputs.flatMap((i) => i.sources ?? [])));

  const pinnedField = crumb?.field;

  return (
    <>
      <div className="trace-scrim" onClick={onClose} aria-hidden data-testid="trace-scrim" />
      <aside
        className="trace-drawer"
        role="dialog"
        aria-modal="false"
        aria-label={`${meta.name} analysis trace`}
        style={{ ['--accent' as any]: meta.accent }}
        data-testid="trace-drawer"
      >
        <header className="trace-drawer-head">
          <span className="monogram" aria-hidden>{meta.monogram}</span>
          <div className="trace-title">
            <h2>{meta.name}</h2>
            <p className="role">{meta.role}</p>
          </div>
          {trace.dataProvenance && (
            <span
              className={`trace-provenance-badge prov-${trace.dataProvenance}`}
              title={
                trace.dataProvenance === 'seeded-parity'
                  ? 'Output is seeded/parity — NOT from live online sources'
                  : trace.dataProvenance === 'mixed'
                  ? 'Some inputs live, some seeded fallback'
                  : trace.dataProvenance === 'none'
                  ? 'No data source wired for this analyst'
                  : 'Output derived from live online sources'
              }
              data-testid="trace-provenance-badge"
            >
              {trace.dataProvenance === 'seeded-parity'
                ? '⚠ NOT live data'
                : trace.dataProvenance === 'mixed'
                ? '◐ mixed (some live)'
                : trace.dataProvenance === 'none'
                ? '∅ no source'
                : '● live data'}
            </span>
          )}
          <button className="trace-close" onClick={onClose} aria-label="Close trace" data-testid="trace-close">
            ×
          </button>
        </header>

        <nav className="trace-switch" aria-label="Switch analyst">
          {traces.map((t) => (
            <button
              key={t.analyst}
              className={`trace-switch-btn ${t.analyst === analystId ? 'active' : ''}`}
              onClick={() => onSelect(t.analyst)}
              data-testid={`trace-switch-${t.analyst}`}
            >
              {t.name}
            </button>
          ))}
        </nav>

        {/* Breadcrumb traceability bar — analyst -> ticker -> datum. */}
        <div className="trace-crumbs" data-testid="trace-crumbs">
          <button className="trace-crumb" onClick={() => setCrumb(null)} data-testid="crumb-analyst">
            {meta.name}
          </button>
          {crumb?.ticker && (
            <>
              <span className="trace-crumb-sep">›</span>
              <button
                className="trace-crumb"
                onClick={() => setCrumb({ analyst: trace.analyst, ticker: crumb.ticker })}
                data-testid="crumb-ticker"
              >
                {crumb.ticker}
              </button>
            </>
          )}
          {crumb?.field && (
            <>
              <span className="trace-crumb-sep">›</span>
              <span className="trace-crumb trace-crumb-leaf" data-testid="crumb-field">{crumb.field}</span>
            </>
          )}
        </div>

        <div className="trace-tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={`trace-tab ${tab === t.id ? 'active' : ''}`}
              onClick={() => setTab(t.id)}
              data-testid={`trace-tab-${t.id}`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="trace-body" data-testid="trace-body">
          {tab === 'instructions' && (
            <section className="trace-section">
              <h3 className="trace-h3">
                Role & instructions
                {liveFlavor && (
                  <span
                    className="trace-live-badge"
                    title="Showing your saved flavor — updates live as you edit it"
                    data-testid="trace-live-badge"
                  >
                    ● live
                  </span>
                )}
              </h3>
              <p className="trace-instructions" data-testid="trace-instructions-body">{instructionsText}</p>
            </section>
          )}

          {tab === 'data' && (
            <section className="trace-section">
              {trace.sourceStatus && Object.keys(trace.sourceStatus).length > 0 && (
                <div className="trace-source-status" data-testid="trace-source-status">
                  <h3 className="trace-h3">
                    Source availability
                    {trace.degraded && (
                      <span className="trace-degraded-badge" title="This analyst ran on a reduced source set">
                        ⚠ degraded
                      </span>
                    )}
                  </h3>
                  <ul className="trace-source-list">
                    {Object.entries(trace.sourceStatus).map(([sid, status]) => {
                      const note = (trace.notes ?? []).find((n) => n.startsWith(sid) || n.includes(sid));
                      return (
                        <li
                          key={sid}
                          className={`trace-source-row trace-source-${status}`}
                          data-testid={`source-row-${sid}`}
                        >
                          <span className="trace-source-dot" aria-hidden />
                          <span className="trace-source-id">{sid}</span>
                          <span className={`trace-source-badge badge-${status}`}>{status}</span>
                          {(status === 'failed' || status === 'skipped') && note && (
                            <span className="trace-source-reason">{note}</span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
              <h3 className="trace-h3">Data received per ticker</h3>
              {trace.inputs.map((input, idx) => {
                const isCollapsed = collapsed.has(input.ticker);
                return (
                  <article key={`${input.ticker}-${idx}`} className="trace-input-card">
                    <button
                      className="trace-input-toggle"
                      onClick={() =>
                        setCollapsed((prev) => {
                          const next = new Set(prev);
                          if (next.has(input.ticker)) next.delete(input.ticker);
                          else next.add(input.ticker);
                          return next;
                        })
                      }
                      aria-expanded={!isCollapsed}
                      data-testid={`input-toggle-${input.ticker}`}
                    >
                      <span className="trace-caret" aria-hidden>{isCollapsed ? '▸' : '▾'}</span>
                      <span className="trace-ticker">{input.ticker}</span>
                      {input.label && <span className="trace-input-label">{input.label}</span>}
                    </button>
                    {!isCollapsed && (
                      <>
                        <dl className="trace-fields">
                          {Object.entries(input.data ?? {}).map(([k, v]) => (
                            <div
                              key={k}
                              className={`trace-field ${pinnedField === k ? 'pinned' : ''}`}
                              data-testid={`field-${input.ticker}-${k}`}
                              onClick={() =>
                                setCrumb({ analyst: trace.analyst, ticker: input.ticker, field: k })
                              }
                            >
                              <dt>{k}</dt>
                              <dd>{formatValue(v)}</dd>
                            </div>
                          ))}
                        </dl>
                        <p className="trace-sources-inline">
                          <span className="trace-sources-label">Source(s):</span>{' '}
                          {input.sources.join(', ')}
                        </p>
                      </>
                    )}
                  </article>
                );
              })}
            </section>
          )}

          {tab === 'weighting' && (
            <section className="trace-section">
              <h3 className="trace-h3">How the output was derived</h3>
              <ol className="trace-weighting">
                {trace.weighting.map((w, idx) => {
                  // Resolve the "primary" ticker each step drew from (first
                  // weighting step points at the first input ticker by default).
                  const targetTicker = trace.inputs[0]?.ticker;
                  return (
                    <li key={idx} className="trace-weight-step" data-testid={`weight-step-${idx}`}>
                      <div className="trace-weight-row">
                        <span className="trace-weight-label">{w.label}</span>
                        <span className="trace-weight-pct">{Math.round((w.weight ?? 0) * 100)}%</span>
                      </div>
                      {/* Visual weighting bar. */}
                      <div className="trace-weight-bar" aria-hidden>
                        <div
                          className="trace-weight-bar-fill"
                          style={{ width: `${Math.round((w.weight ?? 0) * 100)}%` }}
                        />
                      </div>
                      <p className="trace-weight-rationale">{w.rationale}</p>
                      <p className="trace-weight-inputs">
                        inputs:{' '}
                        {w.inputs.map((inp, i) => (
                          <button
                            key={inp}
                            className="trace-link"
                            onClick={() =>
                              setCrumb({ analyst: trace.analyst, ticker: targetTicker, field: inp })
                            }
                            data-testid={`weight-input-${idx}-${i}`}
                          >
                            {inp}
                          </button>
                        ))}
                        {typeof w.contribution === 'number' && (
                          <span className="trace-contribution"> · contribution {w.contribution}</span>
                        )}
                      </p>
                    </li>
                  );
                })}
              </ol>
              <div className="trace-output" data-testid="trace-output">
                <span className={`trace-output-verdict ${verdictClass(trace.output.verdict)}`}>
                  {trace.output.verdict ?? '—'}
                </span>
                {typeof trace.output.score === 'number' && (
                  <span className="trace-output-score">score {trace.output.score}</span>
                )}
              </div>
              {trace.output.summary && (
                <div className="trace-output-block trace-markdown" data-testid="trace-output-summary">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{trace.output.summary}</ReactMarkdown>
                </div>
              )}
              {(() => {
                const details = trace.output.details as
                  | { results?: Record<string, { score: number; verdict: string; summary: string }> }
                  | undefined;
                const results = details?.results;
                if (!results || Object.keys(results).length === 0) return null;
                return (
                  <div className="trace-output-details" data-testid="trace-output-details">
                    <div className="trace-output-details-head">Per-ticker breakdown</div>
                    {Object.entries(results).map(([tkr, r]) => (
                      <div key={tkr} className="trace-output-detail-row">
                        <span className="trace-output-detail-tkr">{tkr}</span>
                        <span className={`trace-output-detail-verdict ${verdictClass(r.verdict)}`}>
                          {r.verdict}
                        </span>
                        {typeof r.score === 'number' && (
                          <span className="trace-output-detail-score">{r.score}</span>
                        )}
                        {r.summary && (
                          <span className="trace-output-detail-sum">
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>{r.summary}</ReactMarkdown>
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                );
              })()}
            </section>
          )}

          {tab === 'sources' && (
            <section className="trace-section">
              <h3 className="trace-h3">Sources analyzed</h3>
              {allSources.length === 0 ? (
                <p className="trace-muted">No sources recorded.</p>
              ) : (
                <ul className="trace-sources">
                  {allSources.map((s) => (
                    <li key={s} data-testid="trace-source">{s}</li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {trace.notes && trace.notes.length > 0 && (
            <footer className="trace-notes">
              {trace.notes.map((n, i) => (
                <p key={i} className="trace-note">⚑ {n}</p>
              ))}
            </footer>
          )}
        </div>
      </aside>
    </>
  );
}

function formatValue(v: any): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return v.length ? v.join(', ') : '—';
  if (typeof v === 'object') {
    try {
      const compact = JSON.stringify(v);
      return compact.length > 120 ? compact.slice(0, 117) + '…' : compact;
    } catch {
      return '[object]';
    }
  }
  return String(v);
}

export default AnalystTraceDrawer;

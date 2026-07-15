// frontend/src/components/RawDataDrawer.tsx
// Right-side slide-in drawer (NOT a modal) — the R5 per-analyst RAW-DATA
// viewer. Reads the `report-<id>.json` dump (Phase R4) so the user can, after a
// run, re-inspect *exactly* the raw data each analyst received — the ingested
// equity store, the options bundles, and the per-analyst `dataReceived`
// annotations (ticker / domain / channel / interval / source / provenance).
//
// This is the deferred UI piece of RAW_DATA_DUMP.md §5 (R5): the backend dump
// is already produced on every report export; this drawer surfaces it. It does
// NOT mutate the run — it is a read-only re-view, and the entry point is the
// Reports calendar (each saved run's "Raw data" button), not the live wall.
//
// Styled dark/glass to match the existing AnalystTraceDrawer (index.css
// .trace-drawer*). Reuses those classes so it inherits the slide-in + scrim.

import { useEffect, useState } from 'react';

// Mirrors RawDataDump in src/server/report.ts + the live dataReceived entries
// (DataReceivedEntry in src/types/financial-analysis.ts). Kept loose (any) on
// purpose: the dump is an on-disk artifact whose exact shapes evolve; the
// drawer renders defensively rather than breaking on a new field.
export interface RawDataDump {
  reportId: string;
  agencyId: string;
  tickers: string[];
  companyName: string;
  generatedAt: string;
  ingested: Record<string, any> | null;
  optionsData: Record<string, any> | null;
  dataReceived: Array<Record<string, any>>;
  byAnalyst: Record<
    string,
    Array<{ ticker: string; channel: string; domains: string[]; provenance: string }>
  >;
}

type Tab = 'overview' | 'analysts' | 'equity' | 'options';

const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'analysts', label: 'By Analyst' },
  { id: 'equity', label: 'Equity Data' },
  { id: 'options', label: 'Options Data' },
];

const ANALYST_ORDER = [
  'orchestrator',
  'data_ingestion',
  'fundamental',
  'technical',
  'sentiment',
  'risk',
  'governance',
  'options_ingestion',
];

const PROVENANCE_LABEL: Record<string, string> = {
  ingested: 'ingested (live)',
  'seeded-parity': 'seeded (parity)',
  'options-live': 'options live',
  'options-seeded': 'options seeded',
};

function prettyAnalyst(id: string): string {
  return id
    .replace(/[_-]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatValue(v: any): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return v.length ? `[${v.length} items]` : '—';
  if (typeof v === 'object') {
    try {
      const compact = JSON.stringify(v);
      return compact.length > 140 ? compact.slice(0, 137) + '…' : compact;
    } catch {
      return '[object]';
    }
  }
  return String(v);
}

export interface RawDataDrawerProps {
  dump: RawDataDump | null;
  onClose: () => void;
  /** Pre-select an analyst when opened from a per-analyst affordance. */
  initialAnalyst?: string | null;
}

export function RawDataDrawer({ dump, onClose, initialAnalyst }: RawDataDrawerProps) {
  const [tab, setTab] = useState<Tab>('overview');
  const [selectedAnalyst, setSelectedAnalyst] = useState<string | null>(initialAnalyst ?? null);

  // Reset tab + selection each time a new dump opens.
  useEffect(() => {
    if (dump) {
      setTab('overview');
      setSelectedAnalyst(initialAnalyst ?? null);
    }
  }, [dump, initialAnalyst]);

  // Close on Escape for keyboard users.
  useEffect(() => {
    if (!dump) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dump, onClose]);

  // Keep hook order stable: declare effects + memo above, early-return below.
  if (!dump) return null;

  const open = true;

  // Sorted analyst list: known order first, then any extras in dump order.
  const analysts = (() => {
    const known = new Set(ANALYST_ORDER);
    const present = Object.keys(dump.byAnalyst ?? {});
    return [
      ...ANALYST_ORDER.filter((a) => present.includes(a)),
      ...present.filter((a) => !known.has(a)),
    ];
  })();

  // If the pre-selected analyst isn't in this dump, fall back to the first.
  const activeAnalyst =
    (selectedAnalyst && analysts.includes(selectedAnalyst) && selectedAnalyst) || analysts[0] || null;
  const activeEntries = activeAnalyst ? dump.byAnalyst?.[activeAnalyst] ?? [] : [];

  return (
    <>
      <div className="trace-scrim" onClick={onClose} aria-hidden data-testid="rawdata-scrim" />
      <aside
        className="trace-drawer"
        role="dialog"
        aria-modal="false"
        aria-label="Raw data inspector"
        data-testid="rawdata-drawer"
        style={{ ['--accent' as any]: '#38bdf8' }}
      >
        <header className="trace-drawer-head">
          <span className="monogram" aria-hidden>RD</span>
          <div className="trace-title">
            <h2>Raw Data Inspector</h2>
            <p className="role">
              {dump.companyName} · {dump.agencyId} · {dump.reportId}
            </p>
          </div>
          <button
            className="trace-close"
            onClick={onClose}
            aria-label="Close raw-data inspector"
            data-testid="rawdata-close"
          >
            ×
          </button>
        </header>

        <div className="trace-tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={`trace-tab ${tab === t.id ? 'active' : ''}`}
              onClick={() => setTab(t.id)}
              data-testid={`rawdata-tab-${t.id}`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="trace-body" data-testid="rawdata-body">
          {tab === 'overview' && (
            <section className="trace-section">
              <h3 className="trace-h3">Run summary</h3>
              <dl className="trace-fields">
                <div className="trace-field"><dt>Report</dt><dd>{dump.reportId}</dd></div>
                <div className="trace-field"><dt>Agency</dt><dd>{dump.agencyId}</dd></div>
                <div className="trace-field"><dt>Company</dt><dd>{dump.companyName}</dd></div>
                <div className="trace-field"><dt>Tickers</dt><dd>{dump.tickers.join(', ') || '—'}</dd></div>
                <div className="trace-field"><dt>Generated</dt><dd>{dump.generatedAt}</dd></div>
                <div className="trace-field">
                  <dt>Equity store</dt>
                  <dd>{dump.ingested ? 'present' : 'empty'}</dd>
                </div>
                <div className="trace-field">
                  <dt>Options bundle</dt>
                  <dd>{dump.optionsData ? 'present' : 'empty'}</dd>
                </div>
                <div className="trace-field">
                  <dt>Annotations</dt>
                  <dd>{dump.dataReceived.length} dataReceived entries</dd>
                </div>
              </dl>
              <h3 className="trace-h3">Analysts with received data</h3>
              <ul className="trace-sources">
                {analysts.length === 0 ? (
                  <li data-testid="rawdata-noanalysts">No raw-data annotations in this dump.</li>
                ) : (
                  analysts.map((a) => (
                    <li key={a} data-testid={`rawdata-analyst-${a}`}>
                      {prettyAnalyst(a)} ({dump.byAnalyst?.[a]?.length ?? 0} blocks)
                    </li>
                  ))
                )}
              </ul>
            </section>
          )}

          {tab === 'analysts' && (
            <section className="trace-section">
              <h3 className="trace-h3">Per-analyst received data</h3>
              <div className="trace-switch">
                {analysts.map((a) => (
                  <button
                    key={a}
                    className={`trace-switch-btn ${a === activeAnalyst ? 'active' : ''}`}
                    onClick={() => setSelectedAnalyst(a)}
                    data-testid={`rawdata-analyst-btn-${a}`}
                  >
                    {prettyAnalyst(a)}
                  </button>
                ))}
              </div>
              {activeAnalyst && (
                <>
                  <p className="trace-sources-label" data-testid="rawdata-active-analyst">
                    {prettyAnalyst(activeAnalyst)}
                  </p>
                  {activeEntries.length === 0 ? (
                    <p className="trace-muted">No dataReceived annotations for this analyst.</p>
                  ) : (
                    <ul className="trace-sources">
                      {activeEntries.map((e, i) => (
                        <li key={i} className="trace-source-row" data-testid={`rawdata-entry-${activeAnalyst}-${i}`}>
                          <span className="trace-source-id">{e.ticker}</span>
                          <span className="trace-source-badge badge-ok">{e.channel}</span>
                          <span className="trace-source-reason">
                            {e.domains.join(', ')} · {PROVENANCE_LABEL[e.provenance] ?? e.provenance}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </section>
          )}

          {tab === 'equity' && (
            <section className="trace-section">
              <h3 className="trace-h3">Ingested equity store</h3>
              {dump.ingested ? (
                <EquityView ingested={dump.ingested} />
              ) : (
                <p className="trace-muted">No ingested equity data in this dump.</p>
              )}
            </section>
          )}

          {tab === 'options' && (
            <section className="trace-section">
              <h3 className="trace-h3">Options bundle</h3>
              {dump.optionsData ? (
                <OptionsView optionsData={dump.optionsData} />
              ) : (
                <p className="trace-muted">No options data in this dump.</p>
              )}
            </section>
          )}
        </div>
      </aside>
    </>
  );
}

function EquityView({ ingested }: { ingested: Record<string, any> }) {
  // market is keyed by ticker in the dump.
  const m = ingested.market;
  const tickers = m && typeof m === 'object' ? Object.keys(m) : [];

  return (
    <>
      {ingested.source && (
        <p className="trace-sources-inline">
          <span className="trace-sources-label">Source:</span> {String(ingested.source)}
        </p>
      )}
      {tickers.length === 0 ? (
        <p className="trace-muted">No per-ticker market data in this dump.</p>
      ) : (
        tickers.map((t) => (
          <article key={t} className="trace-input-card">
            <div className="trace-ticker">{t}</div>
            <dl className="trace-fields">
              {Object.entries(ingested.market[t] ?? {}).map(([k, v]) => (
                <div key={k} className="trace-field" data-testid={`equity-${t}-${k}`}>
                  <dt>{k}</dt>
                  <dd>{formatValue(v)}</dd>
                </div>
              ))}
            </dl>
          </article>
        ))
      )}
      {ingested.fundamental && (
        <>
          <h3 className="trace-h3">Fundamental</h3>
          <pre className="trace-json" data-testid="equity-fundamental">
            {JSON.stringify(ingested.fundamental, null, 2)}
          </pre>
        </>
      )}
      {ingested.sentiment && (
        <>
          <h3 className="trace-h3">Sentiment</h3>
          <pre className="trace-json" data-testid="equity-sentiment">
            {JSON.stringify(ingested.sentiment, null, 2)}
          </pre>
        </>
      )}
    </>
  );
}

function OptionsView({ optionsData }: { optionsData: Record<string, any> }) {
  const underlying = optionsData.underlying_symbol ?? optionsData.underlyingSymbol ?? '—';
  return (
    <>
      <dl className="trace-fields">
        <div className="trace-field"><dt>Underlying</dt><dd>{String(underlying)}</dd></div>
        {optionsData.source && (
          <div className="trace-field"><dt>Source</dt><dd>{String(optionsData.source)}</dd></div>
        )}
        {optionsData.asOf && (
          <div className="trace-field"><dt>asOf</dt><dd>{String(optionsData.asOf)}</dd></div>
        )}
        {Array.isArray(optionsData.price_bars) && (
          <div className="trace-field"><dt>Underlying bars</dt><dd>{optionsData.price_bars.length} rows</dd></div>
        )}
        {Array.isArray(optionsData.option_chain) && (
          <div className="trace-field"><dt>Option chain</dt><dd>{optionsData.option_chain.length} contracts</dd></div>
        )}
        {Array.isArray(optionsData.greeks) && (
          <div className="trace-field"><dt>Greeks</dt><dd>{optionsData.greeks.length} rows</dd></div>
        )}
      </dl>
      <h3 className="trace-h3">Raw options bundle</h3>
      <pre className="trace-json" data-testid="options-json">
        {JSON.stringify(optionsData, null, 2)}
      </pre>
    </>
  );
}

export default RawDataDrawer;

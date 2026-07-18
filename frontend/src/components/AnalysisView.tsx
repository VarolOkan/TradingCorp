// frontend/src/components/AnalysisView.tsx
import type { Socket } from 'socket.io-client';
import { useEffect, useState } from 'react';
import { useAnalysis } from '../hooks/useAnalysis';
import AnalysisForm from './AnalysisForm';
import ResultsPanel from './ResultsPanel';
import RelationsGraphView from './RelationsGraphView';
import AnalystWall from './analysts/AnalystWall';
import AnalystTraceDrawer from './analysts/AnalystTraceDrawer';
import AnalystSettingsDialog from './AnalystSettingsDialog';
import MarketDataCard from './MarketDataCard';
import CompareView from './compare/CompareView';
import { getQuote } from '../api/quoteClient';
import ScreenerPanel from './ScreenerPanel';
import WatchlistBar from './WatchlistBar';
import { useAnalystRun } from '../hooks/useAnalystRun';
import type { AnalystId, AnalystSourceCatalog } from '../types';
import { agencyById, DEFAULT_AGENCY, type AgencyId } from './analysts/agencies';
import { analystById, type AnalystMeta } from './analysts/analysts';
import { AgencySelect } from './analysts/AgencySelect';
import AgencySettingsDialog from './analysts/AgencySettingsDialog';
import { buildAnalystConfigSchema, type AnalystConfigSchema } from './analysts/analystConfigSchema';
import { getAnalystFlavors, type GetAnalystFlavorsResponse } from '../api/analystFlavorsClient';

export interface AnalysisViewProps {
  socket: Socket | null;
  connected: boolean;
  sessionId?: string;
  onSessionChange?: (id: string) => void;
  /** B1: catalog of analysts that declare a LIVE+auth source (drives ⚙ button). */
  sourceCatalog?: AnalystSourceCatalog;
  /** B1: sources already configured (shows ✓ instead of ⚙). */
  configuredSourceKeys?: Set<string>;
  /**
   * §12.4.1: the selected agency, lifted to the parent so the top-right Settings
   * dialog's per-agency "default model" control targets the SAME agency the user
   * is viewing. When omitted, the view falls back to its own internal state.
   */
  agencyId?: AgencyId;
  onAgencyChange?: (id: AgencyId) => void;
  /** Bumped by the parent (App) after an agency create/delete so the dropdown
   *  re-renders from the mutated AGENCIES mirror. Combined with the view's own
   *  re-org version bump. */
  registryVersion?: number;
  /** Called after a source credential is saved (per-analyst dialog) so the
   *  parent can refresh the catalog and the "stored" indicator stays truthful
   *  on the next open. */
  onSourceSaved?: () => void;
}

export function AnalysisView({
  socket,
  connected,
  sessionId = 'default',
  onSessionChange,
  sourceCatalog = { analysts: [] },
  configuredSourceKeys = new Set<string>(),
  agencyId: agencyIdProp,
  onAgencyChange,
  registryVersion: registryVersionProp = 0,
  onSourceSaved,
}: AnalysisViewProps) {
  // Configured-source tracking lives here now: the gear (owned here) sets the
  // dialog's state here too, so clicking the gear actually opens the token
  // dialog instead of a dead copy.
  const [configuredSourceKeysInternal, setConfiguredSourceKeysInternal] = useState<Set<string>>(configuredSourceKeys);
  const { running, result, error, runId, submit, analystTraces, reset: resetAnalysis } = useAnalysis(socket);
  // Analyst wall is driven by the REAL per-analyst events streamed from the
  // backend for the most recent submission's tickers.
  const [wallTickers, setWallTickers] = useState<string[]>([]);
  // Which agency (node composition) is selected. Drives the wall's analyst set
  // so agencies with a different node count (e.g. the 4-node crypto-screener)
  // render their own panels instead of the hardcoded 7-analyst layout.
  // Controlled when the parent passes agencyId (§12.4.1), else internal.
  const [agencyIdInternal, setAgencyIdInternal] = useState<AgencyId>(DEFAULT_AGENCY);
  const agencyId = agencyIdProp ?? agencyIdInternal;
  // Bumped after a re-org or agency CRUD save so the wall + dropdown re-render
  // immediately from the mutated AGENCIES mirror (no "next run" deferral).
  const [registryVersion, setRegistryVersion] = useState(0);
  // Symbol pills for the "Ticker symbols" input. Lifted here so the Screener's
  // "→ Add" (and other surfaces) can drop a ticker into the field without
  // auto-submitting — the user reviews/edits it, then hits Analyze themselves.
  const [symbolPills, setSymbolPills] = useState<string[]>([]);
  // Append a ticker to the pill list (dedupe + hard cap at 6). Used by the
  // Watchlist chip + Screener "→ Add" so those surfaces ADD rather than replace.
  const addSymbol = (s: string) => {
    const sym = s.trim().toUpperCase();
    if (!sym) return;
    setSymbolPills((prev) => {
      if (prev.includes(sym) || prev.length >= 6) return prev;
      return [...prev, sym];
    });
  };
  // Phase 7.5: a "preview" ticker set that fills the Chart/Quote/Options card
  // IMMEDIATELY on (a) a Watchlist chip click or (b) leaving the Ticker symbols
  // input — WITHOUT triggering the agency run. [Analyze] is still the only thing
  // that starts the agents' work (wallTickers). The preview is validated first
  // via a quote lookup; if the ticker isn't found, nothing is shown.
  const [previewTickers, setPreviewTickers] = useState<string[]>([]);
  const [previewChecking, setPreviewChecking] = useState(false);
  // Validate a candidate symbol against the quote endpoint. Resolves to the
  // upper-cased symbol if it exists, or null if not found / errored.
  const resolvePreview = async (raw: string): Promise<string[]> => {
    const syms = raw
      .split(',')
      .map((t) => t.trim().toUpperCase())
      .filter((t) => t.length > 0);
    if (syms.length === 0) return [];
    setPreviewChecking(true);
    try {
      const found = await Promise.all(
        syms.map(async (s) => {
          try {
            const q = await getQuote(s);
            // A quote that resolved but carries a "no data" note is treated as
            // not-found (e.g. unsupported symbol) — nothing shown.
            return q && !q.note ? s : null;
          } catch {
            return null;
          }
        }),
      );
      return found.filter((s): s is string => s !== null);
    } finally {
      setPreviewChecking(false);
    }
  };
  // Screener expand/collapse state, lifted so "→ Add" can collapse the
  // panel (after filling the input + starting the run).
  const [screenerOpen, setScreenerOpen] = useState(false);
  // "Agencies Analysts" collapsible wrapper around the Analyst Wall cards.
  // Default expanded per request.
  const [analystsOpen, setAnalystsOpen] = useState(true);
  // Collapsible wrappers for the Results and Relations sections (default open).
  const [resultsOpen, setResultsOpen] = useState(true);
  const [relationsOpen, setRelationsOpen] = useState(true);
  // Top collapsible grouping the Watchlist + Ticker symbols + Stock Screener.
  const [topSectionOpen, setTopSectionOpen] = useState(true);
  // Ticker symbols (pill input) is its own top-level section, separate from the
  // Watchlist & Screeners collapsible.
  const [tickerSectionOpen, setTickerSectionOpen] = useState(true);
  // Agency switching is guarded by requestAgency/commitAgency (defined below
  // handleSubmit, once resetWall + resetAnalysis are in scope).
  const agencyAnalysts: AnalystMeta[] = agencyById(agencyId).analysts
    .map((id) => analystById(id as AnalystId))
    .filter(Boolean);
  const { state: wall, reset: resetWall } = useAnalystRun(socket, wallTickers, { analystIds: agencyAnalysts.map((a) => a.id) });
  // Phase F: load each analyst's shipped flavor set for the current agency so
  // the Settings dialog can offer a flavor dropdown. Non-fatal if it fails.
  // NOTE: depend only on agencyId + sessionId — `agencyAnalysts` is a fresh
  // array every render and would otherwise retrigger this effect in a loop.
  useEffect(() => {
    let cancelled = false;
    const ids = agencyById(agencyId).analysts;
    Promise.all(
      ids.map(async (id) => {
        try {
          const data = await getAnalystFlavors(sessionId, agencyId, id as string);
          return { id: id as string, data };
        } catch {
          return { id: id as string, data: undefined };
        }
      }),
    ).then((results) => {
      if (cancelled) return;
      const map: Record<string, GetAnalystFlavorsResponse> = {};
      for (const r of results) if (r.data) map[r.id] = r.data;
      setLiveFlavorsById(map);
    });
    return () => {
      cancelled = true;
    };
  }, [agencyId, sessionId, registryVersion, registryVersionProp]);
  // Which analyst's drill-down drawer is open (null = closed).
  const [openAnalyst, setOpenAnalyst] = useState<AnalystId | null>(null);
  // §Card-settings: which analyst's Settings panel is open (null = closed).
  const [settingsAnalyst, setSettingsAnalyst] = useState<AnalystId | null>(null);
  // Per-agency settings dialog (moved out of the top-right Settings dialog):
  // open when true, targets the currently selected agency.
  const [agencySettingsOpen, setAgencySettingsOpen] = useState(false);
  // §Card-settings: analysts the user has saved config for (shows ✓ on gear).
  const [configuredAnalystIds, setConfiguredAnalystIds] = useState<Set<string>>(new Set());
  // Phase 5: compare mode toggle — enabled when 2-5 tickers are in the current
  // run so the user can switch the market-row into a relative-performance view.
  const [compareMode, setCompareMode] = useState(false);
  // Compare requires a completed [Analyze] run covering the entered tickers, so
  // the side-by-side verdicts are populated from real agent output. (The chart +
  // correlation fetch live history regardless, but the verdicts need the run.)
  const runCoversPills =
    wallTickers.length > 0 && symbolPills.every((t) => wallTickers.includes(t));
  // Phase F: shipped flavor sets per analyst id (for the current agency), keyed by analyst id.
  // Now stores the FULL GetAnalystFlavorsResponse (incl. instructions + selectedId) so the
  // trace drawer can show the LIVE (just-edited) Role & Instructions immediately after a save,
  // without requiring a re-run. (Previously it only kept {id,name,role}, so edits were invisible
  // until the next analysis.)
  const [liveFlavorsById, setLiveFlavorsById] = useState<Record<string, GetAnalystFlavorsResponse>>({});
  // Whether the currently-displayed result has been saved/exported. Resets on
  // every new run; gates the "unsaved results" confirm-before-switch prompt.
  const [saved, setSaved] = useState(false);
  // Target agency while a switch is blocked by unsaved data (null = no prompt).
  const [pendingAgency, setPendingAgency] = useState<AgencyId | null>(null);
  // Reload a single analyst's flavor set (called after a save) so the wall + drawer reflect edits.
  const reloadFlavors = async (analystId: string) => {
    try {
      const data = await getAnalystFlavors(sessionId, agencyId, analystId);
      setLiveFlavorsById((prev) => ({ ...prev, [analystId]: data }));
    } catch {
      /* non-fatal */
    }
  };

  // Build the per-card Settings schema for the CURRENT agency from the source
  // catalog (drives which cards show a gear + what the dialog renders).
  const settingsSchemas: Record<string, AnalystConfigSchema> = {};
  for (const meta of agencyAnalysts) {
    const cat = sourceCatalog.analysts.find((c) => c.analystId === meta.id);
    const schema = buildAnalystConfigSchema(
      meta.id,
      meta.name,
      cat ? cat.sources : [],
    );
    // Surface the Polygon options sources in the Data Ingestion card's Settings
    // dialog too (mirrors the General dialog → Sources tab). Polygon is always
    // resolved/stored under `options_ingestion`, so tag each with that
    // analystId so the saved key lands where the options engine acquires it —
    // not under data_ingestion (which never consumes Polygon).
    if (meta.id === 'data_ingestion') {
      const optCat = sourceCatalog.analysts.find((c) => c.analystId === 'options_ingestion');
      if (optCat && optCat.sources.length > 0) {
        const optSources = buildAnalystConfigSchema(
          'options_ingestion',
          'Options Ingestion',
          optCat.sources,
        ).sources;
        for (const s of optSources) {
          schema.sources.push({ ...s, analystId: 'options_ingestion' });
        }
      }
    }
    // Phase F: attach the analyst's shipped flavor set (drives the Flavors
    // section + gear in the Settings dialog). Fetched once per agency change.
    const fl = liveFlavorsById[meta.id];
    schema.flavors = fl
      ? fl.flavors.map((f) => ({ id: f.id, name: f.name, role: f.role }))
      : [];
    // A card with flavors or weights is user-configurable, so the settings gear
    // must show even when the analyst has no credentialed source (e.g. the
    // options analysts ship flavors but no weights). Note: a credentialed
    // SOURCE alone does NOT make the settings gear appear — sources are owned
    // by the separate source-config gear, and we must not open the settings
    // dialog to a duplicate/empty source section.
    schema.hasConfig = schema.weights.length + schema.flavors.length > 0;
    settingsSchemas[meta.id] = schema;
  }
  const handleSubmit = (tickers: string[]) => {
    setWallTickers(tickers);
    setPreviewTickers([]); // the run now owns the displayed card; drop the preview
    setOpenAnalyst(null);
    setSaved(false);
    setPendingAgency(null);
    setCompareMode(false);
    submit(tickers, sessionId, agencyId);
  };

  // Confirm-before-switch guard: if a completed result exists and hasn't been
  // saved/exported yet, ask before wiping the displayed cards + results.
  const commitAgency = (id: AgencyId) => {
    setAgencyIdInternal(id);
    onAgencyChange?.(id);
    resetWall();
    setWallTickers([]);
    resetAnalysis();
    setOpenAnalyst(null);
    setPendingAgency(null);
    setSaved(false);
  };
  const requestAgency = (id: AgencyId) => {
    if (id === agencyId) return;
    if (result && !saved) {
      setPendingAgency(id);
      return;
    }
    commitAgency(id);
  };

  const traceAvailable = (id: AnalystId) =>
    analystTraces.some((t) => t.analyst === id);

  // §4.9 analysts whose trace is degraded (ran on a reduced source set).
  const degradedIds = new Set<AnalystId>(
    analystTraces.filter((t) => t.degraded).map((t) => t.analyst),
  );

  return (
    <div className="analysis-view">
      {/* The agency (node composition) is the user's FIRST decision, so the
          selector sits above the ticker input. Selecting an agency immediately
          drives the analyst cards shown below (see agencyAnalysts + AnalystWall).
          The ⚙ button opens the per-agency settings dialog (default model). */}
      <div className="agency-row">
        <AgencySelect value={agencyId} onChange={requestAgency} disabled={running} />
        <button
          type="button"
          className="agency-settings-gear"
          aria-label={`${agencyById(agencyId).name} settings`}
          title="Agency settings"
          onClick={() => setAgencySettingsOpen(true)}
        >
          ⚙
        </button>
      </div>

      {/* Phase 7: persistent Watchlist / Portfolio — the user's "my tickers"
          home. Lands above the form so returning users see their saved
          symbols first; clicking a chip deep-dives via the analysis tool. */}

      {/* Top collapsible: Watchlist + Stock Screener, grouped for a compact
          default view. Frame + header stay visible when collapsed (only the
          inner content animates). Sits just below the agency selector so the
          agency remains the first analysis control. The Ticker symbols input
          is a SEPARATE top-level section below. */}
      <div className="top-section" data-testid="top-section">
        <button
          type="button"
          className="collapsible-section-toggle"
          aria-expanded={topSectionOpen}
          data-testid="top-section-toggle"
          onClick={() => setTopSectionOpen((v) => !v)}
        >
          {topSectionOpen ? '▾' : '▸'} Watchlist &amp; Screeners
        </button>
        <div className="collapsible" aria-expanded={topSectionOpen}>
          <div className="collapsible-inner">
            <WatchlistBar
              // Clicking a watchlist chip drops the ticker into the Ticker symbols
              // input box AND immediately previews the Chart/Quote/Options card —
              // the agents' work still waits for [Analyze]. The chart appears once
              // the symbol is validated; if it isn't found, nothing shows.
              onOpen={async (s) => { addSymbol(s); const r = await resolvePreview(s); setPreviewTickers((prev) => [...new Set([...prev, ...r])]); }}
              onAnalyze={async (s) => { addSymbol(s); const r = await resolvePreview(s); setPreviewTickers((prev) => [...new Set([...prev, ...r])]); }}
            />

            {/* Phase 6: Stock Screener — find the most promising tickers for the
                selected agency. Sits directly below the Watchlist. The row "→ Add"
                action drops the ticker into the Ticker symbols input (as a pill)
                so the user can include it in their next [Analyze] run — it does NOT
                auto-run, and the panel stays open so more tickers can be added. */}
            <ScreenerPanel
              agencyId={agencyId}
              open={screenerOpen}
              onOpenChange={setScreenerOpen}
              onPick={(t) => { addSymbol(t); }}
            />
          </div>
        </div>
      </div>

      {/* Ticker symbols (pill input) — its own top-level section, separate from
          Watchlist & Screeners. Collapsible so the user can hide the input once
          they've entered their tickers. */}
      <div className="ticker-section" data-testid="ticker-section">
        <button
          type="button"
          className="collapsible-section-toggle"
          aria-expanded={tickerSectionOpen}
          data-testid="ticker-section-toggle"
          onClick={() => setTickerSectionOpen((v) => !v)}
        >
          {tickerSectionOpen ? '▾' : '▸'} Ticker symbols
        </button>
        <div className="collapsible" aria-expanded={tickerSectionOpen}>
          <div className="collapsible-inner">
            <AnalysisForm
              onSubmit={handleSubmit}
              running={running}
              sessionId={sessionId}
              onSessionChange={onSessionChange}
              symbols={symbolPills}
              onSymbolsChange={setSymbolPills}
              // Leaving the Ticker symbols field previews the chart for whatever
              // was typed (validated first; not-found → nothing shown). This is a
              // convenience preview only — [Analyze] still starts the agency run.
              onBlur={async (v) => { setPreviewTickers(await resolvePreview(v)); }}
            />
          </div>
        </div>
      </div>

      {/* Phase M: after a symbol is submitted, show a SINGLE unified market card
          (Chart / Quote / History / Options tabs) instead of three separate
          panels. The card also previews immediately on a Watchlist chip click or
          leaving the Ticker symbols field (previewTickers) — that path does NOT
          start the agency run; only [Analyze] populates wallTickers. */}
      {/* Compare affordance: enabled only once the entered tickers have been
          analyzed (a completed [Analyze] run), so the side-by-side verdicts are
          populated from real agent output. Typing 2–6 pills is necessary but not
          sufficient — the user must run [Analyze] first; otherwise we show a
          hint instead of a button that would render empty verdicts. */}
      {symbolPills.length >= 1 && (
        symbolPills.length >= 2 && symbolPills.length <= 6 ? (
          runCoversPills ? (
            <div className="compare-toggle-row" data-testid="compare-toggle-row">
              <button
                type="button"
                className={`compare-toggle ${compareMode ? 'active' : ''}`}
                aria-pressed={compareMode}
                data-testid="compare-toggle"
                onClick={() => setCompareMode((v) => !v)}
              >
                {compareMode ? 'Exit compare' : 'Compare tickers'}
              </button>
              <span className="compare-hint">Comparing {symbolPills.length} tickers</span>
            </div>
          ) : (
            <span className="compare-hint" data-testid="compare-hint-run">
              Run [Analyze] on these tickers first to compare their verdicts.
            </span>
          )
        ) : (
          <span className="compare-hint" data-testid="compare-hint-guide">
            Enter 2–6 tickers as pills in “Ticker symbols” to compare them.
          </span>
        )
      )}

      {/* Main area: CompareView when comparing, otherwise the per-ticker cards
          (from the last run / preview). The displayed set is always filtered to
          the tickers currently in the input (symbolPills): removing a pill must
          remove that ticker's chart. After a run, show only the run's tickers
          that are still in the input; before any run, show the entered pills
          UNIONed with any previewed symbols. */}
      {compareMode && runCoversPills && symbolPills.length >= 2 && symbolPills.length <= 6 ? (
        <CompareView tickers={symbolPills} result={result} />
      ) : (
        (() => {
          // The input pills are the source of truth for what the user wants
          // graphed. Filter the active data source (the last run if any, else
          // the preview set) down to tickers still in the input, so removing a
          // pill removes that ticker's chart. Fall back to the pills themselves
          // when nothing from the run/preview overlaps the input.
          const source = wallTickers.length > 0 ? wallTickers : previewTickers;
          let displayTickers = source.filter((t) => symbolPills.includes(t));
          if (displayTickers.length === 0) {
            displayTickers = symbolPills.length > 0
              ? symbolPills
              : [...new Set([...symbolPills, ...previewTickers])];
          }
          return (
            displayTickers.length > 0 && (
              <div className="market-row" data-testid="market-row">
                {displayTickers.map((t) => (
                  <MarketDataCard
                    key={t}
                    symbol={t}
                    agencyId={agencyId}
                    technical={result?.technical_analysis?.[t] ?? null}
                    sentiment={result?.sentiment_analysis?.[t] ?? null}
                  />
                ))}
              </div>
            )
          );
        })()
      )}

      {!connected && (
        <p className="connect-hint" role="status">
          Connect to the analysis server to run an analysis.
        </p>
      )}

      {running && (
        <p className="analyzing" role="status">
          Analyzing… (streaming agent output)
        </p>
      )}

      {error && (
        <p className="analysis-error" role="alert">
          {error}
        </p>
      )}

      {/* The wall reflects the SELECTED agency's analyst set. It is shown as
          soon as an agency is chosen (always, since there is a default), so the
          user sees the right cards before they even type a ticker. Running an
          analysis then lights these same panels as the agents execute.
          Wrapped in a collapsible "[Agencies Analysts]" section (default open).
          The frame + header live OUTSIDE .collapsible so the section stays
          visible when collapsed (only the inner content animates). */}
      <div className="agencies-analysts" data-testid="agencies-analysts">
        <button
          type="button"
          className="agencies-analysts-toggle"
          aria-expanded={analystsOpen}
          data-testid="agencies-analysts-toggle"
          onClick={() => setAnalystsOpen((v) => !v)}
        >
          {analystsOpen ? '▾' : '▸'} Agencies Analysts
        </button>
        <div className="collapsible" aria-expanded={analystsOpen}>
          <div className="collapsible-inner">
            <AnalystWall
              run={wall}
              traceAvailable={traceAvailable}
              onOpen={setOpenAnalyst}
              degradedIds={degradedIds}
              sourceConfiguredAnalysts={sourceCatalog.analysts}
              onConfigure={setSettingsAnalyst}
              configuredSourceKeys={configuredSourceKeys}
              settingsSchemas={settingsSchemas}
              configuredAnalystIds={configuredAnalystIds}
              analysts={agencyAnalysts}
            />
          </div>
        </div>
      </div>

      <div className="results-section" data-testid="results-section">
        <button
          type="button"
          className="collapsible-section-toggle"
          aria-expanded={resultsOpen}
          data-testid="results-section-toggle"
          onClick={() => setResultsOpen((v) => !v)}
        >
          {resultsOpen ? '▾' : '▸'} Results
        </button>
        <div className="collapsible" aria-expanded={resultsOpen}>
          <div className="collapsible-inner">
            <ResultsPanel key={runId} agencyId={agencyId} result={result} onResultSaved={() => setSaved(true)} />
          </div>
        </div>
      </div>

      {result && (
        <div className="relations-section" data-testid="relations-section">
          <button
            type="button"
            className="collapsible-section-toggle"
            aria-expanded={relationsOpen}
            data-testid="relations-section-toggle"
            onClick={() => setRelationsOpen((v) => !v)}
          >
            {relationsOpen ? '▾' : '▸'} Relations
          </button>
          <div className="collapsible" aria-expanded={relationsOpen}>
            <div className="collapsible-inner">
              <RelationsGraphView result={result} width={600} height={360} />
            </div>
          </div>
        </div>
      )}

      <AnalystTraceDrawer
        traces={analystTraces}
        analystId={openAnalyst}
        onClose={() => setOpenAnalyst(null)}
        onSelect={setOpenAnalyst}
        liveFlavorsById={liveFlavorsById}
        onFlavorSaved={reloadFlavors}
      />

      <AnalystSettingsDialog
        open={settingsAnalyst !== null}
        onClose={() => setSettingsAnalyst(null)}
        analystId={settingsAnalyst ?? ''}
        analystName={settingsAnalyst ? analystById(settingsAnalyst as AnalystId).name : ''}
        agencyId={agencyId}
        schema={settingsAnalyst ? settingsSchemas[settingsAnalyst]! : ({} as AnalystConfigSchema)}
        sessionId={sessionId}
        onSaved={(id) => {
          setConfiguredAnalystIds((prev) => new Set(prev).add(id));
          // Refresh the catalog so the "stored" indicator is truthful next open.
          onSourceSaved?.();
        }}
        onFlavorSaved={reloadFlavors}
      />

      <AgencySettingsDialog
        open={agencySettingsOpen}
        onClose={() => setAgencySettingsOpen(false)}
        agencyId={agencyId}
        agencyName={agencyById(agencyId).name}
        sessionId={sessionId}
        onRegistryChange={() => setRegistryVersion((v) => v + 1)}
      />

      {pendingAgency && (
        <div
          className="agency-switch-confirm"
          role="dialog"
          aria-modal="true"
          aria-label="Unsaved results — confirm agency switch"
          data-testid="agency-switch-confirm"
        >
          <div className="agency-switch-confirm-box">
            <p className="agency-switch-confirm-msg">
              You have unsaved analysis results for the current agency. Switching to{' '}
              <strong>{agencyById(pendingAgency).name}</strong> will clear the displayed data.
              Switch anyway?
            </p>
            <div className="agency-switch-confirm-actions">
              <button
                type="button"
                className="btn-primary"
                data-testid="agency-switch-confirm-yes"
                onClick={() => commitAgency(pendingAgency)}
              >
                Switch &amp; clear
              </button>
              <button
                type="button"
                className="btn-secondary"
                data-testid="agency-switch-confirm-no"
                onClick={() => setPendingAgency(null)}
              >
                Keep current
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default AnalysisView;

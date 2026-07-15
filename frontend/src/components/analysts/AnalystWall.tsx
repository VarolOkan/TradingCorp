// frontend/src/components/analysts/AnalystWall.tsx
// The "wall of analysts": one framed panel per analyst. Each panel shows the
// analyst's identity, the ticker it is currently processing, a shimmer progress
// bar, and a status dot (idle / active / done). All panels stay visible; the
// active one is highlighted with its accent color. Clicking a panel with a
// completed trace opens the drill-down drawer.
//
// B1: an analyst panel that declares a LIVE+auth data source (per the server's
// /analyst-config catalog) also shows a "⚙ Configure source" button so the user
// can supply a per-source token. The button is intentionally hidden for
// mock-only analysts.

import { useState, useEffect } from 'react';
import { ANALYSTS } from './analysts';
import type { AnalystMeta } from './analysts';
import type { AnalystRunState } from '../../hooks/useAnalystRun';
import type { AnalystId } from './analysts';
import type { AnalystSourceCatalogAnalyst } from '../../types';
import type { AnalystConfigSchema } from './analystConfigSchema';

export interface AnalystWallProps {
  run: AnalystRunState;
  /** Analyst ids that have a trace available (i.e. a completed analysis). */
  traceAvailable?: (id: AnalystId) => boolean;
  /** Open the drill-down drawer for the given analyst. */
  onOpen?: (id: AnalystId) => void;
  /** Analyst ids whose trace is degraded (ran on a reduced source set). */
  degradedIds?: Set<AnalystId>;
  /**
   * B1/source catalog: analysts that declare a LIVE+auth source. Used to decide
   * whether the unified Settings dialog exposes a "Sources" tab and whether the
   * card shows a ✓ (all sources configured). Omit / empty → no Sources tab.
   */
  sourceConfiguredAnalysts?: AnalystSourceCatalogAnalyst[];
  /** Set of `${analystId}:${sourceId}` pairs already configured (shows ✓). */
  configuredSourceKeys?: Set<string>;
  /**
   * §Card-settings: per-analyst Settings schema. A card shows a gear only when
   * its schema.hasConfig is true (i.e. it has weights and/or flavors). Omit →
   * no gear. Combined with a credentialed source, the card shows ONE gear that
   * opens the unified dialog (tabs: Sources / Role & Instructions / Weights).
   */
  settingsSchemas?: Record<string, AnalystConfigSchema>;
  /**
   * Open the unified per-card Settings dialog for the given analyst. Covers
   * sources + flavors + weights — there is no longer a separate source gear.
   */
  onConfigure?: (analystId: AnalystId) => void;
  /** Which analysts are currently configured (shows ✓ on the gear). */
  configuredAnalystIds?: Set<string>;
  /**
   * Phase 4: which analysts to render. Defaults to the full ANALYSTS mirror.
   * When an agency is selected this is the agency's analyst set, so agencies
   * with a different node count / different analysts render correctly.
   */
  analysts?: AnalystMeta[];
}

export function AnalystWall({
  run,
  traceAvailable,
  onOpen,
  degradedIds,
  sourceConfiguredAnalysts = [],
  configuredSourceKeys = new Set<string>(),
  settingsSchemas = {},
  onConfigure,
  configuredAnalystIds = new Set<string>(),
  analysts = ANALYSTS,
}: AnalystWallProps) {
  const hasTraceFor = traceAvailable ?? (() => false);
  const openFor = onOpen ?? (() => {});
  const degraded = degradedIds ?? new Set<AnalystId>();
  const openConfigure = onConfigure ?? (() => {});

  // Live count-up: re-render every 200ms while any analyst is still running so
  // active panels show a ticking timer. Done panels read their frozen
  // durationMs (no interval needed). Stops ticking once the run completes.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!run.running) return;
    const h = setInterval(() => setTick((t) => t + 1), 200);
    return () => clearInterval(h);
  }, [run.running]);

  // Elapsed seconds for a cell, formatted to 1 decimal (e.g. "4.1s").
  const elapsedFor = (cell?: (typeof run.cells)[number]): string | null => {
    if (!cell) return null;
    if (cell.phase === 'done' && typeof cell.durationMs === 'number') {
      return `${(cell.durationMs / 1000).toFixed(1)}s`;
    }
    if (cell.phase === 'active' && typeof cell.startTime === 'number') {
      return `${((Date.now() - cell.startTime) / 1000).toFixed(1)}s`;
    }
    return null;
  };
  return (
    <div className="analyst-wall" role="list" aria-label="Analyst panels" data-tick={tick}>
      {(analysts ?? ANALYSTS).map((a) => {
        const cell = run.cells.find((c) => c.analyst === a.id);
        const phase = cell?.phase ?? 'idle';
        const ticker = cell?.ticker ?? null;
        const task = cell?.task ?? null;
        const progress = cell?.progress ?? 0;
        const hasTrace = hasTraceFor(a.id);
        const isDegraded = hasTrace && degraded.has(a.id);
        const className = [
          'analyst-panel',
          `stage-${a.stage}`,
          `phase-${phase}`,
          hasTrace ? 'clickable' : '',
          isDegraded ? 'degraded' : '',
        ].join(' ');

        return (
          <article
            key={a.id}
            role="listitem"
            className={className}
            style={{ ['--accent' as any]: a.accent }}
            aria-busy={phase === 'active'}
            onClick={hasTrace ? () => openFor(a.id) : undefined}
            onKeyDown={
              hasTrace
                ? (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      openFor(a.id);
                    }
                  }
                : undefined
            }
            tabIndex={hasTrace ? 0 : undefined}
            aria-label={hasTrace ? `Open ${a.name} analysis trace` : a.name}
            data-testid={`panel-${a.id}`}
          >
            <header className="panel-head">
              <span className="monogram" aria-hidden>
                {a.monogram}
              </span>
              <div className="panel-title">
                <h3>{a.name}</h3>
                <p className="role">{a.role}</p>
              </div>
              <span className={`status-dot status-${phase}`} aria-hidden />
              {(() => {
                const t = elapsedFor(cell);
                return t ? (
                  <span
                    className={`panel-timer phase-${phase}`}
                    title={phase === 'active' ? 'Elapsed so far' : 'Run time'}
                    data-testid={`panel-timer-${a.id}`}
                  >
                    {t}
                  </span>
                ) : null;
              })()}
              {isDegraded && (
                <span className="panel-degraded-badge" title="This analyst ran on a reduced source set" data-testid={`panel-degraded-${a.id}`}>
                  ⚠ degraded
                </span>
              )}
              {(() => {
                // A card shows ONE gear when the analyst is configurable at all:
                //   • a LIVE+auth source (Sources tab), and/or
                //   • a settings schema with weights and/or flavors (Role &
                //     Instructions tab / Weights tab).
                // Clicking opens the unified Settings dialog with tabs — matching
                // the main Settings dialog's [Connection] / [LLM Models] pattern.
                const cat = sourceConfiguredAnalysts.find((x) => x.analystId === a.id);
                const hasSource = !!cat && cat.sources.length > 0;
                const schema = settingsSchemas[a.id];
                const hasSettings = !!schema && schema.hasConfig;
                if (!hasSource && !hasSettings) return null;

                const allSourcesDone =
                  !cat || cat.sources.every((s) => configuredSourceKeys.has(`${cat.analystId}:${s.id}`));
                const settingsDone = !hasSettings || configuredAnalystIds.has(a.id);
                const fullyDone = allSourcesDone && settingsDone;

                return (
                  <span className="panel-gears">
                    <button
                      type="button"
                      className="panel-configure-gear"
                      title={fullyDone ? 'Configured' : 'Configure analyst'}
                      aria-label={`Configure ${a.name}`}
                      data-testid={`panel-gear-${a.id}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        openConfigure(a.id);
                      }}
                    >
                      {fullyDone ? '✓' : '⚙'}
                    </button>
                  </span>
                );
              })()}
            </header>

            <div className="panel-body">
              <div className="ticker-row">
                <span className="ticker-label">Ticker</span>
                <span className="ticker-value">{ticker ?? '—'}</span>
              </div>
              <p className="task-line">{phase === 'idle' ? 'Standing by' : task}</p>
              {hasTrace && <p className="panel-cta">View trace →</p>}
            </div>

            <div className="shimmer-track" aria-hidden>
              <div
                className="shimmer-fill"
                style={{
                  width: `${Math.round(progress * 100)}%`,
                  opacity: phase === 'idle' ? 0 : 1,
                }}
              />
            </div>
          </article>
        );
      })}
    </div>
  );
}

export default AnalystWall;

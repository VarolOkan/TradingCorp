// frontend/src/components/ResultsPanel.tsx
import { useState } from 'react';
import type { AnalysisResult } from '../types';
import { ANALYSTS } from './analysts/analysts';
import { postReport, reportViewUrl, type ReportFiles } from '../api/reportClient';

export interface ResultsPanelProps {
  result: AnalysisResult | null;
  /** Selected agency for THIS run — tagged onto the saved report so the
   *  calendar groups/filters by the agency the user actually analyzed with
   *  (not the backend's default). */
  agencyId?: string;
  /** Called after a successful Save/export so the parent can mark the run saved. */
  onResultSaved?: () => void;
}

function decisionLabel(d: AnalysisResult['decision']): string {
  switch (d) {
    case 'APPROVE':
      return 'Approve';
    case 'REJECT':
      return 'Reject';
    case 'ERROR':
      return 'Error';
    default:
      return String(d);
  }
}

// ---------------------------------------------------------------------------
// Thesis presentation (Phase A). Render a compact, scannable verdict grid from
// the structured `analystTraces` already on the payload, instead of the old
// single \n-joined narrative paragraph. Falls back to the raw `investment_thesis`
// string when no traces are present (parity for legacy payloads).
// ---------------------------------------------------------------------------

const ANALYST_NAME: Record<string, string> = Object.fromEntries(
  ANALYSTS.map((a) => [a.id, a.name]),
);

function prettyName(id: string): string {
  if (ANALYST_NAME[id]) return ANALYST_NAME[id];
  return id
    .replace(/[_-]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Map an opaque verdict string onto a traffic-light class. */
function verdictClass(v: string | null | undefined): string {
  if (!v) return 'v-neutral';
  const s = v.toUpperCase();
  const positive = [
    'APPROVE', 'BULLISH', 'GO', 'EDGE', 'POSITIVE', 'CONTROLLED', 'FAIR',
    'CHEAP', 'LOW', 'MODERATE', 'BULL',
  ];
  const negative = [
    'REJECT', 'BEARISH', 'WAIT', 'NO_EDGE', 'NEGATIVE', 'EXPOSED', 'RICH',
    'HIGH', 'EXTREME', 'BEAR',
  ];
  if (positive.some((g) => s.includes(g))) return 'v-positive';
  if (negative.some((g) => s.includes(g))) return 'v-negative';
  return 'v-neutral';
}

interface ThesisRow {
  id: string;
  name: string;
  verdict: string | null;
  score: number | null;
  summary: string;
}

/** Which traces carry a decision-relevant verdict (exclude intake/coord nodes). */
const NON_VERDICT = new Set(['orchestrator', 'data_ingestion', 'options_ingestion']);

function buildThesisRows(result: AnalysisResult): ThesisRow[] {
  const traces = Array.isArray(result.analystTraces) ? result.analystTraces : [];
  return traces
    .filter((t) => !NON_VERDICT.has(t.analyst))
    .filter((t) => (t.output?.verdict) || typeof t.output?.score === 'number')
    .map((t) => ({
      id: t.analyst,
      name: prettyName(t.analyst),
      verdict: t.output?.verdict ?? null,
      score: typeof t.output?.score === 'number' ? t.output!.score : null,
      summary: typeof t.output?.summary === 'string' ? t.output!.summary : '',
    }));
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max).replace(/\s+\S*$/, '');
}

export function ResultsPanel({ result, agencyId, onResultSaved }: ResultsPanelProps) {
  const [exporting, setExporting] = useState(false);
  const [reportFiles, setReportFiles] = useState<ReportFiles | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  if (!result) return null;

  const { decision, confidence, reasoning, preservation_rationale, conditions } = result;
  const risk = result.risk_assessment;

  const handleExport = async () => {
    setExporting(true);
    setExportError(null);
    setReportFiles(null);
    try {
      // The socket payload already carries the normalized fields the backend's
      // report builder consumes (decisions, riskAssessments, analystTraces,
      // dataHealth, company_name, ...). POST it as-is.
      const res = await postReport(result as any, agencyId ? { agencyId } : undefined);
      if (!res.ok) throw new Error(res.error || 'Report generation failed.');
      setReportFiles(res.files);
      onResultSaved?.();
    } catch (e: any) {
      setExportError(e?.message || 'Report generation failed.');
    } finally {
      setExporting(false);
    }
  };

  return (
    <section className="results-panel" aria-live="polite">
      <header className={`result-head decision-${decision.toLowerCase()}`}>
        <span className="decision-badge">{decisionLabel(decision)}</span>
        {confidence != null && (
          <span className="confidence">Confidence: {(confidence * 100).toFixed(0)}%</span>
        )}
        {result.company_name && (
          <span className="company">{result.company_name}</span>
        )}
      </header>

      {result.mockDisabled && (
        <div className="mock-disabled-banner" role="alert" data-testid="mock-disabled-banner">
          ⚠ Mock data disabled (DISABLE_MOCK_DATA). No live source is configured, so the
          analyst outputs below are <strong>empty — not real and not fabricated</strong>.
          Configure a live data source (API key / endpoint) to produce genuine analysis.
        </div>
      )}

      {(() => {
        // Phase B: prefer the backend-computed thesisSummary when present
        // (single source of truth). Fall back to deriving rows from
        // analystTraces (Phase A), then to the raw narrative string.
        const summary = result.thesisSummary;
        const rows: ThesisRow[] = summary
          ? summary.rows.map((r) => ({
              id: r.analyst,
              name: r.name,
              verdict: r.verdict,
              score: r.score,
              summary: r.summary ?? '',
            }))
          : buildThesisRows(result);
        const reasoningText =
          summary && summary.reasoning ? summary.reasoning : result.reasoning;

        if (rows.length > 0) {
          return (
            <div className="thesis thesis-grid" aria-label="Investment thesis summary">
              <div className="thesis-head">Investment Thesis</div>
              <div className="thesis-rows">
                {rows.map((r) => (
                  <div className="thesis-row" key={r.id}>
                    <span className="thesis-name">{r.name}</span>
                    <span className={`thesis-verdict ${verdictClass(r.verdict)}`}>
                      {r.verdict ?? (r.score != null ? `${r.score}` : '—')}
                    </span>
                    {r.score != null && (
                      <span className="thesis-score">{r.score}</span>
                    )}
                    <span className="thesis-summary">
                      {r.summary ? truncate(r.summary, 120) : ''}
                    </span>
                  </div>
                ))}
              </div>
              {reasoningText && (
                <div className="thesis-synthesis">
                  <span className="thesis-syn-label">Synthesis: </span>
                  {truncate(reasoningText, 180)}
                </div>
              )}
            </div>
          );
        }
        if (result.investment_thesis) {
          return (
            <p className="thesis">
              <strong>Thesis:</strong> {result.investment_thesis}
            </p>
          );
        }
        return null;
      })()}

      {result.dataHealth && result.dataHealth.sourcesTotal > 0 && (() => {
        const dh = result.dataHealth!;
        const ratio = dh.sourcesTotal > 0 ? dh.sourcesOk / dh.sourcesTotal : 1;
        const level = ratio >= 1 ? 'ok' : ratio > 0 ? 'degraded' : 'down';
        const label = level === 'ok' ? 'All sources live' : level === 'degraded' ? 'Degraded data' : 'Sources unavailable';
        return (
          <div className={`data-health data-health-${level}`} role="status" aria-label={`Data health: ${label}`}>
            <span className="data-health-dot" aria-hidden="true" />
            <span className="data-health-label">{label}</span>
            <span className="data-health-count">
              {dh.sourcesOk}/{dh.sourcesTotal} sources
            </span>
            {dh.usedMockFallback && (
              <span className="data-health-mock" title="One or more analysts fell back to mock data">
                mock fallback
              </span>
            )}
            {dh.degradedAnalysts.length > 0 && (
              <span className="data-health-analysts">
                degraded: {dh.degradedAnalysts.join(', ')}
              </span>
            )}
          </div>
        );
      })()}

      <div className="reasoning">
        <h3>Reasoning</h3>
        <p>{reasoning}</p>
      </div>

      {preservation_rationale && (
        <div className="preservation">
          <h3>Preservation rationale</h3>
          <p>{preservation_rationale}</p>
        </div>
      )}

      {Array.isArray(conditions) && conditions.length > 0 && (
        <div className="conditions">
          <h3>Conditions</h3>
          <ul>
            {conditions.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </div>
      )}

      {risk && Object.keys(risk).length > 0 && (
        <div className="risk">
          <h3>Risk assessment</h3>
          <ul>
            {Object.entries(risk).map(([k, v]) => (
              <li key={k}>
                <strong>{k}:</strong> {typeof v === 'object' ? JSON.stringify(v) : String(v)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {result.error && (
        <p className="result-error" role="alert">
          {result.error}
        </p>
      )}

      <div className="report-export">
        {reportFiles ? (
          <div className="report-links" data-testid="report-links">
            <span className="report-links-label">Saved. View:</span>
            {reportFiles.pdf ? (
              <a href={reportViewUrl(extractId(reportFiles.pdf), 'pdf')} target="_blank" rel="noreferrer" data-testid="report-pdf">PDF</a>
            ) : (
              <span className="report-link-disabled" title="PDF not available">PDF</span>
            )}
            {reportFiles.md && (
              <a href={reportViewUrl(extractId(reportFiles.md), 'md')} target="_blank" rel="noreferrer" data-testid="report-md">Markdown</a>
            )}
            {reportFiles.html && (
              <a href={reportViewUrl(extractId(reportFiles.html), 'html')} target="_blank" rel="noreferrer" data-testid="report-html">HTML</a>
            )}
          </div>
        ) : (
          <button
            type="button"
            className="btn-secondary"
            data-testid="export-report"
            onClick={handleExport}
            disabled={exporting}
          >
            {exporting ? 'Generating report…' : 'Save reports / data'}
          </button>
        )}

        {exportError && (
          <p className="report-error" role="alert">{exportError}</p>
        )}
      </div>
    </section>
  );
}

// The download route is /reports/:id?format=..., but the saved file path in the
// response is the absolute/route disk path. Derive the id (the filename stem
// sans extension) so we can build the clean download URL.
function extractId(routePath: string): string {
  const seg = routePath.split('/').filter(Boolean).pop() ?? routePath;
  return seg.replace(/\.(pdf|md|html)$/i, '');
}

export default ResultsPanel;

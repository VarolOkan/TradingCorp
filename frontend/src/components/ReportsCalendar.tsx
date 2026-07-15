// frontend/src/components/ReportsCalendar.tsx
// Top-bar [Reports] button -> a dark calendar popover. Days that have
// saved reports are highlighted + clickable; selecting a day lists the runs
// (agency + ticker + time) for that day, and clicking a run opens the
// Markdown report in an in-app modal (ReportModal).
import { useEffect, useMemo, useState } from 'react';
import { listReports, deleteReport, fetchReportRawData, type ReportSummary } from '../api/reportClient';
import ReportModal from './ReportModal';
import RawDataDrawer, { type RawDataDump } from './RawDataDrawer';

const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// Parse display fields out of a ReportSummary. The filename encodes
// report-<Agency>-<Ticker>-<HH-MM-SS>; the summary also carries
// agencyId / tickers / generatedAt (ISO).
function displayOf(r: ReportSummary) {
  const m = /report-(.+)-(\d{2})-(\d{2})-(\d{2})$/.exec(r.id);
  const agency = r.agencyId || (m ? m[1] : 'unknown');
  const ticker = (r.tickers && r.tickers[0]) || (m ? m[2] : '—');
  const time = m ? `${m[2]}:${m[3]}:${m[4]}` : (r.generatedAt || '').slice(11, 19);
  return { agency, ticker, time, company: r.companyName };
}

export default function ReportsCalendar() {
  const [open, setOpen] = useState(false);
  const [byDay, setByDay] = useState<Record<string, ReportSummary[]>>({});
  const [loading, setLoading] = useState(false);
  const [month, setMonth] = useState<Date>(new Date());
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [viewId, setViewId] = useState<string | null>(null);
  // Phase R5: per-run raw-data inspector drawer (re-views the ingested JSON).
  const [rawId, setRawId] = useState<string | null>(null);
  const [rawDump, setRawDump] = useState<RawDataDump | null>(null);
  const [rawError, setRawError] = useState<string | null>(null);
  const [rawLoading, setRawLoading] = useState(false);
  // Collapse long per-day lists behind a [More reports] toggle (>5 shown).
  const [showAll, setShowAll] = useState(false);
  // Per-report delete: confirmation popup state (the run pending deletion),
  // plus in-flight/error state.
  const [pendingDelete, setPendingDelete] = useState<ReportSummary | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const refreshReports = () => {
    setLoading(true);
    listReports()
      .then((data) => {
        setByDay(data.byDay ?? {});
        const days = Object.keys(data.byDay ?? {}).sort();
        // Keep the current selected day if it still has reports; otherwise fall
        // back to the most recent day, or clear if everything was deleted.
        if (selectedDay && (data.byDay ?? {})[selectedDay]?.length) return;
        setSelectedDay(days.length ? days[days.length - 1]! : null);
        if (days.length) setMonth(new Date(days[days.length - 1]! + 'T00:00:00'));
      })
      .catch(() => { /* non-fatal */ })
      .finally(() => setLoading(false));
  };

  const handleDelete = (id: string) => {
    if (deleting) return;
    setDeleting(id);
    setDeleteError(null);
    deleteReport(id)
      .then((res) => {
        if (!res.ok) throw new Error(res.error || 'Delete failed');
        // Remove the run from local state immediately (optimistic), then refresh
        // the calendar's day index so an emptied day is disabled/hidden.
        setByDay((prev) => {
          const next: Record<string, ReportSummary[]> = {};
          for (const [day, list] of Object.entries(prev)) {
            const filtered = list.filter((r) => r.id !== id);
            if (filtered.length) next[day] = filtered;
          }
          if (!next[selectedDay ?? '']?.length) {
            const days = Object.keys(next).sort();
            setSelectedDay(days.length ? days[days.length - 1]! : null);
            if (days.length) setMonth(new Date(days[days.length - 1]! + 'T00:00:00'));
          }
          return next;
        });
        setPendingDelete(null);
        // Re-sync from the server so the index (which the backend pruned) and
        // the UI agree, including any day that just became empty.
        refreshReports();
      })
      .catch((e: Error) => { setDeleteError(e.message); })
      .finally(() => setDeleting(null));
  };

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    listReports()
      .then((data) => {
        if (!alive) return;
        setByDay(data.byDay ?? {});
        const days = Object.keys(data.byDay ?? {}).sort();
        if (days.length) {
          // Default the view to the most recent day with reports.
          setSelectedDay(days[days.length - 1]!);
          setMonth(new Date(days[days.length - 1]! + 'T00:00:00'));
        }
      })
      .catch(() => { /* non-fatal: calendar just stays empty */ })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [open]);

  const year = month.getFullYear();
  const mon = month.getMonth();
  const firstDow = new Date(year, mon, 1).getDay();
  const daysInMonth = new Date(year, mon + 1, 0).getDate();
  const cells = useMemo(() => {
    const out: (number | null)[] = [];
    for (let i = 0; i < firstDow; i++) out.push(null);
    for (let d = 1; d <= daysInMonth; d++) out.push(d);
    return out;
  }, [firstDow, daysInMonth]);

  const dayKey = (d: number) => `${year}-${String(mon + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const selected = selectedDay ? byDay[selectedDay] ?? [] : [];

  return (
    <>
      <button
        type="button"
        className="reports-btn"
        aria-label="Open reports calendar"
        data-testid="reports-btn"
        onClick={() => setOpen((o) => !o)}
      >
        🗓 Reports
      </button>

      {open && (
        <div className="reports-popover" data-testid="reports-popover">
          <div className="reports-pop-head">
            <button
              type="button"
              className="reports-nav"
              aria-label="Previous month"
              onClick={() => setMonth(new Date(year, mon - 1, 1))}
            >
              ‹
            </button>
            <span className="reports-month">{MONTHS[mon]} {year}</span>
            <button
              type="button"
              className="reports-nav"
              aria-label="Next month"
              onClick={() => setMonth(new Date(year, mon + 1, 1))}
            >
              ›
            </button>
          </div>

          {loading && <p className="reports-loading">Loading reports…</p>}

          <div className="reports-grid">
            {WEEKDAYS.map((w) => (
              <div key={w} className="reports-wd">{w}</div>
            ))}
            {cells.map((d, i) => {
              if (d === null) return <div key={`b${i}`} className="reports-cell empty" />;
              const key = dayKey(d);
              const has = !!byDay[key];
              const isSel = key === selectedDay;
              return (
                <button
                  key={key}
                  type="button"
                  className={`reports-cell${has ? ' has' : ''}${isSel ? ' selected' : ''}`}
                  disabled={!has}
                  aria-label={key}
                  data-testid={has ? `cal-day-${key}` : undefined}
                  onClick={() => { setSelectedDay(key); setShowAll(false); }}
                >
                  {d}
                </button>
              );
            })}
          </div>

          {selectedDay && (
            <div className="reports-list" data-testid="reports-list">
              <div className="reports-list-head">{selectedDay}</div>
              {selected.length === 0 && (
                <p className="reports-list-empty">No reports this day.</p>
              )}
              {selected.slice(0, showAll ? selected.length : 5).map((r) => {
                const { agency, ticker, time, company } = displayOf(r);
                return (
                  <div key={r.id} className="reports-item-wrap" data-testid={`report-item-wrap-${r.id}`}>
                    <button
                      type="button"
                      className="reports-item"
                      data-testid={`report-item-${r.id}`}
                      onClick={() => setViewId(r.id)}
                    >
                      <span className="reports-item-agency">{agency}</span>
                      <span className="reports-item-ticker">{ticker}</span>
                      <span className="reports-item-time">{time}</span>
                      {/* Inline delete ✕ — squeezed in right behind the timestamp,
                          bright red. stopPropagation so it deletes instead of opening. */}
                      <button
                        type="button"
                        className="reports-item-del-inline"
                        data-testid={`report-del-${r.id}`}
                        title="Delete this report and all its files"
                        aria-label={`Delete ${r.id}`}
                        disabled={deleting === r.id}
                        onClick={(e) => {
                          e.stopPropagation();
                          setPendingDelete(r);
                        }}
                      >
                        {deleting === r.id ? '…' : '✕'}
                      </button>
                      {company && company !== ticker && (
                        <span className="reports-item-co">{company}</span>
                      )}
                    </button>
                    <button
                      type="button"
                      className="reports-item-raw"
                      data-testid={`report-raw-${r.id}`}
                      onClick={() => {
                        // Close the calendar popover so its date selector does
                        // not overlay the raw-data drawer once it opens.
                        setOpen(false);
                        setRawError(null);
                        setRawLoading(true);
                        setRawDump(null);
                        fetchReportRawData(r.id)
                          .then((d) => { setRawDump(d); setRawId(r.id); })
                          .catch((e: Error) => { setRawError(e.message); })
                          .finally(() => setRawLoading(false));
                      }}
                    >
                      {rawLoading && rawId === r.id ? '…' : 'Raw data'}
                    </button>
                  </div>
                );
              })}
              {selected.length > 5 && (
                <button
                  type="button"
                  className="reports-more"
                  data-testid="reports-more"
                  onClick={() => setShowAll((v) => !v)}
                >
                  {showAll
                    ? `Show fewer ↑`
                    : `More reports (${selected.length - 5}) ↓`}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {viewId && <ReportModal id={viewId} onClose={() => setViewId(null)} />}

      {rawError && (
        <div className="reports-raw-error" role="alert" data-testid="rawdata-error">
          {rawError}
        </div>
      )}

      {pendingDelete && (
        <div
          className="reports-del-overlay"
          role="presentation"
          data-testid="report-del-overlay"
          onClick={() => { if (!deleting) setPendingDelete(null); }}
        >
          <div
            className="reports-del-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="report-del-title"
            aria-describedby="report-del-desc"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="report-del-title" className="reports-del-title">Delete report?</h3>
            <p id="report-del-desc" className="reports-del-desc">
              This permanently removes the report
              {' '}<code>{pendingDelete.id}</code>{' '}
              and all of its generated files (Markdown, HTML, PDF, raw JSON).
              This cannot be undone.
            </p>
            {deleteError && (
              <p className="reports-del-error" role="alert">{deleteError}</p>
            )}
            <div className="reports-del-actions">
              <button
                type="button"
                className="reports-del-cancel"
                data-testid="report-del-cancel"
                disabled={deleting === pendingDelete.id}
                onClick={() => setPendingDelete(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="reports-del-confirm"
                data-testid="report-del-confirm"
                disabled={deleting === pendingDelete.id}
                onClick={() => handleDelete(pendingDelete.id)}
              >
                {deleting === pendingDelete.id ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteError && (
        <div className="reports-del-error" role="alert" data-testid="report-del-error">
          Could not delete report: {deleteError}
        </div>
      )}

      <RawDataDrawer dump={rawDump} onClose={() => { setRawDump(null); setRawId(null); }} />
    </>
  );
}

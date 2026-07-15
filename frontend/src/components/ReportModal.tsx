// frontend/src/components/ReportModal.tsx
// Renders a saved report's Markdown in-app (properly formatted via
// react-markdown + remark-gfm) inside a dark modal. A "open full deck"
// link opens the server-rendered HTML deck in a new tab.
import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { fetchReportMarkdown, reportHtmlUrl } from '../api/reportClient';

interface Props {
  id: string;
  onClose: () => void;
}

export default function ReportModal({ id, onClose }: Props) {
  const [md, setMd] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setMd(null);
    setError(null);
    fetchReportMarkdown(id)
      .then((text) => { if (alive) setMd(text); })
      .catch((e: Error) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [id]);

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="report-modal" onClick={(e) => e.stopPropagation()}>
        <div className="report-modal-head">
          <span className="report-modal-title">Report</span>
          <div className="report-modal-actions">
            <a
              href={reportHtmlUrl(id)}
              target="_blank"
              rel="noreferrer"
              className="report-modal-deck"
            >
              Open full deck ↗
            </a>
            <button type="button" className="report-modal-close" onClick={onClose} aria-label="Close report">
              ✕
            </button>
          </div>
        </div>
        <div className="report-modal-body">
          {error ? (
            <p className="report-modal-error">{error}</p>
          ) : md === null ? (
            <p className="report-modal-loading">Loading report…</p>
          ) : (
            <div className="markdown">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{md}</ReactMarkdown>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

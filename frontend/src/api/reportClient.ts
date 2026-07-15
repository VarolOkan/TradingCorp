// frontend/src/api/reportClient.ts
// Phase C — report export client. POSTs the analysis result to the backend,
// which renders + persists MD/HTML/PDF to disk and returns view links.
// The calendar/report-viewer uses fetchReportMarkdown(id) to pull the raw
// Markdown (served inline) and render it with react-markdown in-app.
import type { AnalysisResult } from '../types';

export interface ReportFiles {
  pdf: string | null; // route-relative, e.g. "/reports/default/2026-07-11/report-long-term-AAPL-12-30-45.pdf"
  md: string | null;
  html: string | null;
}

export interface ReportPostResponse {
  ok: boolean;
  id: string;
  userId?: string;
  day: string;
  files: ReportFiles;
  meta?: any;
  error?: string;
}

export interface ReportSummary {
  id: string;
  userId?: string;
  day: string;
  agencyId: string;
  tickers: string[];
  companyName: string;
  generatedAt: string;
  files: ReportFiles;
}

function apiBase(): string {
  // Same-origin in dev (Vite proxies /reports -> :3001) and prod (static served
  // by the backend). No need to hardcode the port.
  return '';
}

export async function postReport(
  result: AnalysisResult,
  meta?: { agencyId?: string; tickers?: string[]; companyName?: string; parallel?: boolean; userId?: string },
): Promise<ReportPostResponse> {
  const body = { result, meta: { userId: 'default', ...(meta ?? {}) } };
  const res = await fetch(`${apiBase()}/reports`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await res.json()) as ReportPostResponse;
}

export async function listReports(): Promise<{ ok: boolean; count: number; byDay: Record<string, ReportSummary[]> }> {
  const res = await fetch(`${apiBase()}/reports`);
  return (await res.json()) as any;
}

export function reportDownloadUrl(id: string, format: 'pdf' | 'md' | 'html'): string {
  return `${apiBase()}/reports/${encodeURIComponent(id)}?format=${format}`;
}

// View inline in a new browser tab (served with Content-Disposition: inline).
export function reportViewUrl(id: string, format: 'pdf' | 'md' | 'html'): string {
  return `${apiBase()}/reports/${encodeURIComponent(id)}?format=${format}&inline=1`;
}

// Fetch the raw Markdown for in-app rendering (react-markdown). The backend
// serves it inline at ?format=md&inline=1.
export async function fetchReportMarkdown(id: string): Promise<string> {
  const res = await fetch(reportViewUrl(id, 'md'));
  if (!res.ok) throw new Error(`Failed to load report markdown (${res.status})`);
  return await res.text();
}

// Fetch the HTML "deck" URL for the "open full deck in new tab" affordance.
export function reportHtmlUrl(id: string): string {
  return reportViewUrl(id, 'html');
}

// Delete a saved report and all of its generated files (md/html/pdf/json).
export async function deleteReport(id: string): Promise<{ ok: boolean; id: string; removed: number; error?: string }> {
  const res = await fetch(`${apiBase()}/reports/${encodeURIComponent(id)}`, { method: 'DELETE' });
  return (await res.json()) as any;
}

// Phase R5 (RAW_DATA_DUMP.md §5): fetch the raw-data JSON dump for a report so
// the RawDataDrawer can re-show, per analyst, the exact raw data that was
// ingested (equity store + options bundle + per-analyst dataReceived
// annotations). Served inline at ?format=json.
export async function fetchReportRawData(id: string): Promise<any> {
  const res = await fetch(`${apiBase()}/reports/${encodeURIComponent(id)}?format=json`);
  if (!res.ok) throw new Error(`Failed to load raw-data dump (${res.status})`);
  return await res.json();
}

// src/server/report-routes.ts
// Phase C — report persistence + download endpoints.
//
// Directory layout on disk (per user requirement — prepares for future
// multi-tenancy; today there is a single 'default' user):
//   reports/<userId>/<date>/report-<Agency>-<Ticker>-<HH-MM-SS>.<ext>
// The date is YYYY-MM-DD; all three formats (pdf/md/html) for one run share
// the SAME date directory (no separate pdf/md/html subdirs). report-<id>
// maps to the same base name across formats.
//
// POST /reports          -> build MD + HTML + PDF, save under reports/<userId>/<date>/,
//                          return view paths (incl. userId + date) + ids.
// GET  /reports         -> list saved reports (newest first, grouped by day).
// GET  /reports/day/:day-> list only the reports for a given YYYY-MM-DD.
// GET  /reports/:id     -> download; ?format=pdf|md|html (default pdf else md).
//                          :id is the bare filename stem (no userId needed; the
//                          server resolves it from the in-memory index).
//
// Files on disk are the source of truth; an in-memory index speeds listing.

import express from 'express';
import fs from 'fs';
import path from 'path';
import { buildReportModel, buildRawDataDump, renderMarkdown, renderHtml, renderPdfBuffer } from './report';
import { AGENCY_IDS } from '../registry/agencies';
import { logger } from '../utils/logger';

const REPORTS_ROOT = (() => {
  // Allow tests / container mounts to redirect the reports dir.
  if (process.env.REPORTS_ROOT) return path.resolve(process.env.REPORTS_ROOT);
  return path.join(__dirname, '..', '..', 'reports');
})();

// Lazy root resolver so tests can redirect via process.env.REPORTS_ROOT before
// the first request.
function reportsRoot(): string {
  return process.env.REPORTS_ROOT ? path.resolve(process.env.REPORTS_ROOT) : REPORTS_ROOT;
}

// Default tenant until real auth/multi-tenancy lands.
const DEFAULT_USER = 'default';
function resolveUserId(meta: any): string {
  const u = meta?.userId;
  return typeof u === 'string' && u.length > 0 ? u.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 64) : DEFAULT_USER;
}

interface SavedFile {
  format: 'pdf' | 'md' | 'html' | 'json';
  /** Route-relative download path, e.g. "/reports/default/pdf/file.pdf". */
  dir: string;
  /** Absolute path on disk. */
  file: string;
  available: boolean;
}

interface ReportRecord {
  id: string; // bare filename stem, e.g. "report-2026-07-11-ab12cd"
  userId: string;
  day: string;
  agencyId: string;
  tickers: string[];
  companyName: string;
  generatedAt: string;
  files: { pdf: SavedFile | null; md: SavedFile | null; html: SavedFile | null; json: SavedFile | null };
}

// Index keyed by `${userId}:${id}`; a secondary bare-id map for O(1) lookup
// by stem (single-user today, but ready for multi-tenant collisions later).
const index = new Map<string, ReportRecord>();
const byBareId = new Map<string, ReportRecord>();

function ensureDirs(userId: string, day: string): void {
  fs.mkdirSync(path.join(reportsRoot(), userId, day), { recursive: true });
}

// Parse the report filename stem `report-<Agency>-<Ticker>-<HH-MM-SS>`.
// The time is the trailing `-HH-MM-SS` (3 `-`-joined 2-digit groups). The
// agency id is kebab-case (e.g. `long-term`, `options-swing`), so we match it
// against the known AGENCY_IDS set rather than splitting on the first hyphen
// (which would mis-split `long-term-AAPL` into agency `long`).
function parseStem(stem: string): { agencyId: string; ticker: string; time: string } {
  const rest = stem.startsWith('report-') ? stem.slice('report-'.length) : stem;
  // time = last 3 `-`-joined tokens (HH-MM-SS)
  const idx = rest.lastIndexOf('-');
  const idx2 = rest.lastIndexOf('-', idx - 1);
  const idx3 = rest.lastIndexOf('-', idx2 - 1);
  if (idx3 < 0) return { agencyId: rest, ticker: '', time: '' };
  const time = rest.slice(idx3 + 1);
  const head = rest.slice(0, idx3);
  // Longest-match the agency id so `long-term` wins over `long` / `term`.
  const known = [...AGENCY_IDS].sort((a, b) => b.length - a.length);
  const agencyId = known.find((id) => head === id || head.startsWith(id + '-')) ?? head;
  const ticker = head.startsWith(agencyId + '-') ? head.slice(agencyId.length + 1) : '';
  return { agencyId, ticker, time };
}

function listOnDisk(): void {
  // Disk is the source of truth: reconcile the in-memory index from disk on
  // EVERY call (do NOT early-return once primed). The index is a process-wide
  // singleton, so an early return would freeze it at whatever it first saw and
  // permanently hide historical reports written earlier (e.g. yesterday's
  // runs, or other analyses from today) even though their files exist. We
  // merge by id and only fill in the scanned format, so records already in the
  // index (from a recent POST) are preserved while disk files are surfaced.
  const root = reportsRoot();
  if (!fs.existsSync(root)) return;
  // Legacy layout used leaf dirs named pdf/md/html; ignore them so stale
  // pre-filename-change files don't surface as fake "days".
  const legacyFormatDirs = new Set(['pdf', 'md', 'html']);
  for (const userId of fs.readdirSync(root)) {
    const userDir = path.join(root, userId);
    if (!fs.statSync(userDir).isDirectory()) continue;
    for (const day of fs.readdirSync(userDir)) {
      if (legacyFormatDirs.has(day)) continue;
      const dayDir = path.join(userDir, day);
      if (!fs.statSync(dayDir).isDirectory()) continue;
      for (const fname of fs.readdirSync(dayDir)) {
        const m = /^report-.+\.(pdf|md|html|json)$/.exec(fname);
        if (!m) continue;
        const ext = m[1] as 'pdf' | 'md' | 'html' | 'json';
        const stem = fname.slice(0, fname.length - (ext.length + 1));
        const id = stem; // stem already starts with `report-`
        const { agencyId, ticker, time } = parseStem(stem);
        const rec = index.get(`${userId}:${id}`) ?? {
          id,
          userId,
          day,
          agencyId,
          tickers: ticker ? [ticker] : [],
          companyName: ticker ? ticker.toUpperCase() : prettify(agencyId),
          generatedAt: day + (time ? 'T' + time.replace(/-/g, ':') : ''),
          files: { pdf: null, md: null, html: null, json: null },
        };
        rec.files[ext] = {
          format: ext,
          dir: `/reports/${userId}/${day}/${fname}`,
          file: path.join(dayDir, fname),
          available: true,
        };
        index.set(`${userId}:${id}`, rec);
        byBareId.set(id, rec);
      }
    }
  }
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 120);
}

function prettify(id: string): string {
  return id.replace(/[_-]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();
}

export function registerReportRoutes(app: express.Express): void {
  // The POST /reports body is the full final AgentState (raw-data channels +
  // complete LLM message traces) and can be several MB for a long-term/LLM
  // run. The global express.json() already allows 25mb, but we pin an explicit
  // large limit here so this heavy endpoint is self-documenting and decoupled.
  app.use('/reports', express.json({ limit: '25mb' }));

  // POST /reports — build + persist a report from an analysis result.
  app.post('/reports', async (req, res) => {
    try {
      const { result, meta } = req.body ?? {};
      if (!result || typeof result !== 'object') {
        return res.status(400).json({ ok: false, error: 'Missing analysis result payload.' });
      }
      const userId = resolveUserId(meta);
      const m = buildReportModel(result, {
        agencyId: (meta && meta.agencyId) || (result && result.agencyId),
        tickers: (meta && meta.tickers) || (result && result.tickers),
        companyName: (meta && meta.companyName) || (result && result.company_name),
        parallel: meta && meta.parallel,
      });

      ensureDirs(userId, m.day);
      // m.id is the canonical stem report-<Agency>-<Ticker>-<HH-MM-SS>,
      // kept in sync with the on-disk filename so it survives a container restart.
      const base = sanitizeName(m.id);
      const rec: ReportRecord = {
        id: m.id,
        userId,
        day: m.day,
        agencyId: m.agencyId,
        tickers: m.tickers,
        companyName: m.companyName,
        generatedAt: m.generatedAt,
        files: { pdf: null, md: null, html: null, json: null },
      };

      // Markdown (always).
      const mdPath = path.join(reportsRoot(), userId, m.day, `${base}.md`);
      fs.writeFileSync(mdPath, renderMarkdown(m));
      rec.files.md = { format: 'md', dir: `/reports/${userId}/${m.day}/${base}.md`, file: mdPath, available: true };

      // HTML (always, print-friendly).
      const htmlPath = path.join(reportsRoot(), userId, m.day, `${base}.html`);
      fs.writeFileSync(htmlPath, renderHtml(m));
      rec.files.html = { format: 'html', dir: `/reports/${userId}/${m.day}/${base}.html`, file: htmlPath, available: true };

      // Phase R4 (RAW_DATA_DUMP.md): raw-data JSON dump (always). Carries the
      // ingested equity store, options bundles, and per-analyst received
      // annotations so the UI can re-show each analyst's exact raw inputs.
      const jsonPath = path.join(reportsRoot(), userId, m.day, `${base}.json`);
      const dump = buildRawDataDump(result, {
        id: m.id,
        agencyId: m.agencyId,
        tickers: m.tickers,
        companyName: m.companyName,
        generatedAt: m.generatedAt,
      });
      fs.writeFileSync(jsonPath, JSON.stringify(dump, null, 2));
      rec.files.json = { format: 'json', dir: `/reports/${userId}/${m.day}/${base}.json`, file: jsonPath, available: true };

      // PDF (best-effort via pdfkit).
      const pdfBuf = await renderPdfBuffer(m);
      if (pdfBuf) {
        const pdfPath = path.join(reportsRoot(), userId, m.day, `${base}.pdf`);
        fs.writeFileSync(pdfPath, pdfBuf);
        rec.files.pdf = { format: 'pdf', dir: `/reports/${userId}/${m.day}/${base}.pdf`, file: pdfPath, available: true };
      }

      index.set(`${userId}:${m.id}`, rec);
      byBareId.set(m.id, rec);

      // Return route-relative download paths (strings), matching the client's
      // ReportFiles shape; keep the full SavedFile (with absolute path) server-side.
      const filesOut = {
        pdf: rec.files.pdf?.dir ?? null,
        md: rec.files.md?.dir ?? null,
        html: rec.files.html?.dir ?? null,
        json: rec.files.json?.dir ?? null,
      };
      return res.json({ ok: true, id: m.id, userId, day: m.day, files: filesOut, meta: m });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`/reports POST failed: ${msg}`);
      return res.status(500).json({ ok: false, error: msg });
    }
  });

  // GET /reports — list (newest first, grouped by day).
  app.get('/reports', (_req, res) => {
    listOnDisk();
    const all = Array.from(index.values()).sort((a, b) => (a.generatedAt < b.generatedAt ? 1 : -1));
    const byDay: Record<string, any[]> = {};
    for (const r of all) (byDay[r.day] ??= []).push(summary(r));
    res.json({ ok: true, count: all.length, byDay });
  });

  // GET /reports/day/:day — reports for one day (all users; just 'default' now).
  app.get('/reports/day/:day', (req, res) => {
    listOnDisk();
    const day = String(req.params.day).replace(/[^0-9-]/g, '');
    const matches = Array.from(index.values())
      .filter((r) => r.day === day)
      .sort((a, b) => (a.generatedAt < b.generatedAt ? 1 : -1))
      .map(summary);
    res.json({ ok: true, day, count: matches.length, reports: matches });
  });

  // DELETE /reports/:id — remove a saved report and ALL of its generated
  // files (md/html/pdf/json) across every user/day directory, and purge the
  // in-memory index entries. The id is the bare filename stem.
  app.delete('/reports/:id', (req, res) => {
    const id = String(req.params.id);
    if (!/^report-[A-Za-z0-9_.-]+$/.test(id)) {
      return res.status(400).json({ ok: false, error: 'Invalid report id.' });
    }
    let removed = 0;
    const root = reportsRoot();
    if (fs.existsSync(root)) {
      for (const userId of fs.readdirSync(root)) {
        const userDir = path.join(root, userId);
        if (!fs.statSync(userDir).isDirectory()) continue;
        for (const day of fs.readdirSync(userDir)) {
          const dayDir = path.join(userDir, day);
          if (!fs.statSync(dayDir).isDirectory()) continue;
          for (const ext of ['md', 'html', 'pdf', 'json']) {
            const f = path.join(dayDir, `${id}.${ext}`);
            if (fs.existsSync(f)) {
              try {
                fs.unlinkSync(f);
                removed++;
              } catch {
                /* ignore individual failures; best-effort cleanup */
              }
            }
          }
        }
      }
    }
    // Purge from the in-memory index (by both keys).
    for (const key of Array.from(index.keys())) {
      if (key.endsWith(`:${id}`) || key === `${DEFAULT_USER}:${id}`) index.delete(key);
    }
    byBareId.delete(id);
    return res.json({ ok: true, id, removed });
  });

  // GET /reports/:id?format=pdf|md|html[&inline=1] — download (default) or
  // view inline (inline=1) by bare stem. With inline=1 the file is served with
  // `Content-Disposition: inline` + the correct Content-Type so the browser
  // renders it in a new tab instead of prompting a download.
  app.get('/reports/:id', (req, res) => {
    listOnDisk();
    const id = String(req.params.id);
    const rec = byBareId.get(id);
    if (!rec) return res.status(404).json({ ok: false, error: 'Report not found (it may have been cleared on container restart).' });
    const fmt = (req.query.format as string) || 'pdf';
    // Phase R4 (RAW_DATA_DUMP.md): serve the raw-data JSON dump inline.
    if (fmt === 'json') {
      const j = rec.files.json;
      if (!j || !j.available) return res.status(404).json({ ok: false, error: `Format 'json' not available for this report.` });
      try {
        const payload = JSON.parse(fs.readFileSync(j.file, 'utf8'));
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Disposition', `inline; filename="${path.basename(j.file)}"`);
        return res.json(payload);
      } catch (e) {
        return res.status(500).json({ ok: false, error: `Failed to read raw-data dump: ${(e as Error).message}` });
      }
    }
    const f = rec.files[fmt as 'pdf' | 'md' | 'html'];
    if (!f || !f.available) return res.status(404).json({ ok: false, error: `Format '${fmt}' not available for this report.` });
    const ext = path.extname(f.file).slice(1);
    const inline = String(req.query.inline ?? '') === '1';
    const safeName = `${rec.companyName.replace(/[^a-zA-Z0-9_.-]/g, '_')}.${ext}`;
    if (inline) {
      const typeByExt: Record<string, string> = { pdf: 'application/pdf', md: 'text/markdown; charset=utf-8', html: 'text/html; charset=utf-8' };
      res.setHeader('Content-Type', typeByExt[ext] ?? 'application/octet-stream');
      res.setHeader('Content-Disposition', `inline; filename="${safeName}"`);
      res.sendFile(f.file, (e) => {
        if (e) logger.warn(`report view failed: ${e.message}`);
      });
    } else {
      res.download(f.file, safeName, (e) => {
        if (e) logger.warn(`report download failed: ${e.message}`);
      });
    }
  });
}

function summary(r: ReportRecord) {
  return {
    id: r.id,
    userId: r.userId,
    day: r.day,
    agencyId: r.agencyId,
    tickers: r.tickers,
    companyName: r.companyName,
    generatedAt: r.generatedAt,
    files: {
      pdf: r.files.pdf?.dir ?? null,
      md: r.files.md?.dir ?? null,
      html: r.files.html?.dir ?? null,
      json: r.files.json?.dir ?? null,
    },
  };
}

// Use the shared logger (no import cycle: utils/logger only depends on config).

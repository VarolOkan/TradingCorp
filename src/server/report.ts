// src/server/report.ts
// Phase C — CEO/CFO "slide deck" report export.
//
// Single normalized model (`ReportModel`) is rendered three ways so the outputs
// never diverge:
//   * renderMarkdown — primary fallback, readable anywhere.
//   * renderHtml      — self-contained, print-friendly slide deck (open in
//                       browser -> Print -> Save as PDF even without pdfkit).
//   * renderPdfBuffer— real .pdf via pdfkit (vector layout, no browser). Async.
//
// The model is built from the `analysis_complete` payload (see normalizeResult in
// index.ts). All renderers are PURE functions of the model -> unit-testable.

import PDFDocument from 'pdfkit';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Verdict = string | null;

export interface PerTickerDecision {
  ticker: string;
  decision: string | null;
  confidence: number | null;
  riskLevel: string | null;
}

export interface AnalystSlide {
  analyst: string;
  label: string;
  verdict: Verdict;
  score: number | null;
  summary: string | null;
  llmDriven: boolean;
  dataSources: string | null;
  degraded: boolean;
  notes: string[];
}

export interface RiskRow {
  ticker: string;
  riskLevel: string | null;
  rationale: string | null;
  conditions: string[];
}

export interface DataHealth {
  sourcesOk: number;
  sourcesTotal: number;
  degradedAnalysts: string[];
  unavailableSources: string[];
  usedMockFallback: boolean;
}

export interface ReportModel {
  id: string;
  day: string; // YYYY-MM-DD (date only, per user spec)
  generatedAt: string; // ISO full timestamp for display
  agencyId: string;
  tickers: string[];
  companyName: string;
  decision: Verdict;
  confidence: number | null;
  reasoning: string;
  investmentThesis: string | null;
  preservationRationale: string | null;
  conditions: string[];
  perTicker: PerTickerDecision[];
  analysts: AnalystSlide[];
  risks: RiskRow[];
  dataHealth: DataHealth | null;
  methodology: string[];
}

export interface ReportMeta {
  agencyId?: string;
  tickers?: string[];
  companyName?: string;
  model?: string;
  parallel?: boolean;
  generatedAt?: string;
  id?: string;
}

// ---------------------------------------------------------------------------
// Model builder
// ---------------------------------------------------------------------------

function toVerdict(v: unknown): Verdict {
  return typeof v === 'string' ? v : null;
}

/**
 * Build the normalized ReportModel from an analysis_complete result.
 */
export function buildReportModel(result: any, meta: ReportMeta = {}): ReportModel {
  const r = result ?? {};
  const generatedAt = meta.generatedAt ?? new Date().toISOString();
  const day = generatedAt.slice(0, 10); // YYYY-MM-DD, no hours/minutes

  const tickers: string[] = Array.isArray(meta.tickers)
    ? meta.tickers
    : Array.isArray(r.tickers)
      ? r.tickers
      : [];

  // Canonical id == on-disk filename stem: report-<Agency>-<Ticker>-<HH-MM-SS>.
  // (first ticker; multi-ticker runs share the same stem, name shows the first).
  const agencyId = meta.agencyId ?? 'long-term';
  const tickerForFile = (tickers[0] || 'portfolio').replace(/[^a-zA-Z0-9_.-]/g, '_');
  const timeForFile = generatedAt.slice(11, 19).replace(/:/g, '-');
  const id = `report-${agencyId}-${tickerForFile}-${timeForFile}`;

  const companyName =
    meta.companyName || r.company_name || (tickers.length ? tickers.join(', ') : 'Portfolio Review');

  const decisions: Record<string, any> = r.decisions ?? {};
  const riskAssessments: Record<string, any> = r.riskAssessments ?? {};
  const thesisSummary: any = r.thesisSummary ?? null;

  // The backend does NOT always emit per-ticker `decisions` / `riskAssessments`
  // (e.g. the live run returned both as empty `{}`). It DOES emit per-analyst
  // data in `analystTraces` (each with `inputs[].ticker` + `output.verdict/score`)
  // and a per-run `thesisSummary`. Derive per-ticker rows from those so the
  // Per-Ticker Decisions / Risk Register tables are populated instead of "—".
  const allTraces: any[] = Array.isArray(r.analystTraces) ? r.analystTraces : [];

  const traceCovers = (trace: any, ticker: string): boolean => {
    const inputs = Array.isArray(trace?.inputs) ? trace.inputs : [];
    if (inputs.length === 0) return true; // global analyst (covers the whole universe)
    const tk = ticker.toUpperCase();
    return inputs.some((i: any) => {
      const raw = i?.ticker ?? i?.symbol ?? '';
      return String(raw).toUpperCase().split(/[,\s]+/).includes(tk);
    });
  };
  const traceVerdictFor = (analystId: string, ticker: string): { verdict: any; score: any } | null => {
    const t = allTraces.find((tr) => tr?.analyst === analystId && traceCovers(tr, ticker));
    if (!t) return null;
    const out = t.output ?? {};
    return { verdict: out.verdict ?? null, score: typeof out.score === 'number' ? out.score : null };
  };

  const perTicker: PerTickerDecision[] = tickers.map((t) => {
    const d = decisions[t] ?? {};
    const ra = riskAssessments[t] ?? {};
    const gov = traceVerdictFor('governance', t);
    const fund = traceVerdictFor('fundamental', t);
    const riskTr = traceVerdictFor('risk', t);
    const decision =
      d.decision ?? gov?.verdict ?? thesisSummary?.decision ?? fund?.verdict ?? null;
    const confidence =
      typeof d.confidence === 'number'
        ? d.confidence
        : typeof thesisSummary?.confidence === 'number'
          ? thesisSummary.confidence
          : (gov?.score ?? fund?.score ?? null);
    const riskLevel = ra.risk_level ?? d.risk_level ?? riskTr?.verdict ?? null;
    return {
      ticker: t,
      decision: decision ?? null,
      confidence: typeof confidence === 'number' ? confidence : null,
      riskLevel: riskLevel ?? null,
    };
  });

  // Internal pipeline phases (orchestrator routing, data ingestion) are not
  // analyst "deep-dives" — they emit routing/seed directives, not investable
  // verdicts. Exclude them so the report's Analyst Deep-Dives section only
  // shows the actual analysis analysts (and the governance gatekeeper).
  const NON_DEEP_DIVE_IDS = new Set(['orchestrator', 'data_ingestion', 'options_ingestion']);
  const traces: any[] = allTraces.filter((t: any) => t && !NON_DEEP_DIVE_IDS.has(t.analyst));
  const analysts: AnalystSlide[] = traces.map((t: any) => {
    const out = t?.output ?? {};
    const llm = t?.llm ?? null;
    const llmDriven = !!llm && llm.usedFallback === false;
    const sources = t?.sourceStatus
      ? Object.entries(t.sourceStatus).map(([k, v]) => `${k}:${v}`)
      : null;
    return {
      analyst: t?.analyst ?? 'unknown',
      label: prettify(t?.analyst ?? 'unknown'),
      verdict: toVerdict(out.verdict),
      score: typeof out.score === 'number' ? out.score : null,
      summary: typeof out.summary === 'string' ? out.summary : null,
      llmDriven,
      dataSources: sources && sources.length ? sources.join(', ') : null,
      degraded: t?.degraded === true,
      notes: Array.isArray(t?.notes) ? t.notes : [],
    };
  });

  const risks: RiskRow[] = tickers.map((t) => {
    const d = decisions[t] ?? {};
    const ra = riskAssessments[t] ?? {};
    const riskTr = traceVerdictFor('risk', t);
    return {
      ticker: t,
      riskLevel: ra.risk_level ?? d.risk_level ?? riskTr?.verdict ?? null,
      rationale: d.preservation_rationale ?? r.preservation_rationale ?? thesisSummary?.reasoning ?? null,
      conditions: Array.isArray(d.conditions)
        ? d.conditions
        : Array.isArray(r.conditions)
          ? r.conditions
          : [],
    };
  });

  const dataHealth: DataHealth | null = r.dataHealth
    ? {
        sourcesOk: r.dataHealth.sourcesOk ?? 0,
        sourcesTotal: r.dataHealth.sourcesTotal ?? 0,
        degradedAnalysts: Array.isArray(r.dataHealth.degradedAnalysts) ? r.dataHealth.degradedAnalysts : [],
        unavailableSources: Array.isArray(r.dataHealth.unavailableSources) ? r.dataHealth.unavailableSources : [],
        usedMockFallback: r.dataHealth.usedMockFallback === true,
      }
    : null;

  const methodology: string[] = [
    `Agency: ${meta.agencyId ?? 'long-term'}`,
    `Analysts run: ${analysts.map((a) => a.label).join(', ') || 'none'}`,
    `Execution: ${meta.parallel ? 'parallel (fan-out/fan-in after ingestion)' : 'serial (legacy)'}`,
    `LLM-driven analysts: ${analysts.filter((a) => a.llmDriven).map((a) => a.label).join(', ') || 'none'}`,
    `Data provenance: ${dataHealth ? `${dataHealth.sourcesOk}/${dataHealth.sourcesTotal} sources healthy` : 'not reported'}${dataHealth?.usedMockFallback ? ' — MOCK fallback used (findings are illustrative, not live)' : ''}`,
    'Disclaimer: output is generated by a deterministic demo pipeline; replace mock data sources with live feeds for production decisions.',
  ];

  return {
    id,
    day,
    generatedAt,
    agencyId: meta.agencyId ?? 'long-term',
    tickers,
    companyName,
    decision: toVerdict(r.decision),
    confidence: typeof r.confidence === 'number' ? r.confidence : null,
    reasoning: typeof r.reasoning === 'string' ? r.reasoning : 'No reasoning provided.',
    investmentThesis: typeof r.investment_thesis === 'string' ? r.investment_thesis : null,
    preservationRationale: typeof r.preservation_rationale === 'string' ? r.preservation_rationale : null,
    conditions: Array.isArray(r.conditions) ? r.conditions : [],
    perTicker,
    analysts,
    risks,
    dataHealth,
    methodology,
  };
}

function prettify(id: string): string {
  return id
    .replace(/[_-]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function verdictColor(v: Verdict): string {
  switch (v) {
    case 'APPROVE':
    case 'BULLISH':
      return '#22c55e';
    case 'REJECT':
    case 'BEARISH':
      return '#ef4444';
    case 'NEUTRAL':
      return '#f59e0b';
    case 'ERROR':
      return '#94a3b8';
    default:
      return '#64748b';
  }
}

/**
 * Minimal, dependency-free Markdown -> safe HTML for the self-contained HTML
 * deck. The saved HTML deck is rendered from the same ReportModel as the
 * Markdown file, but it was previously escaping analyst summaries as a single
 * flat paragraph — so `**bold**` / `` `code` `` / line breaks showed as raw
 * text. This renders the common inline markdown the pipeline emits (bold,
 * inline code, line breaks, simple `* ` / `- ` bullet lines) into real HTML,
 * with every token HTML-escaped first so it is XSS-safe. It intentionally does
 * NOT support nested/block markdown (tables, headings) — the deck structure
 * itself is laid out by renderHtml.
 */
function miniMarkdown(src: string): string {
  return String(src)
    .split('\n')
    .map((rawLine) => {
      const line = escapeHtml(rawLine);
      // Bullet line?  "- text" or "* text"  -> <li>
      const bullet = /^[\s]*[*-]\s+(.*)$/.exec(line);
      if (bullet) {
        return `<li>${inline(bullet[1])}</li>`;
      }
      return `<p>${inline(line)}</p>`;
    })
    .join('');
}

// Inline-level markdown: `code` and **bold**. Input is already HTML-escaped.
function inline(s: string): string {
  return s
    .replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, (_m, c) => `<strong>${c}</strong>`);
}

// ---------------------------------------------------------------------------
// Markdown renderer (slide-deck style)
// ---------------------------------------------------------------------------

export function renderMarkdown(m: ReportModel): string {
  const L: string[] = [];
  L.push(`# ${m.companyName}`);
  L.push('');
  L.push(`**Investment Review — Executive Deck**`);
  L.push('');
  L.push(`- **Decision:** ${m.decision ?? 'N/A'}`);
  L.push(`- **Confidence:** ${m.confidence != null ? m.confidence + '%' : 'N/A'}`);
  L.push(`- **Agency:** ${m.agencyId}`);
  L.push(`- **Tickers:** ${m.tickers.join(', ') || '—'}`);
  L.push(`- **Generated:** ${m.generatedAt}`);
  L.push('');
  L.push('---');
  L.push('');
  L.push(`## 1. Executive Summary`);
  L.push('');
  L.push(m.reasoning);
  L.push('');
  if (m.investmentThesis) {
    L.push(`**Thesis:** ${m.investmentThesis}`);
    L.push('');
  }

  L.push(`## 2. Per-Ticker Decisions`);
  L.push('');
  if (m.perTicker.length) {
    L.push('| Ticker | Decision | Confidence | Risk |');
    L.push('|--------|----------|------------|------|');
    for (const t of m.perTicker) {
      L.push(
        `| ${t.ticker} | ${t.decision ?? '—'} | ${t.confidence != null ? t.confidence + '%' : '—'} | ${t.riskLevel ?? '—'} |`,
      );
    }
  } else {
    L.push('_No per-ticker decisions._');
  }
  L.push('');

  L.push(`## 3. Analyst Deep-Dives`);
  L.push('');
  if (m.analysts.length) {
    for (const a of m.analysts) {
      L.push(`### ${a.label}`);
      L.push('');
      L.push(`- **Verdict:** ${a.verdict ?? '—'}${a.score != null ? ` (score ${a.score})` : ''}`);
      if (a.llmDriven) L.push(`- **LLM-driven:** yes`);
      if (a.dataSources) L.push(`- **Data sources:** ${a.dataSources}`);
      if (a.degraded) L.push(`- ⚠️ degraded (source fallback)`);
      if (a.summary) L.push('');
      if (a.summary) L.push(a.summary);
      if (a.notes.length) {
        L.push('');
        L.push(`_Notes: ${a.notes.join('; ')}_`);
      }
      L.push('');
    }
  } else {
    L.push('_No analyst traces._');
    L.push('');
  }

  L.push(`## 4. Risk Register`);
  L.push('');
  if (m.risks.length) {
    L.push('| Ticker | Risk | Rationale | Conditions |');
    L.push('|--------|------|-----------|------------|');
    for (const r of m.risks) {
      const rat = (r.rationale ?? '').replace(/\|/g, '/').slice(0, 120);
      const con = r.conditions.join('; ') || '—';
      L.push(`| ${r.ticker} | ${r.riskLevel ?? '—'} | ${rat} | ${con} |`);
    }
  } else {
    L.push('_No risk assessments._');
  }
  L.push('');
  if (m.preservationRationale) {
    L.push(`**Preservation rationale:** ${m.preservationRationale}`);
    L.push('');
  }

  L.push(`## 5. Data Provenance & Health`);
  L.push('');
  if (m.dataHealth) {
    const dh = m.dataHealth;
    L.push(`- Sources healthy: **${dh.sourcesOk}/${dh.sourcesTotal}**`);
    if (dh.degradedAnalysts.length) L.push(`- Degraded analysts: ${dh.degradedAnalysts.join(', ')}`);
    if (dh.unavailableSources.length) L.push(`- Unavailable sources: ${dh.unavailableSources.join(', ')}`);
    if (dh.usedMockFallback) L.push(`- ⚠️ **Mock fallback used** — findings are illustrative, not live data.`);
  } else {
    L.push('_Data health not reported._');
  }
  L.push('');

  L.push(`## 6. Methodology & Appendix`);
  L.push('');
  for (const line of m.methodology) L.push(`- ${line}`);
  L.push('');

  return L.join('\n');
}

// ---------------------------------------------------------------------------
// HTML renderer (self-contained slide deck, print-friendly)
// ---------------------------------------------------------------------------

export function renderHtml(m: ReportModel): string {
  const css = `
    * { box-sizing: border-box; }
    body { margin:0; background:#0b1120; color:#e2e8f0; font-family:'Segoe UI',system-ui,Arial,sans-serif; line-height:1.6; }
    .deck { max-width: 1100px; margin: 0 auto; padding: 24px; }
    .slide { background:#111827; border:1px solid #1f2937; border-radius:14px; padding:32px 36px; margin:0 0 28px; page-break-after: always; }
    .slide:last-child { page-break-after: auto; }
    h1 { font-size: 34px; margin:0 0 4px; }
    h2 { font-size: 22px; margin:0 0 16px; color:#93c5fd; border-bottom:1px solid #1f2937; padding-bottom:8px; }
    h3 { font-size: 18px; margin:18px 0 8px; color:#c4b5fd; }
    .chip { display:inline-block; padding:4px 14px; border-radius:999px; font-weight:700; color:#0b1120; font-size:18px; }
    .meta { color:#94a3b8; font-size:14px; line-height:1.7; }
    .meta b { color:#e2e8f0; }
    /* Prose: analyst summaries / reasoning rendered via miniMarkdown. */
    .prose p { margin:8px 0; }
    .prose ul { margin:8px 0; padding-left:22px; }
    .prose li { margin:4px 0; }
    .prose code { background:#0b1120; border:1px solid #1f2937; border-radius:6px; padding:1px 6px; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:0.92em; color:#7dd3fc; }
    .prose strong { color:#e2e8f0; font-weight:700; }
    table { width:100%; border-collapse:collapse; margin-top:8px; }
    th,td { text-align:left; padding:8px 10px; border-bottom:1px solid #1f2937; font-size:14px; }
    th { color:#93c5fd; }
    .llm { color:#22d3ee; font-size:12px; font-weight:700; }
    .warn { color:#f59e0b; }
    ul { margin:6px 0; padding-left:20px; }
    .foot { color:#64748b; font-size:12px; margin-top:24px; }
    @media print { body { background:#fff; color:#111; } .slide { border:none; box-shadow:none; } h2{color:#1e3a8a;} .prose code{background:#f1f5f9;border-color:#cbd5e1;color:#0f172a;} .prose strong{color:#111;} }
  `;

  const verdictChip = (v: Verdict) =>
    `<span class="chip" style="background:${verdictColor(v)}">${v ?? 'N/A'}</span>`;

  const cover = `
  <div class="slide">
    <h1>${escapeHtml(m.companyName)}</h1>
    <div class="meta" style="margin:14px 0;">
      <div>${verdictChip(m.decision)} &nbsp; <b>Confidence:</b> ${m.confidence != null ? m.confidence + '%' : 'N/A'}</div>
      <div><b>Agency:</b> ${escapeHtml(m.agencyId)}</div>
      <div><b>Tickers:</b> ${escapeHtml(m.tickers.join(', ') || '—')}</div>
      <div><b>Generated:</b> ${escapeHtml(m.generatedAt)}</div>
    </div>
    <h2>Executive Summary</h2>
    <div class="prose">${miniMarkdown(m.reasoning)}</div>
    ${m.investmentThesis ? `<div class="prose"><p><strong>Thesis:</strong> ${miniMarkdown(m.investmentThesis)}</p></div>` : ''}
  </div>`;

  const perTicker = `
  <div class="slide">
    <h2>Per-Ticker Decisions</h2>
    ${m.perTicker.length ? table(['Ticker', 'Decision', 'Confidence', 'Risk'], m.perTicker.map((t) => [t.ticker, t.decision ?? '—', t.confidence != null ? t.confidence + '%' : '—', t.riskLevel ?? '—'])) : '<p>No per-ticker decisions.</p>'}
  </div>`;

  const analysts = `
  <div class="slide">
    <h2>Analyst Deep-Dives</h2>
    ${m.analysts.length ? m.analysts.map((a) => `
      <h3>${escapeHtml(a.label)} ${verdictChip(a.verdict)} ${a.score != null ? `<span class="meta">score ${a.score}</span>` : ''} ${a.llmDriven ? '<span class="llm">LLM-DRIVEN</span>' : ''}</h3>
      ${a.dataSources ? `<div class="meta">Data sources: ${escapeHtml(a.dataSources)}</div>` : ''}
      ${a.degraded ? '<div class="warn">⚠️ degraded (source fallback)</div>' : ''}
      ${a.summary ? `<div class="prose">${miniMarkdown(a.summary)}</div>` : ''}
      ${a.notes.length ? `<div class="meta">${miniMarkdown(a.notes.join('\n'))}</div>` : ''}
    `).join('') : '<p>No analyst traces.</p>'}
  </div>`;

  const risk = `
  <div class="slide">
    <h2>Risk Register</h2>
    ${m.risks.length ? table(['Ticker', 'Risk', 'Rationale', 'Conditions'], m.risks.map((r) => [r.ticker, r.riskLevel ?? '—', (r.rationale ?? '').slice(0, 140), r.conditions.join('; ') || '—'])) : '<p>No risk assessments.</p>'}
    ${m.preservationRationale ? `<p><b>Preservation rationale:</b> ${escapeHtml(m.preservationRationale)}</p>` : ''}
  </div>`;

  const health = `
  <div class="slide">
    <h2>Data Provenance & Health</h2>
    ${m.dataHealth ? `
      <ul>
        <li>Sources healthy: <b>${m.dataHealth.sourcesOk}/${m.dataHealth.sourcesTotal}</b></li>
        ${m.dataHealth.degradedAnalysts.length ? `<li>Degraded analysts: ${escapeHtml(m.dataHealth.degradedAnalysts.join(', '))}</li>` : ''}
        ${m.dataHealth.unavailableSources.length ? `<li>Unavailable sources: ${escapeHtml(m.dataHealth.unavailableSources.join(', '))}</li>` : ''}
        ${m.dataHealth.usedMockFallback ? '<li class="warn">⚠️ Mock fallback used — findings are illustrative, not live data.</li>' : ''}
      </ul>` : '<p>Data health not reported.</p>'}
  </div>`;

  const method = `
  <div class="slide">
    <h2>Methodology & Appendix</h2>
    <ul>${m.methodology.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul>
    <div class="foot">Generated by TradingCorp · ${escapeHtml(m.id)}</div>
  </div>`;

  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(m.companyName)} — Investment Review</title><style>${css}</style></head><body><div class="deck">${cover}${perTicker}${analysts}${risk}${health}${method}</div></body></html>`;
}

function table(headers: string[], rows: string[][]): string {
  return `<table><thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`)
    .join('')}</tbody></table>`;
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// PDF renderer (pdfkit vector layout mirroring the slides) — async, returns Buffer
// ---------------------------------------------------------------------------

function drawDeck(doc: PDFKit.PDFDocument, m: ReportModel): void {
  const W = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const slide = (title: string, draw: () => void) => {
    if (doc.y > 80) doc.addPage();
    doc.rect(doc.page.margins.left - 8, doc.y, W + 16, 30).fill('#111827');
    doc.fillColor('#93c5fd').fontSize(16).text(title, doc.page.margins.left, doc.y + 7);
    doc.moveDown(2);
    draw();
    doc.fillColor('#000');
  };
  const chip = (label: string, color: string, x: number, y: number) => {
    doc.roundedRect(x, y, 90, 22, 6).fill(color);
  };
  const verdictHex = (v: Verdict) => verdictColor(v);

  // Cover
  doc.rect(0, 0, doc.page.width, doc.page.height).fill('#0b1120');
  doc.fillColor('#e2e8f0').fontSize(30).text(m.companyName, 48, 70, { width: W });
  doc.moveDown();
  if (m.decision) chip(String(m.decision), verdictHex(m.decision), 48, doc.y);
  doc.fillColor('#cbd5e1').fontSize(13).text(`Confidence: ${m.confidence != null ? m.confidence + '%' : 'N/A'}`, 150, doc.y);
  doc.fillColor('#94a3b8').fontSize(11)
    .text(`Agency: ${m.agencyId}`, 48, doc.y + 6)
    .text(`Tickers: ${m.tickers.join(', ') || '—'}`, 48, doc.y + 2)
    .text(`Generated: ${m.generatedAt}`, 48, doc.y + 2);
  doc.fillColor('#e2e8f0').fontSize(14).text('Executive Summary', 48, doc.y + 20, { width: W });
  doc.fillColor('#cbd5e1').fontSize(11).text(m.reasoning, 48, doc.y + 4, { width: W, align: 'left' });
  if (m.investmentThesis)
    doc.fillColor('#cbd5e1').fontSize(11).text(`Thesis: ${m.investmentThesis}`, 48, doc.y + 6, { width: W });

  // Per-ticker
  slide('Per-Ticker Decisions', () => {
    if (!m.perTicker.length) {
      doc.fontSize(11).text('No per-ticker decisions.');
      return;
    }
    doc.fontSize(10);
    m.perTicker.forEach((t) =>
      doc.text(`• ${t.ticker}: ${t.decision ?? '—'}  |  Confidence ${t.confidence != null ? t.confidence + '%' : '—'}  |  Risk ${t.riskLevel ?? '—'}`),
    );
  });

  // Analyst deep-dives
  slide('Analyst Deep-Dives', () => {
    doc.fontSize(11);
    m.analysts.forEach((a) => {
      if (doc.y > doc.page.height - 80) doc.addPage();
      doc.fillColor('#c4b5fd').fontSize(12).text(
        `${a.label}  —  ${a.verdict ?? '—'}${a.score != null ? ` (score ${a.score})` : ''}${a.llmDriven ? '  [LLM-DRIVEN]' : ''}`,
      );
      doc.fillColor('#cbd5e1').fontSize(10);
      if (a.summary) doc.text(a.summary, { width: W });
      if (a.dataSources) doc.text(`Data sources: ${a.dataSources}`, { width: W });
      if (a.degraded) doc.fillColor('#f59e0b').text('⚠ degraded (source fallback)');
      doc.fillColor('#cbd5e1').moveDown(0.5);
    });
  });

  // Risk register
  slide('Risk Register', () => {
    doc.fontSize(10);
    m.risks.forEach((r) => {
      doc.fillColor('#e2e8f0').text(`${r.ticker} — Risk: ${r.riskLevel ?? '—'}`);
      if (r.rationale) doc.fillColor('#cbd5e1').text(`  ${r.rationale.slice(0, 160)}`, { width: W });
      if (r.conditions.length) doc.fillColor('#cbd5e1').text(`  Conditions: ${r.conditions.join('; ')}`, { width: W });
      doc.moveDown(0.3);
    });
    if (m.preservationRationale)
      doc.fillColor('#e2e8f0').text(`Preservation rationale: ${m.preservationRationale}`, { width: W });
  });

  // Data health
  slide('Data Provenance & Health', () => {
    doc.fontSize(11);
    if (!m.dataHealth) {
      doc.text('Data health not reported.');
      return;
    }
    const dh = m.dataHealth;
    doc.text(`Sources healthy: ${dh.sourcesOk}/${dh.sourcesTotal}`);
    if (dh.degradedAnalysts.length) doc.text(`Degraded analysts: ${dh.degradedAnalysts.join(', ')}`);
    if (dh.unavailableSources.length) doc.text(`Unavailable sources: ${dh.unavailableSources.join(', ')}`);
    if (dh.usedMockFallback) {
      doc.fillColor('#f59e0b').text('⚠ Mock fallback used — findings illustrative, not live.');
      doc.fillColor('#cbd5e1');
    }
  });

  // Methodology
  slide('Methodology & Appendix', () => {
    doc.fontSize(10);
    m.methodology.forEach((x) => doc.text(`• ${x}`, { width: W }));
    doc.fillColor('#64748b').fontSize(9).text(`Generated by TradingCorp · ${m.id}`, { width: W });
  });
}

/**
 * Render the model to a real PDF Buffer via pdfkit. Returns null if pdfkit is
 * unavailable so the route can fall back to MD/HTML.
 */
export async function renderPdfBuffer(m: ReportModel): Promise<Buffer | null> {
  try {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 48,
      info: { Title: `${m.companyName} — Investment Review` },
    });
    const chunks: Buffer[] = [];
    const done: Promise<Buffer> = new Promise((resolve) => {
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
    });
    drawDeck(doc, m);
    doc.end();
    return await done;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Phase R4 (RAW_DATA_DUMP.md): raw-data JSON dump
// ---------------------------------------------------------------------------

/**
 * Serialize the RAW data every analyst consumed for a report: the ingested
 * equity store (`state.ingested`), the options bundles (`state.optionsData`),
 * and the per-analyst `dataReceived` annotations that specify exactly which
 * slices each analyst received. Emitted as `report-<id>.json` alongside the
 * pdf/md/html so the UI can later re-show, per analyst, the precise raw data
 * behind each verdict (and eventually replay/reload state).
 *
 * Parity-safe: when no raw channels were gathered (legacy / parity runs) the
 * slices are empty arrays but the structure is still emitted, so the export
 * contract never changes shape.
 */
export interface RawDataDump {
  reportId: string;
  agencyId: string;
  tickers: string[];
  companyName: string;
  generatedAt: string;
  ingested: Record<string, any> | null;
  optionsData: Record<string, any> | null;
  dataReceived: Array<Record<string, any>>;
  /** Convenience: per-analyst rollup of which domains each one received. */
  byAnalyst: Record<string, Array<{ ticker: string; channel: string; domains: string[]; provenance: string }>>;
}

export function buildRawDataDump(result: any, meta: ReportMeta = {}): RawDataDump {
  const r = result ?? {};
  const generatedAt = meta.generatedAt ?? new Date().toISOString();
  const ingested = r.ingested ?? null;
  const optionsData = r.optionsData ?? null;
  const entries: Array<Record<string, any>> = Array.isArray(r.dataReceived) ? r.dataReceived : [];

  const byAnalyst: RawDataDump['byAnalyst'] = {};
  for (const e of entries) {
    const list = (byAnalyst[e.analyst] ??= []);
    list.push({
      ticker: e.ticker,
      channel: e.channel,
      domains: Array.isArray(e.blocks) ? e.blocks.map((b: any) => b.domain) : [],
      provenance: e.provenance,
    });
  }

  return {
    reportId: (meta && (meta as any).id) || r.id || 'unknown',
    agencyId: (meta && meta.agencyId) || r.agencyId || 'unknown',
    tickers: (meta && meta.tickers) || r.tickers || [],
    companyName: (meta && meta.companyName) || r.company_name || 'Unknown',
    generatedAt,
    ingested,
    optionsData,
    dataReceived: entries,
    byAnalyst,
  };
}

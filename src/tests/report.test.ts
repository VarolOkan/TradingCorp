// src/tests/report.test.ts
// Phase C — report model + renderers + REST persistence (jest + supertest).
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import os from 'os';
import request from 'supertest';
import express from 'express';
import { buildReportModel, buildRawDataDump, renderMarkdown, renderHtml, renderPdfBuffer } from '../server/report';
import { registerReportRoutes } from '../server/report-routes';

const SAMPLE_RESULT = {
  decision: 'APPROVE',
  confidence: 82,
  reasoning: 'Strong fundamentals and constructive technicals support a long thesis.',
  preservation_rationale: 'Size position to 2% NAV; trail stop at -8%.',
  conditions: ['Re-visit if IV spikes > 40%', 'Exit if guidance cut'],
  company_name: 'ACME Corp',
  investment_thesis: 'Quality compounder with durable moat.',
  tickers: ['ACME'],
  decisions: { ACME: { decision: 'APPROVE', confidence: 82, risk_level: 'LOW' } },
  riskAssessments: { ACME: { risk_level: 'LOW' } },
  analystTraces: [
    {
      analyst: 'fundamental',
      output: { score: 88, verdict: 'BULLISH', summary: 'Robust balance sheet, high ROE.' },
      llm: { usedFallback: false, verdict: 'BULLISH', score: 88, text: 'LLM agrees.' },
      sourceStatus: { edgar: 'ok' },
      degraded: false,
      notes: ['Mock data — replace with a live source.'],
    },
    {
      analyst: 'risk',
      output: { score: 30, verdict: 'BEARISH', summary: 'Elevated tail risk.' },
    },
  ],
  dataHealth: {
    sourcesOk: 3,
    sourcesTotal: 4,
    degradedAnalysts: ['risk'],
    unavailableSources: ['bloomberg'],
    usedMockFallback: true,
  },
};

describe('buildReportModel', () => {
  it('derives a per-day stamp and groups analysts', () => {
    const m = buildReportModel(SAMPLE_RESULT, { agencyId: 'long-term' });
    expect(m.day).toMatch(/^\d{4}-\d{2}-\d{2}$/); // date only, no time
    expect(m.companyName).toBe('ACME Corp');
    expect(m.decision).toBe('APPROVE');
    expect(m.confidence).toBe(82);
    expect(m.perTicker).toHaveLength(1);
    expect(m.analysts).toHaveLength(2);
    expect(m.analysts[0].llmDriven).toBe(true); // non-fallback LLM
    expect(m.dataHealth?.usedMockFallback).toBe(true);
  });
});

describe('renderers', () => {
  const m = buildReportModel(SAMPLE_RESULT, { agencyId: 'long-term' });

  it('renderMarkdown contains all slide sections', () => {
    const md = renderMarkdown(m);
    for (const h of [
      '## 1. Executive Summary',
      '## 2. Per-Ticker Decisions',
      '## 3. Analyst Deep-Dives',
      '## 4. Risk Register',
      '## 5. Data Provenance & Health',
      '## 6. Methodology & Appendix',
    ]) {
      expect(md).toContain(h);
    }
    expect(md).toContain('| ACME |');
    expect(md).toContain('LLM-driven');
  });

  it('renderHtml is valid and has one .slide per section', () => {
    const html = renderHtml(m);
    expect(html).toContain('<!doctype html>');
    const slides = (html.match(/class="slide"/g) || []).length;
    expect(slides).toBeGreaterThanOrEqual(6);
  });

  it('renderPdfBuffer yields a %PDF buffer', async () => {
    const buf = await renderPdfBuffer(m);
    expect(buf).not.toBeNull();
    expect(buf!.slice(0, 4).toString('latin1')).toBe('%PDF');
  });
});

describe('report routes (persistence + download)', () => {
  let app: express.Express;
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reports-test-'));
    process.env.REPORTS_ROOT = tmpRoot;
    app = express();
    app.use(express.json());
    registerReportRoutes(app);
  });

  afterEach(() => {
    delete process.env.REPORTS_ROOT;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('POST /reports writes md+html+pdf and returns in-date-dir paths', async () => {
    const res = await request(app)
      .post('/reports')
      .send({ result: SAMPLE_RESULT, meta: { agencyId: 'long-term', tickers: ['ACME'], companyName: 'ACME Corp' } });
    expect(res.body.ok).toBe(true);
    // New layout: reports/<user>/<date>/report-<Agency>-<Ticker>-<HH-MM-SS>.<ext>
    expect(res.body.files.md).toMatch(/\/reports\/default\/\d{4}-\d{2}-\d{2}\/report-long-term-ACME-/);
    expect(res.body.files.html).toMatch(/\/reports\/default\/\d{4}-\d{2}-\d{2}\/report-long-term-ACME-/);
    expect(res.body.files.pdf).toMatch(/\/reports\/default\/\d{4}-\d{2}-\d{2}\/report-long-term-ACME-/);
    expect(res.body.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('GET /reports lists the saved report and parses kebab-case agency + ticker', async () => {
    await request(app).post('/reports').send({ result: SAMPLE_RESULT, meta: { agencyId: 'long-term', tickers: ['ACME'], companyName: 'ACME Corp' } });
    const list = await request(app).get('/reports');
    expect(list.body.ok).toBe(true);
    expect(list.body.count).toBeGreaterThanOrEqual(1);
    // The stem `report-long-term-ACME-<HH-MM-SS>` must parse with the FULL
    // kebab-case agency id, not split on the first hyphen ("long").
    const found = list.body.byDay && Object.values(list.body.byDay).flat()
      .find((r: any) => r.agencyId === 'long-term' && (r.tickers || []).includes('ACME'));
    expect(found).toBeTruthy();
    expect(found!.agencyId).toBe('long-term');
    expect(found!.tickers).toEqual(['ACME']);
    // Must NOT mis-parse into `long` / `term-ACME`.
    expect(list.body.byDay && Object.values(list.body.byDay).flat()
      .some((r: any) => r.agencyId === 'long')).toBe(false);
  });

  it('GET /reports/:id?format=pdf streams a PDF with attachment header', async () => {
    const post = await request(app).post('/reports').send({ result: SAMPLE_RESULT, meta: { agencyId: 'long-term' } });
    const id = post.body.id;
    const dl = await request(app).get(`/reports/${encodeURIComponent(id)}?format=pdf`);
    expect(dl.status).toBe(200);
    expect(dl.headers['content-disposition'] || '').toContain('attachment');
    expect(dl.body.slice(0, 4).toString('latin1')).toBe('%PDF');
  });

  it('GET /reports/:id?format=pdf&inline=1 serves inline for in-tab viewing', async () => {
    const post = await request(app).post('/reports').send({ result: SAMPLE_RESULT, meta: { agencyId: 'long-term' } });
    const id = post.body.id;
    const view = await request(app).get(`/reports/${encodeURIComponent(id)}?format=pdf&inline=1`);
    expect(view.status).toBe(200);
    expect(view.headers['content-disposition'] || '').toContain('inline');
    expect(view.headers['content-type'] || '').toContain('application/pdf');
    expect(view.body.slice(0, 4).toString('latin1')).toBe('%PDF');
  });

  it('GET /reports/:id?format=html&inline=1 serves inline HTML', async () => {
    const post = await request(app).post('/reports').send({ result: SAMPLE_RESULT, meta: { agencyId: 'long-term' } });
    const id = post.body.id;
    const view = await request(app).get(`/reports/${encodeURIComponent(id)}?format=html&inline=1`);
    expect(view.status).toBe(200);
    expect(view.headers['content-disposition'] || '').toContain('inline');
    expect(view.headers['content-type'] || '').toContain('text/html');
  });

  it('GET /reports/day/:day filters by day', async () => {
    const post = await request(app).post('/reports').send({ result: SAMPLE_RESULT, meta: { agencyId: 'long-term' } });
    const day = post.body.day;
    const dl = await request(app).get(`/reports/day/${day}`);
    expect(dl.body.ok).toBe(true);
    expect(dl.body.count).toBeGreaterThanOrEqual(1);
  });

  // ---- Phase R4 (RAW_DATA_DUMP.md): raw-data JSON dump ----
  const WITH_RAW = {
    ...SAMPLE_RESULT,
    ingested: {
      bars: { '1d': [{ t: '2026-07-10T00:00:00Z', open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 }] },
      market: { ACME: { price: 1.5, beta: 1.1, volatility_30d: 0.2 } },
      source: 'mock',
    },
    optionsData: {
      ACME: {
        underlying_price: 1.5, expiries: ['2026-08-21'], option_chain: [{ strike: 1.5 }],
        greeks: [{ strike: 1.5 }], price_bars: [{ interval: '1d', bars: [{ t: '2026-07-10T00:00:00Z', open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 }] }],
        iv_history: [{ iv: 0.3 }], rfr: 0.04, mock: true, source: 'mock',
      },
    },
    dataReceived: [
      { analyst: 'technical', ticker: 'ACME', channel: 'ingested', blocks: [{ domain: 'bars', interval: '1d', barsUsed: 1, source: 'mock' }], provenance: 'mock' },
      { analyst: 'options_greeks', ticker: 'ACME', channel: 'optionsData', blocks: [{ domain: 'greeks', source: 'mock', rows: 1 }], provenance: 'mock' },
    ],
  };

  it('buildRawDataDump serializes ingested + optionsData + dataReceived + per-analyst rollup', () => {
    const dump = buildRawDataDump(WITH_RAW, { agencyId: 'long-term', tickers: ['ACME'], companyName: 'ACME Corp' });
    expect(dump.tickers).toEqual(['ACME']);
    expect(dump.ingested).toBeTruthy();
    expect(dump.optionsData).toBeTruthy();
    expect(dump.dataReceived).toHaveLength(2);
    expect(dump.byAnalyst.technical![0]!.domains).toContain('bars');
    expect(dump.byAnalyst.options_greeks![0]!.domains).toContain('greeks');
  });

  it('buildRawDataDump is parity-safe when no raw channels are present', () => {
    const dump = buildRawDataDump(SAMPLE_RESULT, { agencyId: 'long-term' });
    expect(dump.ingested).toBeNull();
    expect(dump.optionsData).toBeNull();
    expect(dump.dataReceived).toEqual([]);
    expect(dump.byAnalyst).toEqual({});
  });

  it('POST /reports writes report-<id>.json and exposes files.json', async () => {
    const post = await request(app).post('/reports').send({ result: WITH_RAW, meta: { agencyId: 'long-term', tickers: ['ACME'], companyName: 'ACME Corp' } });
    expect(post.body.ok).toBe(true);
    expect(post.body.files.json).toMatch(/\.json$/);
    // The dump is retrievable via the json format endpoint (round-trips the
    // serialized file back through the route).
    const view = await request(app).get(`/reports/${encodeURIComponent(post.body.id)}?format=json`);
    expect(view.status).toBe(200);
    expect(view.body.reportId).toBe(post.body.id);
    expect(view.body.dataReceived).toHaveLength(2);
  });

  it('GET /reports/:id?format=json streams the raw-data dump inline', async () => {
    const post = await request(app).post('/reports').send({ result: WITH_RAW, meta: { agencyId: 'long-term', tickers: ['ACME'], companyName: 'ACME Corp' } });
    const id = post.body.id;
    const view = await request(app).get(`/reports/${encodeURIComponent(id)}?format=json`);
    expect(view.status).toBe(200);
    expect(view.headers['content-type'] || '').toContain('application/json');
    expect(view.body.reportId).toBe(id);
    expect(view.body.optionsData).toBeTruthy();
    expect(view.body.dataReceived).toHaveLength(2);
  });

  it('GET ?format=json serves the raw-data dump after a restart (disk rescan includes .json)', async () => {
    // Simulate a server restart: a fresh module instance has an EMPTY in-memory
    // index, so the first request triggers listOnDisk() to re-scan disk. The
    // bug was that listOnDisk() ignored .json files, so a report saved in a
    // previous session 404'd on ?format=json. Write a pre-existing .json (plus
    // .md so a record exists) straight to disk, then rescan + fetch.
    jest.resetModules();
    const mod = await import('../server/report-routes');
    const app2 = express();
    app2.use(express.json());
    mod.registerReportRoutes(app2);

    const day = '2026-07-12';
    const userId = 'default';
    const stem = 'report-long-term-ACME-01-02-03';
    const dir = path.join(tmpRoot, userId, day);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${stem}.md`), '# report');
    fs.writeFileSync(
      path.join(dir, `${stem}.json`),
      JSON.stringify({ reportId: stem, ingested: null, optionsData: null, dataReceived: [], byAnalyst: {} }),
    );

    // First request triggers listOnDisk() (index empty for this fresh module).
    await request(app2).get('/reports');
    const view = await request(app2).get(`/reports/${encodeURIComponent(stem)}?format=json`);
    expect(view.status).toBe(200);
    expect(view.body.reportId).toBe(stem);
  });

  it('lists reports from MULTIPLE days on disk (no stale single-scan index)', async () => {
    // Regression: listOnDisk() must reconcile the index from disk on every
    // call, not freeze at the first scan. Write reports for two different days
    // straight to disk, then a fresh module's first GET must surface BOTH
    // days (so yesterday's runs are selectable in the calendar).
    jest.resetModules();
    const mod = await import('../server/report-routes');
    const app2 = express();
    app2.use(express.json());
    mod.registerReportRoutes(app2);

    const userId = 'default';
    const days = ['2026-07-11', '2026-07-12'];
    days.forEach((day, i) => {
      const dir = path.join(tmpRoot, userId, day);
      fs.mkdirSync(dir, { recursive: true });
      const stem = `report-long-term-ACME-0${i}-0${i}-0${i}`;
      fs.writeFileSync(path.join(dir, `${stem}.md`), '# report');
      fs.writeFileSync(path.join(dir, `${stem}.html`), '<!doctype html><html></html>');
    });

    const list = await request(app2).get('/reports');
    expect(list.body.ok).toBe(true);
    const listedDays = Object.keys(list.body.byDay).sort();
    expect(listedDays).toEqual(['2026-07-11', '2026-07-12']);
  });

  it('DELETE /reports/:id removes all generated files for that report', async () => {
    const post = await request(app)
      .post('/reports')
      .send({ result: SAMPLE_RESULT, meta: { agencyId: 'long-term', tickers: ['ACME'], companyName: 'ACME Corp' } });
    expect(post.body.ok).toBe(true);
    const id = post.body.id;
    const day = post.body.day;
    // All four generated files exist on disk.
    for (const ext of ['md', 'html', 'pdf', 'json']) {
      expect(fs.existsSync(path.join(tmpRoot, 'default', day, `${id}.${ext}`))).toBe(true);
    }
    const del = await request(app).delete(`/reports/${encodeURIComponent(id)}`);
    expect(del.body.ok).toBe(true);
    expect(del.body.removed).toBe(4);
    // Files are gone and the report is no longer listed.
    for (const ext of ['md', 'html', 'pdf', 'json']) {
      expect(fs.existsSync(path.join(tmpRoot, 'default', day, `${id}.${ext}`))).toBe(false);
    }
    const list = await request(app).get('/reports');
    expect(list.body.byDay[day] ?? []).not.toContainEqual(expect.objectContaining({ id }));
  });

  it('excludes orchestrator/ingestion traces from Analyst Deep-Dives', () => {
    const m = buildReportModel(
      {
        decisions: { ACME: { decision: 'APPROVE', confidence: 82 } },
        analystTraces: [
          { analyst: 'orchestrator', output: {}, notes: ['ORCHESTRATOR DIRECTIVE — PIPELINE SEED & ROUTING'] },
          { analyst: 'data_ingestion', output: {} },
          { analyst: 'fundamental', output: { score: 88, verdict: 'BULLISH', summary: 'Robust balance sheet.' } },
        ],
      },
      { agencyId: 'long-term', tickers: ['ACME'], companyName: 'ACME Corp' },
    );
    const ids = m.analysts.map((a) => a.analyst);
    expect(ids).not.toContain('orchestrator');
    expect(ids).not.toContain('data_ingestion');
    expect(ids).toEqual(['fundamental']);
  });

  it('HTML deck renders analyst summary markdown (bold/code) and escapes HTML', () => {
    const m = buildReportModel(
      {
        decisions: { ACME: { decision: 'APPROVE', confidence: 82 } },
        analystTraces: [
          { analyst: 'fundamental', output: { score: 88, verdict: 'BULLISH', summary: 'Strong **ROE** and `clean` cash flow.\n- durable moat\n- low leverage' } },
        ],
      },
      { agencyId: 'long-term', tickers: ['ACME'], companyName: 'ACME Corp' },
    );
    const html = renderHtml(m);
    // Bold + inline code rendered as real HTML, not escaped raw text.
    expect(html).toContain('<strong>ROE</strong>');
    expect(html).toContain('<code>clean</code>');
    expect(html).toContain('<li>durable moat</li>');
    // The old escaped-asterisk behavior must be gone.
    expect(html).not.toContain('**ROE**');
    // XSS safety: a <script> in a summary is escaped, not injected.
    const evil = buildReportModel(
      { decisions: {}, analystTraces: [{ analyst: 'fundamental', output: { summary: 'hi <script>alert(1)</script>' } }] },
      { agencyId: 'long-term', tickers: ['ACME'], companyName: 'ACME Corp' },
    );
    expect(renderHtml(evil)).not.toContain('<script>alert(1)</script>');
    expect(renderHtml(evil)).toContain('&lt;script&gt;');
  });
});

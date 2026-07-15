// frontend/src/test/report-export.test.tsx
// Phase C — Export report button posts the result and renders download links.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ResultsPanel } from '../components/ResultsPanel';
import * as reportClient from '../api/reportClient';

const SAMPLE_RESULT: any = {
  decision: 'APPROVE',
  confidence: 0.82,
  reasoning: 'Strong fundamentals.',
  preservation_rationale: 'Size to 2% NAV.',
  conditions: ['Re-visit if IV spikes'],
  company_name: 'ACME Corp',
  investment_thesis: 'Quality compounder.',
  tickers: ['ACME'],
  decisions: { ACME: { decision: 'APPROVE', confidence: 82, risk_level: 'LOW' } },
  riskAssessments: { ACME: { risk_level: 'LOW' } },
  analystTraces: [{ analyst: 'fundamental', output: { score: 88, verdict: 'BULLISH', summary: 'Solid.' } }],
  dataHealth: { sourcesOk: 3, sourcesTotal: 4, degradedAnalysts: [], unavailableSources: [], usedMockFallback: true },
  error: null,
};

describe('ResultsPanel report export', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the Export button', () => {
    render(<ResultsPanel result={SAMPLE_RESULT} />);
    expect(screen.getByTestId('export-report')).toBeInTheDocument();
  });

  it('posts the result and shows PDF + MD + HTML view (in-tab) links', async () => {
    const postMock = vi.spyOn(reportClient, 'postReport').mockResolvedValue({
      ok: true,
      id: 'report-long-term-ACME-12-30-45',
      day: '2026-07-11',
      files: {
        pdf: '/reports/default/2026-07-11/report-long-term-ACME-12-30-45.pdf',
        md: '/reports/default/2026-07-11/report-long-term-ACME-12-30-45.md',
        html: '/reports/default/2026-07-11/report-long-term-ACME-12-30-45.html',
      },
      meta: {},
    });

    render(<ResultsPanel result={SAMPLE_RESULT} />);
    fireEvent.click(screen.getByTestId('export-report'));

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    // It posts the actual result object.
    expect(postMock.mock.calls[0][0]).toBe(SAMPLE_RESULT);

    // Links open the report inline in a new tab (Content-Disposition: inline).
    expect(await screen.findByTestId('report-pdf')).toHaveAttribute(
      'href',
      '/reports/report-long-term-ACME-12-30-45?format=pdf&inline=1',
    );
    expect(screen.getByTestId('report-md')).toHaveAttribute(
      'href',
      '/reports/report-long-term-ACME-12-30-45?format=md&inline=1',
    );
    expect(screen.getByTestId('report-html')).toHaveAttribute(
      'href',
      '/reports/report-long-term-ACME-12-30-45?format=html&inline=1',
    );
  });

  it('shows an error message when the export fails', async () => {
    vi.spyOn(reportClient, 'postReport').mockResolvedValue({
      ok: false,
      id: '',
      day: '',
      files: { pdf: null, md: null, html: null },
      error: 'boom',
    });

    render(<ResultsPanel result={SAMPLE_RESULT} />);
    fireEvent.click(screen.getByTestId('export-report'));
    expect(await screen.findByText(/boom/i)).toBeInTheDocument();
  });

  it('hides the Save button once the report is saved (links remain)', async () => {
    const postMock = vi.spyOn(reportClient, 'postReport').mockResolvedValue({
      ok: true,
      id: 'report-long-term-ACME-12-30-45',
      day: '2026-07-11',
      files: {
        pdf: '/reports/default/2026-07-11/report-long-term-ACME-12-30-45.pdf',
        md: '/reports/default/2026-07-11/report-long-term-ACME-12-30-45.md',
        html: '/reports/default/2026-07-11/report-long-term-ACME-12-30-45.html',
      },
      meta: {},
    });

    render(<ResultsPanel result={SAMPLE_RESULT} />);
    // Before saving, the Save button is visible.
    expect(screen.getByTestId('export-report')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('export-report'));
    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    // After saving, the button disappears and only the "Saved. View:" links remain.
    await waitFor(() => expect(screen.queryByTestId('export-report')).toBeNull());
    expect(screen.getByTestId('report-links')).toHaveTextContent(/Saved/);
    expect(screen.getByTestId('report-pdf')).toBeInTheDocument();
  });
});

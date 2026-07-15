// frontend/src/test/ReportModal.test.tsx
// ReportModal fetches the markdown and renders it with react-markdown
// (properly formatted, NOT a raw <pre>/text blob). Also exposes an
// "open full deck" link. We mock the API client.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import ReportModal from '../components/ReportModal';
import * as reportClient from '../api/reportClient';

vi.mock('../api/reportClient', () => ({
  fetchReportMarkdown: vi.fn(),
  reportHtmlUrl: vi.fn(() => '/reports/x?format=html&inline=1'),
}));

const SAMPLE_MD = `# Apple

**Investment Review — Executive Deck**

- **Decision:** APPROVE
- **Tickers:** AAPL

| Ticker | Decision |
|--------|----------|
| AAPL | APPROVE |
`;

describe('ReportModal', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    (reportClient.fetchReportMarkdown as any).mockResolvedValue(SAMPLE_MD);
  });

  it('renders markdown as formatted HTML (headers, tables, bold)', async () => {
    render(<ReportModal id="report-long-term-AAPL-12-30-45" onClose={() => {}} />);
    // Loading then rendered.
    const h1 = await screen.findByRole('heading', { level: 1 });
    expect(h1.textContent).toContain('Apple');
    // A table was rendered (not raw text).
    expect(screen.getByRole('table')).toBeInTheDocument();
    // Bold decision text present (appears in the bullet + the table cell).
    expect(screen.getAllByText(/APPROVE/).length).toBeGreaterThan(0);
  });

  it('shows the open-full-deck link to the HTML report', async () => {
    render(<ReportModal id="report-long-term-AAPL-12-30-45" onClose={() => {}} />);
    const link = await screen.findByText(/Open full deck/);
    expect(link.getAttribute('href')).toBe('/reports/x?format=html&inline=1');
    expect(link.getAttribute('target')).toBe('_blank');
  });

  it('surfaces an error when the fetch fails', async () => {
    (reportClient.fetchReportMarkdown as any).mockRejectedValue(new Error('boom 500'));
    render(<ReportModal id="report-x" onClose={() => {}} />);
    expect(await screen.findByText(/boom 500/)).toBeInTheDocument();
  });
});

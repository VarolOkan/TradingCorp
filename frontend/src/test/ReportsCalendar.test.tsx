// ReportsCalendar: open the calendar, then verify that clicking a run's
// [Raw data] button closes the date-selector popover (so it no longer overlays
// the raw-data drawer) and opens the RawDataDrawer.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import ReportsCalendar from '../components/ReportsCalendar';
import * as reportClient from '../api/reportClient';

const DAY = '2026-07-12';
const RID = 'report-long-term-ACME-01-02-03';

const summary = {
  id: RID,
  userId: 'default',
  day: DAY,
  agencyId: 'long-term',
  tickers: ['ACME'],
  companyName: 'ACME Corp',
  generatedAt: `${DAY}T01:02:03`,
  files: { pdf: `${RID}.pdf`, md: `${RID}.md`, html: `${RID}.html`, json: `${RID}.json` },
};

const dump = {
  reportId: RID,
  agencyId: 'long-term',
  tickers: ['ACME'],
  companyName: 'ACME Corp',
  generatedAt: `${DAY}T01:02:03`,
  ingested: null,
  optionsData: null,
  dataReceived: [],
  byAnalyst: {},
};

describe('ReportsCalendar — Raw data closes the date selector', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(reportClient, 'listReports').mockResolvedValue({
      ok: true,
      count: 1,
      byDay: { [DAY]: [summary] },
    });
    vi.spyOn(reportClient, 'fetchReportRawData').mockResolvedValue(dump);
  });

  it('clicking [Raw data] closes the calendar popover and opens the drawer', async () => {
    render(<ReportsCalendar />);
    fireEvent.click(screen.getByTestId('reports-btn'));
    // Wait for the day to be listed, then open that day's run list.
    const dayBtn = await screen.findByLabelText(DAY);
    fireEvent.click(dayBtn);
    const rawBtn = await screen.findByTestId(`report-raw-${RID}`);
    expect(screen.getByTestId('reports-popover')).toBeInTheDocument();

    fireEvent.click(rawBtn);

    // Popover (date selector) is gone so it can't overlay the drawer.
    await waitFor(() => expect(screen.queryByTestId('reports-popover')).not.toBeInTheDocument());
    // The raw-data drawer is shown instead.
    await waitFor(() => expect(screen.getByTestId('rawdata-drawer')).toBeInTheDocument());
  });

  it('does not close the popover when merely viewing the Markdown report', async () => {
    render(<ReportsCalendar />);
    fireEvent.click(screen.getByTestId('reports-btn'));
    const dayBtn = await screen.findByLabelText(DAY);
    fireEvent.click(dayBtn);
    const itemBtn = await screen.findByTestId(`report-item-${RID}`);
    fireEvent.click(itemBtn);
    // Markdown modal opens, popover stays (only Raw data closes it).
    expect(screen.getByTestId('reports-popover')).toBeInTheDocument();
    // And we did NOT fetch raw data.
    expect(reportClient.fetchReportRawData).not.toHaveBeenCalled();
  });

  it('delete [x] opens a confirmation dialog, then removes the report', async () => {
    const delMock = vi.spyOn(reportClient, 'deleteReport').mockResolvedValue({ ok: true, id: RID, removed: 4 });
    // First load shows the report; after confirm-delete the component refetches
    // and the server returns no reports.
    const reloadMock = vi
      .spyOn(reportClient, 'listReports')
      .mockResolvedValueOnce({ ok: true, count: 1, byDay: { [DAY]: [summary] } })
      .mockResolvedValue({ ok: true, count: 0, byDay: {} });

    render(<ReportsCalendar />);
    fireEvent.click(screen.getByTestId('reports-btn'));
    const dayBtn = await screen.findByLabelText(DAY);
    fireEvent.click(dayBtn);
    // The tiny [x] button is present (no inline "Delete?").
    const delBtn = await screen.findByTestId(`report-del-${RID}`);
    expect(delBtn).toHaveTextContent('✕');
    expect(screen.queryByTestId('report-del-confirm')).not.toBeInTheDocument();

    // Clicking [x] opens the confirmation popup.
    fireEvent.click(delBtn);
    const confirm = await screen.findByTestId('report-del-confirm');
    expect(screen.getByTestId('report-del-overlay')).toBeInTheDocument();
    // Cancel closes it without deleting.
    fireEvent.click(screen.getByTestId('report-del-cancel'));
    expect(screen.queryByTestId('report-del-overlay')).not.toBeInTheDocument();
    expect(delMock).not.toHaveBeenCalled();

    // Re-open and confirm -> deletes.
    fireEvent.click(delBtn);
    fireEvent.click(await screen.findByTestId('report-del-confirm'));
    await waitFor(() => expect(delMock).toHaveBeenCalledWith(RID));
    await waitFor(() => expect(screen.queryByTestId(`report-item-${RID}`)).not.toBeInTheDocument());
    expect(reloadMock).toHaveBeenCalled();
  });
});

describe('ReportsCalendar — ticker column label', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('shows MULTI X for a multi-symbol report (X = symbol count)', async () => {
    const multiDay = '2026-07-13';
    const multiRid = 'report-long-term-AAPL-MSFT-TSLA-09-08-07';
    const multiSummary = {
      id: multiRid,
      userId: 'default',
      day: multiDay,
      agencyId: 'long-term',
      tickers: ['AAPL', 'MSFT', 'TSLA'],
      companyName: undefined,
      generatedAt: `${multiDay}T09:08:07`,
      files: { pdf: `${multiRid}.pdf`, md: `${multiRid}.md`, html: `${multiRid}.html`, json: `${multiRid}.json` },
    };
    vi.spyOn(reportClient, 'listReports').mockResolvedValue({ ok: true, count: 1, byDay: { [multiDay]: [multiSummary] } });
    render(<ReportsCalendar />);
    fireEvent.click(screen.getByTestId('reports-btn'));
    const dayBtn = await screen.findByLabelText(multiDay);
    fireEvent.click(dayBtn);
    const item = await screen.findByTestId(`report-item-${multiRid}`);
    expect(within(item).getByText('MULTI 3')).toBeInTheDocument();
  });

  it('shows the single symbol for a one-symbol report', async () => {
    // Reuse the single-symbol summary from the outer scope.
    render(<ReportsCalendar />);
    vi.spyOn(reportClient, 'listReports').mockResolvedValue({ ok: true, count: 1, byDay: { [DAY]: [summary] } });
    fireEvent.click(screen.getByTestId('reports-btn'));
    const d = await screen.findByLabelText(DAY);
    fireEvent.click(d);
    const item = await screen.findByTestId(`report-item-${RID}`);
    expect(within(item).getByText('ACME')).toBeInTheDocument();
  });

  it('hides the redundant company span for a multi-symbol report (MULTI already conveys it)', async () => {
    const multiDay = '2026-07-14';
    const multiRid = 'report-long-term-AAPL-MSFT-TSLA-NVDA-09-08-07';
    const multiSummary = {
      id: multiRid,
      userId: 'default',
      day: multiDay,
      agencyId: 'long-term',
      tickers: ['AAPL', 'MSFT', 'TSLA', 'NVDA'],
      companyName: 'AAPL, MSFT, TSLA, NVDA', // backend joins tickers for multi-symbol runs
      generatedAt: `${multiDay}T09:08:07`,
      files: { pdf: `${multiRid}.pdf`, md: `${multiRid}.md`, html: `${multiRid}.html`, json: `${multiRid}.json` },
    };
    vi.spyOn(reportClient, 'listReports').mockResolvedValue({ ok: true, count: 1, byDay: { [multiDay]: [multiSummary] } });
    render(<ReportsCalendar />);
    fireEvent.click(screen.getByTestId('reports-btn'));
    const dayBtn = await screen.findByLabelText(multiDay);
    fireEvent.click(dayBtn);
    const item = await screen.findByTestId(`report-item-${multiRid}`);
    // MULTI 4 label is present...
    expect(within(item).getByText('MULTI 4')).toBeInTheDocument();
    // ...but the joined-symbols company text is NOT duplicated on the right.
    expect(within(item).queryByText('AAPL, MSFT, TSLA, NVDA')).not.toBeInTheDocument();
  });
});

describe('ReportsCalendar — hover tooltip', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the run tickers in a tooltip only after a ~500ms hover', async () => {
    render(<ReportsCalendar />);
    vi.spyOn(reportClient, 'listReports').mockResolvedValue({ ok: true, count: 1, byDay: { [DAY]: [summary] } });
    fireEvent.click(screen.getByTestId('reports-btn'));
    const d = await screen.findByLabelText(DAY);
    fireEvent.click(d);
    const item = await screen.findByTestId(`report-item-${RID}`);
    const wrap = item.closest('.reports-item-wrap') as HTMLElement;

    // Immediately on hover: no tooltip yet (the 500ms delay has not elapsed).
    fireEvent.mouseEnter(wrap);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    // After the delay: tooltip appears with the ticker.
    const tip = await screen.findByRole('tooltip', { timeout: 1500 });
    expect(tip).toHaveTextContent('ACME');

    // Leaving clears it.
    fireEvent.mouseLeave(wrap);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('multi-symbol run shows the full ticker list in the tooltip', async () => {
    const multiDay = '2026-07-15';
    const multiRid = 'report-long-term-AAPL-MSFT-TSLA-NVDA-09-08-07';
    const multiSummary = {
      id: multiRid,
      userId: 'default',
      day: multiDay,
      agencyId: 'long-term',
      tickers: ['AAPL', 'MSFT', 'TSLA', 'NVDA'],
      companyName: 'AAPL, MSFT, TSLA, NVDA',
      generatedAt: `${multiDay}T09:08:07`,
      files: { pdf: `${multiRid}.pdf`, md: `${multiRid}.md`, html: `${multiRid}.html`, json: `${multiRid}.json` },
    };
    render(<ReportsCalendar />);
    vi.spyOn(reportClient, 'listReports').mockResolvedValue({ ok: true, count: 1, byDay: { [multiDay]: [multiSummary] } });
    fireEvent.click(screen.getByTestId('reports-btn'));
    const dayBtn = await screen.findByLabelText(multiDay);
    fireEvent.click(dayBtn);
    const item = await screen.findByTestId(`report-item-${multiRid}`);
    const wrap = item.closest('.reports-item-wrap') as HTMLElement;
    fireEvent.mouseEnter(wrap);
    const tip = await screen.findByRole('tooltip', { timeout: 1500 });
    expect(tip).toHaveTextContent('4 symbols');
    expect(tip).toHaveTextContent('AAPL, MSFT, TSLA, NVDA');
  });
});

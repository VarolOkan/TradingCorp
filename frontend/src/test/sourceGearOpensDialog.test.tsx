// frontend/src/test/sourceGearOpensDialog.test.tsx
// Regression: the single per-analyst ⚙ gear (Phase H) must OPEN the unified
// tabbed Settings dialog when clicked. A previous bug had the gear mutate
// AnalysisView's local gearAnalyst state while the dialog was rendered (and
// read) from App's separate gearAnalyst state — so the click did nothing and
// the gear looked dead/"greyed out". The fix colocates both the gear handler
// and the dialog in AnalysisView, so clicking actually opens the dialog.
//
// Phase H collapse: there is now ONE gear per card. Clicking it opens the
// unified AnalystSettingsDialog with tabs (Sources / Role & Instructions /
// Weights). This test asserts the gear opens that dialog and the data_ingestion
// analyst exposes its full set of credentialed sources on the Sources tab.
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import AnalysisView from '../components/AnalysisView';
import * as flavorClient from '../api/analystFlavorsClient';
import * as analystConfigClient from '../api/analystConfigClient';

vi.mock('../api/analystFlavorsClient', () => ({
  getAnalystFlavors: (...args: any[]) => (flavorClient as any).getAnalystFlavors(...args),
}));

vi.mock('../api/analystConfigClient', () => ({
  getAnalystSourceCatalog: (...args: any[]) => (analystConfigClient as any).getAnalystSourceCatalog(...args),
  postAnalystConfig: (...args: any[]) => (analystConfigClient as any).postAnalystConfig(...args),
}));

describe('data_ingestion gear opens the unified tabbed Settings dialog', () => {
  it('clicking the gear opens the unified dialog with a Sources tab listing all providers', async () => {
    vi.spyOn(flavorClient, 'getAnalystFlavors').mockResolvedValue({
      sessionId: 'default',
      agencyId: 'options-swing',
      analystId: 'vol_surface',
      flavors: [],
      selectedId: '',
    });

    render(
      <AnalysisView
        socket={null}
        connected={false}
        sessionId="default"
        sourceCatalog={{
          analysts: [
            {
              analystId: 'data_ingestion',
              name: 'Data Ingestion',
              sources: [
                { id: 'yahoo', label: 'Yahoo Finance', auth: 'apikey', hasToken: false },
                { id: 'alphaVantage', label: 'Alpha Vantage', auth: 'bearer', hasToken: false },
                { id: 'finnhub', label: 'Finnhub', auth: 'bearer', hasToken: false },
              ],
            },
          ],
        }}
      />,
    );

    // Click the single gear.
    fireEvent.click(screen.getByTestId('panel-gear-data_ingestion'));

    // The unified dialog opened (heading "Data Ingestion · Settings").
    await waitFor(() => {
      expect(screen.getByText('Data Ingestion · Settings')).toBeTruthy();
    });

    // It exposes a Sources tab (the old separate AnalystSourceDialog is gone —
    // sources now live inside the unified dialog).
    expect(screen.getByTestId('tab-sources')).toBeTruthy();

    // Activate the Sources tab and confirm ALL credentialed providers show.
    fireEvent.click(screen.getByTestId('tab-sources'));
    await waitFor(() => {
      expect(screen.getByText('Yahoo Finance')).toBeTruthy();
    });
    expect(screen.getByText('Alpha Vantage')).toBeTruthy();
    expect(screen.getByText('Finnhub')).toBeTruthy();
  });

  it('saving the dialog persists source credentials via the single Save button', async () => {
    vi.spyOn(flavorClient, 'getAnalystFlavors').mockResolvedValue({
      sessionId: 'default',
      agencyId: 'options-swing',
      analystId: 'vol_surface',
      flavors: [],
      selectedId: '',
    });
    const postSpy = vi
      .spyOn(analystConfigClient, 'postAnalystConfig')
      .mockResolvedValue({ ok: true, sessionId: 'default', analystId: 'data_ingestion', sourceId: 'finnhub', hasToken: true });

    render(
      <AnalysisView
        socket={null}
        connected={false}
        sessionId="default"
        sourceCatalog={{
          analysts: [
            {
              analystId: 'data_ingestion',
              name: 'Data Ingestion',
              sources: [
                { id: 'yahoo', label: 'Yahoo Finance', auth: 'apikey', hasToken: false },
                { id: 'alphaVantage', label: 'Alpha Vantage', auth: 'bearer', hasToken: false },
                { id: 'finnhub', label: 'Finnhub', auth: 'bearer', hasToken: false },
              ],
            },
          ],
        }}
      />,
    );

    fireEvent.click(screen.getByTestId('panel-gear-data_ingestion'));
    await waitFor(() => expect(screen.getByText('Data Ingestion · Settings')).toBeTruthy());
    fireEvent.click(screen.getByTestId('tab-sources'));
    await waitFor(() => expect(screen.getByText('Finnhub')).toBeTruthy());

    // Type a token into the Finnhub field and click the dialog's single Save.
    fireEvent.change(screen.getByLabelText('Finnhub token'), { target: { value: 'fh-secret' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(postSpy).toHaveBeenCalled());
    expect(postSpy).toHaveBeenCalledWith(
      expect.objectContaining({ analystId: 'data_ingestion', sourceId: 'finnhub', token: 'fh-secret' }),
      'default',
    );
  });

  it('Data Ingestion Sources tab also surfaces Polygon (stored under options_ingestion)', async () => {
    vi.spyOn(flavorClient, 'getAnalystFlavors').mockResolvedValue({
      sessionId: 'default',
      agencyId: 'options-swing',
      analystId: 'vol_surface',
      flavors: [],
      selectedId: '',
    });

    render(
      <AnalysisView
        socket={null}
        connected={false}
        sessionId="default"
        sourceCatalog={{
          analysts: [
            {
              analystId: 'data_ingestion',
              name: 'Data Ingestion',
              sources: [
                { id: 'yahoo', label: 'Yahoo Finance', auth: 'apikey', hasToken: false },
                { id: 'alphaVantage', label: 'Alpha Vantage', auth: 'bearer', hasToken: false },
                { id: 'finnhub', label: 'Finnhub', auth: 'bearer', hasToken: false },
              ],
            },
            {
              // Polygon belongs to options_ingestion but must ALSO appear in the
              // Data Ingestion card's Sources tab (and save under options_ingestion).
              analystId: 'options_ingestion',
              name: 'Options Ingestion',
              sources: [
                { id: 'polygonOptions', label: 'Polygon Options', auth: 'bearer', hasToken: false },
                { id: 'polygonHist', label: 'Polygon Aggregates', auth: 'bearer', hasToken: false },
              ],
            },
          ],
        }}
      />,
    );

    fireEvent.click(screen.getByTestId('panel-gear-data_ingestion'));
    await waitFor(() => expect(screen.getByText('Data Ingestion · Settings')).toBeTruthy());
    fireEvent.click(screen.getByTestId('tab-sources'));

    // Data Ingestion's own sources are present...
    await waitFor(() => expect(screen.getByText('Alpha Vantage')).toBeTruthy());
    expect(screen.getByText('Finnhub')).toBeTruthy();
    // ...AND the Polygon options/aggregates (which live under options_ingestion)
    // are now visible here too, collapsed into ONE Massive/Polygon key group —
    // the SAME layout as the General Settings → Sources tab: a single shared
    // token field, both endpoints listed beneath it, and one combined [Test]
    // button at the bottom (not two separate single-source rows each with its
    // own Test button).
    expect(screen.getByRole('heading', { name: /Massive\/Polygon Options/i })).toBeTruthy();
    expect(screen.getByText('Options snapshot')).toBeTruthy();
    expect(screen.getByText('Daily aggregates')).toBeTruthy();
    // Exactly one combined Test button for the whole group (no per-endpoint buttons).
    expect(screen.getByRole('button', { name: /Test Massive\/Polygon Options endpoints/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Test Polygon Options connection/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Test Polygon Aggregates connection/i })).toBeNull();
  });
});

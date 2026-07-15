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

vi.mock('../api/analystFlavorsClient', () => ({
  getAnalystFlavors: (...args: any[]) => (flavorClient as any).getAnalystFlavors(...args),
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
                { id: 'yahoo', label: 'Yahoo Finance', auth: 'apikey' },
                { id: 'alphaVantage', label: 'Alpha Vantage', auth: 'bearer' },
                { id: 'finnhub', label: 'Finnhub', auth: 'bearer' },
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
});

// frontend/src/test/analystGear.test.tsx
// Regression: options analysts ship flavors (no weights/sources), so the
// per-card configure gear MUST still appear. Before the fix, hasConfig ignored
// flavors and the gear vanished for every options analyst.
//
// Phase H: a card shows ONE gear (panel-gear-<id>) when the analyst is
// configurable at all — a credentialed source AND/OR a settings schema with
// weights or flavors. Clicking opens the unified tabbed Settings dialog
// (Sources / Role & Instructions / Weights). There is never a second gear.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import AnalysisView from '../components/AnalysisView';
import * as flavorClient from '../api/analystFlavorsClient';

// No socket needed for the gear to render (it's driven by the schema, not the
// connection). Pass null socket + connected=false; the wall + gears still mount.
vi.mock('../api/analystFlavorsClient', () => ({
  getAnalystFlavors: (...args: any[]) => (flavorClient as any).getAnalystFlavors(...args),
}));

const flavors = [
  { id: 'default', name: 'Balanced', role: 'Skew · term', instructions: 'base', isDefault: true },
  { id: 'momentum', name: 'Momentum-leaning', role: 'Edge · momentum', instructions: 'momo' },
];

describe('AnalysisView per-card configure gear (Phase H single-gear model)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows ONE gear on an options analyst card once flavors load', async () => {
    vi.spyOn(flavorClient, 'getAnalystFlavors').mockResolvedValue({
      sessionId: 'default',
      agencyId: 'options-swing',
      analystId: 'vol_surface',
      flavors,
      selectedId: 'default',
    });

    render(
      <AnalysisView
        socket={null}
        connected={false}
        sessionId="default"
        sourceCatalog={{ analysts: [] }}
      />,
    );

    fireEvent.change(screen.getByLabelText('Select analysis agency'), {
      target: { value: 'options-swing' },
    });

    await waitFor(() =>
      expect(screen.getByTestId('panel-gear-vol_surface')).toBeTruthy(),
    );

    // Exactly one gear (no second settings gear).
    expect(screen.queryByTestId('panel-settings-vol_surface')).toBeNull();

    // Clicking the gear opens the unified dialog with a Role & Instructions tab.
    fireEvent.click(screen.getByTestId('panel-gear-vol_surface'));
    await waitFor(() => expect(screen.getByText(/Settings/)).toBeTruthy());
    expect(screen.getByTestId('tab-flavor')).toBeTruthy();
  });

  it('shows ONE gear for an analyst with BOTH a source AND flavors', async () => {
    vi.spyOn(flavorClient, 'getAnalystFlavors').mockResolvedValue({
      sessionId: 'default',
      agencyId: 'options-swing',
      analystId: 'options_risk',
      flavors,
      selectedId: 'default',
    });

    // options_risk has a credentialed source (Polygon) AND shipped flavors.
    // It must expose a SINGLE gear (not two) that opens the unified dialog
    // with BOTH a Sources tab and a Role & Instructions tab.
    render(
      <AnalysisView
        socket={null}
        connected={false}
        sessionId="default"
        sourceCatalog={{
          analysts: [
            {
              analystId: 'options_risk',
              name: 'Options Risk',
              sources: [{ id: 'polygon', label: 'Polygon', auth: 'bearer' }],
            },
          ],
        }}
      />,
    );

    fireEvent.change(screen.getByLabelText('Select analysis agency'), {
      target: { value: 'options-swing' },
    });

    await waitFor(() => expect(screen.getByTestId('panel-gear-options_risk')).toBeTruthy());
    // No second gear.
    expect(screen.queryByTestId('panel-settings-options_risk')).toBeNull();

    fireEvent.click(screen.getByTestId('panel-gear-options_risk'));
    await waitFor(() => expect(screen.getByText('Options Risk · Settings')).toBeTruthy());
    // Both tabs present in the single dialog.
    expect(screen.getByTestId('tab-sources')).toBeTruthy();
    expect(screen.getByTestId('tab-flavor')).toBeTruthy();
  });

  it('shows ONE gear for a pure-ingestion analyst (source only)', async () => {
    // data_ingestion has a credentialed source but (in this test) no flavors
    // resolved, so it shows exactly one gear (no second settings gear).
    vi.spyOn(flavorClient, 'getAnalystFlavors').mockRejectedValue(new Error('404'));

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
              sources: [{ id: 'alphaVantage', label: 'Alpha Vantage', auth: 'apikey' }],
            },
          ],
        }}
      />,
    );

    expect(screen.getByTestId('panel-gear-data_ingestion')).toBeTruthy();
    expect(screen.queryByTestId('panel-settings-data_ingestion')).toBeNull();
  });
});

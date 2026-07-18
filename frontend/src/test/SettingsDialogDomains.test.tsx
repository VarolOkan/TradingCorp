// frontend/src/test/SettingsDialogDomains.test.tsx
// Regression: clicking the Settings "Data Sources" tab must render the
// per-domain source editor without throwing. A prior build referenced an
// undeclared `saving` variable in SettingsDialog.tsx (it lives in
// DomainSourcesTab, not the parent), which threw a ReferenceError during the
// domains-tab render and blacked out the whole app. This test mounts the real
// SettingsDialog and activates that tab so the bug (and the fix) is exercised.

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import SettingsDialog from '../components/SettingsDialog';
import * as client from '../api/domainSourceClient';

const SAMPLE: client.DomainSourcesResponse = {
  domains: {
    price_bars: { available: ['yahoo'], override: undefined, enabled: ['yahoo'], overridden: false },
    news_sentiment: {
      available: ['finnhub', 'yahoo', 'google'],
      override: undefined,
      enabled: ['finnhub', 'yahoo', 'google'],
      overridden: false,
    },
    fundamentals: { available: ['alphaVantage'], override: undefined, enabled: ['alphaVantage'], overridden: false },
    option_chain: { available: ['polygonOptions'], override: undefined, enabled: ['polygonOptions'], overridden: false },
    risk_free_rate: { available: ['treasuryRfr'], override: undefined, enabled: ['treasuryRfr'], overridden: false },
    market_meta: { available: ['yahoo'], override: undefined, enabled: ['yahoo'], overridden: false },
  },
  overrides: {},
};

describe('SettingsDialog — Data Sources tab', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(client, 'getDomainSources').mockResolvedValue(SAMPLE);
    vi.spyOn(client, 'setDomainSources').mockResolvedValue({ ok: true, domain: 'price_bars', enabled: ['yahoo'] });
    vi.spyOn(client, 'resetDomainSources').mockResolvedValue(SAMPLE);
  });

  it('opens the Data Sources tab and renders the per-domain editor without crashing', async () => {
    const onClose = vi.fn();
    render(<SettingsDialog open onClose={onClose} sessionId="default" />);
    // Activate the previously-black-screening tab.
    fireEvent.click(screen.getByTestId('tab-domains'));
    // DomainSourcesTab loads + renders each domain's sources.
    expect(await screen.findByText('News sentiment')).toBeInTheDocument();
    expect(screen.getByText('Price bars')).toBeInTheDocument();
    // No error-boundary fallback triggered.
    expect(screen.queryByTestId('tab-render-error')).toBeNull();
  });

  it('Accept button saves the per-domain mapping via the ref handle', async () => {
    const onClose = vi.fn();
    render(<SettingsDialog open onClose={onClose} sessionId="default" />);
    fireEvent.click(screen.getByTestId('tab-domains'));
    await screen.findByText('News sentiment');
    fireEvent.click(screen.getByTestId('domains-save'));
    await waitFor(() => expect(client.setDomainSources).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
  });
});

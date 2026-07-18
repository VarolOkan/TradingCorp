// frontend/src/test/DomainSourcesTab.test.tsx
// P3b UI test: the per-domain source editor loads the mapping, lets the user
// disable / enable a source (showing an honest "degraded" chip when all are
// off), reorder enabled sources, and POSTs the right per-domain lists on save.

import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { DomainSourcesTab, type DomainSourcesTabHandle } from '../components/analysts/DomainSourcesTab';
import * as client from '../api/domainSourceClient';

const SAMPLE: client.DomainSourcesResponse = {
  domains: {
    news_sentiment: {
      available: ['finnhub', 'yahoo', 'google'],
      override: undefined,
      enabled: ['finnhub', 'yahoo', 'google'],
      overridden: false,
    },
    price_bars: {
      available: ['yahoo'],
      override: undefined,
      enabled: ['yahoo'],
      overridden: false,
    },
  },
  overrides: {},
};

describe('DomainSourcesTab (P3b)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('loads domains and shows available sources as toggles', async () => {
    vi.spyOn(client, 'getDomainSources').mockResolvedValue(SAMPLE);
    render(<DomainSourcesTab />);
    expect(await screen.findByText('News sentiment')).toBeInTheDocument();
    expect(screen.getByLabelText('Toggle finnhub for news_sentiment')).toBeChecked();
    expect(screen.getByLabelText('Toggle yahoo for news_sentiment')).toBeChecked();
    expect(screen.getByLabelText('Toggle google for news_sentiment')).toBeChecked();
  });

  it('disabling the only source for a domain shows an honest "degraded" chip', async () => {
    vi.spyOn(client, 'getDomainSources').mockResolvedValue(SAMPLE);
    vi.spyOn(client, 'setDomainSources').mockResolvedValue({ ok: true, domain: 'price_bars', enabled: [] });
    render(<DomainSourcesTab />);
    await screen.findByText('Price bars');
    // price_bars has only 'yahoo' — disable it.
    const toggle = screen.getByLabelText('Toggle yahoo for price_bars') as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    expect(toggle.checked).toBe(false);
    // Degraded chip appears for the now-empty domain.
    expect(await screen.findByTestId('domain-degraded-price_bars')).toBeInTheDocument();
    expect(screen.getByText(/All sources disabled/i)).toBeInTheDocument();
  });

  it('save POSTs the ordered enabled list per domain', async () => {
    vi.spyOn(client, 'getDomainSources').mockResolvedValue(SAMPLE);
    const setSpy = vi
      .spyOn(client, 'setDomainSources')
      .mockResolvedValue({ ok: true, domain: 'news_sentiment', enabled: ['yahoo', 'finnhub', 'google'] });
    const ref = { current: null as DomainSourcesTabHandle | null };
    render(<DomainSourcesTab ref={ref} />);
    await screen.findByText('News sentiment');

    // Disable finnhub -> draft becomes ['yahoo','google'].
    fireEvent.click(screen.getByLabelText('Toggle finnhub for news_sentiment'));
    const ok = await ref.current!.save();
    expect(ok).toBe(true);
    // Both domains are persisted (price_bars unchanged ['yahoo']).
    expect(setSpy).toHaveBeenCalled();
    const calls = setSpy.mock.calls;
    expect(calls.some((c) => c[0] === 'news_sentiment' && JSON.stringify(c[1]) === JSON.stringify(['yahoo', 'google']))).toBe(true);
    expect(calls.some((c) => c[0] === 'price_bars' && JSON.stringify(c[1]) === JSON.stringify(['yahoo']))).toBe(true);
  });

  it('reset restores defaults', async () => {
    vi.spyOn(client, 'getDomainSources').mockResolvedValue(SAMPLE);
    vi.spyOn(client, 'resetDomainSources').mockResolvedValue(SAMPLE);
    render(<DomainSourcesTab />);
    await screen.findByText('News sentiment');
    fireEvent.click(screen.getByText('Reset to defaults'));
    await waitFor(() => expect(client.resetDomainSources).toHaveBeenCalled());
  });

  it('does NOT crash when a domain is missing available/enabled (regression: black screen)', async () => {
    // A malformed /domain-sources payload (missing `available` or `enabled` on a
    // domain) previously threw during render and, with no error boundary, tore
    // down the entire React root — the whole app went black. The component must
    // now render gracefully instead.
    const MALFORMED: client.DomainSourcesResponse = {
      domains: {
        news_sentiment: { available: undefined as unknown as string[], override: undefined, enabled: undefined as unknown as string[], overridden: false },
        price_bars: { available: ['yahoo'], override: undefined, enabled: undefined as unknown as string[], overridden: false },
        fundamentals: { available: ['alphaVantage'], override: undefined, enabled: ['alphaVantage'], overridden: false },
      },
      overrides: {},
    };
    vi.spyOn(client, 'getDomainSources').mockResolvedValue(MALFORMED);
    // Should render without throwing; the broken domains simply show as degraded.
    expect(() => render(<DomainSourcesTab />)).not.toThrow();
    expect(await screen.findByText('Price bars')).toBeInTheDocument();
    expect(await screen.findByTestId('domain-degraded-price_bars')).toBeInTheDocument();
    expect(await screen.findByTestId('domain-degraded-news_sentiment')).toBeInTheDocument();
  });
});

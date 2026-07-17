// frontend/src/test/SourcesTab.test.tsx
// The SHARED Sources editor used by BOTH the per-analyst dialog and the General
// Settings dialog. It renders the inputs (no own button); each parent dialog
// commits it via the ref's save() (→ postAnalystConfig, the GPG-persisting
// path). Covers: pre-filled Base URIs, NO internal Save button, the "••••••
// already saved" masked display for a previously-stored token + Change flow,
// and that save() POSTs each credential.
import { createRef } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SourcesTab, type SourcesTabHandle } from '../components/analysts/SourcesTab';
import * as analystConfigClient from '../api/analystConfigClient';
import type { SourceCredField } from '../components/analysts/analystConfigSchema';

const sourcesUnstored: SourceCredField[] = [
  { sourceId: 'alphaVantage', label: 'Alpha Vantage', auth: 'apikey', uriRequired: true, uriLabel: 'Base URI', uriDefault: 'https://www.alphavantage.co/query', hasToken: false },
  { sourceId: 'finnhub', label: 'Finnhub', auth: 'bearer', uriRequired: true, uriLabel: 'Base URI', uriDefault: 'https://finnhub.io/api/v1', hasToken: false },
];

const sourcesStored: SourceCredField[] = [
  { sourceId: 'alphaVantage', label: 'Alpha Vantage', auth: 'apikey', uriRequired: true, uriLabel: 'Base URI', uriDefault: 'https://www.alphavantage.co/query', hasToken: true },
  { sourceId: 'finnhub', label: 'Finnhub', auth: 'bearer', uriRequired: true, uriLabel: 'Base URI', uriDefault: 'https://finnhub.io/api/v1', hasToken: false },
];

describe('SourcesTab (shared, GPG-persisting, single Save button)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('pre-fills each known source Base URI so the user only confirms', () => {
    const ref = createRef<SourcesTabHandle>();
    render(<SourcesTab ref={ref} analystId="data_ingestion" sessionId="default" sources={sourcesUnstored} />);
    expect(screen.getByLabelText('Alpha Vantage Base URI')).toHaveValue('https://www.alphavantage.co/query');
    expect(screen.getByLabelText('Finnhub Base URI')).toHaveValue('https://finnhub.io/api/v1');
  });

  it('renders NO internal Save button (parent dialog owns Save)', () => {
    const ref = createRef<SourcesTabHandle>();
    render(<SourcesTab ref={ref} analystId="data_ingestion" sessionId="default" sources={sourcesUnstored} />);
    expect(screen.queryByRole('button', { name: /save sources/i })).toBeNull();
  });

  it('shows a "•••••• already saved" placeholder for a previously-stored token (editable, like LLM Models)', () => {
    const ref = createRef<SourcesTabHandle>();
    render(<SourcesTab ref={ref} analystId="data_ingestion" sessionId="default" sources={sourcesStored} />);
    const tokenInput = screen.getByLabelText('Alpha Vantage token') as HTMLInputElement;
    expect(tokenInput).toHaveAttribute('placeholder', '•••••• already saved');
    // The field is editable — there is NO separate "Change" link to click.
    expect(screen.queryByRole('button', { name: /change/i })).toBeNull();
    // Typing a new value works directly (no reveal step needed).
    fireEvent.change(tokenInput, { target: { value: 'new-key' } });
    expect(tokenInput).toHaveValue('new-key');
  });

  it('save() POSTs a typed token + URI, but does NOT clobber a blank token over a stored one', async () => {
    const spy = vi.spyOn(analystConfigClient, 'postAnalystConfig').mockResolvedValue({
      ok: true, sessionId: 'default', analystId: 'data_ingestion', sourceId: 'alphaVantage', hasToken: true,
    });
    const ref = createRef<SourcesTabHandle>();
    render(<SourcesTab ref={ref} analystId="data_ingestion" sessionId="s1" sources={sourcesUnstored} />);
    fireEvent.change(screen.getByLabelText('Alpha Vantage token'), { target: { value: 'av-key' } });

    const ok = await ref.current!.save();
    expect(ok).toBe(true);
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy).toHaveBeenCalledWith(
      { analystId: 'data_ingestion', sourceId: 'alphaVantage', token: 'av-key', extra: { uri: 'https://www.alphavantage.co/query' } },
      's1',
    );
    // Finnhub: blank token + unchanged (default) URI => NO post (would clobber a
    // previously stored token — the bug this fix prevents).
    expect(spy).not.toHaveBeenCalledWith(
      expect.objectContaining({ sourceId: 'finnhub' }),
      's1',
    );
  });

  it('save() re-POSTs when the URI is changed, still preserving a blank token', async () => {
    vi.spyOn(analystConfigClient, 'postAnalystConfig').mockResolvedValue({
      ok: true, sessionId: 'default', analystId: 'data_ingestion', sourceId: 'finnhub', hasToken: true,
    });
    const ref = createRef<SourcesTabHandle>();
    render(<SourcesTab ref={ref} analystId="data_ingestion" sessionId="s1" sources={sourcesUnstored} />);
    fireEvent.change(screen.getByLabelText('Finnhub Base URI'), { target: { value: 'https://finnhub.io/api/v2' } });

    await ref.current!.save();
    await waitFor(() => expect(analystConfigClient.postAnalystConfig).toHaveBeenCalled());
    expect(analystConfigClient.postAnalystConfig).toHaveBeenCalledWith(
      { analystId: 'data_ingestion', sourceId: 'finnhub', token: '', extra: { uri: 'https://finnhub.io/api/v2' } },
      's1',
    );
  });

  it('save() flips the "stored" chip to true after a successful save', async () => {
    vi.spyOn(analystConfigClient, 'postAnalystConfig').mockResolvedValue({
      ok: true, sessionId: 'default', analystId: 'data_ingestion', sourceId: 'finnhub', hasToken: true,
    });
    const ref = createRef<SourcesTabHandle>();
    render(<SourcesTab ref={ref} analystId="data_ingestion" sessionId="default" sources={sourcesUnstored} />);
    // Finnhub starts "not stored".
    expect(screen.getByLabelText('Finnhub not stored')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Finnhub token'), { target: { value: 'fh-key' } });
    await ref.current!.save();
    await waitFor(() => expect(screen.getByLabelText('Finnhub token stored')).toBeInTheDocument());
  });

  it('shows an empty-state when the analyst has no credentialed sources', () => {
    const ref = createRef<SourcesTabHandle>();
    render(<SourcesTab ref={ref} analystId="governance" sessionId="default" sources={[]} />);
    expect(screen.getByText(/no credentialed sources/i)).toBeInTheDocument();
  });

  describe('per-source [Test] button', () => {
    it('sends a health probe using the stored token and shows OK + latency', async () => {
      const spy = vi
        .spyOn(analystConfigClient, 'testAnalystConfig')
        .mockResolvedValue({ ok: true, sourceId: 'alphaVantage', hasToken: true, latencyMs: 142 });
      const ref = createRef<SourcesTabHandle>();
      render(<SourcesTab ref={ref} analystId="data_ingestion" sessionId="s1" sources={sourcesStored} />);

      fireEvent.click(screen.getByRole('button', { name: /Test Alpha Vantage connection/i }));
      await waitFor(() => expect(spy).toHaveBeenCalledWith('data_ingestion', 'alphaVantage', 's1'));
      expect(await screen.findByText(/OK · 142ms/)).toBeInTheDocument();
    });

    it('shows a clear failure message when the probe fails', async () => {
      vi.spyOn(analystConfigClient, 'testAnalystConfig').mockResolvedValue({
        ok: false,
        sourceId: 'finnhub',
        hasToken: true,
        status: 401,
        error: 'Authentication failed — check the token',
      });
      const ref = createRef<SourcesTabHandle>();
      render(<SourcesTab ref={ref} analystId="data_ingestion" sessionId="default" sources={sourcesStored} />);

      fireEvent.click(screen.getByRole('button', { name: /Test Finnhub connection/i }));
      expect(await screen.findByText(/Authentication failed/i)).toBeInTheDocument();
    });

    it('shows a network error when the request itself throws', async () => {
      vi.spyOn(analystConfigClient, 'testAnalystConfig').mockRejectedValue(new Error('HTTP 500'));
      const ref = createRef<SourcesTabHandle>();
      render(<SourcesTab ref={ref} analystId="data_ingestion" sessionId="default" sources={sourcesStored} />);

      fireEvent.click(screen.getByRole('button', { name: /Test Alpha Vantage connection/i }));
      expect(await screen.findByText(/HTTP 500/)).toBeInTheDocument();
    });
  });
});

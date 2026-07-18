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

  describe('per-source analystId override (General dialog shows options sources under options_ingestion)', () => {
    // The General Settings → Sources tab reuses THIS component but renders Polygon
    // options sources that live under the `options_ingestion` analyst. They MUST
    // POST under `options_ingestion` (where the options engine resolves them),
    // NOT under the tab's display analyst (`data_ingestion`).
    const sourcesMixed: SourceCredField[] = [
      { sourceId: 'alphaVantage', label: 'Alpha Vantage', auth: 'apikey', uriRequired: true, uriLabel: 'Base URI', uriDefault: 'https://www.alphavantage.co/query', hasToken: false },
      { sourceId: 'polygonOptions', label: 'Polygon Options', auth: 'bearer', uriRequired: true, uriLabel: 'Base URI', uriDefault: 'https://api.polygon.io/v3/snapshot/options/{ticker}', hasToken: false, analystId: 'options_ingestion' },
    ];

    it('POSTs a per-source-override source under its OWN analystId', async () => {
      const spy = vi.spyOn(analystConfigClient, 'postAnalystConfig').mockResolvedValue({
        ok: true, sessionId: 'default', analystId: 'options_ingestion', sourceId: 'polygonOptions', hasToken: true,
      });
      const ref = createRef<SourcesTabHandle>();
      render(<SourcesTab ref={ref} analystId="data_ingestion" sessionId="s1" sources={sourcesMixed} />);
      fireEvent.change(screen.getByLabelText('Polygon Options token'), { target: { value: 'poly-key' } });

      const ok = await ref.current!.save();
      expect(ok).toBe(true);
      await waitFor(() => expect(spy).toHaveBeenCalled());
      expect(spy).toHaveBeenCalledWith(
        { analystId: 'options_ingestion', sourceId: 'polygonOptions', token: 'poly-key', extra: { uri: 'https://api.polygon.io/v3/snapshot/options/{ticker}' } },
        's1',
      );
      // The Alpha Vantage row (no override) still saves under the tab analyst.
      expect(spy).not.toHaveBeenCalledWith(
        expect.objectContaining({ sourceId: 'alphaVantage', analystId: 'options_ingestion' }),
        's1',
      );
    });

    it('[Test] button probes the overridden analystId too', async () => {
      const spy = vi.spyOn(analystConfigClient, 'testAnalystConfig').mockResolvedValue({ ok: true, sourceId: 'polygonOptions', hasToken: true, latencyMs: 175 });
      const ref = createRef<SourcesTabHandle>();
      render(<SourcesTab ref={ref} analystId="data_ingestion" sessionId="s1" sources={sourcesMixed} />);
      fireEvent.click(screen.getByRole('button', { name: /Test Polygon Options connection/i }));
      await waitFor(() => expect(spy).toHaveBeenCalledWith('options_ingestion', 'polygonOptions', 's1'));
      expect(await screen.findByText(/OK · 175ms/)).toBeInTheDocument();
    });
  });

  describe('key group (single shared key, endpoints listed underneath)', () => {
    // Polygon/Massive options snapshot + daily aggregates share ONE Massive key.
    // They declare a common keyGroup so the UI shows a single token field and
    // fans the typed key out to BOTH members on save.
    const sourcesGrouped: SourceCredField[] = [
      {
        sourceId: 'polygonOptions', label: 'Polygon Options', auth: 'bearer', uriRequired: true,
        uriLabel: 'Base URI', uriDefault: 'https://api.massive.com/v3/snapshot/options/{ticker}',
        hasToken: false, analystId: 'options_ingestion',
        keyGroup: 'massive', keyGroupLabel: 'Massive/Polygon Options', endpointLabel: 'Options snapshot',
      },
      {
        sourceId: 'polygonHist', label: 'Polygon Aggregates', auth: 'bearer', uriRequired: true,
        uriLabel: 'Base URI', uriDefault: 'https://api.massive.com/v2/aggs/ticker/{ticker}/range/1/day/{from}/{to}',
        hasToken: false, analystId: 'options_ingestion',
        keyGroup: 'massive', keyGroupLabel: 'Massive/Polygon Options', endpointLabel: 'Daily aggregates',
      },
    ];

    it('renders ONE shared key field labelled "Massive/Polygon Options" with each endpoint listed', () => {
      const ref = createRef<SourcesTabHandle>();
      render(<SourcesTab ref={ref} analystId="data_ingestion" sessionId="default" sources={sourcesGrouped} />);
      // Exactly one password (token) input for the whole group.
      const tokenInputs = screen.getAllByLabelText(/Massive\/Polygon Options token/i);
      expect(tokenInputs).toHaveLength(1);
      // Group heading present.
      expect(screen.getByRole('heading', { name: /Massive\/Polygon Options/i })).toBeInTheDocument();
      // Each member's endpoint URI is listed under its endpointLabel.
      expect(screen.getByLabelText('Polygon Options Base URI')).toHaveValue('https://api.massive.com/v3/snapshot/options/{ticker}');
      expect(screen.getByLabelText('Polygon Aggregates Base URI')).toHaveValue('https://api.massive.com/v2/aggs/ticker/{ticker}/range/1/day/{from}/{to}');
      expect(screen.getByText('Options snapshot')).toBeInTheDocument();
      expect(screen.getByText('Daily aggregates')).toBeInTheDocument();
    });

    it('save() fans the single typed key out to BOTH members under options_ingestion', async () => {
      const spy = vi.spyOn(analystConfigClient, 'postAnalystConfig').mockResolvedValue({
        ok: true, sessionId: 'default', analystId: 'options_ingestion', sourceId: 'polygonOptions', hasToken: true,
      });
      const ref = createRef<SourcesTabHandle>();
      render(<SourcesTab ref={ref} analystId="data_ingestion" sessionId="s1" sources={sourcesGrouped} />);
      fireEvent.change(screen.getByLabelText(/Massive\/Polygon Options token/i), { target: { value: 'massive-key' } });

      const ok = await ref.current!.save();
      expect(ok).toBe(true);
      await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
      expect(spy).toHaveBeenCalledWith(
        { analystId: 'options_ingestion', sourceId: 'polygonOptions', token: 'massive-key', extra: { uri: 'https://api.massive.com/v3/snapshot/options/{ticker}' } },
        's1',
      );
      expect(spy).toHaveBeenCalledWith(
        { analystId: 'options_ingestion', sourceId: 'polygonHist', token: 'massive-key', extra: { uri: 'https://api.massive.com/v2/aggs/ticker/{ticker}/range/1/day/{from}/{to}' } },
        's1',
      );
    });

    it('the group "stored" chip flips to stored only after BOTH members save', async () => {
      vi.spyOn(analystConfigClient, 'postAnalystConfig').mockResolvedValue({
        ok: true, sessionId: 'default', analystId: 'options_ingestion', sourceId: 'polygonOptions', hasToken: true,
      });
      const ref = createRef<SourcesTabHandle>();
      render(<SourcesTab ref={ref} analystId="data_ingestion" sessionId="default" sources={sourcesGrouped} />);
      expect(screen.getByLabelText('Massive/Polygon Options not stored')).toBeInTheDocument();
      fireEvent.change(screen.getByLabelText(/Massive\/Polygon Options token/i), { target: { value: 'massive-key' } });
      await ref.current!.save();
      await waitFor(() => expect(screen.getByLabelText('Massive/Polygon Options key stored')).toBeInTheDocument());
    });

    it('renders ONE combined [Test] button at the bottom (not one per endpoint)', async () => {
      const spy = vi
        .spyOn(analystConfigClient, 'testAnalystConfig')
        .mockResolvedValue({ ok: true, sourceId: 'polygonOptions', hasToken: true, latencyMs: 88 });
      const ref = createRef<SourcesTabHandle>();
      render(<SourcesTab ref={ref} analystId="data_ingestion" sessionId="s1" sources={sourcesGrouped} />);
      // One combined button for the whole group — no per-endpoint buttons.
      expect(screen.queryByRole('button', { name: /Test Polygon Options connection/i })).toBeNull();
      expect(screen.queryByRole('button', { name: /Test Polygon Aggregates connection/i })).toBeNull();
      const groupTest = screen.getByRole('button', { name: /Test Massive\/Polygon Options endpoints/i });
      fireEvent.click(groupTest);
      // The combined probe hits BOTH member endpoints under options_ingestion.
      await waitFor(() => expect(spy).toHaveBeenCalledWith('options_ingestion', 'polygonOptions', 's1'));
      await waitFor(() => expect(spy).toHaveBeenCalledWith('options_ingestion', 'polygonHist', 's1'));
      expect(await screen.findByText(/OK · 2\/2/)).toBeInTheDocument();
    });
  });
});

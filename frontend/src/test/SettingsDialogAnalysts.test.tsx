// frontend/src/test/SettingsDialogAnalysts.test.tsx
// Analysts tab: list (built-in Delete disabled, custom deletable), create +
// edit + delete, default/custom guards, and onRegistryChange fires.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import SettingsDialog from '../components/SettingsDialog';
import * as registryClient from '../api/registryClient';
import * as analystFlavorsClient from '../api/analystFlavorsClient';

// SettingsDialog mutates the shared AGENCIES mirror via this helper; stub it.
vi.mock('../components/analysts/agencies', () => ({
  applyRegistryAgencies: vi.fn(),
}));

const BASE = {
  open: true,
  onClose: vi.fn(),
  onSaved: vi.fn(),
  onRegistryChange: vi.fn(),
  sessionId: 'default',
  agencyId: 'long-term',
};

describe('SettingsDialog — Analysts tab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(registryClient, 'getRegistry').mockResolvedValue({
      catalog: [
        { id: 'orchestrator', name: 'Orchestrator', kind: 'orchestrator', stage: 1, custom: false, logic: { mode: 'declarative', weighting: [] } },
        { id: 'data_ingestion', name: 'Data Ingestion', kind: 'ingestion', stage: 1, custom: false, logic: { mode: 'declarative', weighting: [] } },
        { id: 'fundamental', name: 'Fundamental', kind: 'analyst', stage: 2, custom: false, logic: { mode: 'declarative', weighting: [] } },
        { id: 'technical', name: 'Technical', kind: 'analyst', stage: 2, custom: false, logic: { mode: 'declarative', weighting: [] } },
        { id: 'contrarian', name: 'Contrarian', kind: 'analyst', stage: 2, custom: true, logic: { mode: 'declarative', weighting: [] },
          dataSources: [{ id: 'price', label: 'Price', from: 'market', fields: ['close', 'volume'], sources: ['yfinance'] }],
          output: { channels: ['contrarian_out'], verdictField: 'verdict', scoreField: 'score', storeInMessages: true } },
        {
          id: 'flavored', name: 'Flavored', kind: 'analyst', stage: 2, custom: true,
          logic: { mode: 'declarative', weighting: [] },
          flavors: [
            {
              id: 'default', name: 'Balanced', role: 'skew + term structure',
              instructions: 'ROLE: be balanced\nMETHOD: read skew', enabled: true,
              isDefault: true, modelRole: 'deep-thought',
            },
          ],
          flavorId: 'default',
        },
        { id: 'risk', name: 'Risk', kind: 'gatekeeper', stage: 3, custom: false, logic: { mode: 'declarative', weighting: [] } },
        { id: 'governance', name: 'Governance', kind: 'gatekeeper', stage: 3, custom: false, logic: { mode: 'declarative', weighting: [] } },
      ],
      agencies: [
        { id: 'long-term', name: 'Long-term', analystCount: 7, isDefault: true, horizon: 'LONG_TERM', analysts: [] },
      ],
      driver: 'json',
    });
    vi.spyOn(registryClient, 'postAnalyst').mockResolvedValue({ ok: true, id: 'my-analyst', analyst: {} as never } as never);
    vi.spyOn(registryClient, 'putAnalyst').mockResolvedValue({ ok: true, id: 'contrarian', analyst: {} as never } as never);
    vi.spyOn(registryClient, 'deleteAnalyst').mockResolvedValue({ ok: true, id: 'contrarian' } as never);
    vi.spyOn(analystFlavorsClient, 'getAnalystFlavors').mockResolvedValue({
      sessionId: 'default', agencyId: 'long-term', analystId: 'contrarian',
      flavors: [
        { id: 'default', name: 'Card-set', role: 'card role', instructions: 'ROLE: from card\nOBJECTIVE: x', enabled: true, isDefault: true },
      ],
      selectedId: 'default',
    });
    vi.spyOn(analystFlavorsClient, 'postAnalystFlavors').mockResolvedValue({
      ok: true, sessionId: 'default', agencyId: 'long-term', analystId: 'contrarian',
      flavors: [], selectedId: 'default',
    });
  });

  const openTab = async () => {
    render(<SettingsDialog {...BASE} />);
    fireEvent.click(screen.getByTestId('tab-analysts'));
    await screen.findByTestId('analyst-admin-list');
  };

  it('lists analysts and disables Delete on built-ins but not custom', async () => {
    await openTab();
    // Default view is Stage 1; switch to Stage 2 to see these analysts.
    fireEvent.click(screen.getByTestId('analyst-stage-2'));
    expect(screen.getByTestId('analyst-admin-fundamental')).toBeInTheDocument();
    expect(screen.getByTestId('analyst-admin-contrarian')).toBeInTheDocument();
    const delBuiltin = screen.getByTestId('analyst-delete-fundamental') as HTMLButtonElement;
    expect(delBuiltin.disabled).toBe(true);
    const delCustom = screen.getByTestId('analyst-delete-contrarian') as HTMLButtonElement;
    expect(delCustom.disabled).toBe(false);
    // Built-in has no Edit button.
    expect(screen.queryByTestId('analyst-edit-fundamental')).toBeNull();
    expect(screen.getByTestId('analyst-edit-contrarian')).toBeInTheDocument();
  });

  it('clicking a custom analyst row populates the form for editing', async () => {
    await openTab();
    fireEvent.click(screen.getByTestId('analyst-stage-2'));
    fireEvent.click(screen.getByTestId('analyst-admin-contrarian'));
    expect((screen.getByTestId('new-analyst-id') as HTMLInputElement).value).toBe('contrarian');
    expect((screen.getByTestId('new-analyst-name') as HTMLInputElement).value).toBe('Contrarian');
    // Id locked while editing.
    expect((screen.getByTestId('new-analyst-id') as HTMLInputElement).disabled).toBe(true);
    // Save enabled (custom is editable).
    expect((screen.getByTestId('save-analyst') as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText(/Edit analyst · contrarian/)).toBeInTheDocument();
  });

  it('clicking a built-in analyst row populates but disables Save (read-only)', async () => {
    await openTab();
    fireEvent.click(screen.getByTestId('analyst-stage-2'));
    fireEvent.click(screen.getByTestId('analyst-admin-fundamental'));
    expect((screen.getByTestId('new-analyst-id') as HTMLInputElement).value).toBe('fundamental');
    expect((screen.getByTestId('new-analyst-name') as HTMLInputElement).value).toBe('Fundamental');
    // Built-ins cannot be saved.
    expect((screen.getByTestId('save-analyst') as HTMLButtonElement).disabled).toBe(true);
  });

  it('creates a custom analyst and fires onRegistryChange', async () => {
    await openTab();
    fireEvent.change(screen.getByTestId('new-analyst-id'), { target: { value: 'my-analyst' } });
    fireEvent.change(screen.getByTestId('new-analyst-name'), { target: { value: 'My Analyst' } });
    fireEvent.click(screen.getByTestId('save-analyst'));

    await waitFor(() => expect(registryClient.postAnalyst).toHaveBeenCalled());
    const [body, userId] = (registryClient.postAnalyst as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(userId).toBe('default');
    expect(body.id).toBe('my-analyst');
    expect(body.name).toBe('My Analyst');
    await waitFor(() => expect(BASE.onRegistryChange).toHaveBeenCalled());
  });

  it('edits a custom analyst via PUT and keeps the same id', async () => {
    await openTab();
    fireEvent.click(screen.getByTestId('analyst-stage-2'));
    fireEvent.click(screen.getByTestId('analyst-edit-contrarian'));
    fireEvent.change(screen.getByTestId('new-analyst-name'), { target: { value: 'Contrarian 2' } });
    fireEvent.click(screen.getByTestId('save-analyst'));

    await waitFor(() => expect(registryClient.putAnalyst).toHaveBeenCalled());
    const [id, body, userId] = (registryClient.putAnalyst as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(id).toBe('contrarian');
    expect(body.name).toBe('Contrarian 2');
    expect(userId).toBe('default');
    await waitFor(() => expect(BASE.onRegistryChange).toHaveBeenCalled());
  });

  it('deletes a custom analyst and fires onRegistryChange', async () => {
    await openTab();
    fireEvent.click(screen.getByTestId('analyst-stage-2'));
    fireEvent.click(screen.getByTestId('analyst-delete-contrarian'));
    await waitFor(() => expect(registryClient.deleteAnalyst).toHaveBeenCalledWith('contrarian', 'default'));
    await waitFor(() => expect(BASE.onRegistryChange).toHaveBeenCalled());
  });

  it('shows a server error message when create fails', async () => {
    (registryClient.postAnalyst as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('analyst already exists'));
    await openTab();
    fireEvent.change(screen.getByTestId('new-analyst-id'), { target: { value: 'dupe' } });
    fireEvent.change(screen.getByTestId('new-analyst-name'), { target: { value: 'Dupe' } });
    fireEvent.click(screen.getByTestId('save-analyst'));
    await waitFor(() => expect(screen.getByTestId('analyst-error')).toHaveTextContent(/already exists/i));
  });

  it('filters analysts by stage via the stage sub-tabs', async () => {
    await openTab();
    // Default view is Stage 1 → only orchestrator + data_ingestion.
    expect(screen.getByTestId('analyst-admin-orchestrator')).toBeInTheDocument();
    expect(screen.getByTestId('analyst-admin-data_ingestion')).toBeInTheDocument();
    expect(screen.queryByTestId('analyst-admin-fundamental')).toBeNull();
    expect(screen.queryByTestId('analyst-admin-risk')).toBeNull();

    // Stage 3 → only risk + governance.
    fireEvent.click(screen.getByTestId('analyst-stage-3'));
    expect(screen.getByTestId('analyst-admin-risk')).toBeInTheDocument();
    expect(screen.getByTestId('analyst-admin-governance')).toBeInTheDocument();
    expect(screen.queryByTestId('analyst-admin-orchestrator')).toBeNull();

    // Stage 2 → fundamental + contrarian (+ technical).
    fireEvent.click(screen.getByTestId('analyst-stage-2'));
    expect(screen.getByTestId('analyst-admin-fundamental')).toBeInTheDocument();
    expect(screen.getByTestId('analyst-admin-contrarian')).toBeInTheDocument();
    expect(screen.queryByTestId('analyst-admin-orchestrator')).toBeNull();
  });

  it('draws arrows between the stage chips (Stage 1 → 2 → 3)', async () => {
    await openTab();
    // Two connectors: 1→2 and 2→3.
    expect(screen.getByTestId('stage-arrow-1')).toHaveTextContent('→');
    expect(screen.getByTestId('stage-arrow-2')).toHaveTextContent('→');
    // Clicking a stage chip still switches the filter.
    fireEvent.click(screen.getByTestId('analyst-stage-2'));
    expect(screen.getByTestId('analyst-admin-fundamental')).toBeInTheDocument();
  });

  it('splits the edit form into [General][Input][Analysis][Output] sub-tabs', async () => {
    await openTab();
    fireEvent.click(screen.getByTestId('analyst-stage-2'));
    fireEvent.click(screen.getByTestId('analyst-admin-contrarian'));
    // All four sub-tab buttons render.
    expect(screen.getByTestId('analyst-edit-tab-general')).toBeInTheDocument();
    expect(screen.getByTestId('analyst-edit-tab-input')).toBeInTheDocument();
    expect(screen.getByTestId('analyst-edit-tab-analysis')).toBeInTheDocument();
    expect(screen.getByTestId('analyst-edit-tab-output')).toBeInTheDocument();
    // GENERAL is the default; the id/name fields are visible here.
    expect(screen.getByTestId('analyst-edit-general')).toBeInTheDocument();
    expect(screen.queryByTestId('analyst-edit-input')).toBeNull();
    // Switching to INPUT reveals the dataSources editor and hides GENERAL.
    fireEvent.click(screen.getByTestId('analyst-edit-tab-input'));
    expect(screen.getByTestId('analyst-edit-input')).toBeInTheDocument();
    expect(screen.queryByTestId('analyst-edit-general')).toBeNull();
    // ANALYSIS exposes the previously-missing Role & Instructions editor.
    fireEvent.click(screen.getByTestId('analyst-edit-tab-analysis'));
    expect(screen.getByTestId('analyst-edit-analysis')).toBeInTheDocument();
    expect(screen.getByTestId('new-analyst-flavor-name')).toBeInTheDocument();
    expect(screen.getByTestId('new-analyst-flavor-instructions')).toBeInTheDocument();
    expect(screen.getByTestId('new-analyst-flavor-enabled')).toBeInTheDocument();
    // OUTPUT keeps the channels/verdict/score fields.
    fireEvent.click(screen.getByTestId('analyst-edit-tab-output'));
    expect(screen.getByTestId('analyst-edit-output')).toBeInTheDocument();
    expect(screen.getAllByLabelText(/Channels/i).length).toBeGreaterThan(0);
  });

  it('saves the Role & Instructions flavor into the analyst def', async () => {
    await openTab();
    fireEvent.change(screen.getByTestId('new-analyst-id'), { target: { value: 'flavored' } });
    fireEvent.change(screen.getByTestId('new-analyst-name'), { target: { value: 'Flavored' } });
    fireEvent.click(screen.getByTestId('analyst-edit-tab-analysis'));
    fireEvent.change(screen.getByTestId('new-analyst-flavor-name'), { target: { value: 'Momentum' } });
    fireEvent.change(screen.getByTestId('new-analyst-flavor-instructions'), {
      target: { value: 'ROLE: be bullish' },
    });
    fireEvent.click(screen.getByTestId('new-analyst-flavor-enabled'));
    fireEvent.click(screen.getByTestId('save-analyst'));

    await waitFor(() => expect(registryClient.postAnalyst).toHaveBeenCalled());
    const [body] = (registryClient.postAnalyst as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(body.flavors).toBeDefined();
    expect(body.flavors[0].id).toBe('default');
    expect(body.flavors[0].name).toBe('Momentum');
    expect(body.flavors[0].instructions).toBe('ROLE: be bullish');
    expect(body.flavors[0].enabled).toBe(true);
    expect(body.flavors[0].isDefault).toBe(true);
    expect(body.flavorId).toBe('default');
  });

  it('saves the monogram and onAllSourcesFailed GENERAL fields', async () => {
    await openTab();
    fireEvent.change(screen.getByTestId('new-analyst-id'), { target: { value: 'genfields' } });
    fireEvent.change(screen.getByTestId('new-analyst-name'), { target: { value: 'Gen Fields' } });
    fireEvent.change(screen.getByTestId('new-analyst-monogram'), { target: { value: 'GF' } });
    fireEvent.change(screen.getByTestId('new-analyst-onfail'), { target: { value: 'degrade' } });
    fireEvent.click(screen.getByTestId('save-analyst'));

    await waitFor(() => expect(registryClient.postAnalyst).toHaveBeenCalled());
    const [body] = (registryClient.postAnalyst as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(body.monogram).toBe('GF');
    expect(body.onAllSourcesFailed).toEqual({ action: 'degrade' });
  });

  it('omits flavors when no Role & Instructions are entered', async () => {
    await openTab();
    fireEvent.change(screen.getByTestId('new-analyst-id'), { target: { value: 'bare' } });
    fireEvent.change(screen.getByTestId('new-analyst-name'), { target: { value: 'Bare' } });
    fireEvent.click(screen.getByTestId('save-analyst'));

    await waitFor(() => expect(registryClient.postAnalyst).toHaveBeenCalled());
    const [body] = (registryClient.postAnalyst as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(body.flavors).toBeUndefined();
    expect(body.flavorId).toBeUndefined();
  });

  it('repopulates the ANALYSIS Instructions box when editing a flavored analyst', async () => {
    await openTab();
    fireEvent.click(screen.getByTestId('analyst-stage-2'));
    fireEvent.click(screen.getByTestId('analyst-admin-flavored'));
    // Switch to the ANALYSIS sub-tab.
    fireEvent.click(screen.getByTestId('analyst-edit-tab-analysis'));
    const ta = screen.getByTestId('new-analyst-flavor-instructions') as HTMLTextAreaElement;
    expect(ta.value).toBe('ROLE: be balanced\nMETHOD: read skew');
    // Other flavor fields come along too.
    expect((screen.getByTestId('new-analyst-flavor-name') as HTMLInputElement).value).toBe('Balanced');
    expect((screen.getByTestId('new-analyst-flavor-role') as HTMLInputElement).value).toBe('skew + term structure');
    expect((screen.getByTestId('new-analyst-flavor-enabled') as HTMLInputElement).checked).toBe(true);
    // And GENERAL reflects the saved monogram/on-fail when present.
    fireEvent.click(screen.getByTestId('analyst-edit-tab-general'));
    expect((screen.getByTestId('new-analyst-id') as HTMLInputElement).value).toBe('flavored');
  });

  it('loads Role & Instructions from the per-analyst flavor STORE (card path), not just def.flavors', async () => {
    // `contrarian` has NO flavors in the registry catalog (empty def.flavors),
    // but the /analyst-flavors store carries what the card editor wrote.
    // The store load is async, so await the populated value.
    await openTab();
    fireEvent.click(screen.getByTestId('analyst-stage-2'));
    fireEvent.click(screen.getByTestId('analyst-admin-contrarian'));
    await waitFor(() => expect(analystFlavorsClient.getAnalystFlavors).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('analyst-edit-tab-analysis'));
    const ta = screen.getByTestId('new-analyst-flavor-instructions') as HTMLTextAreaElement;
    await waitFor(() => expect(ta.value).toBe('ROLE: from card\nOBJECTIVE: x'));
    expect((screen.getByTestId('new-analyst-flavor-name') as HTMLInputElement).value).toBe('Card-set');
    expect((screen.getByTestId('new-analyst-flavor-role') as HTMLInputElement).value).toBe('card role');
  });

  it('writes the ANALYSIS fields back to the flavor store on save (so the card sees them)', async () => {
    await openTab();
    fireEvent.click(screen.getByTestId('analyst-stage-2'));
    fireEvent.click(screen.getByTestId('analyst-admin-contrarian'));
    await waitFor(() => expect(analystFlavorsClient.getAnalystFlavors).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('analyst-edit-tab-analysis'));
    fireEvent.change(screen.getByTestId('new-analyst-flavor-instructions'), {
      target: { value: 'ROLE: updated via settings' },
    });
    fireEvent.click(screen.getByTestId('save-analyst'));
    await waitFor(() => expect(analystFlavorsClient.postAnalystFlavors).toHaveBeenCalled());
    const [payload] = (analystFlavorsClient.postAnalystFlavors as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(payload.analystId).toBe('contrarian');
    expect(payload.flavors[0].instructions).toBe('ROLE: updated via settings');
  });

  it('populates GENERAL, INPUT, ANALYSIS and OUTPUT in one edit click', async () => {
    await openTab();
    fireEvent.click(screen.getByTestId('analyst-stage-2'));
    fireEvent.click(screen.getByTestId('analyst-admin-contrarian'));
    await waitFor(() => expect(analystFlavorsClient.getAnalystFlavors).toHaveBeenCalled());
    // GENERAL
    expect((screen.getByTestId('new-analyst-id') as HTMLInputElement).value).toBe('contrarian');
    expect((screen.getByTestId('new-analyst-name') as HTMLInputElement).value).toBe('Contrarian');
    // INPUT — dataSources row from the catalog.
    fireEvent.click(screen.getByTestId('analyst-edit-tab-input'));
    expect((screen.getByTestId('analyst-src-0').querySelector('input') as HTMLInputElement).value).toBe('price');
    // ANALYSIS — Role & Instructions from the flavor store (async).
    fireEvent.click(screen.getByTestId('analyst-edit-tab-analysis'));
    const ta = screen.getByTestId('new-analyst-flavor-instructions') as HTMLTextAreaElement;
    await waitFor(() => expect(ta.value).toBe('ROLE: from card\nOBJECTIVE: x'));
    // OUTPUT — channels / verdict / score from the catalog.
    fireEvent.click(screen.getByTestId('analyst-edit-tab-output'));
    expect((screen.getByLabelText(/Channels/i) as HTMLInputElement).value).toBe('contrarian_out');
    expect((screen.getByLabelText(/Verdict field/i) as HTMLInputElement).value).toBe('verdict');
    expect((screen.getByLabelText(/Score field/i) as HTMLInputElement).value).toBe('score');
  });
});

// frontend/src/test/SettingsDialogAgencies.test.tsx
// Phase 1 — SettingsDialog "Agencies" tab: create + delete, default protected,
// click-a-row-to-edit (populates the form, PUT on save), and onRegistryChange
// fires so the dropdown re-renders live.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import SettingsDialog from '../components/SettingsDialog';
import * as registryClient from '../api/registryClient';

// Provide a real (but isolated) AGENCIES mirror so row-click edit can pre-check
// the analyst membership; applyRegistryAgencies is a no-op stub.
vi.mock('../components/analysts/agencies', () => ({
  AGENCIES: {
    'long-term': {
      id: 'long-term',
      name: 'Long-term',
      description: '',
      analysts: [
        { id: 'orchestrator' },
        { id: 'data_ingestion' },
        { id: 'fundamental' },
      ],
    },
    'crypto-screener': {
      id: 'crypto-screener',
      name: 'Crypto Screener',
      description: '',
      analysts: [
        { id: 'data_ingestion' },
        { id: 'onchain' },
        { id: 'sentiment' },
        { id: 'governance' },
      ],
    },
  },
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

describe('SettingsDialog — Agencies tab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(registryClient, 'getRegistry').mockResolvedValue({
      catalog: [
        { id: 'orchestrator', name: 'Orchestrator', description: '', sources: [] },
        { id: 'data_ingestion', name: 'Data Ingestion', description: '', sources: [] },
        { id: 'fundamental', name: 'Fundamental', description: '', sources: [] },
      ],
      agencies: [
        { id: 'long-term', name: 'Long-term', analystCount: 3, isDefault: true, horizon: 'LONG_TERM', analysts: [] },
        { id: 'crypto-screener', name: 'Crypto Screener', analystCount: 4, isDefault: false, horizon: 'INTRADAY', analysts: [] },
      ],
      driver: 'json',
    });
    vi.spyOn(registryClient, 'postAgency').mockResolvedValue({ ok: true, id: 'my-agency' } as never);
    vi.spyOn(registryClient, 'putAgency').mockResolvedValue({ ok: true, id: 'crypto-screener', analysts: [] } as never);
    vi.spyOn(registryClient, 'deleteAgency').mockResolvedValue({ ok: true, id: 'crypto-screener' } as never);
  });

  const openTab = async () => {
    render(<SettingsDialog {...BASE} />);
    fireEvent.click(screen.getByTestId('tab-agencies'));
    await screen.findByTestId('agency-admin-list');
  };

  it('lists agencies and protects the default from deletion', async () => {
    await openTab();
    expect(screen.getByTestId('agency-admin-long-term')).toBeInTheDocument();
    const delDefault = screen.getByTestId('agency-delete-long-term') as HTMLButtonElement;
    expect(delDefault.disabled).toBe(true);
    const delCrypto = screen.getByTestId('agency-delete-crypto-screener') as HTMLButtonElement;
    expect(delCrypto.disabled).toBe(false);
  });

  it('clicking a row populates the form and switches to edit mode (PUT on save)', async () => {
    await openTab();
    // Click the Crypto Screener row.
    fireEvent.click(screen.getByTestId('agency-admin-crypto-screener'));
    // Form is populated.
    expect((screen.getByTestId('new-agency-id') as HTMLInputElement).value).toBe('crypto-screener');
    expect((screen.getByTestId('new-agency-name') as HTMLInputElement).value).toBe('Crypto Screener');
    expect((screen.getByTestId('new-agency-horizon') as HTMLSelectElement).value).toBe('INTRADAY');
    // Id field is locked while editing.
    expect((screen.getByTestId('new-agency-id') as HTMLInputElement).disabled).toBe(true);
    // Legend reflects edit mode.
    expect(screen.getByText(/Edit agency · crypto-screener/)).toBeInTheDocument();
    // Save button now says "Save changes".
    const save = screen.getByTestId('save-agency') as HTMLButtonElement;
    expect(save.textContent).toBe('Save changes');
    // Regression: the existing membership must be pre-checked (its analysts are
    // AgencyAnalystRef objects, so the form normalizes them to plain ids).
    // crypto-screener members are data_ingestion/onchain/sentiment/governance.
    expect((screen.getByLabelText('Data Ingestion') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Fundamental') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText('Orchestrator') as HTMLInputElement).checked).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(registryClient.putAgency).toHaveBeenCalled());
    const [id, body, userId] = (registryClient.putAgency as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(id).toBe('crypto-screener');
    expect(body.name).toBe('Crypto Screener');
    expect(userId).toBe('default');
    // Membership is saved as clean { id } refs, not wrapped objects.
    expect(body.analysts).toEqual([
      { id: 'data_ingestion' },
      { id: 'onchain' },
      { id: 'sentiment' },
      { id: 'governance' },
    ]);
    await waitFor(() => expect(BASE.onRegistryChange).toHaveBeenCalled());
  });

  it('cancel edit clears the form back to create mode', async () => {
    await openTab();
    fireEvent.click(screen.getByTestId('agency-admin-long-term'));
    fireEvent.click(screen.getByText('Cancel edit'));
    expect((screen.getByTestId('new-agency-id') as HTMLInputElement).value).toBe('');
    expect(screen.queryByText(/Edit agency ·/)).toBeNull();
  });

  it('creates an agency and fires onRegistryChange', async () => {
    await openTab();
    fireEvent.change(screen.getByTestId('new-agency-id'), { target: { value: 'my-agency' } });
    fireEvent.change(screen.getByTestId('new-agency-name'), { target: { value: 'My Agency' } });
    fireEvent.click(screen.getByTestId('save-agency'));

    await waitFor(() => expect(registryClient.postAgency).toHaveBeenCalled());
    const [body, userId] = (registryClient.postAgency as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(userId).toBe('default');
    expect(body.id).toBe('my-agency');
    expect(body.name).toBe('My Agency');
    await waitFor(() => expect(BASE.onRegistryChange).toHaveBeenCalled());
  });

  it('deletes a non-default agency and fires onRegistryChange', async () => {
    await openTab();
    // Clicking Delete must NOT trigger row-click edit (stopPropagation).
    fireEvent.click(screen.getByTestId('agency-delete-crypto-screener'));
    await waitFor(() => expect(registryClient.deleteAgency).toHaveBeenCalledWith('crypto-screener', 'default'));
    await waitFor(() => expect(BASE.onRegistryChange).toHaveBeenCalled());
    // Form should still be in create mode (row click did not fire).
    expect((screen.getByTestId('new-agency-id') as HTMLInputElement).value).toBe('');
  });

  it('shows a server error message when create fails', async () => {
    (registryClient.postAgency as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('agency id already exists'));
    await openTab();
    fireEvent.change(screen.getByTestId('new-agency-id'), { target: { value: 'dupe' } });
    fireEvent.click(screen.getByTestId('save-agency'));
    await waitFor(() => expect(screen.getByTestId('agency-error')).toHaveTextContent(/already exists/i));
  });
});

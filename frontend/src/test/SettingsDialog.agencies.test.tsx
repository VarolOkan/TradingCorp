// frontend/src/test/SettingsDialog.agencies.test.tsx
// Phase F — Agencies tab in SettingsDialog: lists agencies, creates a new one
// (POST), deletes a non-default one (DELETE), and refuses to delete the default.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import SettingsDialog from '../components/SettingsDialog';

const getMock = vi.fn();
const postMock = vi.fn();
const deleteMock = vi.fn();
const applyMock = vi.fn();

vi.mock('../api/registryClient', () => ({
  getRegistry: (...args: any[]) => getMock(...args),
  postAgency: (...args: any[]) => postMock(...args),
  deleteAgency: (...args: any[]) => deleteMock(...args),
}));
vi.mock('../components/analysts/agencies', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, applyRegistryAgencies: (...args: any[]) => applyMock(...args) };
});

const AGENCIES = [
  { id: 'long-term', name: 'Long Term', horizon: 'LONG_TERM', analystCount: 5, isDefault: true },
  { id: 'crypto-screener', name: 'Crypto Screener', horizon: 'INTRADAY', analystCount: 4, isDefault: false },
];

describe('SettingsDialog — Agencies tab', () => {
  const onClose = vi.fn();
  const onRegistryChange = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    getMock.mockResolvedValue({ catalog: [], agencies: AGENCIES, driver: 'json' });
    postMock.mockResolvedValue({ ok: true, id: 'my-agency' });
    deleteMock.mockResolvedValue({ ok: true, id: 'crypto-screener' });
  });

  function openOnAgencies() {
    render(
      <SettingsDialog
        open
        onClose={onClose}
        sessionId="default"
        onRegistryChange={onRegistryChange}
      />,
    );
    fireEvent.click(screen.getByTestId('tab-agencies'));
  }

  it('lists agencies and marks the default as non-deletable', async () => {
    openOnAgencies();
    await waitFor(() => expect(screen.getByTestId('agency-admin-long-term')).toBeInTheDocument());
    expect(screen.getByTestId('agency-admin-crypto-screener')).toBeInTheDocument();

    const defaultDelete = screen.getByTestId('agency-delete-long-term') as HTMLButtonElement;
    expect(defaultDelete.disabled).toBe(true);
    const otherDelete = screen.getByTestId('agency-delete-crypto-screener') as HTMLButtonElement;
    expect(otherDelete.disabled).toBe(false);
  });

  it('creates an agency via POST and refreshes', async () => {
    openOnAgencies();
    await waitFor(() => expect(screen.getByTestId('new-agency-id')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('new-agency-id'), { target: { value: 'my-agency' } });
    fireEvent.change(screen.getByTestId('new-agency-name'), { target: { value: 'My Agency' } });

    fireEvent.click(screen.getByTestId('save-agency'));

    await waitFor(() => expect(postMock).toHaveBeenCalled());
    const [def, userId] = postMock.mock.calls[0];
    expect(def.id).toBe('my-agency');
    expect(def.name).toBe('My Agency');
    expect(userId).toBe('default');
    // Refreshed the list + mirrored into the dropdown.
    expect(getMock).toHaveBeenCalledTimes(2);
    expect(applyMock).toHaveBeenCalled();
    expect(onRegistryChange).toHaveBeenCalled();
  });

  it('deletes a non-default agency via DELETE', async () => {
    openOnAgencies();
    await waitFor(() => expect(screen.getByTestId('agency-admin-crypto-screener')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('agency-delete-crypto-screener'));

    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith('crypto-screener', 'default'));
    expect(onRegistryChange).toHaveBeenCalled();
  });

  it('surfaces a delete error without calling onRegistryChange', async () => {
    deleteMock.mockRejectedValueOnce(new Error('cannot delete the default agency'));
    openOnAgencies();
    await waitFor(() => expect(screen.getByTestId('agency-admin-crypto-screener')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('agency-delete-crypto-screener'));
    expect(await screen.findByTestId('agency-error')).toHaveTextContent(/cannot delete the default agency/i);
    expect(onRegistryChange).not.toHaveBeenCalled();
  });
});

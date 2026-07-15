// frontend/src/test/agencySettingsDialog.test.tsx
// Phase A — "Enable LLM for all analysts" bulk action.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import AgencySettingsDialog from '../components/analysts/AgencySettingsDialog';

const enableMock = vi.fn();
const summaryMock = vi.fn();
vi.mock('../api/analystFlavorsClient', () => ({
  enableLlmForAllAnalysts: (...args: any[]) => enableMock(...args),
  getAgencyFlavorSummary: (...args: any[]) => summaryMock(...args),
}));
vi.mock('../api/llmConfigClient', () => ({
  getLlmConfig: () => Promise.resolve({ agencyModelRole: null }),
  postLlmConfig: () => Promise.resolve({ agencyModelRole: null }),
}));

describe('AgencySettingsDialog — Enable LLM for all analysts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: agency starts with LLM disabled for all analysts. Individual
    // tests override as needed. Prevents mock implementations leaking between
    // tests (clearAllMocks clears history but not resolvers).
    summaryMock.mockResolvedValue({ ok: true, sessionId: 'default', agencyId: 'long-term', analysts: [], enabledCount: 0, total: 5 });
  });

  it('reflects the stored LLM opt-in state on open (proves persistence is visible)', async () => {
    summaryMock.mockResolvedValue({ ok: true, sessionId: 'default', agencyId: 'long-term', analysts: [], enabledCount: 5, total: 5 });
    render(
      <AgencySettingsDialog
        open
        onClose={() => {}}
        agencyId="long-term"
        agencyName="Long Term"
        sessionId="default"
      />,
    );
    const state = await screen.findByTestId('agency-llm-state');
    expect(state).toHaveTextContent(/LLM enabled for all 5 analysts \(persisted\)/i);
    expect(summaryMock).toHaveBeenCalledWith('default', 'long-term');
  });

  it('shows a partial state when only some analysts have LLM enabled', async () => {
    summaryMock.mockResolvedValue({ ok: true, sessionId: 'default', agencyId: 'long-term', analysts: [], enabledCount: 2, total: 5 });
    render(
      <AgencySettingsDialog
        open
        onClose={() => {}}
        agencyId="long-term"
        agencyName="Long Term"
        sessionId="default"
      />,
    );
    expect(await screen.findByTestId('agency-llm-state')).toHaveTextContent(/LLM enabled for 2 of 5 analysts/i);
  });

  it('renders the bulk-enable button and calls the API with the agency id', async () => {
    render(
      <AgencySettingsDialog
        open
        onClose={() => {}}
        agencyId="long-term"
        agencyName="Long Term"
        sessionId="default"
      />,
    );
    const btn = screen.getByTestId('enable-llm-all');
    expect(btn).toBeInTheDocument();
    enableMock.mockResolvedValue({ ok: true, agencyId: 'long-term', sessionId: 'default', enabled: true, analystsTouched: 5, flavorsChanged: 5 });
    fireEvent.click(btn);
    await waitFor(() => expect(enableMock).toHaveBeenCalledWith('default', 'long-term', true));
    expect(await screen.findByTestId('bulk-msg')).toHaveTextContent(/LLM enabled for all 5 analysts/i);
  });

  it('disable button calls the API with enabled=false', async () => {
    render(
      <AgencySettingsDialog
        open
        onClose={() => {}}
        agencyId="long-term"
        agencyName="Long Term"
        sessionId="default"
      />,
    );
    enableMock.mockResolvedValue({ ok: true, agencyId: 'long-term', sessionId: 'default', enabled: false, analystsTouched: 5, flavorsChanged: 5 });
    fireEvent.click(screen.getByTestId('disable-llm-all'));
    await waitFor(() => expect(enableMock).toHaveBeenCalledWith('default', 'long-term', false));
    expect(await screen.findByTestId('bulk-msg')).toHaveTextContent(/LLM disabled for all 5 analysts/i);
  });

  it('surfaces an error when the bulk-enable call fails', async () => {
    enableMock.mockRejectedValue(new Error('boom'));
    render(
      <AgencySettingsDialog
        open
        onClose={() => {}}
        agencyId="long-term"
        agencyName="Long Term"
        sessionId="default"
      />,
    );
    fireEvent.click(screen.getByTestId('enable-llm-all'));
    expect(await screen.findByRole('alert')).toHaveTextContent(/boom/i);
  });
});

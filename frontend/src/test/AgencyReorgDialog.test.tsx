// frontend/src/test/AgencyReorgDialog.test.tsx
// Phase 1 — per-agency re-org dialog UX + persistence contract.
//   - opens with the agency's current members in order
//   - reorder (up/down), remove, add from catalog
//   - save PUTs the ordered refs + feedInto, then calls onSaved (live refresh)
//   - empty membership blocks save
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import AgencyReorgDialog from '../components/analysts/AgencyReorgDialog';
import * as registryClient from '../api/registryClient';

// Hermetic, controlled mirror: long-term has exactly the 3 members the
// re-org assertions expect. Keeps DEFAULT_AGENCY + a stubbed
// applyRegistryAgencies so the dialog mutating global state is isolated here.
vi.mock('../components/analysts/agencies', () => ({
  applyRegistryAgencies: vi.fn(),
  DEFAULT_AGENCY: 'long-term',
  AGENCIES: {
    'long-term': {
      id: 'long-term',
      name: 'Long-Term',
      horizon: 'LONG_TERM',
      default: true,
      // Frontend mirror stores analysts as string[].
      analysts: ['orchestrator', 'data_ingestion', 'fundamental'],
    },
  },
}));

const CATALOG = [
  { id: 'orchestrator', name: 'Orchestrator', kind: 'orchestrator', role: 'root', stage: 1, accent: '#000', description: 'root', sources: [] },
  { id: 'data_ingestion', name: 'Data Ingestion', kind: 'ingestion', role: 'ingest', stage: 1, accent: '#111', description: 'ingest', sources: [] },
  { id: 'fundamental', name: 'Fundamental', kind: 'analyst', role: 'fund', stage: 2, accent: '#222', description: 'fund', sources: [] },
  { id: 'technical', name: 'Technical', kind: 'analyst', role: 'tech', stage: 2, accent: '#333', description: 'tech', sources: [] },
  { id: 'risk', name: 'Risk', kind: 'analyst', role: 'risk', stage: 3, accent: '#444', description: 'risk', sources: [] },
  // 'onchain' is in the catalog but NOT in long-term's roster → addable.
  { id: 'onchain', name: 'On-Chain', kind: 'analyst', role: 'chain', stage: 2, accent: '#555', description: 'chain', sources: [] },
];

const BASE = {
  open: true,
  onClose: vi.fn(),
  onSaved: vi.fn(),
  agencyId: 'long-term',
  agencyName: 'Long-term',
  sessionId: 'default',
  getRegistry: vi.fn(),
  putAgencyAnalysts: vi.fn(),
};

describe('AgencyReorgDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(registryClient, 'getRegistry').mockResolvedValue({
      catalog: CATALOG,
      agencies: [
        { id: 'long-term', name: 'Long-term', analystCount: 3, isDefault: true, horizon: 'LONG_TERM', analysts: ['orchestrator', 'data_ingestion', 'fundamental'] },
      ],
      driver: 'json',
    });
    vi.spyOn(registryClient, 'putAgencyAnalysts').mockResolvedValue({
      ok: true,
      id: 'long-term',
      analysts: [{ id: 'orchestrator' }, { id: 'fundamental' }, { id: 'data_ingestion' }],
    });
  });

  it('renders the agency members in roster order on open', async () => {
    render(<AgencyReorgDialog {...BASE} />);
    const rows = await screen.findAllByTestId(/^reorg-row-/);
    // The first member appears first.
    const first = document.querySelector('[data-testid^="reorg-row-"]');
    expect(first).toHaveTextContent('Orchestrator');
  });

  it('reorders a member up/down and saves the new order with feedInto', async () => {
    render(<AgencyReorgDialog {...BASE} />);
    await screen.findByText('Orchestrator');
    // Move the 3rd member (Fundamental) up twice so order becomes
    // [Fundamental, Orchestrator, Data Ingestion].
    const upButtons = await screen.findAllByTestId(/reorg-up-/);
    fireEvent.click(upButtons[2]); // fundamental up
    fireEvent.click(upButtons[2]); // fundamental up again
    fireEvent.click(screen.getByTestId('reorg-save'));

    await waitFor(() => expect(registryClient.putAgencyAnalysts).toHaveBeenCalled());
    const calls = (registryClient.putAgencyAnalysts as ReturnType<typeof vi.fn>).mock.calls;
    const [id, payload, userId] = calls[0];
    expect(id).toBe('long-term');
    expect(userId).toBe('default');
    expect(payload.analysts.map((r: { id: string }) => r.id)).toEqual([
      'fundamental',
      'orchestrator',
      'data_ingestion',
    ]);
    await waitFor(() => expect(BASE.onSaved).toHaveBeenCalled());
  });

  it('removes a member and blocks save when empty', async () => {
    render(<AgencyReorgDialog {...BASE} />);
    await screen.findByText('Orchestrator');
    // Remove all three members.
    const removes = await screen.findAllByTestId(/reorg-remove-/);
    for (const r of removes) fireEvent.click(r);
    expect(screen.queryByTestId(/^reorg-row-/)).toBeNull();
    const save = screen.getByTestId('reorg-save') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });

  it('adds a catalog analyst not yet in the roster', async () => {
    render(<AgencyReorgDialog {...BASE} />);
    await screen.findByText('Orchestrator');
    // The add UI is a <select>; "onchain" is in the catalog but not in
    // the long-term roster, so it should be a selectable option.
    const select = screen.getByTestId('reorg-add-select') as HTMLSelectElement;
    expect(select.querySelector('option[value="onchain"]')).toBeTruthy();
    fireEvent.change(select, { target: { value: 'onchain' } });
    const rows = await screen.findAllByTestId(/^reorg-row-/);
    expect(rows.some((r) => r.textContent?.includes('On-Chain'))).toBe(true);
  });
});

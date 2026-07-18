// frontend/src/test/analystFlavors.test.ts
// Phase F — frontend flavor schema + dialog dropdown (vitest).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildAnalystConfigSchema } from '../components/analysts/analystConfigSchema';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import AnalystSettingsDialog from '../components/AnalystSettingsDialog';

// Mock the flavors client so the dialog can load + save without a backend.
const getMock = vi.fn();
const postMock = vi.fn();
vi.mock('../api/analystFlavorsClient', () => ({
  getAnalystFlavors: (...args: any[]) => getMock(...args),
  postAnalystFlavors: (...args: any[]) => postMock(...args),
}));

const flavors = [
  { id: 'default', name: 'Balanced', role: 'Skew · term', instructions: 'base', isDefault: true },
  { id: 'momentum', name: 'Momentum-leaning', role: 'Edge · momentum', instructions: 'momo' },
];

describe('buildAnalystConfigSchema flavors field', () => {
  it('carries an empty flavors array by default (hasConfig still reflects weights/sources)', () => {
    const s = buildAnalystConfigSchema('fundamental', 'Fundamental', []);
    expect(Array.isArray(s.flavors)).toBe(true);
    expect(s.flavors.length).toBe(0);
  });

  it('groups Massive/Polygon options + aggregates into ONE keyGroup (shared token + combined Test)', () => {
    // This is the schema the Data Ingestion agent's Settings dialog builds for
    // the Polygon sources — it MUST match the General Settings → Sources tab
    // layout: a single shared token field + a single combined [Test] button,
    // with both endpoints grouped (not two separate single-source rows).
    const s = buildAnalystConfigSchema('options_ingestion', 'Options Ingestion', [
      { id: 'polygonOptions', label: 'Polygon Options', auth: 'bearer' },
      { id: 'polygonHist', label: 'Polygon Aggregates', auth: 'bearer' },
    ]);
    expect(s.sources).toHaveLength(2);
    const opt = s.sources.find((x) => x.sourceId === 'polygonOptions')!;
    const agg = s.sources.find((x) => x.sourceId === 'polygonHist')!;
    expect(opt.keyGroup).toBe('massive');
    expect(opt.keyGroupLabel).toBe('Massive/Polygon Options');
    expect(opt.endpointLabel).toBe('Options snapshot');
    expect(agg.keyGroup).toBe('massive');
    expect(agg.keyGroupLabel).toBe('Massive/Polygon Options');
    expect(agg.endpointLabel).toBe('Daily aggregates');
    // Both share the SAME group, so SourcesTab collapses them into one block.
    expect(opt.keyGroup).toBe(agg.keyGroup);
  });
});

describe('AnalystSettingsDialog Flavor section', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders a flavor dropdown when the schema has flavors and selects on save', async () => {
    getMock.mockResolvedValue({
      sessionId: 's',
      agencyId: 'options-swing',
      analystId: 'options_risk',
      flavors,
      selectedId: 'default',
    });
    postMock.mockResolvedValue({ ok: true });

    const schema = buildAnalystConfigSchema('options_risk', 'Options Risk', []);
    schema.flavors = [
      { id: 'default', name: 'Balanced', role: 'Skew · term' },
      { id: 'momentum', name: 'Momentum-leaning', role: 'Edge · momentum' },
    ];

    render(
      <AnalystSettingsDialog
        open
        onClose={() => {}}
        analystId="options_risk"
        analystName="Options Risk"
        agencyId="options-swing"
        schema={schema}
        sessionId="s"
      />,
    );

    // Flavor legend appears.
    expect(await screen.findByText(/Flavor \(Role & Instructions\)/)).toBeTruthy();
    const select = (await screen.findByLabelText('Options Risk flavor')) as HTMLSelectElement;
    expect(select).toBeTruthy();
    expect(select.value).toBe('default');

    // Change selection + submit.
    fireEvent.change(select, { target: { value: 'momentum' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(postMock).toHaveBeenCalled());
    const sent = postMock.mock.calls[0][0];
    expect(sent.selectedId).toBe('momentum');
    expect(sent.flavors.length).toBe(2);
  });

  it('§10.6: renders an editable instructions textarea and posts the REAL (non-empty) instructions on save', async () => {
    getMock.mockResolvedValue({
      sessionId: 's',
      agencyId: 'options-swing',
      analystId: 'options_risk',
      flavors,
      selectedId: 'default',
    });
    postMock.mockResolvedValue({ ok: true });

    const schema = buildAnalystConfigSchema('options_risk', 'Options Risk', []);
    schema.flavors = flavors.map((f) => ({ id: f.id, name: f.name, role: f.role }));

    render(
      <AnalystSettingsDialog
        open
        onClose={() => {}}
        analystId="options_risk"
        analystName="Options Risk"
        agencyId="options-swing"
        schema={schema}
        sessionId="s"
      />,
    );

    // The selected flavor's instructions are editable (textarea, NOT a hidden placeholder).
    const ta = (await screen.findByLabelText('Flavor instructions')) as HTMLTextAreaElement;
    expect(ta.value).toBe('base');

    // Edit instructions + save → server receives the edited text, not ''.
    fireEvent.change(ta, { target: { value: 'edited role & instructions' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(postMock).toHaveBeenCalled());
    const sent = postMock.mock.calls[0][0];
    const posted = sent.flavors.find((f: any) => f.id === 'default');
    expect(posted.instructions).toBe('edited role & instructions');
  });

  it('§10.6: Add flavor creates a 3rd option and Delete is disabled while only one remains', async () => {
    getMock.mockResolvedValue({
      sessionId: 's',
      agencyId: 'options-swing',
      analystId: 'options_risk',
      flavors: [flavors[0]],
      selectedId: 'default',
    });
    postMock.mockResolvedValue({ ok: true });

    const schema = buildAnalystConfigSchema('options_risk', 'Options Risk', []);
    schema.flavors = [flavors[0]].map((f) => ({ id: f.id, name: f.name, role: f.role }));

    render(
      <AnalystSettingsDialog
        open
        onClose={() => {}}
        analystId="options_risk"
        analystName="Options Risk"
        agencyId="options-swing"
        schema={schema}
        sessionId="s"
      />,
    );

    const addBtn = await screen.findByRole('button', { name: '+ Add flavor' });
    const delBtn = screen.getByRole('button', { name: 'Delete flavor' }) as HTMLButtonElement;
    const select = (await screen.findByLabelText('Options Risk flavor')) as HTMLSelectElement;

    // Only one flavor → delete disabled.
    expect(delBtn.disabled).toBe(true);
    expect(select.options.length).toBe(1);

    // Add flavor → 2 options, delete now enabled.
    fireEvent.click(addBtn);
    expect(select.options.length).toBe(2);
    expect(delBtn.disabled).toBe(false);
    // New flavor is auto-selected and editable.
    expect(select.value).toBe('custom-1');
  });

  it('§10.7: renders a "Use LLM" toggle and posts enabled:true when checked', async () => {
    getMock.mockResolvedValue({
      sessionId: 's',
      agencyId: 'options-swing',
      analystId: 'options_risk',
      flavors: [{ id: 'default', name: 'Balanced', role: 'Skew · term', instructions: 'base', isDefault: true, enabled: false }],
      selectedId: 'default',
    });
    postMock.mockResolvedValue({ ok: true });

    const schema = buildAnalystConfigSchema('options_risk', 'Options Risk', []);
    schema.flavors = [{ id: 'default', name: 'Balanced', role: 'Skew · term' }];

    render(
      <AnalystSettingsDialog
        open
        onClose={() => {}}
        analystId="options_risk"
        analystName="Options Risk"
        agencyId="options-swing"
        schema={schema}
        sessionId="s"
      />,
    );

    // The "Use LLM" checkbox exists and is initially unchecked (parity guard).
    const toggle = (await screen.findByLabelText('Enable the LLM analysis step for this flavor')) as HTMLInputElement;
    expect(toggle).toBeTruthy();
    expect(toggle.checked).toBe(false);

    // Flip it on + save → server receives enabled:true.
    fireEvent.click(toggle);
    expect(toggle.checked).toBe(true);
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(postMock).toHaveBeenCalled());
    const sent = postMock.mock.calls[0][0];
    const posted = sent.flavors.find((f: any) => f.id === 'default');
    expect(posted.enabled).toBe(true);
  });
});

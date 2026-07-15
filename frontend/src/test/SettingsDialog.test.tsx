// frontend/src/test/SettingsDialog.test.tsx
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SettingsDialog } from '../components/SettingsDialog';
import * as configClient from '../api/configClient';

describe('SettingsDialog', () => {
  const onClose = vi.fn();
  const onSaved = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders nothing when closed', () => {
    const { container } = render(
      <SettingsDialog open={false} onClose={onClose} />
    );
    expect(container.querySelector('.settings-overlay')).toBeNull();
  });

  it('renders the form with default values when open', () => {
    render(<SettingsDialog open onClose={onClose} />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByLabelText('Backend URI')).toHaveValue('http://localhost:3001');
    expect(screen.getByLabelText('Access token')).toHaveValue('');
  });

  it('prefills from initial settings', () => {
    render(
      <SettingsDialog
        open
        onClose={onClose}
        initial={{ baseUri: 'https://init.example', accessToken: 'abc', extra: { k: 'v' } }}
      />
    );
    expect(screen.getByLabelText('Backend URI')).toHaveValue('https://init.example');
    expect(screen.getByLabelText('Access token')).toHaveValue('abc');
    const keyInput = screen.getByLabelText('extra key') as HTMLInputElement;
    expect(keyInput.value).toBe('k');
  });

  it('shows a validation error for a non-http baseUri', async () => {
    render(<SettingsDialog open onClose={onClose} />);
    fireEvent.change(screen.getByLabelText('Backend URI'), { target: { value: 'ftp://nope' } });
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/http/i);
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('saves valid settings and calls onSaved', async () => {
    const postSpy = vi.spyOn(configClient, 'postSettings').mockResolvedValue({
      ok: true,
      sessionId: 'default',
      baseUri: 'https://x.example',
      hasToken: false,
      extraKeys: [],
    });
    render(<SettingsDialog open onClose={onClose} onSaved={onSaved} />);
    fireEvent.change(screen.getByLabelText('Backend URI'), { target: { value: 'https://x.example' } });
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));

    expect(await screen.findByRole('status')).toHaveTextContent(/Saved/i);
    expect(postSpy).toHaveBeenCalledWith(
      { baseUri: 'https://x.example', accessToken: '', extra: {}, parallelAnalysts: false },
      'default'
    );
    expect(onSaved).toHaveBeenCalledWith(
      expect.objectContaining({ baseUri: 'https://x.example' })
    );
    postSpy.mockRestore();
  });

  it('shows an error when postSettings rejects', async () => {
    const postSpy = vi.spyOn(configClient, 'postSettings').mockRejectedValue(
      new Error('Failed to save settings: baseUri is required')
    );
    render(<SettingsDialog open onClose={onClose} />);
    fireEvent.change(screen.getByLabelText('Backend URI'), { target: { value: 'https://ok.example' } });
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/baseUri is required/i);
    expect(onClose).not.toHaveBeenCalled();
    postSpy.mockRestore();
  });

  it('adds, edits, and removes extra parameter rows', () => {
    render(<SettingsDialog open onClose={onClose} />);
    expect(screen.queryByLabelText('extra key')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '+ Add parameter' }));
    const keyInput = screen.getByLabelText('extra key') as HTMLInputElement;
    const valueInput = screen.getByLabelText('extra value') as HTMLInputElement;
    fireEvent.change(keyInput, { target: { value: 'region' } });
    fireEvent.change(valueInput, { target: { value: 'eu' } });
    expect(keyInput.value).toBe('region');
    expect(valueInput.value).toBe('eu');

    fireEvent.click(screen.getByRole('button', { name: 'Remove parameter' }));
    expect(screen.queryByLabelText('extra key')).toBeNull();
  });

  it('cancel button calls onClose', () => {
    render(<SettingsDialog open onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('overlay click closes when not saving', () => {
    const { container } = render(<SettingsDialog open onClose={onClose} />);
    const overlay = container.querySelector('.settings-overlay') as HTMLElement;
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// ---- LLM Models tab (§12.5) ----
import * as llmConfigClient from '../api/llmConfigClient';

const SEED: llmConfigClient.LlmConfigResponse = {
  configs: [
    { role: 'deep-thought', provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-opus-4-8', hasToken: false },
    { role: 'scanner', provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-opus-4-8', hasToken: false },
    { role: 'flexible', provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-opus-4-8', hasToken: false },
  ],
  agencyModelRole: null,
};

describe('SettingsDialog LLM Models tab', () => {
  const onClose = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(llmConfigClient, 'getLlmConfig').mockResolvedValue(SEED);
    vi.spyOn(llmConfigClient, 'postLlmConfig').mockResolvedValue(SEED);
  });

  it('Connection tab is the default; switching to LLM Models loads the 3 role rows', async () => {
    render(<SettingsDialog open onClose={onClose} agencyId="ag-equities" />);
    expect(screen.getByLabelText('Backend URI')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('tab-llm'));
    expect(await screen.findByTestId('llm-role-deep-thought')).toBeInTheDocument();
    expect(screen.getByTestId('llm-role-scanner')).toBeInTheDocument();
    expect(screen.getByTestId('llm-role-flexible')).toBeInTheDocument();
  });

  it('tokens render as password inputs; a seeded role (provider+model, no token) shows "configured" + "no token" (token never echoed)', async () => {
    render(<SettingsDialog open onClose={onClose} agencyId="ag-equities" />);
    fireEvent.click(screen.getByTestId('tab-llm'));
    await screen.findByTestId('llm-role-deep-thought');
    const tokenInput = screen.getByLabelText('deep-thought token') as HTMLInputElement;
    expect(tokenInput.type).toBe('password');
    expect(tokenInput.value).toBe('');
    // Seeded configs have provider+model set → considered configured...
    expect(screen.getByLabelText('deep-thought configured')).toBeInTheDocument();
    // ...but with no token, we show an honest "no token" note instead of a
    // misleading "not configured" (the role is fully usable in fallback mode).
    expect(screen.getByLabelText('deep-thought no token')).toBeInTheDocument();
    expect(screen.queryByLabelText('deep-thought not configured')).toBeNull();
  });

  it('saving posts the three role configs and closes (Accept)', async () => {
    const postSpy = vi.spyOn(llmConfigClient, 'postLlmConfig');
    const { unmount } = render(<SettingsDialog open onClose={onClose} agencyId="ag-equities" />);
    fireEvent.click(screen.getByTestId('tab-llm'));
    await screen.findByTestId('llm-role-deep-thought');

    fireEvent.change(screen.getByLabelText('deep-thought token'), { target: { value: 'sk-secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));

    await waitFor(() => expect(postSpy).toHaveBeenCalled());
    const body = postSpy.mock.calls[0][0] as llmConfigClient.LlmConfigPost;
    expect(body.configs.length).toBe(3);
    expect(body.configs.find((c) => c.role === 'deep-thought')!.token).toBe('sk-secret');
    // The per-agency default-model control now lives in AgencySettingsDialog,
    // so the main dialog no longer posts an agency override.
    expect(screen.queryByTestId('agency-model-role')).not.toBeInTheDocument();
    // Accept saves; the dialog closes on unmount (no leaked timer).
    unmount();
    expect(onClose).toHaveBeenCalled();
  });

  it('Test button probes the provider and shows a success result', async () => {
    vi.spyOn(llmConfigClient, 'postLlmConfigTest').mockResolvedValue({
      ok: true,
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'anthropic/claude-opus-4-8',
      hasToken: true,
      status: 200,
    });
    render(<SettingsDialog open onClose={onClose} agencyId="ag-equities" />);
    fireEvent.click(screen.getByTestId('tab-llm'));
    await screen.findByTestId('llm-role-deep-thought');

    fireEvent.click(screen.getByLabelText('Test deep-thought connection'));
    expect(await screen.findByText(/Connected \(HTTP 200\)/)).toBeInTheDocument();
  });

  it('Test button shows a failure result and does not close the dialog', async () => {
    vi.spyOn(llmConfigClient, 'postLlmConfigTest').mockResolvedValue({
      ok: false,
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'anthropic/claude-opus-4-8',
      hasToken: true,
      status: 401,
      error: 'Authentication failed — check the token',
    });
    render(<SettingsDialog open onClose={onClose} agencyId="ag-equities" />);
    fireEvent.click(screen.getByTestId('tab-llm'));
    await screen.findByTestId('llm-role-deep-thought');

    fireEvent.click(screen.getByLabelText('Test deep-thought connection'));
    expect(await screen.findByText(/Authentication failed/i)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});

// ---- Server Log tab ----
import * as serverLogClient from '../api/serverLogClient';

describe('SettingsDialog Server Log tab', () => {
  const onClose = vi.fn();
  const onSaved = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(serverLogClient, 'getServerLog').mockResolvedValue(
      '[INFO] 2026-07-11T09:28:18.568Z - LLM vault OK (gpg)\n[INFO] 2026-07-11T09:28:24.083Z - Starting analysis for tickers: N'
    );
  });

  it('switching to Server Log fetches and renders the log tail', async () => {
    render(<SettingsDialog open onClose={onClose} />);
    fireEvent.click(screen.getByTestId('tab-log'));
    expect(await screen.findByTestId('server-log')).toBeInTheDocument();
    expect(screen.getByTestId('server-log').textContent).toContain('LLM vault OK (gpg)');
    expect(serverLogClient.getServerLog).toHaveBeenCalledWith(200);
  });

  it('changing the line count re-fetches with that count', async () => {
    render(<SettingsDialog open onClose={onClose} />);
    fireEvent.click(screen.getByTestId('tab-log'));
    await screen.findByTestId('server-log');
    fireEvent.change(screen.getByLabelText('Log line count'), { target: { value: '500' } });
    await waitFor(() => expect(serverLogClient.getServerLog).toHaveBeenLastCalledWith(500));
  });

  it('parallel-analysts toggle prefills, toggles, and saves with the flag', async () => {
    const postSpy = vi
      .spyOn(configClient, 'postSettings')
      .mockResolvedValue({ ok: true, sessionId: 'default', baseUri: 'https://x.example', hasToken: false, extraKeys: [] });
    render(
      <SettingsDialog
        open
        onClose={onClose}
        onSaved={onSaved}
        initial={{ baseUri: 'https://x.example', accessToken: '', extra: {}, parallelAnalysts: true }}
      />,
    );
    const toggle = screen.getByTestId('parallel-analysts') as HTMLInputElement;
    // Prefilled ON from initial.
    expect(toggle.checked).toBe(true);
    // Turn it OFF, then save.
    fireEvent.click(toggle);
    expect((screen.getByTestId('parallel-analysts') as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(postSpy).toHaveBeenCalled());
    expect(postSpy).toHaveBeenCalledWith(
      expect.objectContaining({ parallelAnalysts: false }),
      'default',
    );
    postSpy.mockRestore();
  });

  it('opens the API docs in a new tab against the backend URI', () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(
      <SettingsDialog
        open
        onClose={onClose}
        initial={{ baseUri: 'https://api.example:3001/' }}
      />
    );
    fireEvent.click(screen.getByTestId('view-api-docs'));
    expect(openSpy).toHaveBeenCalledWith(
      'https://api.example:3001/api-docs/',
      '_blank',
      'noopener,noreferrer',
    );
    openSpy.mockRestore();
  });

  it('falls back to the default backend URI for API docs when the field is empty', () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<SettingsDialog open onClose={onClose} />);
    fireEvent.click(screen.getByTestId('view-api-docs'));
    expect(openSpy).toHaveBeenCalledWith(
      'http://localhost:3001/api-docs/',
      '_blank',
      'noopener,noreferrer',
    );
    openSpy.mockRestore();
  });
});


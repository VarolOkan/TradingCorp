// frontend/src/test/AnalysisForm.test.tsx
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import { AnalysisForm, MAX_SYMBOLS } from '../components/AnalysisForm';

// Symbol validation hits the server (GET /validate-symbols). In jsdom `fetch`
// is undefined, so stub it. Default: every symbol resolves as a real ticker
// (valid), which preserves the existing add expectations. Individual tests
// override per-case.
const validJson = (symbol: string) => ({
  results: [{ symbol, valid: true }],
  valid: [symbol],
  invalid: [],
});
beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => validJson('AAPL'),
      text: async () => 'AAPL,2026-07-19,20:00,225.1',
    })),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('AnalysisForm (pill input)', () => {
  it('renders the pill container and a disabled Analyze button when empty', () => {
    render(<AnalysisForm symbols={[]} onSymbolsChange={vi.fn()} onSubmit={vi.fn()} />);
    expect(screen.getByLabelText('Ticker symbols')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Analyze' })).toBeDisabled();
  });

  it('adds a pill on Enter and submits the pill list', async () => {
    const onSubmit = vi.fn();
    const onSymbolsChange = vi.fn();
    render(<AnalysisForm symbols={[]} onSymbolsChange={onSymbolsChange} onSubmit={onSubmit} />);
    const input = screen.getByLabelText('Ticker symbols') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'aapl' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(onSymbolsChange).toHaveBeenCalledWith(['AAPL']));
  });

  it('submits cleaned, uppercased, multi-ticker pills', () => {
    const onSubmit = vi.fn();
    render(
      <AnalysisForm
        symbols={['AAPL', 'MSFT']}
        onSymbolsChange={vi.fn()}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Analyze' }));
    expect(onSubmit).toHaveBeenCalledWith(['AAPL', 'MSFT']);
  });

  it('removes a pill via its × button', async () => {
    const onSymbolsChange = vi.fn();
    render(
      <AnalysisForm symbols={['AAPL']} onSymbolsChange={onSymbolsChange} onSubmit={vi.fn()} />,
    );
    expect(screen.getByTestId('pill-AAPL')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('pill-remove-AAPL'));
    expect(onSymbolsChange).toHaveBeenCalledWith([]);
  });

  it('caps at MAX_SYMBOLS (6) and disables the input at the cap', () => {
    const onSymbolsChange = vi.fn();
    const full = ['A', 'B', 'C', 'D', 'E', 'F'];
    render(
      <AnalysisForm symbols={full} onSymbolsChange={onSymbolsChange} onSubmit={vi.fn()} />,
    );
    expect(screen.getByLabelText('Ticker symbols')).toBeDisabled();
    expect((screen.getByLabelText('Ticker symbols') as HTMLInputElement).placeholder).toBe(
      `Max ${MAX_SYMBOLS} tickers`,
    );
  });

  it('does not submit when no pills are present', () => {
    const onSubmit = vi.fn();
    render(<AnalysisForm symbols={[]} onSymbolsChange={vi.fn()} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('button', { name: 'Analyze' }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('shows Analyzing… and disables inputs while running', () => {
    render(<AnalysisForm symbols={['AAPL']} onSymbolsChange={vi.fn()} onSubmit={vi.fn()} running />);
    expect(screen.getByRole('button', { name: 'Analyzing…' })).toBeDisabled();
    expect(screen.getByLabelText('Ticker symbols')).toBeDisabled();
  });

  it('renders the session field when onSessionChange is provided', () => {
    const onSessionChange = vi.fn();
    render(
      <AnalysisForm
        symbols={[]}
        onSymbolsChange={vi.fn()}
        onSubmit={vi.fn()}
        onSessionChange={onSessionChange}
        sessionId="abc"
      />,
    );
    const session = screen.getByLabelText('Session ID') as HTMLInputElement;
    expect(session.value).toBe('abc');
    fireEvent.change(session, { target: { value: 'xyz' } });
    expect(onSessionChange).toHaveBeenCalledWith('xyz');
  });

  it('rejects a non-symbol word (e.g. IRON), shows an error ABOVE the input, and clears it on edit', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => ({
        ok: true,
        status: 200,
        json: async () => ({
          results: [{ symbol: 'IRON', valid: false }],
          valid: [],
          invalid: ['IRON'],
        }),
        text: async () => (/iron/i.test(String(url)) ? 'No data' : 'AAPL,2026-07-19,20:00,225.1'),
      })),
    );
    const onSymbolsChange = vi.fn();
    const { container } = render(
      <AnalysisForm symbols={[]} onSymbolsChange={onSymbolsChange} onSubmit={vi.fn()} />,
    );
    const input = screen.getByLabelText('Ticker symbols') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'IRON' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    const err = await screen.findByTestId('ticker-form-error');
    expect(err).toHaveTextContent(/not a recognized ticker/i);
    expect(onSymbolsChange).not.toHaveBeenCalled();

    // (a) error renders BELOW all controls: it is the last child of the form.
    const form = container.querySelector('form')!;
    const kids = Array.from(form.children);
    const errIdx = kids.findIndex((c) => c.getAttribute('data-testid') === 'ticker-form-error');
    const btnIdx = kids.findIndex((c) => c.tagName === 'BUTTON');
    expect(errIdx).toBeGreaterThanOrEqual(0);
    expect(btnIdx).toBeGreaterThanOrEqual(0);
    expect(errIdx).toBeGreaterThan(btnIdx); // below the Analyze button / all controls

    // (b) error clears once the user edits the input again (bad symbol "removed").
    fireEvent.change(input, { target: { value: '' } });
    await waitFor(() => expect(screen.queryByTestId('ticker-form-error')).not.toBeInTheDocument());
    vi.unstubAllGlobals();
  });
});

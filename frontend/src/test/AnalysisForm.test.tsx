// frontend/src/test/AnalysisForm.test.tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { AnalysisForm, MAX_SYMBOLS } from '../components/AnalysisForm';

describe('AnalysisForm (pill input)', () => {
  it('renders the pill container and a disabled Analyze button when empty', () => {
    render(<AnalysisForm symbols={[]} onSymbolsChange={vi.fn()} onSubmit={vi.fn()} />);
    expect(screen.getByLabelText('Ticker symbols')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Analyze' })).toBeDisabled();
  });

  it('adds a pill on Enter and submits the pill list', () => {
    const onSubmit = vi.fn();
    const onSymbolsChange = vi.fn();
    render(<AnalysisForm symbols={[]} onSymbolsChange={onSymbolsChange} onSubmit={onSubmit} />);
    const input = screen.getByLabelText('Ticker symbols') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'aapl' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSymbolsChange).toHaveBeenCalledWith(['AAPL']);
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

  it('removes a pill via its × button', () => {
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
});

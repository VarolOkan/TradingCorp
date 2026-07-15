// frontend/src/test/AnalysisForm.test.tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { AnalysisForm } from '../components/AnalysisForm';

describe('AnalysisForm', () => {
  it('renders inputs and a disabled Analyze button when empty', () => {
    render(<AnalysisForm onSubmit={vi.fn()} />);
    expect(screen.getByLabelText('Ticker symbols')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Analyze' })).toBeDisabled();
  });

  it('submits cleaned, uppercased tickers', () => {
    const onSubmit = vi.fn();
    render(<AnalysisForm onSubmit={onSubmit} />);
    const input = screen.getByLabelText('Ticker symbols') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'aapl, msft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Analyze' }));
    expect(onSubmit).toHaveBeenCalledWith(['AAPL', 'MSFT']);
  });

  it('does not submit when input is blank', () => {
    const onSubmit = vi.fn();
    render(<AnalysisForm onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('button', { name: 'Analyze' }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('shows Analyzing… and disables inputs while running', () => {
    render(<AnalysisForm onSubmit={vi.fn()} running />);
    expect(screen.getByRole('button', { name: 'Analyzing…' })).toBeDisabled();
    expect(screen.getByLabelText('Ticker symbols')).toBeDisabled();
  });

  it('renders the session field when onSessionChange is provided', () => {
    const onSessionChange = vi.fn();
    render(<AnalysisForm onSubmit={vi.fn()} onSessionChange={onSessionChange} sessionId="abc" />);
    const session = screen.getByLabelText('Session ID') as HTMLInputElement;
    expect(session.value).toBe('abc');
    fireEvent.change(session, { target: { value: 'xyz' } });
    expect(onSessionChange).toHaveBeenCalledWith('xyz');
  });
});

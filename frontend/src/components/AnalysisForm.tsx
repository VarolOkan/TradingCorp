// frontend/src/components/AnalysisForm.tsx
import { useState, FormEvent } from 'react';

export interface AnalysisFormProps {
  onSubmit: (tickers: string[]) => void;
  running?: boolean;
  sessionId?: string;
  onSessionChange?: (id: string) => void;
  /** Controlled value. When provided, the parent owns the symbol text. */
  value?: string;
  /** Called on every keystroke when controlled via `value`. */
  onChange?: (v: string) => void;
  /** Called when the input loses focus (blur). Used for a no-run chart preview. */
  onBlur?: (value: string) => void;
}

export function AnalysisForm({
  onSubmit,
  running = false,
  sessionId,
  onSessionChange,
  value,
  onChange,
  onBlur,
}: AnalysisFormProps) {
  // Internal fallback so the form still works when uncontrolled (no value prop).
  const [internal, setInternal] = useState('');
  const input = value ?? internal;
  const setInput = (v: string) => {
    setInternal(v);
    onChange?.(v);
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const tickers = input
      .split(',')
      .map((t) => t.trim().toUpperCase())
      .filter((t) => t.length > 0);
    if (tickers.length === 0) return;
    onSubmit(tickers);
  };

  return (
    <form className="analysis-form" onSubmit={handleSubmit}>
      <label>
        Ticker symbols
        <input
          type="text"
          value={input}
          placeholder="e.g. AAPL, MSFT, NVDA"
          aria-label="Ticker symbols"
          disabled={running}
          onChange={(e) => setInput(e.target.value)}
          onBlur={(e) => onBlur?.(e.target.value)}
        />
      </label>

      {onSessionChange && (
        <label className="session-field">
          Session ID
          <input
            type="text"
            value={sessionId ?? 'default'}
            aria-label="Session ID"
            disabled={running}
            onChange={(e) => onSessionChange(e.target.value)}
          />
        </label>
      )}

      <button type="submit" disabled={running || input.trim().length === 0}>
        {running ? 'Analyzing…' : 'Analyze'}
      </button>
    </form>
  );
}

export default AnalysisForm;

// frontend/src/components/AnalysisForm.tsx
import { useState, FormEvent, KeyboardEvent } from 'react';

export const MAX_SYMBOLS = 6;

export interface AnalysisFormProps {
  onSubmit: (tickers: string[]) => void;
  running?: boolean;
  sessionId?: string;
  onSessionChange?: (id: string) => void;
  /** Controlled list of ticker pills owned by the parent. */
  symbols: string[];
  /** Called whenever the pill list changes (add / remove). */
  onSymbolsChange: (symbols: string[]) => void;
  /** Called on blur of the text field (used for a no-run chart preview). */
  onBlur?: (value: string) => void;
}

function normalize(raw: string): string {
  return raw.trim().toUpperCase();
}

export function AnalysisForm({
  onSubmit,
  running = false,
  sessionId,
  onSessionChange,
  symbols,
  onSymbolsChange,
  onBlur,
}: AnalysisFormProps) {
  const [draft, setDraft] = useState('');
  const atMax = symbols.length >= MAX_SYMBOLS;

  const addSymbol = (raw: string) => {
    const sym = normalize(raw);
    if (!sym) return;
    if (symbols.length >= MAX_SYMBOLS) return; // hard cap
    if (symbols.includes(sym)) {
      setDraft('');
      return;
    }
    onSymbolsChange([...symbols, sym]);
    setDraft('');
  };

  const removeSymbol = (sym: string) => {
    onSymbolsChange(symbols.filter((s) => s !== sym));
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',' || e.key === ' ') {
      e.preventDefault();
      // Support pasting "AAPL,MSFT" — split and add each.
      draft
        .split(',')
        .map(normalize)
        .filter(Boolean)
        .forEach(addSymbol);
    } else if (e.key === 'Backspace' && draft === '' && symbols.length > 0) {
      // Backspace on empty draft removes the last pill.
      removeSymbol(symbols[symbols.length - 1]);
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    // If the user types a comma inline, commit immediately.
    if (v.includes(',')) {
      v.split(',').map(normalize).filter(Boolean).forEach(addSymbol);
    } else {
      setDraft(v);
    }
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    // Commit any in-progress draft first.
    if (draft.trim()) addSymbol(draft);
    if (symbols.length === 0) return;
    onSubmit(symbols);
  };

  return (
    <form className="analysis-form" onSubmit={handleSubmit}>
      <label>
        Ticker symbols (up to {MAX_SYMBOLS})
        <div className="symbol-pills" data-testid="symbol-pills">
          {symbols.map((s) => (
            <span key={s} className="watchlist-chip" data-testid={`pill-${s}`}>
              <span className="watchlist-chip-symbol">{s}</span>
              <button
                type="button"
                className="watchlist-chip-remove"
                aria-label={`Remove ${s}`}
                data-testid={`pill-remove-${s}`}
                disabled={running}
                onClick={() => removeSymbol(s)}
              >
                ×
              </button>
            </span>
          ))}
          <input
            type="text"
            value={draft}
            placeholder={atMax ? `Max ${MAX_SYMBOLS} tickers` : 'Type a ticker, then Enter (e.g. AAPL)'}
            aria-label="Ticker symbols"
            disabled={running || atMax}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onBlur={(e) => {
              // Blur only PREVIEWS the typed ticker (validated in the parent via
              // resolvePreview). It does NOT auto-commit to pills — an explicit
              // Enter/comma is required to add a pill, so invalid tickers typed
              // and abandoned never become pills.
              const sym = normalize(draft);
              onBlur?.(sym);
            }}
          />
        </div>
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

      <button type="submit" className="analyze-btn" disabled={running || symbols.length === 0}>
        {running ? 'Analyzing…' : 'Analyze'}
      </button>
    </form>
  );
}

export default AnalysisForm;

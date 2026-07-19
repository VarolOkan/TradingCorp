// frontend/src/components/WatchlistBar.tsx
// Phase 7 (Watchlist / Portfolio): the persistent "my tickers" home. Sits above
// the analysis form so the user lands on a portfolio view, not a one-shot form.
// Each saved symbol is a card chip: click to deep-dive (runs it through the
// analysis tool -> MarketDataCard), or remove it from the watchlist.
import { useState } from 'react';
import { useWatchlist } from '../lib/watchlist';
import { validateSymbolsClient } from '../api/symbolClient';

export interface WatchlistBarProps {
  /** Deep-dive a symbol: run it through the analysis tool (MarketDataCard). */
  onOpen: (symbol: string) => void;
  /** Optional: also seed the analysis form input with the symbol. */
  onAnalyze?: (symbol: string) => void;
}

export function WatchlistBar({ onOpen, onAnalyze }: WatchlistBarProps) {
  const { symbols, add, remove } = useWatchlist();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const sym = draft.trim().toUpperCase();
    if (!sym) {
      setError('Enter a ticker');
      return;
    }
    if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(sym)) {
      setError('Invalid ticker format');
      return;
    }
    setChecking(true);
    setError(null);
    try {
      // Server-side validation: rejects non-symbols (e.g. the English word
      // "IRON") before persisting them to the watchlist. Fail-open: if the
      // server/network errors we accept the ticker rather than blocking.
      const { invalid } = await validateSymbolsClient([sym]);
      if (invalid.includes(sym)) {
        setError(`"${sym}" is not a recognized ticker symbol`);
        return;
      }
    } catch {
      // network/validation error → accept (fail-open)
    } finally {
      setChecking(false);
    }
    add(sym);
    setDraft('');
  };

  return (
    <section className="watchlist-bar" data-testid="watchlist-bar" aria-label="Watchlist">
      <div className="watchlist-head">
        <span className="watchlist-title">★ Watchlist</span>
        <span className="watchlist-count" data-testid="watchlist-count">
          {symbols.length} {symbols.length === 1 ? 'symbol' : 'symbols'}
        </span>
      </div>

      <form className="watchlist-add" onSubmit={submit}>
        <input
          className="watchlist-input"
          type="text"
          placeholder="Add ticker (e.g. AAPL)"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          aria-label="Add ticker to watchlist"
          data-testid="watchlist-input"
        />
        <button type="submit" className="watchlist-add-btn" data-testid="watchlist-add-btn" disabled={checking}>
          {checking ? '…' : '+ Add'}
        </button>
      </form>
      {error && (
        <p className="watchlist-error" role="alert" data-testid="watchlist-error">
          {error}
        </p>
      )}

      {symbols.length === 0 ? (
        <p className="watchlist-empty" data-testid="watchlist-empty">
          No saved tickers yet. Add one above, or star a market card to save it here.
        </p>
      ) : (
        <ul className="watchlist-chips" data-testid="watchlist-chips">
          {symbols.map((sym) => (
            <li key={sym} className="watchlist-chip" data-testid={`watchlist-chip-${sym}`}>
              <button
                type="button"
                className="watchlist-chip-symbol"
                title={`Deep-dive ${sym}`}
                onClick={() => (onAnalyze ? onAnalyze(sym) : onOpen(sym))}
                data-testid={`watchlist-open-${sym}`}
              >
                {sym}
              </button>
              <button
                type="button"
                className="watchlist-chip-remove"
                title={`Remove ${sym} from watchlist`}
                aria-label={`Remove ${sym}`}
                onClick={() => remove(sym)}
                data-testid={`watchlist-remove-${sym}`}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default WatchlistBar;

// frontend/src/api/optionsHistoryClient.ts
// Client for the Phase I options historical-chain endpoint (GET /options-history).
export type OptionRight = 'C' | 'P';

export interface OptionQuote {
  expiry: string;
  strike: number;
  type: OptionRight;
  bid: number;
  ask: number;
  last: number;
  volume: number;
  open_interest: number;
  iv: number;
  underlying_price: number;
  underlying_ts: string;
}

/** Per-strike Black–Scholes greeks (see src/registry/logic/greeks.ts for units). */
export interface GreeksRow {
  expiry: string;
  strike: number;
  type: OptionRight;
  delta: number;
  gamma: number;
  vega: number;
  theta: number;
  rho: number;
  iv_in: number;
  underlying_price: number;
  ttm_years: number;
  rfr: number;
}

export interface OptionChainResult {
  ticker: string;
  underlying_price: number;
  quotes: OptionQuote[];
  expiries: string[];
  rfr: number;
  /** Per-strike greeks, re-derived from each quote's IV (Phase 17). */
  greeks: GreeksRow[];
  source: 'polygon' | 'yahoo' | 'mock';
  note?: string;
}

export async function getOptionChain(symbol: string): Promise<OptionChainResult> {
  const res = await fetch(`/options-history?symbol=${encodeURIComponent(symbol.trim().toUpperCase())}`);
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data.error) detail = data.error;
    } catch {
      /* keep generic */
    }
    throw new Error(`Failed to load option chain: ${detail}`);
  }
  return (await res.json()) as OptionChainResult;
}

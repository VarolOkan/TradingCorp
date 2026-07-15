// frontend/src/api/quoteClient.ts
// Client for the Phase I market-quote endpoint (GET /quote?symbol=...).
// Returns the normalized quote shape produced by src/server/quote.ts.
export interface QuoteResult {
  symbol: string;
  name: string | null;
  price: number | null;
  open: number | null;
  change: number | null;
  changePct: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  previousClose: number | null;
  week52High: number | null;
  week52Low: number | null;
  yearChangePct: number | null;
  volume: number | null;
  avgVolume3m: number | null;
  currency: string | null;
  exchange: string | null;
  marketState: string | null;
  delaySec: number | null;
  timezoneOffsetMin: number | null;
  marketCap: number | null;
  sharesOut: number | null;
  floatShares: number | null;
  avgVolume10d: number | null;
  dividendYield: number | null;
  peTTM: number | null;
  epsTTM: number | null;
  priceToSales: number | null;
  priceToBook: number | null;
  earningsDate: string | null;
  marketTime: number | null;
  source: 'yahoo';
  note?: string;
}

export async function getQuote(symbol: string): Promise<QuoteResult> {
  const res = await fetch(`/quote?symbol=${encodeURIComponent(symbol.trim().toUpperCase())}`);
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data.error) detail = data.error;
    } catch {
      /* keep generic */
    }
    throw new Error(`Failed to load quote: ${detail}`);
  }
  return (await res.json()) as QuoteResult;
}

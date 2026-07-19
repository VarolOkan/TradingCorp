// frontend/src/api/symbolClient.ts
// Client for the server-side symbol-validation endpoint
// (GET /validate-symbols?symbols=AAPL,MSFT,IRON). Validation runs on the server
// because the symbol API (Stooq) is not CORS-accessible from the browser.
export interface SymbolValidationResult {
  results: { symbol: string; valid: boolean }[];
  valid: string[];
  invalid: string[];
}

export async function validateSymbolsClient(symbols: string[]): Promise<SymbolValidationResult> {
  const cleaned = Array.from(
    new Set(symbols.map((s) => s.trim().toUpperCase()).filter((s) => s.length > 0)),
  );
  if (cleaned.length === 0) {
    return { results: [], valid: [], invalid: [] };
  }
  const res = await fetch(`/validate-symbols?symbols=${encodeURIComponent(cleaned.join(','))}`);
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data.error) detail = data.error;
    } catch {
      /* keep generic */
    }
    throw new Error(`Symbol validation failed: ${detail}`);
  }
  return (await res.json()) as SymbolValidationResult;
}

// src/utils/symbol-lookup.ts
// Validate candidate ticker symbols against a REAL, working symbol source so the
// UI and the orchestrator can reject non-symbols (e.g. "GGGGGG", random words)
// instead of silently analyzing them.
//
// Source: Yahoo Finance chart endpoint (query1.finance.yahoo.com/v8/finance/
// chart/<SYM>) — the SAME tokenless source the app's /quote endpoint already
// trusts (see src/server/quote.ts). A real symbol returns chart.result[0]; an
// unknown symbol returns chart.error ("No data found, symbol may be delisted")
// and is treated as INVALID. This replaced an earlier Stooq CSV lookup that is
// no longer functional (Stooq now returns an HTML error page for the CSV
// endpoint, which the parser mistook for a valid quote).
//
// Best-effort + fail-open: a network error, non-OK status, timeout, or
// unreadable payload resolves the ticker as VALID so a Yahoo outage never blocks
// the user from adding a symbol. A DEFINITIVE "no data" from Yahoo is INVALID.

const YAHOO_CHART = (ticker: string) =>
  `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    ticker.toUpperCase(),
  )}?range=1d&interval=1d`;

// Loose shape gate: only skip the network call for inputs that can never be a
// real ticker (too long, or containing chars outside A-Z0-9.). 1–6 chars with
// digits/dots (e.g. BRK.B) are allowed through so Yahoo can decide. NOTE: this
// used to reject 6-char all-caps (like "GGGGGG"), which caused obvious junk to
// fail-open and slip through — that guard is now permissive on length.
function looksLikeTicker(ticker: string): boolean {
  return /^[A-Z0-9.]{1,6}$/.test(ticker);
}

async function checkOne(ticker: string, fetchFn: typeof fetch, signal: AbortSignal): Promise<boolean> {
  if (!looksLikeTicker(ticker)) return true; // don't second-guess; fail-open
  try {
    const res = await fetchFn(YAHOO_CHART(ticker), {
      signal,
      headers: { 'User-Agent': 'TradingCorp/1.0' },
    });
    let payload: any = null;
    try {
      payload = await res.json();
    } catch {
      // Unreadable body (HTML error page, truncated JSON, etc.).
    }
    // A definitive "not a real symbol" from Yahoo → INVALID. Yahoo signals this
    // BOTH on HTTP 200 (chart.error) AND on HTTP 404 (Not Found). Treating a
    // 404 as fail-open-valid was the original bug: junk like JHJHGJ / GGGGGG
    // came back as valid because Yahoo 404s the symbol.
    if (payload?.chart?.error) return false;
    // A result row exists → valid.
    if (payload?.chart?.result?.[0]) return true;
    // No result and no explicit error: this is the ambiguous case (e.g. a 5xx
    // or a rate-limit 429 with no chart.error). Fail OPEN so a Yahoo outage
    // never blocks the user from adding a symbol — but a 404-with-error above
    // is NOT ambiguous, it is a definitive "not found".
    return true;
  } catch {
    // Network/CORS/timeout/abort — fail-open so analysis is never blocked.
    return true;
  }
}

export interface SymbolValidationResult {
  valid: string[];
  invalid: string[];
  /** Symbols accepted from the local universe set (no external call made). */
  localHits: string[];
}

/**
 * Validate a set of candidate tickers.
 *
 * Two-layer check (cheapest first):
 *   Layer 1 — local universe set (src/utils/universe-lookup): a symbol already
 *     in the cached ~13k listed-pool is accepted with ZERO external calls.
 *   Layer 2 — Yahoo chart endpoint (only for symbols NOT in the local set): a
 *     definitive "No data found" from Yahoo makes it INVALID; anything else
 *     (real quote, or any error/timeout) is treated as VALID (fail-open) so a
 *     Yahoo outage never blocks the user.
 *
 * A symbol that is merely ABSENT from the local set is NOT rejected — the set
 * is NASDAQ-centric and incomplete — so it falls through to Yahoo.
 *
 * @param tickers  Candidate symbols (upper-cased + de-duped here).
 * @param fetchFn  Optional fetch (tests inject a fake). Defaults to globalThis.fetch.
 * @param timeoutMs  Per Yahoo request abort timeout. Default 4000ms.
 * @param universeCheck  Optional local-membership resolver (tests inject a fake
 *                 to stay hermetic). Defaults to the real universe set. Return
 *                 'in' to accept locally, 'out'/'unknown' to consult Yahoo.
 */
export async function validateTickers(
  tickers: string[],
  fetchFn?: typeof fetch,
  timeoutMs = 4000,
  universeCheck?: (ticker: string) => Promise<'in' | 'out' | 'unknown'>,
): Promise<SymbolValidationResult> {
  const doFetch = fetchFn ?? (globalThis as any).fetch;
  const unique = Array.from(new Set(tickers.map((t) => t.toUpperCase())));

  // Layer 1: local universe set (no external calls for hits).
  const localHits: string[] = [];
  const needYahoo: string[] = [];
  const check = universeCheck ?? (async (t: string) => {
    const { universeMembership } = await import('./universe-lookup');
    return universeMembership(t);
  });
  try {
    await Promise.all(
      unique.map(async (t) => {
        const m = await check(t);
        if (m === 'in') localHits.push(t);
        else needYahoo.push(t); // 'out' or 'unknown' → consult Yahoo
      }),
    );
  } catch {
    // Universe check failed — send everything to Yahoo (fail-open).
    needYahoo.push(...unique);
  }

  // Layer 2: Yahoo check for anything not resolved locally.
  const yahooResults = await Promise.all(
    needYahoo.map(async (t) => {
      if (!doFetch) return true; // no fetch available → fail-open
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await checkOne(t, doFetch, controller.signal);
      } finally {
        clearTimeout(timer);
      }
    }),
  );

  const valid: string[] = [...localHits];
  const invalid: string[] = [];
  needYahoo.forEach((t, i) => (yahooResults[i] ? valid.push(t) : invalid.push(t)));
  return { valid, invalid, localHits };
}

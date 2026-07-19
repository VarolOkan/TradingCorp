// src/utils/universe-lookup.ts
// Local, cache-backed lookup of the screener's equity universe, used as the
// FIRST (and cheapest) gate for ticker validation. The screener already pulls
// and daily-caches the full ~13k listed-pool (see src/registry/logic/universe).
// Validation reuses that cached set so a symbol that is ALREADY in the universe
// is accepted with ZERO external calls — only symbols NOT in the local set are
// forwarded to the Yahoo symbol check (src/utils/symbol-lookup.ts).
//
// IMPORTANT correctness note: "not in the local set" does NOT mean invalid.
// The universe is NASDAQ-centric and incomplete (new IPOs, some NYSE-only
// names). So a missing symbol is reported as `unknown` and the caller must fall
// through to the live Yahoo check rather than rejecting it. Only a HIT is a
// definitive local accept.
import { getUniverse, type UniverseCache } from '../registry/logic/universe';

export type UniverseMembership = 'in' | 'out' | 'unknown';

let symbolSet: Set<string> | null = null;
let loadedAt = 0;
const TTL_MS = 24 * 60 * 60 * 1000; // 1 day, matching the universe cache

/**
 * Load (or reuse) the universe symbol set. Symbols only — we pass skipQuotes so
 * this never triggers the Yahoo quote pre-filter. Shares the universe cache with
 * the screener, so a warm screener means this is free.
 */
export async function loadUniverseSet(cache?: UniverseCache): Promise<Set<string>> {
  const now = Date.now();
  if (symbolSet && now - loadedAt < TTL_MS) return symbolSet;
  const u = await getUniverse({ skipQuotes: true, ...(cache ? { cache } : {}) });
  symbolSet = new Set(u.quotes.map((q) => q.ticker.toUpperCase()));
  loadedAt = now;
  return symbolSet;
}

/** Force a reload on next call (test hook / manual refresh). */
export function resetUniverseSet(): void {
  symbolSet = null;
  loadedAt = 0;
}

/**
 * Check whether a ticker is in the locally-cached universe.
 *  - 'in'      → definitively a real listed symbol (accept, no external call)
 *  - 'out'     → definitively NOT in the cached set (caller should fall through
 *                to the live Yahoo check; do NOT treat as invalid here)
 *  - 'unknown' → the universe isn't loaded yet (caller should fall through)
 */
export async function universeMembership(
  ticker: string,
  cache?: UniverseCache,
): Promise<UniverseMembership> {
  const sym = ticker.trim().toUpperCase();
  if (!sym) return 'unknown';
  try {
    const set = await loadUniverseSet(cache);
    if (!set || set.size === 0) return 'unknown';
    return set.has(sym) ? 'in' : 'out';
  } catch {
    // Universe source unreachable — don't block validation; fall through.
    return 'unknown';
  }
}

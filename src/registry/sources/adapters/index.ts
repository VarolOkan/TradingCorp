// src/registry/sources/adapters/index.ts
// P1 adapter registry. Maps (domain -> sourceId -> adapter). resolveDomain and
// the legacy fetch wrappers look up the pure normalize() here instead of
// carrying inline parse. P2 fan-in iterates all adapters registered for a domain.

import type { DataDomain } from '../../types/domains';
import type { SourceAdapter } from './types';
import { yahooPriceAdapter, normalizeYahooChart } from './yahoo-price';
import { finnhubNewsAdapter, normalizeFinnhubNews } from './finnhub-news';
import {
  alphaVantageFundamentalsAdapter,
  normalizeAvOverview,
  scoreFromAvOverview,
} from './alphavantage-fundamentals';

export type { SourceAdapter, AdapterContext } from './types';
export { normalizeYahooChart, normalizeFinnhubNews, normalizeAvOverview, scoreFromAvOverview };

/** All registered adapters (one per provider×domain pair). */
export const ADAPTERS: ReadonlyArray<SourceAdapter<any>> = [
  yahooPriceAdapter,
  finnhubNewsAdapter,
  alphaVantageFundamentalsAdapter,
];

/** domain -> (sourceId -> adapter) lookup, built once. */
const BY_DOMAIN: Record<string, Record<string, SourceAdapter<any>>> = (() => {
  const m: Record<string, Record<string, SourceAdapter<any>>> = {};
  for (const a of ADAPTERS) {
    (m[a.domain] ??= {})[a.sourceId] = a;
  }
  return m;
})();

/** Look up a single adapter by domain + source id (undefined if none). */
export function getAdapter<D extends DataDomain>(
  domain: D,
  sourceId: string,
): SourceAdapter<D> | undefined {
  return BY_DOMAIN[domain]?.[sourceId] as SourceAdapter<D> | undefined;
}

/** All adapters registered for a domain (P2 fan-in enumerates these). */
export function adaptersFor<D extends DataDomain>(domain: D): SourceAdapter<D>[] {
  return Object.values(BY_DOMAIN[domain] ?? {}) as SourceAdapter<D>[];
}

// src/registry/sources/adapters/types.ts
// P1 (docs/ARCHITECTURE.md §Multi-Source Data Architecture, P1). Adapter contract.
//
// An ADAPTER is the *pure* parse half of a data source: it turns a raw provider
// payload (already fetched by the caller / acquireSource) into the canonical
// per-domain shape from `registry/types/domains.ts`. Keeping normalize() pure
// (no fetch, no clock beyond what the payload carries) makes it:
//   - fixture-testable in isolation (drift-hardening — this is what caught the
//     earlier "schema-drifted payload" failures),
//   - reusable by both the legacy functions (P1) and the multi-source fan-in (P2),
//   - free of provider URLs at the analyst layer (vendor lock-in removal).
//
// The FETCH half stays in acquireSource / the legacy functions for now; P4
// deletes the legacy wrappers once every call site routes through adapters.

import type { DataDomain, DomainShapes } from '../../types/domains';
import type { BarInterval } from '../../../types/financial-analysis';

/**
 * A source adapter for exactly one (provider, domain) pair.
 *
 * @typeParam D - the DataDomain this adapter produces.
 */
export interface SourceAdapter<D extends DataDomain> {
  /** Stable source id (matches DataSourceSpec.id / LEGACY_SOURCE_ID). */
  readonly sourceId: string;
  /** The domain this adapter normalizes into. */
  readonly domain: D;
  /**
   * Pure parse: raw provider payload -> canonical domain shape, or `null` when
   * the payload is empty / schema-drifted / not usable (caller then falls back).
   * MUST NOT fetch, MUST NOT throw on malformed input (return null instead).
   */
  normalize(raw: unknown, ctx: AdapterContext): DomainShapes[D] | null;
}

/** Per-call context an adapter may need to shape output (symbol, window, …). */
export interface AdapterContext {
  ticker: string;
  interval?: BarInterval;
  lookbackDays?: number;
  /** Extra provider-specific hints (e.g. key presence) without widening the API. */
  [k: string]: unknown;
}

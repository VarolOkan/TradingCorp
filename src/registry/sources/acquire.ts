// src/registry/sources/acquire.ts
// §4.9 multi-source acquisition engine.
//
// Acquires ONE external data source per call with its own policy:
//   - per-source timeout (AbortController)
//   - local retries with backoff (RetryHandler semantics, inline so we can
//     honour per-source retries + non-retryable 401/403 fast-fail + 429 backoff)
//   - post-fetch schema validator (case 4: empty / schema-drifted payload)
//   - onError policy: 'skip' | 'degrade' | 'fallback' | 'fail'
//
// It is intentionally TRANSPORT-AGNOSTIC: the actual fetch is injected
// (`fetchFn`) so tests can drive every corner case with a mock. In production
// the server wires `globalThis.fetch` (or node fetch). With NO real sources
// configured (the default MockSpec-only setup) this module is simply never
// called — so the engine is 100% parity-safe with the current mock behaviour.
//
// Auth attachment (bearer vs apikey) reads `runtimeConfig.accessToken`; the
// token is NEVER logged, echoed, or written into traces — only the source
// name + status are.

import type { DataSourceSpec } from '../../types/registry';

/** Result of attempting to acquire a single source. */
export interface AcquireResult {
  /** Source id (or label fallback) used as the sourceStatus key. */
  id: string;
  ok: boolean;
  /** 'ok' | 'skipped' | 'failed' | 'fallback' — matches AnalystTrace.sourceStatus value space. */
  status: 'ok' | 'skipped' | 'failed' | 'fallback';
  /** Acquired field data (keyed by field name) when ok/fallback. */
  data?: Record<string, any>;
  /** Human-readable reason for skip/fail (recorded in trace.notes). */
  reason?: string;
  /** True if the failure was an auth error (401/403) — drives "Check API key" hint. */
  authError?: boolean;
}

/** Minimal fetch interface (compatible with global fetch and test doubles). */
export type FetchFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; signal: AbortSignal }
) => Promise<{
  status: number;
  ok: boolean;
  json: () => Promise<any>;
  headers: { get(name: string): string | null };
}>;

export interface AcquireContext {
  /** Injected transport. Defaults to a node/browser global fetch adapter. */
  fetchFn?: FetchFn;
  /** The ticker being analyzed (substitutes {ticker}/{symbol} in endpoints). */
  ticker?: string;
  /** Connection config (token attachment). Optional. */
  runtimeConfig?: { baseUri: string; accessToken: string; extra: Record<string, string> } | null;
  /**
   * Per-source token resolver (B1). Given a source id, returns that source's
   * own credential (from the server-side AnalystConfigStore), or undefined to
   * fall back to the global runtimeConfig.accessToken. This lets each analyst
   * attach a DIFFERENT api key per external source while the global token
   * remains the fallback. The token is never logged/echoed by this module.
   */
  resolveToken?: (sourceId: string) => string | undefined;
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_RETRIES = 2;

const NON_RETRYABLE = new Set([401, 403]);
const RATE_LIMITED = new Set([429]);

function resolveFetch(ctx: AcquireContext): FetchFn {
  if (ctx.fetchFn) return ctx.fetchFn;
  const g: any = typeof globalThis !== 'undefined' ? globalThis : {};
  if (typeof g.fetch === 'function') {
    return (url, init) => g.fetch(url, init);
  }
  throw new Error('No fetch implementation available; pass fetchFn explicitly.');
}

/** Build request headers per the source auth policy. Token is attached, never logged. */
function buildHeaders(source: DataSourceSpec, ctx: AcquireContext): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  // B1: prefer a per-source token if the caller supplied a resolver, else the
  // global runtimeConfig token. undefined → fall back.
  const sourceId = source.id ?? source.label;
  const token = ctx.resolveToken?.(sourceId) ?? ctx.runtimeConfig?.accessToken ?? '';
  if (source.auth === 'bearer' && token) {
    headers['Authorization'] = `Bearer ${token}`;
  } else if (source.auth === 'apikey' && token) {
    // apikey is attached as a query param on the URL (see expandUrl), not header.
  }
  return headers;
}

function expandUrl(source: DataSourceSpec, ctx: AcquireContext): string {
  const base = ctx.runtimeConfig?.baseUri ?? '';
  let url = source.endpoint ?? '';
  const ticker = ctx.ticker ?? '';
  if (ticker) {
    url = url.replace(/\{ticker\}/gi, encodeURIComponent(ticker)).replace(/\{symbol\}/gi, encodeURIComponent(ticker));
  }
  const sourceId = source.id ?? source.label;
  const token = ctx.resolveToken?.(sourceId) ?? ctx.runtimeConfig?.accessToken ?? '';
  if (source.auth === 'apikey' && token) {
    const sep = url.includes('?') ? '&' : '?';
    return `${base}${url}${sep}apikey=${encodeURIComponent(token)}`;
  }
  return `${base}${url}`;
}

/** Validate a successful payload actually carries the requested fields (case 4). */
function validatePayload(payload: any, source: DataSourceSpec): boolean {
  if (!payload || typeof payload !== 'object') return false;
  // If the source declares a nested okPath envelope (e.g. Yahoo
  // `{ chart: { result: [...] } }`), validate THAT node exists rather than
  // requiring the requested fields at the top level.
  if (source.okPath) {
    return getPath(payload, source.okPath) !== undefined;
  }
  // An empty object for every requested field counts as schema-drift/empty.
  const hasAny = source.fields.some((f) => payload[f] !== undefined && payload[f] !== null);
  return hasAny || source.fields.length === 0;
}

/** Read a dot/bracket path like `chart.result[0].meta` from an object. */
function getPath(obj: any, path: string): any {
  const parts = path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean);
  let cur: any = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Acquire a single source, honouring timeout/retries/onError. Does NOT itself
 * apply the onError *policy* to the wider run — that is the caller's job
 * (GenericAnalystNode). This returns a structured AcquireResult so the caller
 * can branch on skip/degrade/fallback/fail.
 */
export async function acquireSource(
  source: DataSourceSpec,
  ctx: AcquireContext = {},
): Promise<AcquireResult> {
  const id = source.id ?? source.label;
  const timeoutMs = source.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = source.retries ?? DEFAULT_RETRIES;
  const fetchFn = resolveFetch(ctx);

  if (source.type && source.type !== 'rest' && source.type !== 'graphql') {
    // ws / ingestion / analyst sources are not fetched here (delegated
    // elsewhere); treat as a configuration no-op skip.
    return { id, ok: false, status: 'skipped', reason: `source type '${source.type}' not fetched by engine` };
  }

  if (!source.endpoint) {
    return { id, ok: false, status: 'skipped', reason: 'no endpoint configured' };
  }

  let lastAuthError = false;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchFn(expandUrl(source, ctx), {
        method: 'GET',
        headers: buildHeaders(source, ctx),
        signal: controller.signal,
      });

      if (NON_RETRYABLE.has(res.status)) {
        // Case 2: bad/expired token — do NOT retry; fail immediately.
        lastAuthError = true;
        return { id, ok: false, status: 'failed', reason: `HTTP ${res.status} (auth)`, authError: true };
      }
      if (RATE_LIMITED.has(res.status)) {
        // Case 3: rate-limited — back off then retry (unless last attempt).
        if (attempt < retries) {
          const retryAfter = Number(res.headers.get('retry-after') ?? '1');
          await delay(Math.min(Math.max(retryAfter, 1), 5) * 1000);
          continue;
        }
        return { id, ok: false, status: 'failed', reason: `HTTP 429 (rate-limited after ${retries} retries)` };
      }
      if (res.status >= 500) {
        // Case 1: server error — retry (unless last attempt).
        if (attempt < retries) {
          await delay(Math.min(500 * Math.pow(2, attempt), 5000));
          continue;
        }
        return { id, ok: false, status: 'failed', reason: `HTTP ${res.status} (server error)` };
      }
      if (!res.ok) {
        return { id, ok: false, status: 'failed', reason: `HTTP ${res.status}` };
      }

      const payload = await res.json().catch(() => null);
      if (!validatePayload(payload, source)) {
        // Case 4: empty / schema-drifted payload.
        return { id, ok: false, status: 'failed', reason: 'empty or schema-drifted payload' };
      }
      // Success — project only the requested fields.
      const data: Record<string, any> = {};
      for (const f of source.fields) {
        if (payload[f] !== undefined) data[f] = payload[f];
      }
      return { id, ok: true, status: 'ok', data };
    } catch (err) {
      // Timeout (AbortError) or network reset → case 1/5: retry unless last attempt.
      if (attempt < retries) {
        await delay(Math.min(500 * Math.pow(2, attempt), 5000));
        continue;
      }
      const msg = err instanceof Error ? err.message : String(err);
      return { id, ok: false, status: 'failed', reason: `fetch error: ${msg}` };
    } finally {
      clearTimeout(timer);
    }
  }

  return { id, ok: false, status: 'failed', reason: lastAuthError ? 'auth error' : 'exhausted retries' };
}

/**
 * Apply a source's onError policy given the acquisition result. Returns the
 * effective status to record + whether the analyst should escalate (fail).
 */
export function applySourcePolicy(
  result: AcquireResult,
  source: DataSourceSpec,
  allSources: DataSourceSpec[],
  ctx: AcquireContext,
): { status: AcquireResult['status']; data?: Record<string, any>; escalate: boolean; note?: string } {
  if (result.ok) {
    const out: { status: AcquireResult['status']; data?: Record<string, any>; escalate: boolean } = {
      status: 'ok',
      escalate: false,
    };
    if (result.data !== undefined) out.data = result.data;
    return out;
  }

  const onError = source.onError ?? 'skip';

  switch (onError) {
    case 'skip':
    case 'degrade':
      return {
        status: 'skipped',
        escalate: source.required === true,
        note: `${source.label}: ${onError === 'degrade' ? 'degraded (source unavailable)' : 'skipped (source unavailable)'}`,
      };
    case 'fallback': {
      const fb = allSources.find((s) => s.id === source.fallbackSourceId);
      if (fb && fb !== source) {
        // Synchronous fallback attempt is done by the caller loop; here we just
        // mark the intent. The caller retries acquireSource on the fallback.
        return { status: 'fallback', escalate: false, note: `${source.label}: trying fallback ${fb.label}` };
      }
      return {
        status: 'skipped',
        escalate: source.required === true,
        note: `${source.label}: fallback '${source.fallbackSourceId ?? ''}' not found, skipped`,
      };
    }
    case 'fail':
      return { status: 'failed', escalate: true, note: `${source.label}: required source failed` };
    default:
      return { status: 'skipped', escalate: source.required === true };
  }
}

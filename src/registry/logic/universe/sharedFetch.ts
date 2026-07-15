// src/registry/logic/universe/sharedFetch.ts
// Phase 1: the injectable fetch contract shared by every universe/quote
// provider. Tests pass a mock; production uses global fetch. Keeping it
// narrow (url + optional headers + text()) avoids pulling Node's full
// fetch types into the test surface and lets us fake a 200/429/empty
// response with zero network.
export type FetchFn = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  json: () => Promise<any>;
  /** Response headers (mapped to a plain record). Optional in mocks. */
  headers?: Record<string, string>;
}>;

import { DEFAULT_USER_AGENT } from './nasdaqTraderProvider';

/** Resolve the real global fetch, typed to our narrow contract. */
export function realFetch(): FetchFn {
  const f = (globalThis as any).fetch;
  if (!f) throw new Error('global fetch unavailable (Node 18+ required)');
  return async (url: string, init?: { headers?: Record<string, string> }) => {
    const headers = { 'User-Agent': DEFAULT_USER_AGENT, ...(init?.headers ?? {}) };
    const res = await f(url, { headers });
    const h = res.headers as any;
    return {
      ok: res.ok,
      status: res.status,
      text: () => res.text(),
      json: () => res.json(),
      headers: h && typeof h.entries === 'function' ? Object.fromEntries(h.entries()) : {},
    };
  };
}

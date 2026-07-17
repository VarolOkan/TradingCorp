// frontend/src/api/analystConfigClient.ts
// Client for the per-analyst / per-source credential endpoint (B1).
//
// The Settings dialog collects a backend baseUri / accessToken (POST /config).
// Per-analyst source tokens (POST /analyst-config) are a SEPARATE, finer-grained
// credential: each live+auth source on an analyst can carry its OWN api key.
// The token is sent over the wire to the server but is never echoed back and is
// never written to the client bundle.

import type {
  AnalystSourceConfig,
  AnalystSourceCatalog,
} from '../types';

export interface PostAnalystConfigResponse {
  ok: boolean;
  sessionId: string;
  analystId: string;
  sourceId: string;
  hasToken: boolean;
}

/** Normalized health-probe result returned by POST /analyst-config/test. */
export interface SourceTestResult {
  ok: boolean;
  sourceId: string;
  hasToken: boolean;
  status?: number;
  error?: string;
  detail?: string;
  latencyMs?: number;
}

/**
 * POST a health probe for one source. Uses the STORED token (vault) on the
 * server, so it works even when the field is blank.
 */
export async function testAnalystConfig(
  analystId: string,
  sourceId: string,
  sessionId = 'default'
): Promise<SourceTestResult> {
  const res = await fetch(`/analyst-config/test?sessionId=${encodeURIComponent(sessionId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ analystId, sourceId }),
  });
  if (!res.ok) {
    throw new Error(`Source test failed: HTTP ${res.status}`);
  }
  return (await res.json()) as SourceTestResult;
}

/**
 * POST one source credential for (session, analystId, sourceId).
 */
export async function postAnalystConfig(
  config: AnalystSourceConfig,
  sessionId = 'default'
): Promise<PostAnalystConfigResponse> {
  const res = await fetch(
    `/analyst-config?sessionId=${encodeURIComponent(sessionId)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    }
  );

  if (!res.ok) {
    let details: string[] = [];
    try {
      const data = (await res.json()) as { error?: string; details?: string[] };
      details = data.details ?? [data.error ?? `HTTP ${res.status}`];
    } catch {
      details = [`HTTP ${res.status}`];
    }
    throw new Error(`Failed to save source config: ${details.join('; ')}`);
  }

  return (await res.json()) as PostAnalystConfigResponse;
}

/**
 * GET the catalog of analysts that declare a LIVE+auth source. The client uses
 * this to decide which analyst panels show a "⚙ Configure source" button.
 */
export async function getAnalystSourceCatalog(): Promise<AnalystSourceCatalog> {
  const res = await fetch('/analyst-config', { method: 'GET' });
  if (!res.ok) {
    throw new Error(`Failed to load source catalog: HTTP ${res.status}`);
  }
  return (await res.json()) as AnalystSourceCatalog;
}

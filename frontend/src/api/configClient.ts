// frontend/src/api/configClient.ts
// Client for the runtime connection settings endpoint (Option B).
//
// The Settings dialog collects a backend baseUri / accessToken / extra and
// POSTs them here. The token is sent over the wire to the server but is never
// echoed back by the server and is never written to the client bundle log.

import type { ConnectionSettings } from '../types';

export interface PostSettingsResponse {
  ok: boolean;
  sessionId: string;
  baseUri: string;
  hasToken: boolean;
  extraKeys: string[];
}

export interface StaticConfigResponse {
  analysis: Record<string, unknown>;
  version: string;
}

/**
 * POST runtime connection settings for a session.
 *
 * @param settings  The baseUri / accessToken / extra collected in the dialog.
 * @param sessionId Optional session id (defaults to 'default').
 */
export async function postSettings(
  settings: ConnectionSettings,
  sessionId = 'default'
): Promise<PostSettingsResponse> {
  const res = await fetch(`/config?sessionId=${encodeURIComponent(sessionId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });

  if (!res.ok) {
    let details: string[] = [];
    try {
      const data = (await res.json()) as { error?: string; details?: string[] };
      details = data.details ?? [data.error ?? `HTTP ${res.status}`];
    } catch {
      details = [`HTTP ${res.status}`];
    }
    throw new Error(`Failed to save settings: ${details.join('; ')}`);
  }

  return (await res.json()) as PostSettingsResponse;
}

/**
 * GET the static analysis config (server defaults).
 */
export async function getConfig(): Promise<StaticConfigResponse> {
  const res = await fetch('/config', { method: 'GET' });
  if (!res.ok) {
    throw new Error(`Failed to load config: HTTP ${res.status}`);
  }
  return (await res.json()) as StaticConfigResponse;
}

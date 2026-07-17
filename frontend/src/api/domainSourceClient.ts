// frontend/src/api/domainSourceClient.ts
// Client for the P3b per-domain source-mapping endpoints (GET/POST /domain-sources).
// Lets the Settings UI enable / disable / reorder the sources feeding each data
// domain, persisted server-side (survives restart).

export interface DomainSourceView {
  available: string[];
  override: string[] | undefined;
  enabled: string[];
  overridden: boolean;
}

export interface DomainSourcesResponse {
  domains: Record<string, DomainSourceView>;
  overrides: Record<string, string[]>;
}

export async function getDomainSources(): Promise<DomainSourcesResponse> {
  const res = await fetch('/domain-sources', { method: 'GET' });
  if (!res.ok) throw new Error(`Failed to load domain sources: HTTP ${res.status}`);
  return (await res.json()) as DomainSourcesResponse;
}

export interface SetDomainSourcesResponse {
  ok: boolean;
  domain: string;
  enabled: string[];
}

/** Persist the enabled (ordered) source list for one domain. */
export async function setDomainSources(
  domain: string,
  sources: string[],
): Promise<SetDomainSourcesResponse> {
  const res = await fetch('/domain-sources', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ domain, sources }),
  });
  if (!res.ok) {
    let details: string[] = [];
    try {
      const data = (await res.json()) as { error?: string; details?: string[] };
      details = data.details ?? [data.error ?? `HTTP ${res.status}`];
    } catch {
      details = [`HTTP ${res.status}`];
    }
    throw new Error(`Failed to save domain sources: ${details.join('; ')}`);
  }
  return (await res.json()) as SetDomainSourcesResponse;
}

export async function resetDomainSources(): Promise<DomainSourcesResponse> {
  const res = await fetch('/domain-sources/reset', { method: 'POST' });
  if (!res.ok) throw new Error(`Failed to reset domain sources: HTTP ${res.status}`);
  return (await res.json()) as DomainSourcesResponse;
}

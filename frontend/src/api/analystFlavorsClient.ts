// frontend/src/api/analystFlavorsClient.ts
// Client for the per-analyst FLAVORS endpoint (docs/EXTENDING_ANALYSTS.md §8).
//
// GET  /analyst-flavors  — resolved { flavors, selectedId } for (session, agency, analyst)
// POST /analyst-flavors  — full replace of the user's flavor set + selection

export interface AnalystFlavorDTO {
  id: string;
  name: string;
  role: string;
  instructions: string;
  isDefault?: boolean;
  /** §10.7 — when true (and a provider token is configured) the LLM step fires for this flavor. */
  enabled?: boolean;
}

export interface GetAnalystFlavorsResponse {
  sessionId: string;
  agencyId: string;
  analystId: string;
  flavors: AnalystFlavorDTO[];
  selectedId: string;
}

export interface PostAnalystFlavorsResponse {
  ok: boolean;
  sessionId: string;
  agencyId: string;
  analystId: string;
  flavors: AnalystFlavorDTO[];
  selectedId: string;
}

export async function getAnalystFlavors(
  sessionId: string,
  agencyId: string,
  analystId: string,
): Promise<GetAnalystFlavorsResponse> {
  const res = await fetch(
    `/analyst-flavors?sessionId=${encodeURIComponent(sessionId)}&agencyId=${encodeURIComponent(agencyId)}&analystId=${encodeURIComponent(analystId)}`,
  );
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data.error) detail = data.error;
    } catch {
      /* keep generic */
    }
    throw new Error(`Failed to load analyst flavors: ${detail}`);
  }
  return (await res.json()) as GetAnalystFlavorsResponse;
}

export async function postAnalystFlavors(payload: {
  sessionId: string;
  agencyId: string;
  analystId: string;
  flavors: AnalystFlavorDTO[];
  selectedId: string;
}): Promise<PostAnalystFlavorsResponse> {
  const res = await fetch('/analyst-flavors', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    let details: string[] = [];
    try {
      const data = (await res.json()) as { error?: string; details?: string[] };
      details = data.details ?? [data.error ?? `HTTP ${res.status}`];
    } catch {
      details = [`HTTP ${res.status}`];
    }
    throw new Error(`Failed to save analyst flavors: ${details.join('; ')}`);
  }
  return (await res.json()) as PostAnalystFlavorsResponse;
}

export interface AgencyFlavorSummaryResponse {
  ok: boolean;
  sessionId: string;
  agencyId: string;
  analysts: { analystId: string; llmEnabled: boolean }[];
  enabledCount: number;
  total: number;
}

/** §10.7 — reflect the currently-stored LLM opt-in state for an agency. */
export async function getAgencyFlavorSummary(
  sessionId: string,
  agencyId: string,
): Promise<AgencyFlavorSummaryResponse> {
  const qs = new URLSearchParams({ sessionId, agencyId });
  const res = await fetch(`/analyst-flavors/agency-summary?${qs.toString()}`);
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data.error) detail = data.error;
    } catch {
      /* keep generic */
    }
    throw new Error(`Failed to load agency flavor summary: ${detail}`);
  }
  return (await res.json()) as AgencyFlavorSummaryResponse;
}

export interface BulkEnableLlmResponse {
  ok: boolean;
  agencyId: string;
  sessionId: string;
  enabled: boolean;
  analystsTouched: number;
  flavorsChanged: number;
}

/**
 * §10.7 convenience: enable (or disable) the LLM step for ALL analysts in an
 * agency at once, by flipping `enabled` on each analyst's SELECTED flavor.
 * Preserves existing instructions/selection — only the opt-in flag is toggled.
 */
export async function enableLlmForAllAnalysts(
  sessionId: string,
  agencyId: string,
  enabled = true,
): Promise<BulkEnableLlmResponse> {
  const res = await fetch('/analyst-flavors/bulk-enable-llm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, agencyId, enabled }),
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data.error) detail = data.error;
    } catch {
      /* keep generic */
    }
    throw new Error(`Failed to enable LLM for all analysts: ${detail}`);
  }
  return (await res.json()) as BulkEnableLlmResponse;
}

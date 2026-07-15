// frontend/src/api/analystParamsClient.ts
// Client for the per-analyst tunable WEIGHTS endpoint (docs/CARD_SETTINGS_PANEL.md).
//
// POST /analyst-params  — save weight overrides for (session, agency, analyst)
// GET  /analyst-params  — load saved weights for a whole agency (repopulate panels)

export interface PostAnalystParamsResponse {
  ok: boolean;
  sessionId: string;
  agencyId: string;
  analystId: string;
  params: Record<string, number>;
}

export interface GetAnalystParamsResponse {
  sessionId: string;
  agencyId: string;
  /** Saved weights keyed by analystId. */
  params: Record<string, Record<string, number>>;
}

export async function postAnalystParams(
  payload: { sessionId: string; agencyId: string; analystId: string; params: Record<string, number> },
): Promise<PostAnalystParamsResponse> {
  const res = await fetch('/analyst-params', {
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
    throw new Error(`Failed to save analyst params: ${details.join('; ')}`);
  }
  return (await res.json()) as PostAnalystParamsResponse;
}

export async function getAnalystParams(
  sessionId: string,
  agencyId: string,
): Promise<GetAnalystParamsResponse> {
  const res = await fetch(
    `/analyst-params?sessionId=${encodeURIComponent(sessionId)}&agencyId=${encodeURIComponent(agencyId)}`,
  );
  if (!res.ok) {
    throw new Error(`Failed to load analyst params: HTTP ${res.status}`);
  }
  return (await res.json()) as GetAnalystParamsResponse;
}

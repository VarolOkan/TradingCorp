// frontend/src/api/llmConfigClient.ts
// Client for the LLM provider/model config endpoints (docs/EXTENDING_ANALYSTS.md § options flavors + LLM step).
//
// GET  /llm-config  → { configs: LlmModelConfigPublic[], agencyModelRole }
// POST /llm-config  → full replace of the 3 role configs (+ optional agencyModelRole)
// GET  /llm-config/status → { roles: { [role]: { provider, model, configured } } }

import type { LlmRole, LlmProvider } from '../../../src/server/llm-config';

export interface LlmModelConfigPublic {
  role: LlmRole;
  provider: LlmProvider;
  baseUrl: string;
  model: string;
  hasToken: boolean;
}

export interface LlmConfigResponse {
  configs: LlmModelConfigPublic[];
  agencyModelRole: LlmRole | null;
}

export interface LlmConfigStatusResponse {
  roles: Record<string, { provider: LlmProvider; model: string; configured: boolean }>;
}

export interface LlmConfigPost {
  configs: Array<{
    role: LlmRole;
    provider: LlmProvider;
    baseUrl: string;
    model: string;
    token: string;
  }>;
  agencyId?: string;
  agencyModelRole?: LlmRole | null;
  sessionId?: string;
}

export async function getLlmConfig(
  sessionId = 'default',
  agencyId?: string,
): Promise<LlmConfigResponse> {
  const qs = new URLSearchParams({ sessionId });
  if (agencyId) qs.set('agencyId', agencyId);
  const res = await fetch(`/llm-config?${qs.toString()}`);
  if (!res.ok) throw new Error(`Failed to load LLM config: HTTP ${res.status}`);
  return (await res.json()) as LlmConfigResponse;
}

export async function getLlmConfigStatus(): Promise<LlmConfigStatusResponse> {
  const res = await fetch('/llm-config/status');
  if (!res.ok) throw new Error(`Failed to load LLM config status: HTTP ${res.status}`);
  return (await res.json()) as LlmConfigStatusResponse;
}

export async function postLlmConfig(body: LlmConfigPost): Promise<LlmConfigResponse> {
  const res = await fetch('/llm-config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let details: string[] = [];
    try {
      const data = (await res.json()) as { error?: string; details?: string[] };
      details = data.details ?? [data.error ?? `HTTP ${res.status}`];
    } catch {
      details = [`HTTP ${res.status}`];
    }
    throw new Error(`Failed to save LLM config: ${details.join('; ')}`);
  }
  return (await res.json()) as LlmConfigResponse;
}

export interface LlmConfigTestResponse {
  ok: boolean;
  provider: LlmProvider;
  baseUrl: string;
  model: string;
  hasToken: boolean;
  status?: number;
  error?: string;
  detail?: string;
}

export async function postLlmConfigTest(body: {
  role?: string;
  provider: LlmProvider;
  baseUrl: string;
  model: string;
  token: string;
  sessionId?: string;
}): Promise<LlmConfigTestResponse> {
  const res = await fetch('/llm-config/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let details: string[] = [];
    try {
      const data = (await res.json()) as { error?: string; details?: string[] };
      details = data.details ?? [data.error ?? `HTTP ${res.status}`];
    } catch {
      details = [`HTTP ${res.status}`];
    }
    throw new Error(`LLM test failed: ${details.join('; ')}`);
  }
  return (await res.json()) as LlmConfigTestResponse;
}

// src/server/llm-config-routes.ts
// Phase G — REST for the LLM provider/model config (docs/OPTIONS_AND_AGENCY_EXPANSION.md §12).
//
// GET  /llm-config            → public configs (token → hasToken) + per-agency role
// GET  /llm-config/status     → which roles are live (configured:bool)
// POST /llm-config            → full replace of the 3 role configs (+ optional agencyModelRole)

import type { Express } from 'express';
import {
  LlmConfigStore,
  LLM_ROLES,
  PROVIDER_BASE_URLS,
  resolveModelRole,
  vaultHealth,
  type LlmModelConfig,
  type LlmModelConfigPublic,
  type LlmRole,
  type LlmProvider,
} from './llm-config';
import type { AgencyDef } from '../types/registry';

function isLlmRole(v: unknown): v is LlmRole {
  return typeof v === 'string' && (LLM_ROLES as string[]).includes(v);
}
function isProvider(v: unknown): v is LlmProvider {
  return typeof v === 'string' && Object.keys(PROVIDER_BASE_URLS).includes(v);
}

export function registerLlmConfigRoutes(
  app: Express,
  store: LlmConfigStore,
  getAgencyDef?: (agencyId: string) => AgencyDef | undefined,
): void {
  // GET public configs (+ per-agency role override for the requested agency).
  app.get('/llm-config', (req, res) => {
    const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : 'default';
    const agencyId = typeof req.query.agencyId === 'string' ? req.query.agencyId : undefined;
    const configs: LlmModelConfigPublic[] = store.list();
    const agencyModelRole = agencyId ? store.getAgencyModelRole(sessionId, agencyId) : null;
    res.json({ configs, agencyModelRole });
  });

  // GET status snapshot.
  app.get('/llm-config/status', (_req, res) => {
    res.json({ roles: store.status(), vault: vaultHealth() });
  });

  // POST full replace of the 3 role configs (+ optional agency override).
  app.post('/llm-config', (req, res) => {
    const body = req.body as {
      configs?: LlmModelConfig[];
      agencyId?: string;
      agencyModelRole?: LlmRole | null;
      sessionId?: string;
    };

    if (!Array.isArray(body.configs)) {
      res.status(400).json({ error: 'configs must be an array' });
      return;
    }

    const seen = new Set<string>();
    const errors: string[] = [];
    for (const c of body.configs) {
      if (!isLlmRole(c?.role)) {
        errors.push(`invalid role: ${String(c?.role)}`);
        continue;
      }
      if (seen.has(c.role)) {
        errors.push(`duplicate role: ${c.role}`);
        continue;
      }
      seen.add(c.role);
      if (!isProvider(c.provider)) {
        errors.push(`invalid provider for ${c.role}: ${String(c.provider)}`);
        continue;
      }
      if (typeof c.model !== 'string' || c.model.trim().length === 0) {
        errors.push(`model is required for ${c.role}`);
        continue;
      }
      // An empty token means "keep the existing one" (the dialog sends '' for
      // roles whose Token field the user left untouched, so a save must NOT
      // wipe previously-stored tokens). Only a non-empty token replaces.
      const existing = store.get(c.role);
      const token =
        typeof c.token === 'string' && c.token.length > 0 ? c.token : (existing?.token ?? '');
      store.put({
        role: c.role,
        provider: c.provider,
        baseUrl: typeof c.baseUrl === 'string' && c.baseUrl.trim().length > 0 ? c.baseUrl.trim() : PROVIDER_BASE_URLS[c.provider],
        model: c.model.trim(),
        token,
      });
    }

    // §12.4.1 per-agency model assignment.
    if (body.agencyId) {
      if (body.agencyModelRole !== undefined) {
        if (body.agencyModelRole !== null && !isLlmRole(body.agencyModelRole)) {
          errors.push(`invalid agencyModelRole: ${String(body.agencyModelRole)}`);
        } else {
          const sessionId = typeof body.sessionId === 'string' ? body.sessionId : 'default';
          store.setAgencyModelRole(sessionId, body.agencyId, body.agencyModelRole);
        }
      }
    }

    if (errors.length > 0) {
      res.status(400).json({ error: 'Invalid LLM config', details: errors });
      return;
    }

    const agencyModelRole = body.agencyId
      ? store.getAgencyModelRole(typeof body.sessionId === 'string' ? body.sessionId : 'default', body.agencyId)
      : null;

    res.json({ ok: true, configs: store.list(), agencyModelRole });
  });

  // POST /llm-config/test — validate a provider URI + token by making a real
  // (lightweight) probe request. Uses the token from the request body; if the
  // body token is blank the stored token for that role is used instead.
  app.post('/llm-config/test', async (req, res) => {
    const body = req.body as {
      role?: string;
      provider?: LlmProvider;
      baseUrl?: string;
      model?: string;
      token?: string;
      sessionId?: string;
    };

    if (!isProvider(body.provider)) {
      res.status(400).json({ ok: false, error: `invalid provider: ${String(body.provider)}` });
      return;
    }
    const baseUrl = (body.baseUrl && body.baseUrl.trim()) || PROVIDER_BASE_URLS[body.provider];
    const model = (body.model && body.model.trim()) || '';
    // Prefer the token typed in the dialog; fall back to the stored one so the
    // Test button works even when the field is left blank (token stays secret).
    const stored = body.role && isLlmRole(body.role) ? store.get(body.role as LlmRole) : undefined;
    const token = body.token && body.token.length > 0 ? body.token : stored?.token ?? '';

    const probe = await probeLlmProvider({
      provider: body.provider,
      baseUrl,
      model,
      token,
    });

    res.json({
      ok: probe.ok,
      provider: body.provider,
      baseUrl,
      model,
      hasToken: token.length > 0,
      status: probe.status,
      error: probe.error,
      detail: probe.detail,
    });
  });

  // Expose resolveModelRole helper on the store for handlers (kept here to avoid
  // a circular import in handler land). No-op export shim.
  void resolveModelRole;
  void getAgencyDef;
}

/**
 * Probe an LLM provider to confirm the URI + token are valid. Uses the
 * provider's model-listing endpoint (cheap, auth-validating) — never sends a
 * chat completion. Returns a normalized result safe to show the user.
 */
export async function probeLlmProvider(opts: {
  provider: LlmProvider;
  baseUrl: string;
  model: string;
  token: string;
}): Promise<{ ok: boolean; status?: number; error?: string; detail?: string }> {
  const { provider, baseUrl, token } = opts;
  // Each provider exposes a model/identity endpoint that requires a valid token.
  const pathByProvider: Record<LlmProvider, string> = {
    openrouter: '/models',
    openai: '/models',
    anthropic: '/models',
    azure: '/models',
    ollama: '/api/tags',
  };
  const probePath = pathByProvider[provider];
  const url = `${baseUrl.replace(/\/+$/, '')}${probePath}`;

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (provider === 'anthropic') {
    // Anthropic expects the key under x-api-key and a version header.
    if (token) headers['x-api-key'] = token;
    headers['anthropic-version'] = '2023-06-01';
  } else if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const resp = await fetch(url, { method: 'GET', headers, signal: controller.signal });
    clearTimeout(timeout);
    const status = resp.status;
    if (status >= 200 && status < 300) {
      return { ok: true, status };
    }
    let detail: string | undefined;
    try {
      const txt = await resp.text();
      detail = txt.slice(0, 300) || undefined;
    } catch {
      /* ignore */
    }
    if (status === 401 || status === 403) {
      return { ok: false, status, error: 'Authentication failed — check the token', detail };
    }
    if (status === 404) {
      return { ok: false, status, error: 'Endpoint not found — check the Base URL', detail };
    }
    return { ok: false, status, error: `Provider returned HTTP ${status}`, detail };
  } catch (err) {
    const e = err as Error;
    if (e.name === 'AbortError') {
      return { ok: false, error: 'Request timed out — check the Base URL / network' };
    }
    return { ok: false, error: e.message || 'Network error — check the Base URL / token' };
  }
}

// src/registry/logic/llm.ts
// Phase F/G — provider-agnostic LLM call for the analyst "LLM does the work" step
// (docs/OPTIONS_AND_AGENCY_EXPANSION.md §10.3, §12).
//
// The client is OpenAI-compatible chat completions. The provider/baseUrl/model/token
// are resolved from the LlmConfigStore by ROLE (deep-thought | scanner | flexible)
// so the three roles are independent slots (§12.6). When NO token is configured for
// the resolved role it DEGRADES to a deterministic structured fallback so the pipeline
// still completes with the same shape — parity preserved (no key = no behavior change).
// The fallback returns a neutral verdict + the system prompt echoed as the "summary" so
// the trace is auditable without an external call.

import { resolveLlmConfig, type LlmModelConfig, type LlmRole } from '../../server/llm-config';
import { logger } from '../../utils/logger';

export interface LLMResult {
  /** Raw model text (or the fallback echo). */
  text: string;
  /** Parsed verdict if one could be extracted, else null. */
  verdict?: string | null;
  /** Parsed score 0–100 if one could be extracted, else null. */
  score?: number | null;
  /** True when the deterministic fallback ran (no provider token). */
  usedFallback: boolean;
  /** The resolved role (for trace auditing). */
  role?: LlmRole;
}

export interface LLMRequest {
  /** Selected flavor instructions (the system prompt). */
  system: string;
  /** Analyst-specific data summary (the user message). */
  user: string;
  /** §12.4 — which LLM role to run as. Resolves provider/baseUrl/model/token. */
  role?: LlmRole;
  /** Optional explicit overrides (used by tests / no-store path). */
  config?: Partial<LlmModelConfig>;
  temperature?: number;
}

/**
 * Resolve the effective config for a request. When a `role` is given we read
 * the shared LlmConfigStore; otherwise fall back to env (legacy path).
 */
function resolveRequestConfig(req: LLMRequest): LlmModelConfig & { apiKey: string | undefined } {
  if (req.role) {
    const cfg = resolveLlmConfig(llmConfigStoreOrNull(), req.role);
    // Prefer the role's stored token; fall back to env tokens so a key set via
    // OPENAI_API_KEY / LLM_API_KEY still works even without the vault/UI.
    const apiKey = cfg.token
      || (req.role === 'deep-thought'
        ? process.env.OPENAI_API_KEY || process.env.LLM_API_KEY
        : undefined)
      || process.env.LLM_API_KEY
      || undefined;
    return { ...cfg, apiKey };
  }
  // Legacy env path (no role): read env directly.
  const apiKey = process.env.OPENAI_API_KEY || process.env.LLM_API_KEY || undefined;
  return {
    role: 'deep-thought',
    provider: (process.env.LLM_PROVIDER as any) || 'openai',
    baseUrl: process.env.OPENAI_BASE_URL || process.env.LLM_BASE_URL || 'https://api.openai.com/v1',
    model: process.env.OPENAI_MODEL || process.env.LLM_MODEL || 'gpt-4o-mini',
    token: apiKey || '',
    apiKey,
  };
}

// Lazily avoid a hard import cycle at module load: llm.ts (logic) → llm-config.ts
// (server) is fine (server already imports logic), but to be safe we resolve the
// store lazily inside the function.
let _store: { get: (r: LlmRole) => LlmModelConfig } | null = null;
function llmConfigStoreOrNull() {
  if (!_store) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('../../server/llm-config');
    _store = mod.llmConfigStore;
  }
  return _store as any;
}

/** Extract a BULLISH/BEARISH/NEUTRAL (or APPROVE/REJECT) verdict from text. */
function extractVerdict(text: string): string | null {
  const upper = text.toUpperCase();
  if (/\b(BULLISH|BUY|APPROVE|LONG)\b/.test(upper)) return 'BULLISH';
  if (/\b(BEARISH|SELL|REJECT|SHORT)\b/.test(upper)) return 'BEARISH';
  if (/\bNEUTRAL|HOLD\b/.test(upper)) return 'NEUTRAL';
  return null;
}

/** Extract the first 0–100 integer score mentioned in text. */
function extractScore(text: string): number | null {
  const m = text.match(/(?:score|rating)[^\d]*?(\d{1,3})/i) || text.match(/\b(\d{1,3})\s*\/\s*100\b/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
}

/**
 * Call the LLM (if a token is configured for the role) or degrade to a
 * deterministic fallback. Never throws on provider failure — it falls back so
 * the pipeline completes.
 */
export async function runAnalystLLM(req: LLMRequest): Promise<LLMResult> {
  const cfg = resolveRequestConfig(req);
  const role = cfg.role;

  if (!cfg.apiKey) {
    logger.info(
      `LLM CALL SKIPPED (no token) role=${role} baseUrl=${cfg.baseUrl} model=${cfg.model} ` +
        `— using parity-safe deterministic fallback (no network call made)`,
    );
    // Parity-safe fallback: echo the system instructions; neutral verdict.
    const text = `[fallback:${role}] ${req.system}\n\nData: ${req.user}`;
    return { text, verdict: 'NEUTRAL', score: null, usedFallback: true, role };
  }

  try {
    logger.info(
      `LLM CALL role=${role} -> ${cfg.baseUrl.replace(/\/$/, '')}/chat/completions ` +
        `model=${cfg.model} (apiKey set: yes)`,
    );
    const url = `${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: req.config?.model || cfg.model,
        temperature: req.temperature ?? 0.3,
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user },
        ],
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.warn(`LLM CALL FAILED role=${role} status=${res.status} body=${body.slice(0, 300)}`);
      throw new Error(`LLM HTTP ${res.status}`);
    }
    const data = (await res.json()) as any;
    const text: string = data?.choices?.[0]?.message?.content ?? '';
    logger.info(`LLM CALL OK role=${role} responseLen=${text.length}`);
    return {
      text,
      verdict: extractVerdict(text),
      score: extractScore(text),
      usedFallback: false,
      role,
    };
  } catch (err) {
    logger.warn(`LLM CALL ERROR role=${role}: ${(err as Error).message}`);
    // Any provider failure degrades to the deterministic fallback rather than
    // breaking the run.
    const text = `[fallback after error: ${(err as Error).message}] ${req.system}\n\nData: ${req.user}`;
    return { text, verdict: 'NEUTRAL', score: null, usedFallback: true, role };
  }
}

/** True when the resolved role has a configured token (so the LLM step would actually call). */
export function isLLMConfigured(role: LlmRole = 'deep-thought'): boolean {
  try {
    return Boolean(llmConfigStoreOrNull().get(role).token);
  } catch {
    return Boolean(process.env.OPENAI_API_KEY || process.env.LLM_API_KEY);
  }
}

// src/server/llm-config.ts
// Phase G — LLM provider/model configuration (docs/EXTENDING_ANALYSTS.md §8).
//
// Three preconfigured model ROLES ship empty-token:
//   deep-thought | scanner | flexible
// Each maps to a provider + baseUrl + model + token (token empty by default →
// runAnalystLLM hits the deterministic fallback, so the pipeline behaves
// exactly as before until a token is supplied).
//
// LLM auth is kept on a SEPARATE channel from data-source auth (no accidental
// leakage of a market-data key into an LLM call, or vice-versa). GET never
// echoes a raw token — it returns hasToken only.

import path from 'path';
import { TokenVault, createVault, resolveVaultUserId } from './llm-vault';
// Non-secret LLM selection persists to a JSON file (llm-json-store.ts) instead
// of better-sqlite3: the native module has been flaky in this environment and
// crashes the server at startup (ERR_DLOPEN_FAILED). SqliteLlmStore remains
// available for tests via the inMemorySqlite helper, but it is imported LAZILY
// below so its top-level `import 'better-sqlite3'` never loads at server boot.
import { JsonLlmStore } from './llm-json-store';

export type LlmRole = 'deep-thought' | 'scanner' | 'flexible';
export type LlmProvider = 'openrouter' | 'openai' | 'anthropic' | 'azure' | 'ollama';

export const LLM_ROLES: LlmRole[] = ['deep-thought', 'scanner', 'flexible'];

/** Per-provider default base URLs (§12.7). */
export const PROVIDER_BASE_URLS: Record<LlmProvider, string> = {
  openrouter: 'https://openrouter.ai/api/v1',
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  azure: 'https://your-resource.openai.azure.com/openai',
  ollama: 'http://localhost:11434/v1',
};

export const LLM_ROLE_LABELS: Record<LlmRole, string> = {
  'deep-thought': 'Deep Thought',
  'scanner': 'Scanner',
  'flexible': 'Flexible',
};

export interface LlmModelConfig {
  role: LlmRole;
  provider: LlmProvider;
  baseUrl: string;
  model: string;
  /** Never echoed by GET; only hasToken is returned. */
  token: string;
}

export interface LlmModelConfigPublic {
  role: LlmRole;
  provider: LlmProvider;
  baseUrl: string;
  model: string;
  hasToken: boolean;
}

export interface LlmConfigStatus {
  [role: string]: { provider: LlmProvider; model: string; configured: boolean };
}

export interface LlmConfigState {
  configs: LlmModelConfig[];
  /** §12.4.1 per-agency role override keyed by `${sessionId}:${agencyId}`. */
  agencyModelRole: Record<string, LlmRole | null>;
}

/** The seeded default set (empty tokens) — §12.4. */
export function defaultLlmConfigs(): LlmModelConfig[] {
  return [
    {
      role: 'deep-thought',
      provider: 'openrouter',
      baseUrl: PROVIDER_BASE_URLS.openrouter,
      model: 'anthropic/claude-opus-4-8',
      token: '',
    },
    {
      role: 'scanner',
      provider: 'openrouter',
      baseUrl: PROVIDER_BASE_URLS.openrouter,
      model: 'anthropic/claude-opus-4-8',
      token: '',
    },
    {
      role: 'flexible',
      provider: 'openrouter',
      baseUrl: PROVIDER_BASE_URLS.openrouter,
      model: 'anthropic/claude-opus-4-8',
      token: '',
    },
  ];
}

export class LlmConfigStore {
  private configs: LlmModelConfig[];
  private agencyModelRole = new Map<string, LlmRole | null>();
  private vault: TokenVault;
  // Selection store. Production uses JsonLlmStore (plain fs, no native module);
  // tests inject an in-memory SqliteLlmStore via the `sqlite` constructor arg.
  private sqlite: import('./llm-sqlite').SqliteLlmStore | JsonLlmStore;
  private userId: string;

  constructor(
    seed: LlmModelConfig[] = defaultLlmConfigs(),
    vault?: TokenVault,
    // Lazy type-only reference to avoid importing the native module at boot.
    sqlite?: import('./llm-sqlite').SqliteLlmStore | JsonLlmStore,
    userId?: string,
  ) {
    this.configs = seed.map((c) => ({ ...c }));
    this.vault = vault ?? new TokenVault(this.defaultPath(), 'default', null);
    this.userId = userId || resolveVaultUserId();
    // Default to the JSON-backed store so the server boots even where the
    // better-sqlite3 native build is ABI-incompatible (ERR_DLOPEN_FAILED).
    this.sqlite = sqlite ?? new JsonLlmStore(undefined, this.userId);
    // Hydrate the non-secret SELECTION (provider/baseUrl/model) per role from
    // the plaintext, per-user SQLite store — this is what survives restart and
    // is NOT kept in the GPG vault (which holds secrets/tokens only).
    for (const c of this.configs) {
      const saved = this.sqlite.getRoleConfig(this.userId, c.role);
      if (saved) {
        c.provider = saved.provider;
        c.baseUrl = saved.baseUrl;
        c.model = saved.model;
      }
    }
    // Hydrate secrets (tokens) from the encrypted vault (if enabled + present).
    for (const c of this.configs) {
      const saved = this.vault.getLlm(c.role);
      if (saved && saved.token) c.token = saved.token;
    }
    // Hydrate per-agency role overrides from SQLite (per user).
    for (const [key, role] of Object.entries(this.sqlite.getAllAgencyRoles(this.userId))) {
      this.agencyModelRole.set(key, role);
    }
  }

  private defaultPath(): string {
    return process.env.LLM_VAULT_PATH ||
      require('path').join(process.cwd(), '.vault', 'llm-tokens.gpg');
  }

  /** All three roles seed correctly (deep-thought/scanner/flexible, openrouter, claude-opus-4-8, empty token). */
  static seeded(vault?: TokenVault, sqlite?: import('./llm-sqlite').SqliteLlmStore, userId?: string): LlmConfigStore {
    return new LlmConfigStore(defaultLlmConfigs(), vault, sqlite, userId);
  }

  /** Replace a role's config (validated by the route layer). Persist the
   *  non-secret selection to plaintext per-user SQLite; token stays in vault. */
  put(config: LlmModelConfig): void {
    const idx = this.configs.findIndex((c) => c.role === config.role);
    if (idx === -1) {
      this.configs.push({ ...config });
    } else {
      this.configs[idx] = { ...config };
    }
    // Selection (provider/baseUrl/model) → plaintext SQLite, survives restart,
    // per user, NOT in the GPG vault. Token → vault (secrets only).
    this.sqlite.upsertRoleConfig(this.userId, {
      role: config.role,
      provider: config.provider,
      baseUrl: config.baseUrl,
      model: config.model,
    });
    this.vault.setLlm(config.role, { ...config });
    this.vault.save();
  }

  /** Read a role's full config (server-side only — includes token). */
  get(role: LlmRole): LlmModelConfig {
    const found = this.configs.find((c) => c.role === role);
    if (!found) throw new Error(`Unknown LLM role: ${role}`);
    return { ...found };
  }

  /** Read all roles as public (token → hasToken). */
  list(): LlmModelConfigPublic[] {
    return this.configs.map((c) => ({
      role: c.role,
      provider: c.provider,
      baseUrl: c.baseUrl,
      model: c.model,
      hasToken: Boolean(c.token),
    }));
  }

  /** §12.2 status snapshot for the UI. */
  status(): LlmConfigStatus {
    const out: LlmConfigStatus = {};
    for (const c of this.configs) {
      out[c.role] = {
        provider: c.provider,
        model: c.model,
        configured: Boolean(c.token),
      };
    }
    return out;
  }

  // ---- §12.4.1 per-agency model assignment ----

  setAgencyModelRole(sessionId: string, agencyId: string, role: LlmRole | null): void {
    const key = `${sessionId}:${agencyId}`;
    this.agencyModelRole.set(key, role);
    // Persist the override to the plaintext per-user SQLite store (with vault
    // kept as a secondary copy for backward-compat; token secrets are unaffected).
    this.sqlite.setAgencyRole(this.userId, sessionId, agencyId, role);
    this.vault.setAgency(sessionId, agencyId, role);
    this.vault.save();
  }

  getAgencyModelRole(sessionId: string, agencyId: string): LlmRole | null {
    return this.agencyModelRole.get(`${sessionId}:${agencyId}`) ?? null;
  }

  reset(): void {
    this.configs = defaultLlmConfigs();
    this.agencyModelRole.clear();
    // Clear persisted tokens (vault) and selection (sqlite) too (best-effort).
    try {
      this.sqlite.clearUser(this.userId);
    } catch {
      /* sqlite disabled — nothing to clear */
    }
    try {
      this.vault.clearUser();
      this.vault.save();
    } catch {
      /* vault disabled — nothing to clear */
    }
  }
}

// A single shared store instance for the running server. The non-secret model
// selection persists to plaintext per-user JSON (.data/llm-config.json) so it
// survives restart and scales to many users WITHOUT depending on better-sqlite3
// (which has been flaky in this environment and crashed startup). Tokens
// persist to an encrypted vault (gpg/AES) when LLM_VAULT_PASSPHRASE is
// configured, else in-memory.
const sharedVault = createVault();
const sharedJson = new JsonLlmStore();
export const llmConfigStore = new LlmConfigStore(defaultLlmConfigs(), sharedVault, sharedJson);

/** Vault health for diagnostics/UI: cipher kind + whether the on-disk vault
 *  could be read at boot (null = ok, string = the decrypt error). */
export function vaultHealth(): { kind: string; unreadable: string | null } {
  return { kind: sharedVault.cipherKind, unreadable: sharedVault.vaultUnreadable };
}

/**
 * §12.4 resolution order: flavor.modelRole → agencyModelRole → agencyDef
 * default → global 'deep-thought'.
 */
export function resolveModelRole(
  flavorRole: LlmRole | undefined,
  agencyRole: LlmRole | null | undefined,
  agencyDefRole: LlmRole | undefined,
): LlmRole {
  if (flavorRole) return flavorRole;
  if (agencyRole) return agencyRole;
  if (agencyDefRole) return agencyDefRole;
  return 'deep-thought';
}

/**
 * Resolve a role to a concrete provider/baseUrl/model/token (server-side).
 * Used by runAnalystLLM; a missing/empty token signals the deterministic
 * fallback.
 */
export function resolveLlmConfig(
  store: LlmConfigStore,
  role: LlmRole,
): LlmModelConfig {
  return store.get(role);
}

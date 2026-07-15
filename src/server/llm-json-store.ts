// src/server/llm-json-store.ts
// Drop-in replacement for llm-sqlite.ts that persists the non-secret LLM
// *selection* (provider / baseUrl / model per role) and the per-agency role
// override as plain JSON instead of better-sqlite3.
//
// WHY: the model-name selection must survive restart, and it previously lived
// in better-sqlite3. That native module has repeatedly failed to load in this
// environment (NODE_MODULE_VERSION ABI mismatch -> ERR_DLOPEN_FAILED), which
// both crashed the server at startup and prevented the model name from
// persisting. Plain fs + JSON has no native dependency, so it is robust and
// removes the crash vector. The GPG/AES vault (llm-vault.ts) still owns the
// secrets (tokens); this file stores ONLY non-secret selections.
//
// SCHEMA (on disk):
//   { "roles": { "<userId>": { "<role>": { provider, baseUrl, model } } },
//     "agencyRoles": { "<userId>": { "<sessionId>:<agencyId>": role|null } } }
//
// Mirrors SqliteLlmStore's public surface so LlmConfigStore can swap with a
// one-line change.

import fs from 'fs';
import path from 'path';
import type { LlmRole, LlmProvider } from './llm-config';

export interface RoleConfigRow {
  role: LlmRole;
  provider: LlmProvider;
  baseUrl: string;
  model: string;
}

interface DiskShape {
  roles: Record<string, Record<string, RoleConfigRow>>;
  agencyRoles: Record<string, Record<string, LlmRole | null>>;
}

const DEFAULT_DB_PATH = (): string =>
  process.env.LLM_JSON_PATH ||
  path.join(process.cwd(), '.data', 'llm-config.json');

export class JsonLlmStore {
  private data: DiskShape = { roles: {}, agencyRoles: {} };
  private readonly dbPath: string;
  private loaded = false;
  readonly userId: string;

  constructor(dbPath?: string, userId?: string) {
    this.dbPath = dbPath || DEFAULT_DB_PATH();
    this.userId = userId || 'default';
  }

  private ensure(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      if (fs.existsSync(this.dbPath)) {
        const parsed = JSON.parse(fs.readFileSync(this.dbPath, 'utf8')) as Partial<DiskShape>;
        this.data = {
          roles: parsed.roles ?? {},
          agencyRoles: parsed.agencyRoles ?? {},
        };
      }
    } catch {
      // Corrupt/unreadable file is non-fatal; start from empty.
      this.data = { roles: {}, agencyRoles: {} };
    }
    if (!this.data.roles) this.data.roles = {};
    if (!this.data.agencyRoles) this.data.agencyRoles = {};
  }

  private flush(): void {
    try {
      const dir = path.dirname(this.dbPath);
      if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.dbPath, JSON.stringify(this.data, null, 2), 'utf8');
    } catch {
      // Best-effort persistence; never break the request path on disk errors.
    }
  }

  // ---- role selection (provider / baseUrl / model) ----

  getRoleConfig(userId: string, role: LlmRole): RoleConfigRow | null {
    this.ensure();
    return this.data.roles[userId]?.[role] ?? null;
  }

  getAllRoleConfigs(userId: string): RoleConfigRow[] {
    this.ensure();
    return Object.values(this.data.roles[userId] ?? {});
  }

  upsertRoleConfig(
    userId: string,
    cfg: { role: LlmRole; provider: LlmProvider; baseUrl: string; model: string },
  ): void {
    this.ensure();
    if (!this.data.roles[userId]) this.data.roles[userId] = {};
    this.data.roles[userId]![cfg.role] = {
      role: cfg.role,
      provider: cfg.provider,
      baseUrl: cfg.baseUrl,
      model: cfg.model,
    };
    this.flush();
  }

  // ---- per-agency role override ----

  getAgencyRole(userId: string, sessionId: string, agencyId: string): LlmRole | null {
    this.ensure();
    return this.data.agencyRoles[userId]?.[`${sessionId}:${agencyId}`] ?? null;
  }

  getAllAgencyRoles(userId: string): Record<string, LlmRole | null> {
    this.ensure();
    return { ...(this.data.agencyRoles[userId] ?? {}) };
  }

  setAgencyRole(
    userId: string,
    sessionId: string,
    agencyId: string,
    role: LlmRole | null,
  ): void {
    this.ensure();
    if (!this.data.agencyRoles[userId]) this.data.agencyRoles[userId] = {};
    this.data.agencyRoles[userId]![`${sessionId}:${agencyId}`] = role;
    this.flush();
  }

  /** Remove all selection rows for a user (used by store.reset()). */
  clearUser(userId: string): void {
    this.ensure();
    delete this.data.roles[userId];
    delete this.data.agencyRoles[userId];
    this.flush();
  }

  close(): void {
    // No-op: JSON is flushed on every mutation.
  }
}

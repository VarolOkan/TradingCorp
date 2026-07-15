// src/server/llm-sqlite.ts
// Phase G (persistence split) — plaintext, PER-USER LLM *selection* store.
//
// WHY THIS EXISTS (explicit user requirement):
//   The GPG/AES vault (llm-vault.ts) is reserved for SECRETS ONLY — the LLM
//   tokens. A user's non-secret model selection (provider / baseUrl / model
//   for each of the 3 roles) and the per-agency "which role powers this
//   agency" override must persist across restarts but MUST NOT live in the
//   encrypted file. We store that selection here, in SQLite, keyed per user
//   so the design scales to hundreds of users.
//
// SCHEMA:
//   llm_role_config(user_id, role, provider, base_url, model, updated_at) PK(user_id, role)
//   llm_agency_role(user_id, session_id, agency_id, role, updated_at) PK(user_id, session_id, agency_id)
//
// NO secrets are ever written to this database. Tokens remain in llm-vault.ts.

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import type { LlmRole, LlmProvider } from './llm-config';
import { resolveVaultUserId } from './llm-vault';

export interface RoleConfigRow {
  role: LlmRole;
  provider: LlmProvider;
  baseUrl: string;
  model: string;
}

const DEFAULT_DB_PATH = (): string =>
  process.env.LLM_SQLITE_PATH ||
  path.join(process.cwd(), '.data', 'llm-config.db');

export class SqliteLlmStore {
  private db: Database.Database | null = null;
  private readonly dbPath: string;
  readonly userId: string;

  constructor(dbPath?: string, userId?: string) {
    this.dbPath = dbPath || DEFAULT_DB_PATH();
    this.userId = userId || resolveVaultUserId();
  }

  /**
   * Open + create schema on first use (lazy, so merely importing the module
   * never touches disk in unit tests that don't exercise the shared store).
   */
  private ensure(): Database.Database {
    if (this.db) return this.db;
    const dir = path.dirname(this.dbPath);
    if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const db = new Database(this.dbPath);
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS llm_role_config (
        user_id    TEXT NOT NULL,
        role       TEXT NOT NULL,
        provider   TEXT NOT NULL,
        base_url   TEXT NOT NULL,
        model      TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (user_id, role)
      );
      CREATE TABLE IF NOT EXISTS llm_agency_role (
        user_id    TEXT NOT NULL,
        session_id TEXT NOT NULL,
        agency_id  TEXT NOT NULL,
        role       TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (user_id, session_id, agency_id)
      );
    `);
    this.db = db;
    return db;
  }

  // ---- role selection (provider / baseUrl / model) ----

  getRoleConfig(userId: string, role: LlmRole): RoleConfigRow | null {
    const row = this.ensure()
      .prepare(
        `SELECT role, provider, base_url AS baseUrl, model
           FROM llm_role_config WHERE user_id = ? AND role = ?`,
      )
      .get(userId, role) as RoleConfigRow | undefined;
    return row ?? null;
  }

  getAllRoleConfigs(userId: string): RoleConfigRow[] {
    return this.ensure()
      .prepare(
        `SELECT role, provider, base_url AS baseUrl, model
           FROM llm_role_config WHERE user_id = ?`,
      )
      .all(userId) as RoleConfigRow[];
  }

  upsertRoleConfig(
    userId: string,
    cfg: { role: LlmRole; provider: LlmProvider; baseUrl: string; model: string },
  ): void {
    this.ensure()
      .prepare(
        `INSERT INTO llm_role_config (user_id, role, provider, base_url, model, updated_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(user_id, role) DO UPDATE SET
           provider    = excluded.provider,
           base_url    = excluded.base_url,
           model       = excluded.model,
           updated_at  = datetime('now')`,
      )
      .run(userId, cfg.role, cfg.provider, cfg.baseUrl, cfg.model);
  }

  // ---- per-agency role override ----

  getAgencyRole(userId: string, sessionId: string, agencyId: string): LlmRole | null {
    const row = this.ensure()
      .prepare(
        `SELECT role FROM llm_agency_role WHERE user_id = ? AND session_id = ? AND agency_id = ?`,
      )
      .get(userId, sessionId, agencyId) as { role: LlmRole | null } | undefined;
    return (row?.role ?? null) as LlmRole | null;
  }

  getAllAgencyRoles(userId: string): Record<string, LlmRole | null> {
    const rows = this.ensure()
      .prepare(`SELECT session_id, agency_id, role FROM llm_agency_role WHERE user_id = ?`)
      .all(userId) as Array<{ session_id: string; agency_id: string; role: LlmRole | null }>;
    const out: Record<string, LlmRole | null> = {};
    for (const r of rows) out[`${r.session_id}:${r.agency_id}`] = r.role ?? null;
    return out;
  }

  setAgencyRole(
    userId: string,
    sessionId: string,
    agencyId: string,
    role: LlmRole | null,
  ): void {
    this.ensure()
      .prepare(
        `INSERT INTO llm_agency_role (user_id, session_id, agency_id, role, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT(user_id, session_id, agency_id) DO UPDATE SET
           role       = excluded.role,
           updated_at = datetime('now')`,
      )
      .run(userId, sessionId, agencyId, role);
  }

  /** Remove all selection rows for a user (used by store.reset()). */
  clearUser(userId: string): void {
    const db = this.ensure();
    db.prepare(`DELETE FROM llm_role_config WHERE user_id = ?`).run(userId);
    db.prepare(`DELETE FROM llm_agency_role WHERE user_id = ?`).run(userId);
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

/** Build the shared per-user SQLite store from env (defaults under .data/). */
export function createSqliteStore(): SqliteLlmStore {
  return new SqliteLlmStore();
}

/**
 * TEST/FACTORY HELPER — build an isolated, in-memory SQLite store for a given
 * user. Keeps unit tests hermetic (no .data/llm-config.db file, no cross-test
 * leakage) while exercising the exact same SQL as production.
 */
export function inMemorySqlite(userId = 'default'): SqliteLlmStore {
  return new SqliteLlmStore(':memory:', userId);
}

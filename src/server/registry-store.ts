// src/server/registry-store.ts
// Phase 1 (per-user persistence) — DUAL DRIVER store for agency re-org +
// agency CRUD. One of two backends is selected at runtime via the env var
// REGISTRY_STORE_DRIVER:
//
//   REGISTRY_STORE_DRIVER=json    -> RegistryJsonStore   [DEFAULT]
//                                 (per-user JSON file .data/registry-<userId>.json,
//                                  ZERO native deps — runs anywhere, incl. the
//                                  sandbox where better-sqlite3 ABI-crashes)
//   REGISTRY_STORE_DRIVER=sqlite  -> RegistrySqliteStore
//                                 (per-user sqlite table registry_overrides,
//                                  the user's preferred backend; needs a working
//                                  better-sqlite3 native build)
//   (unset -> defaults to 'json' so a better-sqlite3 ABI rebuild can never
//    silently flip persistence to a different backend and drop user config)
//
// Both backends implement the SAME RegistryStore interface and persist these
// four override kinds per user:
//   agency_membership : AgencyAnalystRef[]        (ordered analysts in a flow)
//   feed_into         : string[]                  (consumers of an analyst)
//   agency_def        : AgencyDef                 (user-created agency)
//   custom_analyst    : AnalystDef                (Phase 2: e.g. contrarian)
//
// applyOverridesToRegistry() merges a user's overrides over the compiled
// AGENCIES / ANALYST_DEFS live objects the graph reads per request — so a
// re-org is reflected on the next run with no restart.

import fs from 'fs';
import path from 'path';
import { dataDir, dataFilePath } from './dataDir';
import type { AgencyDef, AgencyAnalystRef, AnalystDef } from '../types/registry';

export type OverrideKind =
  | 'agency_membership'
  | 'agency_def'
  | 'custom_analyst'
  | 'feed_into';

/** The four override buckets held by every driver. */
export interface RegistryBlob {
  agency_membership: Record<string, AgencyAnalystRef[]>;
  agency_def: Record<string, AgencyDef>;
  custom_analyst: Record<string, AnalystDef>;
  feed_into: Record<string, string[]>;
}

export function emptyBlob(): RegistryBlob {
  return {
    agency_membership: {},
    agency_def: {},
    custom_analyst: {},
    feed_into: {},
  };
}

/**
 * Backend-agnostic contract. Every method takes an explicit `userId` so a
 * single store instance can serve multiple users (and tests can target a
 * specific user without constructing a fresh store).
 */
export interface RegistryStore {
  readonly driver: 'json' | 'sqlite';
  setAgencyMembership(userId: string, agencyId: string, analysts: AgencyAnalystRef[]): void;
  getAgencyMembership(userId: string, agencyId: string): AgencyAnalystRef[] | null;
  setFeedInto(userId: string, analystId: string, consumers: string[]): void;
  getFeedInto(userId: string, analystId: string): string[] | null;
  setAgencyDef(userId: string, def: AgencyDef): void;
  getAgencyDef(userId: string, agencyId: string): AgencyDef | null;
  deleteAgencyDef(userId: string, agencyId: string): void;
  setCustomAnalyst(userId: string, def: AnalystDef): void;
  getCustomAnalyst(userId: string, analystId: string): AnalystDef | null;
  deleteCustomAnalyst(userId: string, analystId: string): void;
  listAgencyMemberships(userId: string): Record<string, AgencyAnalystRef[]>;
  listAgencyDefs(userId: string): Record<string, AgencyDef>;
  listCustomAnalysts(userId: string): Record<string, AnalystDef>;
  listFeedInto(userId: string): Record<string, string[]>;
  /** Every userId that currently has at least one persisted override. */
  listUsers(): string[];
  clearUser(userId: string): void;
  close(): void;
}

// ----------------------------------------------------------------------------
// JSON driver — per-user file under .data/registry-<userId>.json
// ----------------------------------------------------------------------------

const DEFAULT_JSON_DIR = (): string =>
  process.env.REGISTRY_STORE_DIR || dataDir();

export class RegistryJsonStore implements RegistryStore {
  readonly driver = 'json' as const;
  private readonly dir: string;

  constructor(dir?: string) {
    this.dir = dir || DEFAULT_JSON_DIR();
  }

  private fileFor(userId: string): string {
    const safe = userId.replace(/[^A-Za-z0-9_.-]/g, '_');
    return path.join(this.dir, `registry-${safe}.json`);
  }

  private load(userId: string): RegistryBlob {
    const f = this.fileFor(userId);
    if (!fs.existsSync(f)) return emptyBlob();
    try {
      const parsed = JSON.parse(fs.readFileSync(f, 'utf8')) as Partial<RegistryBlob> & { userId?: string };
      // Drop the persisted `userId` side-field (it is not part of the blob type).
      const { userId: _omit, ...blob } = parsed;
      return { ...emptyBlob(), ...blob };
    } catch {
      return emptyBlob();
    }
  }

  private save(userId: string, blob: RegistryBlob): void {
    if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
    // Persist userId alongside the blob so listUsers() can enumerate exactly
    // (the filename encoding is lossy and cannot be reversed reliably).
    fs.writeFileSync(this.fileFor(userId), JSON.stringify({ ...blob, userId }, null, 2));
  }

  private mutate(userId: string, kind: OverrideKind, fn: (b: RegistryBlob) => void): void {
    const blob = this.load(userId);
    fn(blob);
    this.save(userId, blob);
  }

  setAgencyMembership(userId: string, agencyId: string, analysts: AgencyAnalystRef[]): void {
    this.mutate(userId, 'agency_membership', (b) => { b.agency_membership[agencyId] = analysts; });
  }
  getAgencyMembership(userId: string, agencyId: string): AgencyAnalystRef[] | null {
    return this.load(userId).agency_membership[agencyId] ?? null;
  }
  setFeedInto(userId: string, analystId: string, consumers: string[]): void {
    this.mutate(userId, 'feed_into', (b) => { b.feed_into[analystId] = consumers; });
  }
  getFeedInto(userId: string, analystId: string): string[] | null {
    return this.load(userId).feed_into[analystId] ?? null;
  }
  setAgencyDef(userId: string, def: AgencyDef): void {
    this.mutate(userId, 'agency_def', (b) => { b.agency_def[def.id] = def; });
  }
  getAgencyDef(userId: string, agencyId: string): AgencyDef | null {
    return this.load(userId).agency_def[agencyId] ?? null;
  }
  deleteAgencyDef(userId: string, agencyId: string): void {
    this.mutate(userId, 'agency_def', (b) => { delete b.agency_def[agencyId]; });
  }
  setCustomAnalyst(userId: string, def: AnalystDef): void {
    this.mutate(userId, 'custom_analyst', (b) => { b.custom_analyst[def.id] = def; });
  }
  getCustomAnalyst(userId: string, analystId: string): AnalystDef | null {
    return this.load(userId).custom_analyst[analystId] ?? null;
  }
  deleteCustomAnalyst(userId: string, analystId: string): void {
    this.mutate(userId, 'custom_analyst', (b) => { delete b.custom_analyst[analystId]; });
  }
  listAgencyMemberships(userId: string): Record<string, AgencyAnalystRef[]> {
    return this.load(userId).agency_membership;
  }
  listAgencyDefs(userId: string): Record<string, AgencyDef> {
    return this.load(userId).agency_def;
  }
  listCustomAnalysts(userId: string): Record<string, AnalystDef> {
    return this.load(userId).custom_analyst;
  }
  listFeedInto(userId: string): Record<string, string[]> {
    return this.load(userId).feed_into;
  }
  listUsers(): string[] {
    if (!fs.existsSync(this.dir)) return [];
    const out = new Set<string>();
    for (const file of fs.readdirSync(this.dir)) {
      const m = /^registry-(.+)\.json$/.exec(file);
      if (!m) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(this.dir, file), 'utf8')) as { userId?: string };
        if (parsed.userId) out.add(parsed.userId);
      } catch {
        /* skip unreadable files */
      }
    }
    return [...out];
  }
  clearUser(userId: string): void {
    const f = this.fileFor(userId);
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  close(): void {
    /* no-op for the file driver */
  }
}

// ----------------------------------------------------------------------------
// SQLite driver — per-user rows in registry_overrides(user_id, kind, key, json)
// better-sqlite3 is REQUIRED lazily so importing this module (or using the JSON
// driver) never loads the native module (which ABI-crashes in some envs).
// ----------------------------------------------------------------------------

import type BetterSqlite3 from 'better-sqlite3';

export class RegistrySqliteStore implements RegistryStore {
  readonly driver = 'sqlite' as const;
  private db: BetterSqlite3.Database | null = null;
  private readonly dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath = dbPath || process.env.REGISTRY_SQLITE_PATH ||
      dataFilePath('registry.db');
  }

  private ensure(): BetterSqlite3.Database {
    if (this.db) return this.db;
    // Lazy require — only invoked when the SQLite driver is actually used.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Database = require('better-sqlite3') as typeof BetterSqlite3;
    const dir = path.dirname(this.dbPath);
    if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const db = new Database(this.dbPath);
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS registry_overrides (
        user_id    TEXT NOT NULL,
        kind       TEXT NOT NULL,
        key        TEXT NOT NULL,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (user_id, kind, key)
      );
    `);
    this.db = db;
    return db;
  }

  private get(userId: string, kind: OverrideKind, key: string): any | null {
    const row = this.ensure()
      .prepare(`SELECT value_json FROM registry_overrides WHERE user_id = ? AND kind = ? AND key = ?`)
      .get(userId, kind, key) as { value_json: string } | undefined;
    return row ? JSON.parse(row.value_json) : null;
  }
  private getAll(userId: string, kind: OverrideKind): Record<string, any> {
    const rows = this.ensure()
      .prepare(`SELECT key, value_json FROM registry_overrides WHERE user_id = ? AND kind = ?`)
      .all(userId, kind) as Array<{ key: string; value_json: string }>;
    const out: Record<string, any> = {};
    for (const r of rows) out[r.key] = JSON.parse(r.value_json);
    return out;
  }
  private put(userId: string, kind: OverrideKind, key: string, value: unknown): void {
    this.ensure()
      .prepare(
        `INSERT INTO registry_overrides (user_id, kind, key, value_json, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT(user_id, kind, key) DO UPDATE SET
           value_json = excluded.value_json, updated_at = datetime('now')`,
      )
      .run(userId, kind, key, JSON.stringify(value));
  }
  private del(userId: string, kind: OverrideKind, key: string): void {
    this.ensure()
      .prepare(`DELETE FROM registry_overrides WHERE user_id = ? AND kind = ? AND key = ?`)
      .run(userId, kind, key);
  }

  setAgencyMembership(userId: string, agencyId: string, analysts: AgencyAnalystRef[]): void {
    this.put(userId, 'agency_membership', agencyId, analysts);
  }
  getAgencyMembership(userId: string, agencyId: string): AgencyAnalystRef[] | null {
    return this.get(userId, 'agency_membership', agencyId);
  }
  setFeedInto(userId: string, analystId: string, consumers: string[]): void {
    this.put(userId, 'feed_into', analystId, consumers);
  }
  getFeedInto(userId: string, analystId: string): string[] | null {
    return this.get(userId, 'feed_into', analystId);
  }
  setAgencyDef(userId: string, def: AgencyDef): void {
    this.put(userId, 'agency_def', def.id, def);
  }
  getAgencyDef(userId: string, agencyId: string): AgencyDef | null {
    return this.get(userId, 'agency_def', agencyId);
  }
  deleteAgencyDef(userId: string, agencyId: string): void {
    this.del(userId, 'agency_def', agencyId);
  }
  setCustomAnalyst(userId: string, def: AnalystDef): void {
    this.put(userId, 'custom_analyst', def.id, def);
  }
  getCustomAnalyst(userId: string, analystId: string): AnalystDef | null {
    return this.get(userId, 'custom_analyst', analystId);
  }
  deleteCustomAnalyst(userId: string, analystId: string): void {
    this.del(userId, 'custom_analyst', analystId);
  }
  listAgencyMemberships(userId: string): Record<string, AgencyAnalystRef[]> {
    return this.getAll(userId, 'agency_membership');
  }
  listAgencyDefs(userId: string): Record<string, AgencyDef> {
    return this.getAll(userId, 'agency_def');
  }
  listCustomAnalysts(userId: string): Record<string, AnalystDef> {
    return this.getAll(userId, 'custom_analyst');
  }
  listFeedInto(userId: string): Record<string, string[]> {
    return this.getAll(userId, 'feed_into');
  }
  listUsers(): string[] {
    const rows = this.ensure()
      .prepare(`SELECT DISTINCT user_id FROM registry_overrides`)
      .all() as Array<{ user_id: string }>;
    return rows.map((r) => r.user_id);
  }
  clearUser(userId: string): void {
    this.ensure().prepare(`DELETE FROM registry_overrides WHERE user_id = ?`).run(userId);
  }
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

// ----------------------------------------------------------------------------
// Factory — env-selected driver
// ----------------------------------------------------------------------------

export type RegistryDriverName = 'json' | 'sqlite';

export function resolveDriverName(): RegistryDriverName {
  // Default to the zero-native-dependency JSON store so a better-sqlite3 ABI
  // rebuild (e.g. via `npm run build`) can NEVER silently flip persistence to a
  // different backend and drop user config. Opt into SQLite with
  // REGISTRY_STORE_DRIVER=sqlite (requires a working native build).
  const v = (process.env.REGISTRY_STORE_DRIVER || 'json').toLowerCase().trim();
  return v === 'sqlite' ? 'sqlite' : 'json';
}

/**
 * Build the configured store (env-driven).
 *
 * If the resolved driver is `sqlite` we still PROBE it before committing:
 * constructing a RegistrySqliteStore is lazy, but the first real operation
 * (`ensure()` inside `listUsers()`) loads the better-sqlite3 native binding,
 * which ABI-crashes (ERR_DLOPEN_FAILED) on Node versions where the prebuilt
 * binary was compiled for a different ABI. When that happens we DEGRADE
 * gracefully to the zero-dependency JSON store instead of crashing the server
 * at boot — persistence still works, just written as per-user JSON files.
 *
 * Opt out of the fallback with REGISTRY_STORE_DRIVER=sqlite and accept the
 * crash (e.g. to be forced into `npm rebuild better-sqlite3`).
 */
export function createRegistryStore(): RegistryStore {
  if (resolveDriverName() === 'json') return new RegistryJsonStore();
  try {
    const sqlite = new RegistrySqliteStore();
    sqlite.listUsers(); // forces ensure() -> loads the native binding
    return sqlite;
  } catch (err) {
    console.error(
      '[registry] better-sqlite3 unavailable at boot (likely ABI mismatch) — ' +
      'falling back to JSON store (.data/registry-*.json). ' +
      'Run `npm rebuild better-sqlite3` to restore SQLite persistence.',
      (err as Error)?.message ?? err,
    );
    return new RegistryJsonStore();
  }
}

/** Build an isolated JSON store rooted at a temp dir (hermetic JSON-path tests). */
export function inMemoryJson(dir = ':memory:'): RegistryJsonStore {
  // dir is unused for a pure file store; tests pass a real temp dir.
  return new RegistryJsonStore(dir === ':memory:' ? undefined : dir);
}

/** Build an isolated, in-memory SQLite store (hermetic sqlite-path tests). */
export function inMemorySqlite(userIdIgnored = 'default'): RegistrySqliteStore {
  return new RegistrySqliteStore(':memory:');
}

// ----------------------------------------------------------------------------
// Live merge — overrides over the compiled registry (graph reads per request)
// ----------------------------------------------------------------------------

import { AGENCIES } from '../registry/agencies';
import { ANALYST_DEFS } from '../registry/analysts';

// Pristine compiled snapshots, captured ONCE at module load (before any
// override mutation). applyOverridesToRegistry resets to these each call so a
// runtime DELETE (which removes a store entry) actually drops the key, instead
// of lingering from a previous POST. Deep-cloned so resets are clean.
const COMPILED_AGENCIES = JSON.parse(JSON.stringify(AGENCIES)) as typeof AGENCIES;
export const COMPILED_ANALYST_DEFS = JSON.parse(JSON.stringify(ANALYST_DEFS)) as typeof ANALYST_DEFS;

export function applyOverridesToRegistry(store: RegistryStore, userId: string): void {
  // 0) Reset the in-memory registry to its compiled base so deletes/overrides
  //    never accumulate across calls.
  for (const k of Object.keys(AGENCIES)) delete AGENCIES[k];
  Object.assign(AGENCIES, COMPILED_AGENCIES);
  for (const k of Object.keys(ANALYST_DEFS)) delete ANALYST_DEFS[k];
  Object.assign(ANALYST_DEFS, COMPILED_ANALYST_DEFS);

  const custom = store.listCustomAnalysts(userId);
  for (const [id, def] of Object.entries(custom)) ANALYST_DEFS[id] = def;

  const agencyDefs = store.listAgencyDefs(userId);
  for (const [id, def] of Object.entries(agencyDefs)) AGENCIES[id] = def;

  const memberships = store.listAgencyMemberships(userId);
  for (const [agencyId, analysts] of Object.entries(memberships)) {
    if (!AGENCIES[agencyId]) continue;
    AGENCIES[agencyId] = { ...AGENCIES[agencyId]!, analysts: analysts.map((r) => ({ ...r })) };
  }

  // feed_into: ensure each consumer ref lists the producer in dependsOn.
  const feedInto = store.listFeedInto(userId);
  for (const [analystId, consumers] of Object.entries(feedInto)) {
    for (const agency of Object.values(AGENCIES)) {
      for (const ref of agency.analysts) {
        if (!consumers.includes(ref.id)) continue;
        const base = ANALYST_DEFS[ref.id];
        const deps = (ref.dependsOn ?? base?.dependsOn ?? []).slice();
        if (!deps.includes(analystId)) ref.dependsOn = [...deps, analystId];
      }
    }
  }
}

/**
 * Merge overrides for EVERY persisted user into the live registry. Used at
 * server boot (and after any write) so that data saved under a non-default
 * userId — e.g. the frontend's `sessionId` — survives a restart instead of
 * being invisible until the next save. Resets once, then layers each user's
 * overrides over the compiled base (last writer wins per agency/analyst id).
 */
export function applyAllOverridesToRegistry(store: RegistryStore): void {
  // 1) Reset to the compiled base.
  for (const k of Object.keys(AGENCIES)) delete AGENCIES[k];
  Object.assign(AGENCIES, COMPILED_AGENCIES);
  for (const k of Object.keys(ANALYST_DEFS)) delete ANALYST_DEFS[k];
  Object.assign(ANALYST_DEFS, COMPILED_ANALYST_DEFS);

  const users = store.listUsers();
  // 2) Layer each user's defs + memberships (agency/analyst id collisions:
  //    last writer wins).
  for (const userId of users) {
    for (const [id, def] of Object.entries(store.listCustomAnalysts(userId))) {
      ANALYST_DEFS[id] = def;
    }
    for (const [id, def] of Object.entries(store.listAgencyDefs(userId))) {
      AGENCIES[id] = def;
    }
    for (const [agencyId, analysts] of Object.entries(store.listAgencyMemberships(userId))) {
      if (!AGENCIES[agencyId]) continue;
      AGENCIES[agencyId] = { ...AGENCIES[agencyId]!, analysts: analysts.map((r) => ({ ...r })) };
    }
  }

  // 3) Apply feed_into last, against the fully-merged agencies.
  for (const userId of users) {
    const feedInto = store.listFeedInto(userId);
    for (const [analystId, consumers] of Object.entries(feedInto)) {
      for (const agency of Object.values(AGENCIES)) {
        for (const ref of agency.analysts) {
          if (!consumers.includes(ref.id)) continue;
          const base = ANALYST_DEFS[ref.id];
          const deps = (ref.dependsOn ?? base?.dependsOn ?? []).slice();
          if (!deps.includes(analystId)) ref.dependsOn = [...deps, analystId];
        }
      }
    }
  }
}

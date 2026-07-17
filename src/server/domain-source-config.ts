// src/server/domain-source-config.ts
// P3b — persisted per-domain source configuration (the SWAPPABLE mapping made
// user-editable). Lets an operator enable / disable / reorder the sources that
// feed each data domain from the Settings UI, with NO code change. Persisted to
// a JSON file under DATA_DIR so it survives a restart.
//
// resolveDomain() (logic/domains.ts) consults this store automatically: when a
// caller does not pass an explicit `enabledSources` override, it falls back to
// this store's per-domain list; if neither is set, the domain's compile-time
// DOMAIN_SOURCES default applies. So the UI config wins over defaults, and an
// explicit ctx override (tests) still wins over everything.
//
// Honesty guard: an empty enabled list for a domain degrades THAT domain (a
// `skipped` record from resolveDomain) instead of fabricating a live source or
// taking down the pipeline — see resolveDomain + the semantic-honesty bar.

import fs from 'fs';
import { dataFilePath } from './dataDir';
import { DOMAIN_SOURCES } from '../registry/analyst-config-schema';

const FILE = dataFilePath('domain-sources.json');

/** A domain id we know how to configure. */
export type ConfigurableDomain =
  | 'price_bars'
  | 'option_chain'
  | 'news_sentiment'
  | 'fundamentals'
  | 'risk_free_rate'
  | 'market_meta';

/** Map of domain -> ordered enabled source ids. */
export type DomainSourceMap = Partial<Record<ConfigurableDomain, string[]>>;

export class DomainSourceConfigStore {
  private map: DomainSourceMap = {};

  constructor(private file: string = FILE) {
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as DomainSourceMap;
        this.map = raw && typeof raw === 'object' ? raw : {};
      }
    } catch {
      // Corrupt / unreadable -> start from defaults (empty map = use DOMAIN_SOURCES).
      this.map = {};
    }
  }

  private save(): void {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.map, null, 2), 'utf8');
    } catch {
      // Persistence is best-effort; the in-memory map still drives the run.
    }
  }

  /**
   * Effective enabled source list for a domain. Resolution order:
   *   1. an explicit entry in this store (set via the UI)
   *   2. the compile-time DOMAIN_SOURCES default
   * Returns the ordered ids; an empty array means "all disabled" (domain
   * degrades). `undefined` is never returned — callers get a concrete list.
   */
  get(domain: ConfigurableDomain): string[] {
    const explicit = this.map[domain];
    if (explicit !== undefined) return explicit.slice();
    const def = (DOMAIN_SOURCES as Record<string, string[]>)[domain];
    return def ? def.slice() : [];
  }

  /** True when the UI has overridden this domain (vs the compile-time default). */
  isOverridden(domain: ConfigurableDomain): boolean {
    return this.map[domain] !== undefined;
  }

  /** Persist the enabled list for one domain. Empty array = all disabled. */
  set(domain: ConfigurableDomain, sources: string[]): void {
    this.map[domain] = sources.slice();
    this.save();
  }

  /** Remove the UI override; the domain reverts to its compile-time default. */
  clear(domain: ConfigurableDomain): void {
    delete this.map[domain];
    this.save();
  }

  /** Whole map (for GET /domain-sources). */
  all(): DomainSourceMap {
    return { ...this.map };
  }

  /** Reset to all-defaults. */
  reset(): void {
    this.map = {};
    this.save();
  }
}

export const domainSourceConfigStore = new DomainSourceConfigStore();

// src/server/connection-config.ts
// Runtime connection configuration (Option B).
//
// The user supplies backend URI / access-token / extra knobs through the
// in-app Settings dialog. Those are POSTed to `POST /config` and stored
// in-memory per session — never persisted to disk, never logged in full, and
// never embedded in the client bundle. The analysis handler reads the active
// config when it runs.

import { ConnectionSettings } from '../../frontend/src/types';

/** A fully-resolved runtime config (always has a baseUri). */
export interface ResolvedConfig {
  baseUri: string;
  accessToken: string;
  extra: Record<string, string>;
  /** Run independent analysts concurrently after ingestion (default false). */
  parallelAnalysts: boolean;
}

const DEFAULT_BASE_URI = 'http://localhost:3001';

/**
 * Validation result for an incoming settings payload.
 */
export interface ValidationResult {
  ok: boolean;
  errors: string[];
  /** Coerced/normalized settings (only meaningful when ok === true). */
  settings?: ConnectionSettings;
}

/**
 * In-memory store of runtime connection settings.
 *
 * Keyed by an opaque session id (the Socket.IO handshake passes it, or the
 * route falls back to a single shared "default" session for REST clients).
 * This keeps secrets out of `.env` and lets the same backend serve multiple
 * frontends with different runtime config.
 */
export class ConnectionConfigStore {
  private store = new Map<string, ResolvedConfig>();

  /** Validate and normalize an incoming settings payload. */
  static validate(input: unknown): ValidationResult {
    const errors: string[] = [];

    if (typeof input !== 'object' || input === null) {
      return { ok: false, errors: ['Request body must be a JSON object'] };
    }

    const body = input as Record<string, unknown>;

    // baseUri: required, must be a non-empty http(s) URL.
    let baseUri = typeof body.baseUri === 'string' ? body.baseUri.trim() : '';
    if (!baseUri) {
      errors.push('baseUri is required');
    } else if (!/^https?:\/\/.+/i.test(baseUri)) {
      errors.push('baseUri must be an http(s) URL');
    }

    // accessToken: optional, string.
    const accessToken = typeof body.accessToken === 'string' ? body.accessToken : '';

    // extra: optional, flat string map.
    let extra: Record<string, string> = {};
    if (body.extra !== undefined && body.extra !== null) {
      if (typeof body.extra !== 'object' || Array.isArray(body.extra)) {
        errors.push('extra must be an object map of string keys to string values');
      } else {
        const extraObj = body.extra as Record<string, unknown>;
        for (const [k, v] of Object.entries(extraObj)) {
          if (typeof v !== 'string') {
            errors.push(`extra.${k} must be a string`);
          } else {
            extra[k] = v;
          }
        }
      }
    }

    // parallelAnalysts: optional boolean knob (default false).
    const parallelAnalysts = body.parallelAnalysts === true;

    if (errors.length > 0) {
      return { ok: false, errors };
    }

    return {
      ok: true,
      errors: [],
      settings: { baseUri, accessToken, extra, parallelAnalysts },
    };
  }

  /** Store config for a session. Returns the resolved config. */
  set(sessionId: string, settings: ConnectionSettings): ResolvedConfig {
    const resolved: ResolvedConfig = {
      baseUri: settings.baseUri || DEFAULT_BASE_URI,
      accessToken: settings.accessToken || '',
      extra: settings.extra || {},
      parallelAnalysts: settings.parallelAnalysts === true,
    };
    this.store.set(sessionId, resolved);
    return resolved;
  }

  /** Read config for a session, falling back to the default session. */
  get(sessionId: string): ResolvedConfig {
    const c = this.store.get(sessionId) ?? this.store.get('default') ?? this.defaultConfig();
    return { ...c, parallelAnalysts: c.parallelAnalysts === true };
  }

  /** True if a session (or the default) has explicit config set. */
  has(sessionId: string): boolean {
    return this.store.has(sessionId) || this.store.has('default');
  }

  /** Remove a session's config. */
  clear(sessionId: string): void {
    this.store.delete(sessionId);
  }

  /** Reset all stored config (primarily for tests). */
  reset(): void {
    this.store.clear();
  }

  /** The baseline config used when nothing has been set. */
  defaultConfig(): ResolvedConfig {
    return { baseUri: DEFAULT_BASE_URI, accessToken: '', extra: {}, parallelAnalysts: true };
  }
}

// A single shared store instance for the running server.
export const connectionConfigStore = new ConnectionConfigStore();

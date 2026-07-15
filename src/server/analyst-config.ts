// src/server/analyst-config.ts
// Per-analyst / per-source credential store (B1 design).
//
// The global Settings dialog (ConnectionConfigStore) holds the ONE backend
// baseUri + a shared access token. But several analysts may each reach out to
// MULTIPLE live external sources, each potentially with its OWN api key /
// bearer token (e.g. Alpha Vantage key for fundamental, Finnhub key for
// sentiment, Polygon key for technical). This store holds those per-analyst /
// per-source tokens, keyed by `${session}:${analystId}:${sourceId}`.
//
// They are:
//   - stored in-memory only (never written to disk, never in the client bundle
//     after POST),
//   - never logged verbatim,
//   - never echoed back to the client (the read API returns a boolean hasToken),
//   - resolved with a graceful fallback chain: explicit per-source token →
//     global runtimeConfig token.
//
// Mirrors the ConnectionConfigStore shape so the two stores are consistent.

/** A single source credential. */
export interface SourceCredential {
  /** API key / bearer token for THIS source on THIS analyst. Never logged. */
  token: string;
  /** Free-form extra knobs for the source (e.g. account id). */
  extra: Record<string, string>;
}

/** Composite key for a credential. */
export interface CredentialKey {
  sessionId: string;
  analystId: string;
  sourceId: string;
}

function composeKey(k: CredentialKey): string {
  return `${k.sessionId}:${k.analystId}:${k.sourceId}`;
}

/**
 * Validation result for an incoming per-analyst config payload.
 */
export interface AnalystConfigValidation {
  ok: boolean;
  errors: string[];
  value?: { token: string; extra: Record<string, string> };
}

export class AnalystConfigStore {
  private store = new Map<string, SourceCredential>();

  /** Validate + normalize an incoming source credential payload. */
  static validate(input: unknown): AnalystConfigValidation {
    const errors: string[] = [];
    if (typeof input !== 'object' || input === null) {
      return { ok: false, errors: ['Request body must be a JSON object'] };
    }
    const body = input as Record<string, unknown>;

    if (typeof body.analystId !== 'string' || !body.analystId) {
      errors.push('analystId is required');
    }
    if (typeof body.sourceId !== 'string' || !body.sourceId) {
      errors.push('sourceId is required');
    }
    const token = typeof body.token === 'string' ? body.token : '';
    // token is OPTIONAL here: a user may clear a credential by sending ''.
    let extra: Record<string, string> = {};
    if (body.extra !== undefined && body.extra !== null) {
      if (typeof body.extra !== 'object' || Array.isArray(body.extra)) {
        errors.push('extra must be an object map of string keys to string values');
      } else {
        const extraObj = body.extra as Record<string, unknown>;
        for (const [key, v] of Object.entries(extraObj)) {
          if (typeof v !== 'string') {
            errors.push(`extra.${key} must be a string`);
          } else {
            extra[key] = v;
          }
        }
      }
    }

    if (errors.length > 0) return { ok: false, errors };
    return { ok: true, errors: [], value: { token, extra } };
  }

  /** Store a credential for a (session, analyst, source) triple. */
  set(key: CredentialKey, cred: SourceCredential): void {
    this.store.set(composeKey(key), { token: cred.token, extra: cred.extra ?? {} });
  }

  /** Read a credential (or undefined if none set). */
  get(key: CredentialKey): SourceCredential | undefined {
    return this.store.get(composeKey(key));
  }

  /** True if a credential exists for the triple. */
  has(key: CredentialKey): boolean {
    return this.store.has(composeKey(key));
  }

  /** Remove one credential. */
  clear(key: CredentialKey): void {
    this.store.delete(composeKey(key));
  }

  /** Reset all stored credentials (primarily for tests). */
  reset(): void {
    this.store.clear();
  }

  /**
   * Resolve the effective token for a source: explicit per-source token wins,
   * otherwise fall back to the global runtimeConfig token, otherwise ''.
   */
  resolveToken(key: CredentialKey, fallbackToken?: string): string {
    const cred = this.store.get(composeKey(key));
    if (cred && cred.token) return cred.token;
    return fallbackToken ?? '';
  }
}

/** A single shared store instance for the running server. */
export const analystConfigStore = new AnalystConfigStore();

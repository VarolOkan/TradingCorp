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
// Persistence: every token/URI is written through the SAME encrypted GPG/AES
// vault that holds the LLM tokens (llm-vault.ts). So a saved Alpha Vantage /
// Finnhub key is encrypted-at-rest AND survives a server restart — it is never
// written to the DB or a plaintext JSON file. When the vault is disabled
// (no LLM_VAULT_PASSPHRASE), writes fall back to in-memory only (current
// session) and a warning is logged, exactly like the LLM path.
//
// They are also:
//   - never logged verbatim,
//   - never echoed back to the client (the read API returns a boolean hasToken),
//   - resolved with a graceful fallback chain: explicit per-source token →
//     global runtimeConfig token.
//
// Mirrors the ConnectionConfigStore shape so the two stores are consistent.

import { TokenVault, getSharedVault } from './llm-vault';

/** A single source credential. */
export interface SourceCredential {
  /** API key / bearer token for THIS source on THIS analyst. Never logged. */
  token: string;
  /** Free-form extra knobs for the source (e.g. account id, base URI). */
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
  private vault: TokenVault;

  constructor(vault?: TokenVault) {
    // Reuse the SHARED vault singleton so source tokens live in the SAME
    // encrypted file as the LLM tokens (and so a save here never clobbers
    // an LLM token written by llm-config's store).
    this.vault = vault ?? getSharedVault();
  }

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

  /** Store a credential for a (session, analyst, source) triple. Persists to GPG vault. */
  set(key: CredentialKey, cred: SourceCredential & { clearToken?: boolean }): void {
    // A blank token means "keep the existing token" (the UI shows a
    // "•••••• already saved" placeholder and never refills the real token,
    // so a re-save must NOT clobber a previously stored token). Only an
    // explicit clearToken:true wipes it.
    const existing = this.get(key);
    const token =
      cred.token && cred.token.length > 0
        ? cred.token
        : cred.clearToken
          ? ''
          : existing?.token ?? '';
    this.store.set(composeKey(key), { token, extra: cred.extra ?? {} });
    // Persist to the encrypted vault, keyed by analyst+source (the session is
    // a runtime-only concept; the vault is single-tenant per server).
    this.vault.setSourceToken(key.analystId, key.sourceId, token, cred.extra ?? {});
    this.vault.save();
  }

  /** Read a credential (or undefined if none set). Prefers the vault so a
   *  restarted server still resolves a previously-saved token. */
  get(key: CredentialKey): SourceCredential | undefined {
    const fromVault = this.vault.getSourceToken(key.analystId, key.sourceId);
    if (fromVault && (fromVault.token || Object.keys(fromVault.extra).length > 0)) {
      return { token: fromVault.token, extra: fromVault.extra ?? {} };
    }
    return this.store.get(composeKey(key));
  }

  /** True when the backing vault is unconfigured (credentials in-memory only,
   *  lost on restart). Surfaces the honesty warning the UI shows. */
  vaultDisabled(): boolean {
    return this.vault.cipherKind === 'none';
  }

  /** True if a credential exists for the triple. */
  has(key: CredentialKey): boolean {
    return this.get(key) !== undefined;
  }

  /** Remove one credential (and its vault entry). */
  clear(key: CredentialKey): void {
    this.store.delete(composeKey(key));
    this.vault.clearSourceToken(key.analystId, key.sourceId);
    this.vault.save();
  }

  /** Reset all stored credentials (primarily for tests). */
  reset(): void {
    this.store.clear();
    this.vault.clearUser();
    this.vault.save();
  }

  /**
   * Resolve the effective token for a source: explicit per-source token wins,
   * otherwise fall back to the global runtimeConfig token, otherwise ''.
   */
  resolveToken(key: CredentialKey, fallbackToken?: string): string {
    const cred = this.get(key);
    if (cred && cred.token) return cred.token;
    return fallbackToken ?? '';
  }
}

/** A single shared store instance for the running server. */
export const analystConfigStore = new AnalystConfigStore();

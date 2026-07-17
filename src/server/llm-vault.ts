// src/server/llm-vault.ts
// Phase G — durable, encrypted token storage (server-side only).
//
// WHY: LlmConfigStore is in-memory, so every server restart wiped all LLM
// tokens. This module persists tokens + per-agency model assignments to an
// encrypted file on the server, surviving restarts.
//
// STRUCTURE (multi-user ready from day one):
//   {
//     version: 1,
//     users: {
//       "<userId>": {
//         llm: { [role]: LlmModelConfig },          // secret tokens live here
//         agencyModelRole: { "<sessionId>:<agencyId>": LlmRole | null }
//       }
//     }
//   }
// Today a single user ("default") is used; future auth can populate more
// users without reshaping the file. The *encryption* is shared by the running
// server (one GPG recipient / one passphrase) — only the internal layout is
// per-user.
//
// CIPHER SELECTION (runtime, safe defaults):
//   - If `gpg` is available AND LLM_VAULT_PASSPHRASE is set  -> GPG symmetric.
//   - Else if LLM_VAULT_PASSPHRASE is set                    -> AES-256-GCM.
//   - Else                                                    -> vault disabled
//     (in-memory only; a warning is logged; tokens still work this session).

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawnSync } from 'child_process';
import type { LlmModelConfig, LlmRole } from './llm-config';

const VAULT_VERSION = 1;

export interface SourceTokenDTO {
  token: string;
  extra: Record<string, string>;
}

export interface UserVault {
  llm: Partial<Record<LlmRole, LlmModelConfig>>;
  agencyModelRole: Record<string, LlmRole | null>;
  /** Per-source data credentials (Alpha Vantage, Finnhub, ...). Keyed by
   *  `${analystId}:${sourceId}` — single-tenant today (one server). Secrets
   *  ONLY; never echoed to the client. Persisted encrypted, survives restart. */
  sourceTokens: Record<string, SourceTokenDTO>;
}

export interface VaultData {
  version: number;
  users: Record<string, UserVault>;
}

// --- Cipher abstraction -----------------------------------------------------

export interface Cipher {
  readonly kind: 'gpg' | 'aes';
  encrypt(plain: string): Buffer;
  decrypt(buf: Buffer): string;
}

/** GPG symmetric cipher (--symmetric with a passphrase). */
class GpgCipher implements Cipher {
  readonly kind = 'gpg' as const;
  constructor(private passphrase: string) {}

  private run(args: string[], input?: Buffer): Buffer {
    const res = spawnSync('gpg', ['--batch', '--yes', '--pinentry-mode', 'loopback',
      '--passphrase', this.passphrase, ...args], { input, maxBuffer: 16 * 1024 * 1024 });
    if (res.status !== 0) {
      const err = (res.stderr?.toString() || res.error?.message || 'gpg failed').trim();
      throw new Error(`gpg error: ${err}`);
    }
    return res.stdout;
  }

  encrypt(plain: string): Buffer {
    return this.run(['--symmetric'], Buffer.from(plain, 'utf8'));
  }

  decrypt(buf: Buffer): string {
    return this.run(['--decrypt'], buf).toString('utf8');
  }
}

/** AES-256-GCM cipher (Node built-in, no external binary required). */
export class AesCipher implements Cipher {
  readonly kind = 'aes' as const;
  private key: Buffer;
  constructor(passphrase: string, private fixedSalt?: string) {
    const salt = Buffer.from(this.fixedSalt || 'financial-analysis-pipeline::llm-vault');
    this.key = crypto.scryptSync(passphrase, salt, 32);
  }

  encrypt(plain: string): Buffer {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    // layout: [iv(12)] [tag(16)] [ciphertext]
    return Buffer.concat([iv, tag, ct]);
  }

  decrypt(buf: Buffer): string {
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ct = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  }
}

/** Pick a cipher from the environment, or null if the vault must stay disabled. */
export function selectCipher(): { cipher: Cipher | null; reason: string } {
  const pass = process.env.LLM_VAULT_PASSPHRASE;
  if (!pass) {
    return { cipher: null, reason: 'LLM_VAULT_PASSPHRASE not set — vault disabled (in-memory only).' };
  }
  const gpg = spawnSync('gpg', ['--version'], { maxBuffer: 64 * 1024 });
  if (gpg.status === 0) {
    return { cipher: new GpgCipher(pass), reason: 'Using GPG symmetric encryption.' };
  }
  return { cipher: new AesCipher(pass), reason: 'gpg not available — using AES-256-GCM fallback.' };
}

// --- TokenVault -------------------------------------------------------------

export class TokenVault {
  private data: VaultData = { version: VAULT_VERSION, users: {} };
  private loaded = false;
  readonly cipherKind: 'gpg' | 'aes' | 'none';
  /** Set when a vault file existed but could NOT be decrypted (wrong passphrase,
   * corrupt, etc.). Surfaced loudly so tokens aren't silently dropped. */
  vaultUnreadable: string | null = null;

  constructor(
    private filePath: string,
    private userId: string,
    private cipher: Cipher | null,
  ) {
    this.cipherKind = cipher ? cipher.kind : 'none';
  }

  /** Load + parse the encrypted file (no-op if missing/disabled). On a
   * decrypt failure we do NOT silently wipe tokens — we record the error and
   * rename the unreadable file to a .corrupt-<ts>.bak so a fresh save can
   * re-key it (the renamed bytes stay recoverable). */
  load(): void {
    this.loaded = true;
    if (!this.cipher) return;
    if (!fs.existsSync(this.filePath)) return;
    try {
      const raw = fs.readFileSync(this.filePath);
      const json = this.cipher.decrypt(raw);
      const parsed = JSON.parse(json) as VaultData;
      if (parsed && parsed.users) this.data = parsed;
    } catch (e) {
      const reason = (e as Error).message;
      this.vaultUnreadable = reason;
      // Preserve the unreadable bytes (rename, never delete) so a correct
      // passphrase can still recover them later; this also unblocks a fresh
      // save from writing a clean file on the original path.
      try {
        const bak = `${this.filePath}.corrupt-${Date.now()}.bak`;
        fs.renameSync(this.filePath, bak);
        this.vaultUnreadable = `${reason} (unreadable vault moved to ${bak})`;
      } catch { /* leave as-is if rename fails */ }
    }
  }

  private user(): UserVault {
    let u = this.data.users[this.userId];
    if (!u) {
      u = { llm: {}, agencyModelRole: {}, sourceTokens: {} };
      this.data.users[this.userId] = u;
    }
    if (!u.sourceTokens) u.sourceTokens = {};
    return u;
  }

  getSourceToken(analystId: string, sourceId: string): SourceTokenDTO | undefined {
    return this.user().sourceTokens[`${analystId}:${sourceId}`];
  }

  setSourceToken(analystId: string, sourceId: string, token: string, extra: Record<string, string>): void {
    this.user().sourceTokens[`${analystId}:${sourceId}`] = { token, extra: extra ?? {} };
  }

  clearSourceToken(analystId: string, sourceId: string): void {
    delete this.user().sourceTokens[`${analystId}:${sourceId}`];
  }

  getLlm(role: LlmRole): LlmModelConfig | undefined {
    return this.user().llm[role];
  }

  setLlm(role: LlmRole, config: LlmModelConfig): void {
    this.user().llm[role] = config;
  }

  getAgency(sessionId: string, agencyId: string): LlmRole | null {
    return this.user().agencyModelRole[`${sessionId}:${agencyId}`] ?? null;
  }

  /** All agency overrides for this user (keyed `${sessionId}:${agencyId}`). */
  getAgencyAll(): Record<string, LlmRole | null> {
    return { ...this.user().agencyModelRole };
  }

  setAgency(sessionId: string, agencyId: string, role: LlmRole | null): void {
    this.user().agencyModelRole[`${sessionId}:${agencyId}`] = role;
  }

  /** Remove all secret data for the current user (used by store.reset()). */
  clearUser(): void {
    this.data.users[this.userId] = { llm: {}, agencyModelRole: {}, sourceTokens: {} };
  }

  /** Atomically write the encrypted vault (tmp file + rename).
   *
   *  SAFETY (prevents silent token loss): the vault holds BOTH LLM tokens and
   *  per-source data credentials (Alpha Vantage, Finnhub, ...) in ONE file.
   *  Because the shared vault is a process-wide singleton, a successful boot
   *  loads the COMPLETE file into `this.data`, so any save from either the LLM
   *  path or the source-credential path already carries every other secret.
   *  The one dangerous case is a process that has a cipher but could NOT decrypt
   *  the existing file at boot: its `this.data` is empty, so overwriting would
   *  wipe every persisted secret. Guard against exactly that — if
   *  `vaultUnreadable` is set we REFUSE to write (the good bytes were preserved
   *  as a .corrupt-*.bak by load()). We do NOT merge with the on-disk copy here:
   *  a merge can only ever ADD keys, so it would resurrect intentionally
   *  cleared entries (clearSourceToken / reset), breaking deletion semantics. */
  save(): void {
    if (!this.cipher) return; // disabled
    // Guard: never clobber a file this process failed to read.
    if (this.vaultUnreadable) {
      console.warn(
        `[vault] refusing to overwrite ${this.filePath} — existing file was unreadable ` +
          `(vaultUnreadable set). A save here would drop all other persisted secrets. ` +
          `Fix the passphrase / re-key, then retry.`,
      );
      return;
    }
    const json = JSON.stringify(this.data);
    const enc = this.cipher.encrypt(json);
    const dir = path.dirname(this.filePath);
    if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, enc, { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
    fs.chmodSync(this.filePath, 0o600);
  }

  /** Test/dev helper: explicit cipher injection (does not touch env). */
  static withCipher(filePath: string, userId: string, cipher: Cipher): TokenVault {
    const v = new TokenVault(filePath, userId, cipher);
    v.load();
    return v;
  }
}

/** The current user id — single-tenant today ('default'), multi-user ready. */
export function resolveVaultUserId(): string {
  return process.env.LLM_VAULT_USER || 'default';
}

/** Build the default vault from env, or a disabled instance when unconfigured. */
export function createVault(): TokenVault {
  const filePath = process.env.LLM_VAULT_PATH ||
    path.join(process.cwd(), '.vault', 'llm-tokens.gpg');
  const userId = resolveVaultUserId();
  const { cipher, reason } = selectCipher();
  if (!cipher) {
    console.warn(`[vault] ${reason} Set LLM_VAULT_PASSPHRASE to enable encrypted token persistence.`);
  } else {
    console.log(`[vault] token persistence enabled (${cipher.kind}) -> ${filePath}`);
  }
  const vault = new TokenVault(filePath, userId, cipher);
  vault.load();
  if (vault.vaultUnreadable) {
    console.error(`[vault] UNREADABLE: ${vault.vaultUnreadable}`);
  }
  return vault;
}

/**
 * Process-wide SINGLE vault instance. Both the LLM config store and the
 * per-source credential store (analyst-config) must use THIS instance so a save
 * from either one never overwrites the other's in-memory copy of the file.
 */
let _sharedVault: TokenVault | null = null;
export function getSharedVault(): TokenVault {
  if (!_sharedVault) _sharedVault = createVault();
  return _sharedVault;
}

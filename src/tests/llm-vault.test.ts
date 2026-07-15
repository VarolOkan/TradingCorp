// src/tests/llm-vault.test.ts
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { TokenVault, AesCipher } from '../server/llm-vault';
import { LlmConfigStore, defaultLlmConfigs, type LlmModelConfig } from '../server/llm-config';

function tmpFile(name: string): string {
  return path.join(os.tmpdir(), `llm-vault-test-${process.pid}-${name}.gpg`);
}

function aesVault(file: string, user = 'default'): TokenVault {
  return TokenVault.withCipher(file, user, new AesCipher('test-passphrase'));
}

describe('TokenVault (AES fallback cipher)', () => {
  const file = tmpFile('basic');
  afterEach(() => { try { fs.unlinkSync(file); } catch {} });

  it('persists a token and reads it back after reload', () => {
    const v1 = aesVault(file);
    v1.setLlm('deep-thought', {
      role: 'deep-thought', provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1', model: 'm', token: 'sk-secret-123',
    });
    v1.save();
    expect(fs.existsSync(file)).toBe(true);

    const v2 = aesVault(file); // fresh instance, same file
    const got = v2.getLlm('deep-thought');
    expect(got?.token).toBe('sk-secret-123');
  });

  it('keeps tokens isolated per user inside the same file', () => {
    const v1 = aesVault(file, 'alice');
    v1.setLlm('scanner', { role: 'scanner', provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o', token: 'alice-token' });
    v1.save();
    const v2 = aesVault(file, 'bob');
    v2.setLlm('scanner', { role: 'scanner', provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o', token: 'bob-token' });
    v2.save();

    const alice = aesVault(file, 'alice');
    const bob = aesVault(file, 'bob');
    expect(alice.getLlm('scanner')?.token).toBe('alice-token');
    expect((bob.getLlm('scanner') as LlmModelConfig).token).toBe('bob-token');
    expect((bob.getLlm('deep-thought') as LlmModelConfig | undefined)?.token).toBeUndefined();
  });

  it('persists per-agency model overrides and re-reads them', () => {
    const v = aesVault(file);
    v.setAgency('sess-1', 'ag-equities', 'flexible');
    v.setAgency('sess-1', 'ag-crypto', 'scanner');
    v.save();

    const v2 = aesVault(file);
    expect(v2.getAgency('sess-1', 'ag-equities')).toBe('flexible');
    expect(v2.getAgency('sess-1', 'ag-crypto')).toBe('scanner');
    expect(v2.getAgency('sess-1', 'ag-unknown')).toBeNull();
    expect(v2.getAgencyAll()['sess-1:ag-equities']).toBe('flexible');
  });

  it('produces ciphertext that is not the plaintext', () => {
    const v = aesVault(file);
    v.setLlm('deep-thought', { role: 'deep-thought', provider: 'openrouter', baseUrl: 'x', model: 'm', token: 'super-secret' });
    v.save();
    const raw = fs.readFileSync(file).toString('utf8');
    expect(raw).not.toContain('super-secret');
  });
});

describe('LlmConfigStore + vault integration', () => {
  const file = tmpFile('store');
  afterEach(() => { try { fs.unlinkSync(file); } catch {} });

  it('a token set via put() survives a fresh store constructed from the same vault file', () => {
    const vault = TokenVault.withCipher(file, 'default', new AesCipher('pw'));
    const s1 = new LlmConfigStore(defaultLlmConfigs(), vault);
    s1.put({ role: 'deep-thought', provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'm', token: 'persisted-token' });

    // Simulate restart: new store, same vault file.
    const vault2 = TokenVault.withCipher(file, 'default', new AesCipher('pw'));
    const s2 = new LlmConfigStore(defaultLlmConfigs(), vault2);
    expect(s2.get('deep-thought').token).toBe('persisted-token');
    expect(s2.list().find((c) => c.role === 'deep-thought')?.hasToken).toBe(true);
  });

  it('agency override survives restart', () => {
    const vault = TokenVault.withCipher(file, 'default', new AesCipher('pw'));
    const s1 = new LlmConfigStore(defaultLlmConfigs(), vault);
    s1.setAgencyModelRole('sess-9', 'ag-equities', 'scanner');

    const vault2 = TokenVault.withCipher(file, 'default', new AesCipher('pw'));
    const s2 = new LlmConfigStore(defaultLlmConfigs(), vault2);
    expect(s2.getAgencyModelRole('sess-9', 'ag-equities')).toBe('scanner');
  });

  it('reset() wipes persisted tokens', () => {
    const vault = TokenVault.withCipher(file, 'default', new AesCipher('pw'));
    const s1 = new LlmConfigStore(defaultLlmConfigs(), vault);
    s1.put({ role: 'scanner', provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o', token: 'tok' });

    const vault2 = TokenVault.withCipher(file, 'default', new AesCipher('pw'));
    const s2 = new LlmConfigStore(defaultLlmConfigs(), vault2);
    s2.reset();
    const vault3 = TokenVault.withCipher(file, 'default', new AesCipher('pw'));
    const s3 = new LlmConfigStore(defaultLlmConfigs(), vault3);
    expect(s3.get('scanner').token).toBe('');
  });

  it('a disabled vault (cipher=null) does NOT throw and keeps tokens in-memory only', () => {
    const vault = new TokenVault(file, 'default', null); // no cipher
    const s = new LlmConfigStore(defaultLlmConfigs(), vault);
    s.put({ role: 'flexible', provider: 'ollama', baseUrl: 'http://localhost:11434/v1', model: 'llama3', token: 't' });
    expect(s.get('flexible').token).toBe('t');
    expect(fs.existsSync(file)).toBe(false); // nothing written
  });
});

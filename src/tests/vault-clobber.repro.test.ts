import { TokenVault, AesCipher } from '../server/llm-vault';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('shared vault clobber guards', () => {
  it('guard 2: a source-token save in a process that CAN read the file preserves the LLM key', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultg2-'));
    const file = path.join(dir, 'llm-tokens.gpg');
    const pass = 'test-pass';
    const vA = new TokenVault(file, 'default', new AesCipher(pass));
    vA.load();
    vA.setLlm('deep-thought', { role: 'deep-thought', provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', token: 'REAL_LLM_KEY' });
    vA.save();

    const vB = new TokenVault(file, 'default', new AesCipher(pass));
    vB.load();
    vB.setSourceToken('data_ingestion', 'finnhub', 'FH_TOKEN', {});
    vB.save();

    const vC = new TokenVault(file, 'default', new AesCipher(pass));
    vC.load();
    expect(vC.getLlm('deep-thought')?.token).toBe('REAL_LLM_KEY');
    expect(vC.getSourceToken('data_ingestion', 'finnhub')?.token).toBe('FH_TOKEN');
  });

  it('guard 1: a process that CANNOT decrypt refuses to overwrite (good bytes survive in .bak)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultg1-'));
    const file = path.join(dir, 'llm-tokens.gpg');
    const pass = 'test-pass';
    const vA = new TokenVault(file, 'default', new AesCipher(pass));
    vA.load();
    vA.setLlm('deep-thought', { role: 'deep-thought', provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', token: 'REAL_LLM_KEY' });
    vA.save();

    const vB = new TokenVault(file, 'default', new AesCipher('WRONG'));
    vB.load();
    expect(vB.vaultUnreadable).not.toBeNull();
    vB.setSourceToken('data_ingestion', 'finnhub', 'FH_TOKEN', {});
    vB.save();

    // The canonical file must NOT be recreated by the failed-decrypt process.
    expect(fs.existsSync(file)).toBe(false);
    // The good bytes are preserved in a .corrupt-*.bak and still decrypt.
    const bak = fs.readdirSync(dir).find((f) => f.includes('.corrupt-') && f.endsWith('.bak'))!;
    const vC = new TokenVault(path.join(dir, bak), 'default', new AesCipher(pass));
    vC.load();
    expect(vC.getLlm('deep-thought')?.token).toBe('REAL_LLM_KEY');
  });
});

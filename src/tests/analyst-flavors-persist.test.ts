// src/tests/analyst-flavors-persist.test.ts
// Regression for the "Enable LLM for all analysts" toggle (and any flavor
// customization) being LOST after a server restart. The store now mirrors to a
// JSON file; this test proves a set survives a fresh store instance (== restart)
// reading the same file. No sqlite dependency, so it runs in this sandbox.
import { describe, it, expect, afterAll } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { AnalystFlavorStore } from '../server/analyst-flavors';
import type { FlavorKey, FlavorSet } from '../server/analyst-flavors';

const tmp = path.join(os.tmpdir(), `flavors-test-${process.pid}-${Date.now()}`);
fs.mkdirSync(tmp, { recursive: true });

const key: FlavorKey = { sessionId: 'default', agencyId: 'long-term', analystId: 'technical' };
const set: FlavorSet = {
  flavors: [
    {
      id: 'default',
      name: 'Default',
      role: 'Technical analysis',
      instructions: 'Do the thing.',
      isDefault: true,
      enabled: true, // the bulk "Enable LLM for all" flag we must keep across restart
      modelRole: 'deep-thought',
    },
  ],
  selectedId: 'default',
};

afterAll(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('AnalystFlavorStore persistence (survives restart)', () => {
  it('keeps the enabled flag after a fresh store instance reads the file', () => {
    const file = path.join(tmp, 'flavors.json');
    const s1 = new AnalystFlavorStore(file);
    s1.set(key, set);

    // Simulate a server restart: brand-new store instance, same file path.
    const s2 = new AnalystFlavorStore(file);
    const loaded = s2.get(key);
    expect(loaded).toBeDefined();
    expect(loaded!.flavors[0]!.enabled).toBe(true);
    expect(loaded!.selectedId).toBe('default');
  });

  it('clear() removes the entry from disk too', () => {
    const file = path.join(tmp, 'flavors-2.json');
    const s1 = new AnalystFlavorStore(file);
    s1.set(key, set);
    s1.clear(key);

    const s2 = new AnalystFlavorStore(file);
    expect(s2.get(key)).toBeUndefined();
  });

  it('reset() empties the persisted file', () => {
    const file = path.join(tmp, 'flavors-3.json');
    const s1 = new AnalystFlavorStore(file);
    s1.set(key, set);
    s1.reset();

    const s2 = new AnalystFlavorStore(file);
    expect(s2.get(key)).toBeUndefined();
    // File exists but is empty object (or absent) — never resurrects the entry.
    const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '{}';
    expect(JSON.parse(raw)).toEqual({});
  });
});

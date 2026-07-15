// src/tests/connection-config.test.ts
import {
  ConnectionConfigStore,
  ValidationResult,
} from '../server/connection-config';

describe('ConnectionConfigStore.validate', () => {
  it('accepts a minimal valid payload', () => {
    const r: ValidationResult = ConnectionConfigStore.validate({
      baseUri: 'http://localhost:3001',
    });
    expect(r.ok).toBe(true);
    expect(r.settings!.baseUri).toBe('http://localhost:3001');
    expect(r.settings!.accessToken).toBe('');
    expect(r.settings!.extra).toEqual({});
  });

  it('accepts https baseUri with token and extra', () => {
    const r = ConnectionConfigStore.validate({
      baseUri: 'https://api.example.com',
      accessToken: 'secret-token',
      extra: { region: 'us-east', tier: 'pro' },
    });
    expect(r.ok).toBe(true);
    expect(r.settings!.accessToken).toBe('secret-token');
    expect(r.settings!.extra).toEqual({ region: 'us-east', tier: 'pro' });
  });

  it('trims whitespace from baseUri', () => {
    const r = ConnectionConfigStore.validate({ baseUri: '  http://x.test  ' });
    expect(r.ok).toBe(true);
    expect(r.settings!.baseUri).toBe('http://x.test');
  });

  it('rejects a non-object body', () => {
    const r = ConnectionConfigStore.validate('nope');
    expect(r.ok).toBe(false);
    expect(r.errors).toContain('Request body must be a JSON object');
  });

  it('rejects a null body', () => {
    const r = ConnectionConfigStore.validate(null);
    expect(r.ok).toBe(false);
  });

  it('requires baseUri', () => {
    const r = ConnectionConfigStore.validate({});
    expect(r.ok).toBe(false);
    expect(r.errors).toContain('baseUri is required');
  });

  it('rejects a non-http baseUri', () => {
    const r = ConnectionConfigStore.validate({ baseUri: 'ftp://example.com' });
    expect(r.ok).toBe(false);
    expect(r.errors).toContain('baseUri must be an http(s) URL');
  });

  it('rejects a non-string baseUri', () => {
    const r = ConnectionConfigStore.validate({ baseUri: 12345 });
    expect(r.ok).toBe(false);
  });

  it('rejects extra as an array', () => {
    const r = ConnectionConfigStore.validate({
      baseUri: 'http://x.test',
      extra: [1, 2, 3],
    });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/extra must be an object/);
  });

  it('rejects non-string extra values', () => {
    const r = ConnectionConfigStore.validate({
      baseUri: 'http://x.test',
      extra: { score: 42 as any },
    });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/extra.score must be a string/);
  });

  it('collects multiple errors', () => {
    const r = ConnectionConfigStore.validate({ baseUri: 'bad', extra: [] });
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThanOrEqual(2);
  });
});

describe('ConnectionConfigStore instance', () => {
  let store: ConnectionConfigStore;

  beforeEach(() => {
    store = new ConnectionConfigStore();
  });

  afterEach(() => {
    store.reset();
  });

  it('stores and retrieves settings for a session', () => {
    store.set('s1', {
      baseUri: 'https://b.example',
      accessToken: 'tok',
      extra: { k: 'v' },
    });
    const got = store.get('s1');
    expect(got.baseUri).toBe('https://b.example');
    expect(got.accessToken).toBe('tok');
    expect(got.extra).toEqual({ k: 'v' });
    expect(store.has('s1')).toBe(true);
  });

  it('falls back to default session then to defaultConfig', () => {
    // No config set for any session.
    expect(store.has('missing')).toBe(false);
    const got = store.get('missing');
    expect(got.baseUri).toBe('http://localhost:3001');
    expect(got.accessToken).toBe('');
    expect(got.extra).toEqual({});
  });

  it('prefers a session-specific config over the default session', () => {
    store.set('default', {
      baseUri: 'https://default.example',
      accessToken: '',
      extra: {},
    });
    store.set('s2', {
      baseUri: 'https://s2.example',
      accessToken: '',
      extra: {},
    });
    const got = store.get('s2');
    expect(got.baseUri).toBe('https://s2.example');
  });

  it('falls back to the default session when session missing', () => {
    store.set('default', {
      baseUri: 'https://default.example',
      accessToken: 'x',
      extra: { a: 'b' },
    });
    const got = store.get('other');
    expect(got.baseUri).toBe('https://default.example');
    expect(got.accessToken).toBe('x');
  });

  it('normalizes missing fields in set()', () => {
    const resolved = store.set('s3', {
      baseUri: '',
      accessToken: undefined as any,
      extra: undefined as any,
    });
    expect(resolved.baseUri).toBe('http://localhost:3001');
    expect(resolved.accessToken).toBe('');
    expect(resolved.extra).toEqual({});
  });

  it('clears a session', () => {
    store.set('s4', {
      baseUri: 'https://x.example',
      accessToken: '',
      extra: {},
    });
    store.clear('s4');
    expect(store.has('s4')).toBe(false);
  });

  it('reset() empties all config', () => {
    store.set('a', { baseUri: 'https://a', accessToken: '', extra: {} });
    store.set('b', { baseUri: 'https://b', accessToken: '', extra: {} });
    store.reset();
    expect(store.has('a')).toBe(false);
    expect(store.has('b')).toBe(false);
  });

  it('defaultConfig() returns a fresh default object', () => {
    const d = store.defaultConfig();
    expect(d).toEqual({ baseUri: 'http://localhost:3001', accessToken: '', extra: {}, parallelAnalysts: true });
  });
});

// frontend/src/test/configClient.test.ts
import { postSettings, getConfig } from '../api/configClient';

describe('configClient', () => {
  const jsonMock = vi.fn();
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    jsonMock.mockResolvedValue({});
    fetchMock.mockResolvedValue({ ok: true, json: jsonMock } as any);
    global.fetch = fetchMock as any;
  });

  it('postSettings POSTs the settings and returns the parsed response', async () => {
    jsonMock.mockResolvedValue({
      ok: true,
      sessionId: 's1',
      baseUri: 'https://b.example',
      hasToken: true,
      extraKeys: ['region'],
    });
    const res = await postSettings(
      { baseUri: 'https://b.example', accessToken: 'tok', extra: { region: 'eu' } },
      's1'
    );
    expect(fetchMock).toHaveBeenCalledWith(
      '/config?sessionId=s1',
      expect.objectContaining({ method: 'POST' })
    );
    const body = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    expect(body).toEqual({ baseUri: 'https://b.example', accessToken: 'tok', extra: { region: 'eu' } });
    expect(res.hasToken).toBe(true);
  });

  it('postSettings throws with server details on non-ok response', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: 'bad', details: ['baseUri is required'] }) } as any);
    await expect(
      postSettings({ baseUri: 'not-a-url', accessToken: '', extra: {} })
    ).rejects.toThrow(/baseUri is required/);
  });

  it('postSettings throws a generic message when response JSON is unreadable', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => { throw new Error('bad json'); } } as any);
    await expect(
      postSettings({ baseUri: 'http://x', accessToken: '', extra: {} })
    ).rejects.toThrow(/HTTP 500/);
  });

  it('getConfig GETs /config and returns the parsed response', async () => {
    jsonMock.mockResolvedValue({ analysis: { foo: 1 }, version: '1.0.0' });
    const res = await getConfig();
    expect(fetchMock).toHaveBeenCalledWith('/config', expect.objectContaining({ method: 'GET' }));
    expect(res.version).toBe('1.0.0');
  });

  it('getConfig throws on non-ok response', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) } as any);
    await expect(getConfig()).rejects.toThrow(/HTTP 503/);
  });
});

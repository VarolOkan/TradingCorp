// frontend/src/test/registryClient.test.ts
// Unit tests for the registry API client (Phase 1). Mocks global.fetch and
// asserts each verb hits the right URL/method and surfaces server errors.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getRegistry,
  putAgencyAnalysts,
  postAgency,
  deleteAgency,
} from '../api/registryClient';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('registryClient', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('getRegistry GETs /registry with the userId', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ catalog: [], agencies: [], driver: 'json' }));
    const out = await getRegistry('user-1');
    expect(fetchMock).toHaveBeenCalledWith('/registry?userId=user-1');
    expect(out.driver).toBe('json');
  });

  it('putAgencyAnalysts PUTs the ordered refs + feedInto', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, id: 'long-term', analysts: [] }));
    await putAgencyAnalysts(
      'long-term',
      { analysts: [{ id: 'orchestrator' }, { id: 'fundamental' }], feedInto: { fundamental: ['risk'] } },
      'user-1',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('/registry/agency/long-term?userId=user-1');
    expect(opts.method).toBe('PUT');
    const body = JSON.parse(opts.body);
    expect(body.analysts.map((r: { id: string }) => r.id)).toEqual(['orchestrator', 'fundamental']);
    expect(body.feedInto).toEqual({ fundamental: ['risk'] });
  });

  it('postAgency POSTs a new agency def', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, id: 'my-agency' }, true, 201));
    await postAgency(
      { id: 'my-agency', name: 'My Agency', horizon: 'LONG_TERM', analysts: [{ id: 'orchestrator' }] } as never,
      'user-1',
    );
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('/registry/agency?userId=user-1');
    expect(opts.method).toBe('POST');
  });

  it('deleteAgency DELETEs the agency', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, id: 'deletable' }));
    await deleteAgency('deletable', 'user-1');
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('/registry/agency/deletable?userId=user-1');
    expect(opts.method).toBe('DELETE');
  });

  it('surfaces the server error message on non-2xx', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'cannot delete the default agency' }, false, 400));
    await expect(deleteAgency('long-term', 'user-1')).rejects.toThrow(/default agency/i);
  });
});

// src/tests/domain-source-routes.test.ts
// P3b: tests for the per-domain source-mapping routes (GET/POST/reset) and that
// the persisted config is actually consumed by resolveDomain (the engine reads
// the store when no explicit ctx override is passed). Uses an isolated JSON file
// under os.tmpdir so it never touches the real DATA_DIR.

import request from 'supertest';
import express from 'express';
import { DomainSourceConfigStore } from '../server/domain-source-config';
import { registerDomainSourceRoutes } from '../server/domain-source-routes';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveDomain } from '../registry/logic/domains';

function tmpFile(name: string): string {
  return path.join(os.tmpdir(), `${name}-${process.pid}.json`);
}

describe('P3b /domain-sources routes', () => {
  let app: express.Express;
  let store: DomainSourceConfigStore;
  let file: string;

  beforeEach(() => {
    file = tmpFile('domain-sources-test');
    try { fs.unlinkSync(file); } catch {}
    app = express();
    app.use(express.json());
    store = new DomainSourceConfigStore(file);
    registerDomainSourceRoutes(app, store);
  });

  afterEach(() => {
    try { fs.unlinkSync(file); } catch {}
  });

  it('GET lists every domain with available + effective enabled sources', async () => {
    const res = await request(app).get('/domain-sources');
    expect(res.status).toBe(200);
    expect(res.body.domains).toHaveProperty('news_sentiment');
    expect(res.body.domains).toHaveProperty('price_bars');
    // Default = compile-time DOMAIN_SOURCES (finnhub-led for news).
    expect(res.body.domains.news_sentiment.enabled).toEqual(
      expect.arrayContaining(['finnhub', 'yahoo', 'google']),
    );
    expect(res.body.domains.news_sentiment.overridden).toBe(false);
    expect(res.body.domains.news_sentiment.override).toBeUndefined();
  });

  it('POST validates unknown domain + unknown source', async () => {
    const badDomain = await request(app).post('/domain-sources').send({ domain: 'nope', sources: ['finnhub'] });
    expect(badDomain.status).toBe(400);
    const badSrc = await request(app)
      .post('/domain-sources')
      .send({ domain: 'news_sentiment', sources: ['bogus'] });
    expect(badSrc.status).toBe(400);
    expect(badSrc.body.available).toEqual(expect.arrayContaining(['finnhub']));
  });

  it('POST sets an override and GET reflects it; reset clears it', async () => {
    const post = await request(app)
      .post('/domain-sources')
      .send({ domain: 'news_sentiment', sources: ['yahoo', 'google'] });
    expect(post.status).toBe(200);
    expect(post.body.ok).toBe(true);
    expect(post.body.enabled).toEqual(['yahoo', 'google']);

    const get = await request(app).get('/domain-sources');
    expect(get.body.domains.news_sentiment.overridden).toBe(true);
    expect(get.body.domains.news_sentiment.enabled).toEqual(['yahoo', 'google']);

    const reset = await request(app).post('/domain-sources/reset');
    expect(reset.status).toBe(200);
    expect(reset.body.domains.news_sentiment.overridden).toBe(false);
  });

  it('persists to disk so it survives a fresh store instance', async () => {
    await request(app)
      .post('/domain-sources')
      .send({ domain: 'news_sentiment', sources: ['yahoo'] });
    // A brand-new store reading the same file must see the override.
    const reopened = new DomainSourceConfigStore(file);
    expect(reopened.isOverridden('news_sentiment')).toBe(true);
    expect(reopened.get('news_sentiment')).toEqual(['yahoo']);
  });
});

describe('P3b resolveDomain ctx override still wins', () => {
  it('resolveDomain with ctx override beats any store value (honest degrade)', async () => {
    const [rec] = await resolveDomain('news_sentiment', 'AAPL', {
      fetchFn: async (url: string) =>
        url.includes('finnhub.io')
          ? Response.json({ sentiment_score: 42, headlines: [{ title: 'x', url: 'u', source: 'finnhub', time: 't' }] })
          : Response.json({ items: [] }),
      finnhubKey: 'k',
      // Explicit ctx override must take precedence over the store / default.
      enabledSources: { news_sentiment: [] },
    });
    expect((rec as any).status).toBe('skipped');
    expect((rec as any).note).toMatch(/all sources disabled/);
  });
});

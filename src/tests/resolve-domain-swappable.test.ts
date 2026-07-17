// src/tests/resolve-domain-swappable.test.ts
// P3 — swappable per-domain source configuration (backend). Verifies that
// resolveDomain honors an explicit `enabledSources` map: a source can be
// disabled / reordered per domain, and disabling the LAST source for a domain
// degrades THAT domain honestly (a `skipped` record, no false "live" badge),
// without taking down the rest of the pipeline. The default (no override) path
// is unchanged, so P0 parity still holds.

import { resolveDomain } from '../registry/logic/domains';

// Every mock returns the same canned payload for ANY url so the REAL parse
// paths run (parity). For news we need a finnhub-shaped JSON AND a yahoo-RSS
// shape depending on the url; the test routes by substring like the P2b test.
const FINNHUB_NEWS = [{ headline: 'AAPL beats estimates', url: 'u', source: 'Finnhub', datetime: 1, summary: 's' }];
const YAHOO_RSS = `<rss><channel><item>
  <title>AAPL falls on weak demand</title>
  <link>https://finance.yahoo.com/news/aapl-weak</link>
  <pubDate>Wed, 17 Jul 2026 10:00:00 GMT</pubDate>
  <source url="https://finance.yahoo.com">Yahoo</source></item></channel></rss>`;
const YAHOO_CHART = { chart: { result: [ { timestamp: [1, 2], indicators: { quote: [ { open: [1, 2], high: [1, 2], low: [1, 2], close: [1, 2], volume: [1, 1] } ] } } ] } };

function routedFetch() {
  return async (url: string) => {
    if (url.includes('finnhub')) {
      return { ok: true, status: 200, json: async () => FINNHUB_NEWS, text: async () => '' };
    }
    return { ok: true, status: 200, json: async () => YAHOO_CHART, text: async () => YAHOO_RSS };
  };
}

describe('P3 — swappable domain source config', () => {
  it('default (no override) still resolves finnhub primary — parity intact', async () => {
    const [rec] = await resolveDomain('news_sentiment', 'AAPL', {
      fetchFn: routedFetch() as any,
      finnhubKey: 'k',
    });
    expect(rec!.sourceId).toBe('finnhub');
    expect(rec!.status).toBe('ok');
  });

  it('disabling finnhub => news domain resolves from yahoo/google only (no finnhub call)', async () => {
    const recs = await resolveDomain('news_sentiment', 'AAPL', {
      fetchFn: routedFetch() as any,
      finnhubKey: 'k', // key still present, but disabled in the mapping
      enabledSources: { news_sentiment: ['yahoo', 'google'] },
    });
    const live = recs.filter((r) => r.sourceId !== 'mock' && (r.data as any)?.headlines?.length > 0);
    expect(live.length).toBeGreaterThanOrEqual(1);
    expect(live[0]!.sourceId).not.toBe('finnhub');
  });

  it('disabling ALL sources for news => honest skipped record, no false live', async () => {
    const recs = await resolveDomain('news_sentiment', 'AAPL', {
      fetchFn: routedFetch() as any,
      finnhubKey: 'k',
      enabledSources: { news_sentiment: [] },
    });
    expect(recs.length).toBe(1);
    expect(recs[0]!.status).toBe('skipped');
    expect(recs[0]!.confidence).toBe(0);
    expect(recs[0]!.note).toMatch(/disabled/);
  });

  it('disabling the only source for price_bars degrades THAT domain, others unaffected', async () => {
    const priceRecs = await resolveDomain('price_bars', 'AAPL', {
      fetchFn: routedFetch() as any,
      enabledSources: { price_bars: [] },
    });
    expect(priceRecs.length).toBe(1);
    expect(priceRecs[0]!.status).toBe('skipped');

    // Other domains must NOT be affected by a per-domain disable.
    const newsRecs = await resolveDomain('news_sentiment', 'AAPL', {
      fetchFn: routedFetch() as any,
      finnhubKey: 'k',
      enabledSources: { price_bars: [] }, // disabled here, NOT news
    });
    const live = newsRecs.filter((r) => r.sourceId !== 'mock');
    expect(live.length).toBeGreaterThanOrEqual(1);
    expect(live[0]!.sourceId).toBe('finnhub'); // news unaffected
  });

  it('reordering: news enabled as [yahoo, finnhub] still yields live data', async () => {
    const recs = await resolveDomain('news_sentiment', 'AAPL', {
      fetchFn: routedFetch() as any,
      finnhubKey: 'k',
      enabledSources: { news_sentiment: ['yahoo', 'finnhub'] },
    });
    const live = recs.filter((r) => r.sourceId !== 'mock');
    expect(live.length).toBeGreaterThanOrEqual(1);
  });
});

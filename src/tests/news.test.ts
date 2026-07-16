// Phase 4 (live news): news.ts scoring + ingestion population + sentiment hook.
import { fetchCompanyNews, scoreHeadline, newsToIngestedSentiment } from '../registry/logic/news';
import { fetchRealFinancialData } from '../registry/logic/data-ingestion';

describe('news.ts keyword-polarity scoring', () => {
  it('scores a clearly positive headline high', () => {
    const s = scoreHeadline('AAPL beats earnings estimates, raises guidance');
    expect(s).toBeGreaterThan(20);
  });
  it('scores a clearly negative headline low', () => {
    const s = scoreHeadline('AAPL shares plunge as regulator opens investigation');
    expect(s).toBeLessThan(-20);
  });
  it('scores a neutral headline near zero', () => {
    expect(Math.abs(scoreHeadline('Company announces a routine board meeting'))).toBeLessThan(20);
  });
  it('clamps to [-100, 100]', () => {
    const many = Array.from({ length: 10 }, () => 'beats').join(' ');
    const s = scoreHeadline(many);
    expect(s).toBeLessThanOrEqual(100);
    expect(s).toBeGreaterThanOrEqual(-100);
  });

  it('returns seeded headlines + mock source when no key/fetch', async () => {
    const r = await fetchCompanyNews('AAPL');
    expect(r.source).toBe('mock');
    expect(r.headlines.length).toBeGreaterThan(0);
    expect(r.sentiment_score).toBeGreaterThanOrEqual(-100);
    expect(r.sentiment_score).toBeLessThanOrEqual(100);
  });

  it('parses a real Finnhub payload via injected fetchFn', async () => {
    const fake = async () => ({
      ok: true,
      json: async () => ([
        { headline: 'AAPL beats estimates and raises guidance', source: 'Bloomberg', datetime: 1700000000, url: 'http://x/1', category: 'company' },
        { headline: 'AAPL downgraded on weak demand', source: 'Reuters', datetime: 1700086400, url: 'http://x/2', category: 'company' },
      ]),
    });
    const r = await fetchCompanyNews('AAPL', { fetchFn: fake as any, finnhubKey: 'k' });
    expect(r.source).toBe('finnhub');
    expect(r.headlines).toHaveLength(2);
    expect(r.headlines[0]!.timestamp).toBe(new Date(1700086400 * 1000).toISOString());
    expect(r.headlines.every((h) => h.score !== 0 || h.sentiment === 'NEUTRAL')).toBe(true);
  });

  it('fetches Yahoo Finance RSS and previews real article text', async () => {
    const yahooRss = `<?xml version="1.0"?><rss><channel>
      <item><title>AAPL surges on record iPhone sales</title><link>https://finance.yahoo.com/news/aapl1</link><source url="https://yahoo.com">Yahoo</source><pubDate>Tue, 03 Jun 2026 14:00:00 GMT</pubDate></item>
      <item><title>AAPL downgraded by analysts</title><link>https://finance.yahoo.com/news/aapl2</link><source url="https://yahoo.com">Yahoo</source><pubDate>Mon, 02 Jun 2026 10:00:00 GMT</pubDate></item>
    </channel></rss>`;
    const article = `<!doctype html><body><script>x</script><p>Apple shares jumped to a record high on Monday after strong iPhone demand. Analysts lifted price targets across the board.</p></body>`;
    const fake = async (url: string) => {
      if (url.includes('finnhub.io')) return { ok: false, json: async () => [] };
      if (url.includes('finance.yahoo.com/news/rss')) return { ok: true, json: async () => null, text: async () => yahooRss };
      if (url.includes('finance.yahoo.com/news/aapl1')) return { ok: true, json: async () => null, text: async () => article };
      return { ok: false, json: async () => null, text: async () => '' };
    };
    const r = await fetchCompanyNews('AAPL', { fetchFn: fake as any });
    expect(r.source).toBe('yahoo');
    expect(r.headlines.length).toBeGreaterThan(0);
    expect(r.headlines[0]!.url).toContain('finance.yahoo.com');
    expect(r.headlines[0]!.sourceRoot).toBe('yahoo');
    // real article preview extracted from the Yahoo URL
    expect(r.headlines[0]!.summary).toContain('Apple shares jumped');
  });

  it('mixes Yahoo + Google into one de-duplicated, newest-first list', async () => {
    const yahooRss = `<?xml version="1.0"?><rss><channel>
      <item><title>AAPL surges on record iPhone sales</title><link>https://finance.yahoo.com/news/aapl1</link><source url="https://yahoo.com">Yahoo</source><pubDate>Mon, 02 Jun 2026 14:00:00 GMT</pubDate></item>
    </channel></rss>`;
    const googleRss = `<?xml version="1.0"?><rss><channel>
      <item><title>TSLA tanks after recall</title><link>https://news.google.com/rss/articles/CBMitsla</link><source url="https://reuters.com">Reuters</source><pubDate>Mon, 02 Jun 2026 14:00:00 GMT</pubDate></item>
      <item><title>AAPL surges on record iPhone sales</title><link>https://news.google.com/rss/articles/CBMdup</link><source url="https://yahoo.com">Yahoo</source><pubDate>Mon, 02 Jun 2026 14:00:00 GMT</pubDate></item>
    </channel></rss>`;
    const fake = async (url: string) => {
      if (url.includes('finnhub.io')) return { ok: false, json: async () => [] };
      if (url.includes('finance.yahoo.com/news/rss')) return { ok: true, json: async () => null, text: async () => yahooRss };
      if (url.includes('news.google.com/rss')) return { ok: true, json: async () => null, text: async () => googleRss };
      return { ok: false, json: async () => null, text: async () => '' };
    };
    const r = await fetchCompanyNews('AAPL', { fetchFn: fake as any });
    expect(r.source).toBe('mixed');
    expect(r.note).toContain('yahoo=1');
    expect(r.note).toContain('google=2');
    // the duplicate title appears once (Yahoo variant wins, with previewable URL)
    const titles = r.headlines.map((h) => h.title);
    expect(new Set(titles).size).toBe(titles.length);
    const dup = r.headlines.find((h) => h.title.includes('surges on record'));
    expect(dup!.sourceRoot).toBe('yahoo');
  });

  it('newsToIngestedSentiment feeds the sentiment analyst realSent hook', async () => {
    const r = await fetchCompanyNews('AAPL');
    const ing = newsToIngestedSentiment(r);
    expect(typeof ing.sentiment_score).toBe('number');
    expect(Array.isArray(ing.key_news)).toBe(true);
    expect(ing.data_source).toMatch(/news/);
  });
});

describe('news article-lead snippet enrichment', () => {
  const ARTICLE_HTML = `<!doctype html><html><head><title>Meta</title></head><body>
    <script>var x=1;</script><style>.a{color:red}</style>
    <header>nav menu top</header>
    <article><p>Apple reported record quarterly revenue of $95 billion. The result beat analyst estimates on strong services growth. Shares rose 4% in after-hours trading.</p><p>Guidance was reaffirmed.</p></article>
    <footer>copyright boilerplate</footer></body></html>`;

  const fakeFetch = async (url: string) => {
    if (url.includes('finnhub.io')) return { ok: false, json: async () => [] };
    if (url.includes('query1.finance.yahoo.com')) return { ok: false, json: async () => ({}) };
    if (url.includes('news.google.com/rss/search')) {
      const rss = `<?xml version="1.0"?><rss><channel><item><title>AAPL hits record revenue</title><link>https://news.google.com/rss/articles/ABC</link><source url="https://reuters.com">Reuters</source><pubDate>Mon, 02 Jun 2026 14:00:00 GMT</pubDate></item></channel></rss>`;
      return { ok: true, json: async () => null, text: async () => rss };
    }
    return { ok: true, json: async () => null, text: async () => ARTICLE_HTML };
  };

  it('enriches Google/Yahoo headlines with a real 1-2 sentence story snippet', async () => {
    const r = await fetchCompanyNews('AAPL', { fetchFn: fakeFetch as any });
    expect(r.source).toBe('google');
    expect(r.headlines[0]!.summary).toBeTruthy();
    expect(r.headlines[0]!.summary).toContain('Apple reported record quarterly revenue');
    // boilerplate must be stripped
    expect(r.headlines[0]!.summary).not.toMatch(/nav menu|copyright|Meta/);
    // capped to ~2 sentences / ~320 chars
    expect(r.headlines[0]!.summary!.length).toBeLessThanOrEqual(340);
  });
});

describe('data-ingestion wires real news into sentiment_data', () => {
  const fakeNews = async (url: string) => {
    if (url.includes('company-news')) {
      return { ok: true, json: async () => ([{ headline: 'AAPL beats estimates', source: 'Bloomberg', datetime: 1700000000, url: 'http://x', category: 'company' }]) };
    }
    // return a non-ok for yahoo so market stays mock; news path still runs.
    return { ok: false, json: async () => ({}) };
  };

  it('overrides sentiment_data with real news when Finnhub reachable', async () => {
    const out = await fetchRealFinancialData(
      { tickers: ['AAPL'] },
      fakeNews as any,
      undefined,
      { newsFetcher: fakeNews as any, finnhubKey: 'k' },
    );
    const sent = out.sentiment_data.AAPL;
    expect(sent.data_source).toMatch(/live-news/);
    expect(sent.sentiment_score).toBeGreaterThan(0); // "beats" is positive
    expect(Array.isArray(sent.key_news)).toBe(true);
    expect(sent.key_news[0].title).toContain('beats');
  });

  it('keeps seeded sentiment when no news key supplied', async () => {
    const out = await fetchRealFinancialData({ tickers: ['AAPL'] }, undefined);
    const sent = out.sentiment_data.AAPL;
    expect(sent.data_source).toBeUndefined();
  });
});

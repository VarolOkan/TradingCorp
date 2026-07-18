// src/registry/sources/adapters/news-sources.ts
// P4 (docs/MULTI_SOURCE_ARCHITECTURE.md §P4). The news_sentiment domain fans in
// across three live feeds — Finnhub (keyed), Yahoo RSS (key-free), Google News
// RSS (key-free). Their provider URLs moved here from news.ts so the legacy
// logic file is URL-free (grep-guard compliant). Each builder is a pure function.

/** Finnhub company-news endpoint (keyed). */
export function finnhubNewsUrl(ticker: string, key: string): string {
  // from = 30 days back so the feed is fresh but bounded.
  const from = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const to = new Date().toISOString().slice(0, 10);
  return `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(ticker)}&from=${from}&to=${to}&token=${key}`;
}

// Yahoo Finance RSS headline feed — a live, key-free feed that returns REAL
// article URLs (finance.yahoo.com/...html). Unlike the dead /v1/finance/news
// JSON endpoint (HTTP 500 without auth), this one works from the server and
// lets us extract a genuine story preview. Used as the primary no-key source.
export function yahooNewsRssUrl(ticker: string): string {
  return `https://finance.yahoo.com/news/rss/headline/?symbols=${encodeURIComponent(ticker)}`;
}

// Google News search feed (RSS) — a published, key-free feed. Headlines link to
// Google redirect URLs that resolve to the actual publisher story. Second
// fallback after Yahoo.
export function googleNewsRssUrl(ticker: string): string {
  return `https://news.google.com/rss/search?q=${encodeURIComponent(ticker)}&hl=en-US&gl=US&ceid=US:en`;
}

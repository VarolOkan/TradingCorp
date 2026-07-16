// src/server/news-routes.ts
// Phase 4 (live news + sentiment feed): GET /news?symbol=
// Returns real company-news headlines (Finnhub, tokenless after a free
// FINNHUB_KEY) + a deterministic keyword-polarity aggregate sentiment score,
// falling back to seeded headlines when the key/network is unavailable. Shapes
// the payload so the MarketDataCard News/Sentiment tab can render real news and
// the sentiment analyst can score it.
import type { Express } from 'express';
import https from 'node:https';
import { fetchCompanyNews, type NewsFetchFn } from '../registry/logic/news';

// Server-side fetch used for live news providers (Finnhub/Yahoo/Google) AND for
// article-preview extraction. We use Node's `https` (not global `fetch`/undici)
// with a raised `maxHeaderSize`, because some publisher pages (e.g. Yahoo)
// return 50+ `set-cookie` headers that make undici's fetch throw
// `HeadersOverflowError` before we can read the body. `https` lets us lift that
// limit. Redirects are followed manually (up to 4 hops).
const UA = 'Mozilla/5.0 (TradingCorp)';

function httpsGet(url: string, redirectsLeft = 4): Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  json: () => Promise<any>;
}> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { 'User-Agent': UA, Accept: 'text/html,application/xml,application/json,*/*' }, maxHeaderSize: 65536 },
      (res) => {
        const status = res.statusCode ?? 0;
        const loc = res.headers.location;
        if ((status === 301 || status === 302 || status === 303 || status === 307 || status === 308) && loc && redirectsLeft > 0) {
          res.resume(); // drain
          const next = loc.startsWith('http') ? loc : new URL(loc, url).toString();
          httpsGet(next, redirectsLeft - 1).then(resolve).catch(reject);
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          resolve({
            ok: status >= 200 && status < 300,
            status,
            text: () => Promise.resolve(body),
            json: () => Promise.resolve(body ? JSON.parse(body) : null),
          });
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('news fetch timeout')));
  });
}

const serverFetch: NewsFetchFn = (url: string) =>
  httpsGet(url).then((r) => ({
    ok: r.ok,
    status: r.status,
    text: r.text,
    json: r.json,
  }));

export function registerNewsRoutes(app: Express, fetchFn?: NewsFetchFn): void {
  app.get('/news', async (req, res) => {
    const symbol = typeof req.query.symbol === 'string' ? req.query.symbol.trim() : '';
    if (!symbol) {
      return res.status(400).json({ error: 'symbol query parameter is required' });
    }
    try {
      const result = await fetchCompanyNews(symbol, {
        ...(fetchFn ? { fetchFn } : {}),
        fetchFn: serverFetch,
      });
      return res.json(result);
    } catch (err) {
      return res.status(502).json({
        error: `news fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });
}

// src/registry/sources/adapters/finnhub-news.ts
// P1: pure parse for Finnhub company-news payload -> NewsHeadline[] + aggregate.
// Extracted from news.ts fetchCompanyNews inline block (behavior-identical).
// The async `enrichSummaries` fetch step is NOT part of normalize (adapters are
// pure) — the legacy fetch wrapper still calls it after normalize.

import type { NewsHeadline } from '../../logic/news';
import { scoreHeadline, scoreToLabel } from '../../logic/news';
import type { SourceAdapter, AdapterContext } from './types';

export interface FinnhubNormalized {
  headlines: NewsHeadline[];
  sentiment_score: number;
  sentiment_label: NewsHeadline['sentiment'];
}

/**
 * Parse a Finnhub `/company-news` array into headlines + aggregate score.
 * Returns null on a non-array / empty payload so the caller can fall through to
 * the next source (Yahoo RSS / Google / mock), preserving legacy fallback order.
 */
export function normalizeFinnhubNews(raw: unknown): FinnhubNormalized | null {
  const items: any[] = Array.isArray(raw) ? raw : [];
  if (items.length === 0) return null;
  const headlines: NewsHeadline[] = items
    .filter((it) => it && typeof it.headline === 'string')
    .map((it) => {
      const score = scoreHeadline(it.headline);
      return {
        title: it.headline,
        url: typeof it.url === 'string' ? it.url : '',
        source: typeof it.source === 'string' ? it.source : 'Finnhub',
        timestamp:
          typeof it.datetime === 'number'
            ? new Date(it.datetime * 1000).toISOString()
            : new Date().toISOString(),
        sentiment: scoreToLabel(score),
        score,
        ...(typeof it.summary === 'string' ? { summary: it.summary } : { summary: undefined }),
      } as NewsHeadline;
    })
    .sort((a, b) => +new Date(b.timestamp) - +new Date(a.timestamp))
    .slice(0, 30);
  if (headlines.length === 0) return null;
  const agg = Math.round(headlines.reduce((s, h) => s + h.score, 0) / headlines.length);
  return { headlines, sentiment_score: agg, sentiment_label: scoreToLabel(agg) };
}

export const finnhubNewsAdapter: SourceAdapter<'news_sentiment'> = {
  sourceId: 'finnhub',
  domain: 'news_sentiment',
  normalize(raw, ctx: AdapterContext) {
    const n = normalizeFinnhubNews(raw);
    if (!n) return null;
    return {
      ticker: ctx.ticker,
      headlines: n.headlines,
      sentiment_score: n.sentiment_score,
      sentiment_label: n.sentiment_label,
      source: 'finnhub',
    };
  },
};

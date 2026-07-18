// src/registry/logic/news.ts
// Phase 4 (live news + sentiment feed): real company-news headlines for a
// ticker, scored with a DETERMINISTIC keyword-polarity model (no LLM — free,
// auditable, reproducible). Headlines + an aggregate sentiment score are
// returned so (a) the MarketDataCard News/Sentiment tab can show real news even
// before an analysis run, and (b) the sentiment analyst's existing `realSent`
// hook fires (it reads ingested.sentiment[ticker].sentiment_score + key_news),
// turning the seeded sentiment verdict into a real one.

// Provider fallback chain (so the News tab always shows genuine stories when
// the server has network access, even with no FINNHUB_KEY):
//   Finnhub /company-news (key) -> Yahoo Finance news feed -> Google News RSS
//   -> synthetic seeded headlines (last resort, no network).

import { finnhubNewsAdapter } from '../sources/adapters/finnhub-news';
import { finnhubNewsUrl, yahooNewsRssUrl, googleNewsRssUrl } from '../sources/adapters/news-sources';

export interface NewsHeadline {
  title: string;
  url: string;
  source: string;
  timestamp: string; // ISO
  /** Per-headline polarity label. */
  sentiment: 'VERY_POSITIVE' | 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE' | 'VERY_NEGATIVE';
  /** Per-headline score, -100..+100 (deterministic). */
  score: number;
  /** Opening lines of the article (from Finnhub `summary`, or a seeded blurb
   *  in mock mode). Optional — not every source provides it. */
  summary?: string;
  /** Which aggregator the headline came from: 'yahoo' (real, previewable URL)
   *  or 'google' (redirect URL, not server-previewable). */
  sourceRoot?: 'yahoo' | 'google';
}

export interface SentimentConsensus {
  /** 0..1 agreement across sources (1 = identical, →0 = maximally divergent). */
  agreement: number;
  /** true when >1 source contributed AND agreement < threshold. */
  low_consensus: boolean;
  /** source ids that actually contributed to the blend. */
  contributors: string[];
  /** per-source breakdown for the trace drawer. */
  contributions: Array<{
    sourceId: string;
    value: number;
    weight: number;
    confidence: number;
    effectiveWeight: number;
    contribution: number;
  }>;
}

export interface NewsResult {
  ticker: string;
  headlines: NewsHeadline[];
  /** Aggregate sentiment score, -100..+100 (mean of headline scores, rounded). */
  sentiment_score: number;
  /** Aggregate label derived from sentiment_score. */
  sentiment_label: string;
  source: 'finnhub' | 'yahoo' | 'google' | 'mixed' | 'mock';
  note?: string;
  /** P2b: populated when ≥2 sources were weighed into this result (source:'mixed'). */
  consensus?: SentimentConsensus;
}

export type NewsFetchFn = (url: string) => Promise<{ ok: boolean; json: () => Promise<any>; text?: () => Promise<string>; status?: number }>;

// --- Deterministic keyword-polarity lexicon (auditable, no model) ---
const POSITIVE_TERMS: Record<string, number> = {
  beat: 25, beats: 25, 'above estimates': 25, 'tops': 20, upgrade: 22, upgraded: 22,
  'price target raised': 18, 'buy': 15, 'outperform': 18, 'strong buy': 20,
  'record': 14, 'growth': 12, 'surge': 18, 'soars': 22, 'jumps': 16, 'rallies': 16,
  'dividend increase': 16, 'expands': 10, 'profit': 14, 'beats estimates': 25,
  'new high': 16, 'bullish': 16, 'guidance raised': 18, 'partnership': 10,
};
const NEGATIVE_TERMS: Record<string, number> = {
  miss: -25, misses: -25, 'below estimates': -25, 'downgrade': -22, downgraded: -22,
  'price target cut': -18, 'sell': -15, 'underperform': -18, 'weak': -14,
  'plunge': -20, 'slumps': -16, 'tumbles': -18, 'drops': -12, 'falls': -10,
  'lawsuit': -18, 'investigation': -16, 'recall': -16, 'layoffs': -18, 'warning': -16,
  'guidance cut': -18, 'misses estimates': -25, 'new low': -16, 'bearish': -16,
  'default': -22, 'bankruptcy': -28, 'fraud': -26, 'probe': -14, 'fined': -14,
};

export function scoreHeadline(title: string): number {
  const t = ` ${title.toLowerCase()} `;
  // Single signed term list (positive = +w, negative = -w) so scoring is a
  // single reduction — no separate pos/neg loop whose branch the transpiler
  // could mangle.
  const SIGNED: Array<[string, number]> = [
    ['beat', 25], ['beats', 25], ['above estimates', 25], ['tops', 20], ['upgrade', 22], ['upgraded', 22],
    ['price target raised', 18], ['buy', 15], ['outperform', 18], ['strong buy', 20],
    ['record', 14], ['growth', 12], ['surge', 18], ['soars', 22], ['jumps', 16], ['rallies', 16],
    ['dividend increase', 16], ['expands', 10], ['profit', 14], ['beats estimates', 25],
    ['new high', 16], ['bullish', 16], ['guidance raised', 18], ['partnership', 10],
    ['miss', -25], ['misses', -25], ['below estimates', -25], ['downgrade', -22], ['downgraded', -22],
    ['price target cut', -18], ['sell', -15], ['underperform', -18], ['weak', -14],
    ['plunge', -20], ['slumps', -16], ['tumbles', -18], ['drops', -12], ['falls', -10],
    ['lawsuit', -18], ['investigation', -16], ['recall', -16], ['layoffs', -18], ['warning', -16],
    ['guidance cut', -18], ['misses estimates', -25], ['new low', -16], ['bearish', -16],
    ['default', -22], ['bankruptcy', -28], ['fraud', -26], ['probe', -14], ['fined', -14],
  ];
  const total = SIGNED.reduce((acc, [term, w]) => {
    return acc + (termIncludes(t, term) ? w : 0);
  }, 0);
  // clamp to -100..100
  return Math.max(-100, Math.min(100, total));
}

/**
 * Match a lexicon term against a headline. Multi-word phrases are matched as
 * substrings (they never collide meaningfully); single words use a word-boundary
 * regex so we never, e.g., score "upgrade" inside "regulator" or "beat" inside
 * "beaten". Word-boundary matching is strictly more precise than `includes`.
 */
function termIncludes(haystack: string, term: string): boolean {
  if (term.includes(' ')) return haystack.includes(term);
  return new RegExp(`\\b${escapeRegExp(term)}\\b`).test(haystack);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function scoreToLabel(score: number): NewsHeadline['sentiment'] {
  if (score >= 60) return 'VERY_POSITIVE';
  if (score >= 20) return 'POSITIVE';
  if (score >= -20) return 'NEUTRAL';
  if (score >= -60) return 'NEGATIVE';
  return 'VERY_NEGATIVE';
}

// Pull the opening 1-2 sentences of an article page so the News tab can show a
// genuine snippet of the original story (when the feed itself provides no
// summary, e.g. Google News RSS). This is a lightweight HTML->text extract:
// strip scripts/styles/tags, decode entities, then take the first two
// sentences, capped to ~320 chars. No LLM, no full-site scrape.
function extractLead(rawHtml: string): string {
  let s = rawHtml
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, ' ')
    .replace(/<(header|nav|footer|aside|noscript|svg|form|button)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  s = s
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&#0?39;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&#8217;/gi, "'").replace(/&#8216;/gi, "'").replace(/&#8220;/gi, '"')
    .replace(/&#8221;/gi, '"').replace(/&hellip;/gi, '…').replace(/&mdash;/gi, '—')
    .replace(/&ndash;/gi, '–');
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) return '';
  // Sentences that are clearly UI/interstitial noise, not article prose.
  const noise = /^(oops|skip to|sign in|subscribe|cookie|privacy|terms|menu|watch|listen|advertisement|your privacy choices|we and our partners)/i;
  const junk = /(shutterstock|getty|\.com|min read|edt|est|bst|@|at \d{1,2}:|reuters|bloomberg|ap photo|afp)/i;
  const sentences = s
    .split(/(?<=[.!?])\s+/)
    .map((x) => x.trim())
    .filter((x) => x.length > 0)
    // keep only sentences that look like real prose: long enough, contain a
    // lowercase letter + space (real writing), and aren't UI boilerplate.
    .filter((x) => x.length > 40 && /[a-z]\s/.test(x) && !noise.test(x) && !junk.test(x));
  if (sentences.length === 0) return '';
  let lead = sentences.slice(0, 2).join(' ');
  if (lead.length > 320) lead = lead.slice(0, 317).trimEnd() + '…';
  return lead;
}

// Fetch an article URL and return its lead text ('' on any failure — the UI
// already hides empty snippets, so a failed extract is a silent no-op).
async function fetchArticleLead(url: string, doFetch: NewsFetchFn): Promise<string> {
  try {
    const res = await doFetch(url);
    if (!res.ok) return '';
    const html = typeof res.text === 'function' ? await res.text() : '';
    return extractLead(html);
  } catch {
    return '';
  }
}

// Best-effort: populate `summary` for the top `limit` real headlines that don't
// already have one, by fetching the linked article and extracting its lead.
async function enrichSummaries(
  headlines: NewsHeadline[],
  doFetch: NewsFetchFn | undefined,
  limit = 6,
): Promise<void> {
  if (!doFetch) return;
  const needy = headlines.filter((h) => !h.summary && h.url).slice(0, limit);
  await Promise.all(
    needy.map(async (h) => {
      const lead = await fetchArticleLead(h.url, doFetch);
      if (lead) h.summary = lead;
    }),
  );
}

// Parse a Google News RSS <item> element into a NewsHeadline. Google wraps the
// real URL in a /rss/articles/ redirect; we keep that (it resolves to the
// actual story) rather than the intermediate news.google.com/article URL.
function parseGoogleRssItem(item: string): NewsHeadline | null {
  const grab = (tag: string): string => {
    const m = item.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>', 'i'));
    return m ? (m[1] ?? '').split('<![CDATA[').join('').split(']]>').join('').trim() : '';
  };
  const title = grab('title');
  const link = grab('link');
  if (!title || !link) return null;
  const pub = grab('pubDate');
  const sourceMatch = item.match(/<source[^>]*>([\s\S]*?)<\/source>/i);
  const source = sourceMatch ? (sourceMatch[1] ?? '').trim() : 'Google News';
  const score = scoreHeadline(title);
  return {
    title,
    url: link,
    source,
    sourceRoot: 'google',
    timestamp: pub ? new Date(pub).toISOString() : new Date().toISOString(),
    sentiment: scoreToLabel(score),
    score,
  };
}

// Parse a Yahoo Finance RSS <item> into a NewsHeadline. Yahoo gives a REAL
// article URL (finance.yahoo.com/...html) that we can fetch server-side for a
// genuine story preview, so these items get an inline snippet.
function parseYahooRssItem(item: string): NewsHeadline | null {
  const grab = (tag: string): string => {
    const m = item.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>', 'i'));
    return m ? (m[1] ?? '').split('<![CDATA[').join('').split(']]>').join('').trim() : '';
  };
  const title = grab('title');
  const link = grab('link');
  if (!title || !link) return null;
  const pub = grab('pubDate');
  const sourceMatch = item.match(/<source[^>]*>([\s\S]*?)<\/source>/i);
  const source = sourceMatch ? (sourceMatch[1] ?? '').trim() : 'Yahoo';
  const score = scoreHeadline(title);
  return {
    title,
    url: link,
    source,
    sourceRoot: 'yahoo',
    timestamp: pub ? new Date(pub).toISOString() : new Date().toISOString(),
    sentiment: scoreToLabel(score),
    score,
  };
}

// Merge Yahoo + Google headline lists into one de-duplicated, newest-first set.
// De-dup key is a normalized title so the same story from both feeds appears
// once (preferring the Yahoo variant, which carries a previewable URL).
function mergeHeadlines(yahoo: NewsHeadline[], google: NewsHeadline[]): NewsHeadline[] {
  const seen = new Set<string>();
  const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const out: NewsHeadline[] = [];
  const push = (h: NewsHeadline) => {
    const k = norm(h.title);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(h);
  };
  // Yahoo first (previewable), then Google fills the rest.
  yahoo.forEach(push);
  google.forEach(push);
  return out.sort((a, b) => +new Date(b.timestamp) - +new Date(a.timestamp));
}

/**
 * Fetch real company news + sentiment for a ticker, with a graceful fallback
 * chain so the News tab always shows genuine stories when the server has
 * network access — even with no FINNHUB_KEY:
 *   Finnhub (if key set + reachable) -> Yahoo Finance -> Google News RSS -> synthetic mock
 * Headlines are scored with the same deterministic keyword-polarity model
 * regardless of source, so the UI/analyst read is consistent.
 */
export async function fetchCompanyNews(
  symbol: string,
  opts: { fetchFn?: NewsFetchFn | undefined; finnhubKey?: string | undefined } = {},
): Promise<NewsResult> {
  const ticker = symbol.trim().toUpperCase();
  const key = opts.finnhubKey ?? (typeof process !== 'undefined' ? (process as any).env?.FINNHUB_KEY : undefined);
  const doFetch = opts.fetchFn;

  // 1) Finnhub (key required).
  if (key && typeof doFetch === 'function') {
    try {
      const res = await doFetch(finnhubNewsUrl(ticker, key));
      if (res.ok) {
        const payload = await res.json().catch(() => null);
        // P1: parse delegated to the Finnhub news adapter (pure, fixture-tested).
        const parsed = finnhubNewsAdapter.normalize(payload, { ticker });
        if (parsed) {
          await enrichSummaries(parsed.headlines, doFetch);
          return parsed;
        }
      }
    } catch {
      /* fall through to Yahoo */
    }
  }

  // 2) Yahoo Finance RSS headline feed (no key, real article URLs).
  let yahooHeadlines: NewsHeadline[] = [];
  if (typeof doFetch === 'function') {
    try {
      const res = await doFetch(yahooNewsRssUrl(ticker));
      if (res.ok) {
        const xml = typeof res.text === 'function' ? await res.text() : '';
        const items = xml.split('<item>').slice(1);
        yahooHeadlines = items
          .map((it) => parseYahooRssItem(it))
          .filter((h): h is NewsHeadline => h !== null)
          .sort((a, b) => +new Date(b.timestamp) - +new Date(a.timestamp))
          .slice(0, 30);
        // Yahoo URLs point to real finance.yahoo.com articles -> previewable.
        await enrichSummaries(yahooHeadlines, doFetch);
      }
    } catch {
      /* ignore Yahoo failure; continue to Google */
    }
  }

  // 3) Google News RSS (no key, key-free published feed). Combine with Yahoo so
  //    the News tab mixes both sources. Google links are redirects that a
  //    browser resolves to the publisher, but they can't be server-previewed
  //    (Google serves a JS shell), so only Yahoo items get an inline preview.
  let googleHeadlines: NewsHeadline[] = [];
  if (typeof doFetch === 'function') {
    try {
      const res = await doFetch(googleNewsRssUrl(ticker));
      if (res.ok) {
        const xml = typeof res.text === 'function' ? await res.text() : '';
        const items = xml.split('<item>').slice(1);
        googleHeadlines = items
          .map((it) => parseGoogleRssItem(it))
          .filter((h): h is NewsHeadline => h !== null)
          .sort((a, b) => +new Date(b.timestamp) - +new Date(a.timestamp))
          .slice(0, 30);
        // Enrich Google items with a preview when their (resolved) article URL
        // is server-fetchable. Real Google redirect URLs serve a JS shell and
        // will no-op here (extractLead returns '' on failure, UI hides empties),
        // but a fetchable publisher URL — as in tests and some feeds — gets a
        // genuine inline snippet, matching the Yahoo path.
        await enrichSummaries(googleHeadlines, doFetch);
      }
    } catch {
      /* ignore Google failure */
    }
  }

  // Merge Yahoo + Google, de-duplicated by title, newest first.
  const merged = mergeHeadlines(yahooHeadlines, googleHeadlines).slice(0, 30);
  if (merged.length) {
    const agg = Math.round(merged.reduce((s, h) => s + h.score, 0) / merged.length);
    const sources = new Set(merged.map((h) => h.sourceRoot));
    const label = yahooHeadlines.length && googleHeadlines.length ? 'mixed'
      : yahooHeadlines.length ? 'yahoo'
      : 'google';
    return {
      ticker,
      headlines: merged,
      sentiment_score: agg,
      sentiment_label: scoreToLabel(agg),
      source: label as NewsResult['source'],
      note: `yahoo=${yahooHeadlines.length} google=${googleHeadlines.length}`,
    };
  }

  // 4) Synthetic mock (last resort — no network / all fetches failed).
  const headlines = mockHeadlines(ticker);
  const agg = Math.round(headlines.reduce((s, h) => s + h.score, 0) / headlines.length);
  return {
    ticker,
    headlines,
    sentiment_score: agg,
    sentiment_label: scoreToLabel(agg),
    source: 'mock',
    note: key ? 'news fetch failed; using seeded headlines (parity)' : 'no news source reachable; using seeded headlines (parity)',
  };
}

// Seeded mock headlines (parity when no key/network) — shaped exactly like the
// Finnhub payload so downstream scoring + the UI are identical in form.
function mockHeadlines(ticker: string): NewsHeadline[] {
  const seedTerms: Array<[string, number]> = [
    [`${ticker} beats earnings estimates, raises full-year guidance`, 50],
    [`Analysts upgrade ${ticker} to Buy on strong demand`, 30],
    [`${ticker} announces dividend increase and buyback`, 28],
    [`${ticker} shares slip as supply chain concerns weigh`, -34],
    [`Regulators open investigation into ${ticker} practices`, -40],
    [`${ticker} unveils new product line at flagship event`, 18],
  ];
  const blurbs: Record<string, string> = {
    [`${ticker} beats earnings estimates, raises full-year guidance`]:
      `${ticker} reported quarterly results ahead of consensus and lifted its full-year outlook, citing stronger demand and disciplined cost controls.`,
    [`Analysts upgrade ${ticker} to Buy on strong demand`]:
      `Several sell-side desks raised their rating on ${ticker}, pointing to accelerating order growth and an improved margin trajectory.`,
    [`${ticker} announces dividend increase and buyback`]:
      `${ticker}'s board approved a higher quarterly dividend and an expanded share repurchase program, signaling confidence in free-cash-flow generation.`,
    [`${ticker} shares slip as supply chain concerns weigh`]:
      `${ticker} traded lower after management flagged ongoing supply-chain constraints that could pressure near-term delivery timelines.`,
    [`Regulators open investigation into ${ticker} practices`]:
      `A regulatory body confirmed a probe into ${ticker}'s business practices; the company said it is cooperating and expects no material disruption.`,
    [`${ticker} unveils new product line at flagship event`]:
      `${ticker} debuted a new product family at its marquee event, with availability and pricing expected in the coming quarters.`,
  };
  return seedTerms.map(([title, score], i) => ({
    title,
    // No real article exists in mock mode, so link to a live news search for
    // the headline instead of a dead example.com placeholder.
    url: `https://news.google.com/search?q=${encodeURIComponent(title)}`,
    source: ['Bloomberg', 'Reuters', 'CNBC', 'WSJ', 'FT', 'MarketWatch'][i % 6]!,
    timestamp: new Date(Date.now() - i * 36 * 3600 * 1000).toISOString(),
    sentiment: scoreToLabel(score),
    score,
    summary: blurbs[title] ?? '',
  }));
}

/**
 * Build the `ingested.sentiment[ticker]` object the sentiment analyst expects.
 * When real news is available this carries a genuine `sentiment_score` + real
 * `key_news`, so performSentimentAnalysis takes its data-driven branch.
 */
export function newsToIngestedSentiment(news: NewsResult): {
  sentiment_score: number;
  news_sentiment: string;
  key_news: Array<{ title: string; summary: string; sentiment: string; timestamp: string; source: string }>;
  data_source: string;
} {
  return {
    sentiment_score: news.sentiment_score,
    news_sentiment: news.sentiment_label,
    key_news: news.headlines.slice(0, 8).map((h) => ({
      title: h.title,
      summary: h.summary ?? '',
      sentiment: h.sentiment,
      timestamp: h.timestamp,
      source: h.source,
    })),
    data_source: `${news.source}:live-news`,
  };
}

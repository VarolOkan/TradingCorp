// frontend/src/api/newsClient.ts
// Client for the Phase 4 live news + sentiment endpoint (GET /news).
export type NewsSentimentLabel =
  | 'VERY_POSITIVE'
  | 'POSITIVE'
  | 'NEUTRAL'
  | 'NEGATIVE'
  | 'VERY_NEGATIVE';

export interface NewsHeadline {
  title: string;
  url: string;
  source: string;
  timestamp: string;
  sentiment: NewsSentimentLabel;
  score: number;
  /** Opening lines of the article, when the source provides them. */
  summary?: string;
  /** Which aggregator the headline came from: 'yahoo' (real, previewable URL)
   *  or 'google' (redirect URL; link opens in a new tab, no inline preview). */
  sourceRoot?: 'yahoo' | 'google';
}

export interface NewsResult {
  ticker: string;
  headlines: NewsHeadline[];
  sentiment_score: number;
  sentiment_label: NewsSentimentLabel;
  source: 'finnhub' | 'yahoo' | 'google' | 'mixed' | 'mock';
  note?: string;
}

export async function getNews(symbol: string): Promise<NewsResult> {
  const params = new URLSearchParams({ symbol: symbol.trim().toUpperCase() });
  const res = await fetch(`/news?${params.toString()}`);
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data.error) detail = data.error;
    } catch {
      /* keep generic */
    }
    throw new Error(`Failed to load news: ${detail}`);
  }
  return (await res.json()) as NewsResult;
}

export function sentimentClass(label: NewsSentimentLabel): string {
  return `sentiment-${label.toLowerCase()}`;
}

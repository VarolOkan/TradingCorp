// src/registry/logic/sentiment.ts
// Phase 3 extraction (doc §8 Phase 3). Pure sentiment-analysis handler.
// SentimentAnalystNode is now a thin shim that delegates here.

import type { AgentState, SentimentAnalysis } from '../../types/financial-analysis';
import { instructionFor } from '../prompts';
import {
  stringToSeed,
  seededRandom,
  updateInvestmentThesis,
  hasTickers,
  annotateDataReceived,
  recordDataReceived,
  type NodeSurface,
} from './shared';
import type { AnalystTuning } from '../../types/registry';

export type { NodeSurface };

export async function sentimentHandler(
  state: AgentState,
  node: NodeSurface,
  tuning?: AnalystTuning,
): Promise<AgentState> {
  let updatedState = node.updateStep(state, 'sentiment_analysis_start');
  node.emitProgress(updatedState, 'analyst:start', 'sentiment', { stage: 2 });

  updatedState = node.addMessage(updatedState, 'system',
    `Starting sentiment analysis for ${state.tickers.length} ticker(s): ${state.tickers.join(', ')}`);

  try {
    if (!hasTickers(state)) {
      throw new Error('No tickers specified for sentiment analysis');
    }

    const analyses: Record<string, SentimentAnalysis> = {};
    let usedLiveSentiment = false;
    for (const ticker of state.tickers) {
      analyses[ticker] = performSentimentAnalysis(ticker, tuning, state.ingested);
      const realSent = state.ingested?.sentiment?.[ticker];
      if (realSent && typeof realSent.data_source === 'string' && realSent.data_source.includes('live')) {
        usedLiveSentiment = true;
      }
      if (realSent && typeof realSent === 'object' && typeof realSent.sentiment_score === 'number') {
        const live = typeof realSent.data_source === 'string' && realSent.data_source.includes('live');
        updatedState = recordDataReceived(updatedState, annotateDataReceived(
          'sentiment', ticker, 'ingested',
          [{ domain: 'sentiment', source: live ? 'live' : 'seeded' }],
          live ? 'live' : 'seeded-parity',
          live ? 'live sentiment supplied upstream' : 'seeded sentiment supplied upstream',
        ));
      } else {
        updatedState = recordDataReceived(updatedState, annotateDataReceived(
          'sentiment', ticker, 'ingested',
          [{ domain: 'sentiment', source: 'seeded' }],
          'seeded-parity', 'no ingested.sentiment — sentiment ran on seeded fallback',
        ));
      }
    }

    updatedState = {
      ...updatedState,
      messages: [
        ...(updatedState.messages || []),
        {
          role: 'system',
          content: `Sentiment analysis completed for ${state.tickers.length} ticker(s)`,
          timestamp: new Date().toISOString(),
          data: { analyses, summary: generateAnalysisSummary(analyses) },
        },
      ],
      investment_thesis: updateInvestmentThesis(state.investment_thesis, generateAnalysisSummary(analyses), 'SENTIMENT'),
    };

    updatedState = node.captureTrace(updatedState, {
      analyst: 'sentiment',
      name: 'Sentiment Analyst',
      stage: 2,
      instructions: instructionFor('sentiment'),
      inputs: state.tickers.map((ticker) => ({
        ticker,
        label: 'News / social / analyst / institutional sentiment',
        data: {
          news_sentiment: analyses[ticker]?.news_sentiment,
          social_sentiment: analyses[ticker]?.social_sentiment,
          analyst_sentiment: analyses[ticker]?.analyst_sentiment,
          institutional_sentiment: analyses[ticker]?.institutional_sentiment,
          sentiment_score: analyses[ticker]?.sentiment_score,
          news_count: analyses[ticker]?.key_news?.length,
          social_mentions: analyses[ticker]?.social_trends?.length,
        },
        sources: analyses[ticker]?.social_trends && analyses[ticker]?.data_source?.includes('live')
          ? ['Finnhub company-news (live)']
          : ['Finnhub company-news (live)', 'Social (proxy from news)'],
      })),
      weighting: [
        { label: 'News posture', inputs: ['news_sentiment', 'key_news'], weight: 0.35, rationale: 'Curated news is the most reliable signal of fundamental narrative.', contribution: 35, scale: '0..100 score weight' },
        { label: 'Analyst & institutional posture', inputs: ['analyst_sentiment', 'institutional_sentiment'], weight: 0.35, rationale: 'Sell-side and institutional positioning carry weight near catalysts.', contribution: 35, scale: '0..100 score weight' },
        { label: 'Social confirmation / divergence', inputs: ['social_sentiment', 'social_trends'], weight: 0.3, rationale: 'Social used as confirmation; flagged when it diverges from news.', contribution: 30, scale: '0..100 score weight' },
      ],
      output: {
        score: avgSentimentScore(analyses),
        verdict: avgSentimentScore(analyses) >= 25 ? 'BULLISH' : avgSentimentScore(analyses) >= -25 ? 'NEUTRAL' : 'BEARISH',
        summary: generateAnalysisSummary(analyses),
        details: { analyses },
      },
      notes: usedLiveSentiment
        ? ['Sentiment driven by live Finnhub company-news; divergent news vs social is surfaced as a watch item.']
        : ['No live news feed configured — sentiment ran on seeded fallback; divergent news vs social is surfaced as a watch item.'],
    });

    node.emitProgress(updatedState, 'analyst:done', 'sentiment', {
      stage: 2,
      tickers: state.tickers,
      summary: generateAnalysisSummary(analyses),
    });
    return updatedState;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      ...updatedState,
      error: `Sentiment analysis error: ${errorMessage}`,
      current_step: 'sentiment_analysis_error',
      messages: [
        ...(updatedState.messages || []),
        { role: 'error', content: `Failed to perform sentiment analysis: ${errorMessage}`, timestamp: new Date().toISOString() },
      ],
    };
  }
}

function performSentimentAnalysis(
  ticker: string,
  tuning?: AnalystTuning,
  ingested?: AgentState['ingested'],
): SentimentAnalysis {
  const seed = stringToSeed(ticker + '_sentiment');
  const rng = seededRandom(seed);
  const horizon = tuning?.horizon ?? 'LONG_TERM';

  // Phase E: when a real sentiment object was ingested, use its scores. Falls
  // back to the seeded path (parity default) when absent.
  const realSent = ingested?.sentiment?.[ticker];
  if (realSent && typeof realSent === 'object' && typeof realSent.sentiment_score === 'number') {
    const s = Math.max(-100, Math.min(100, Math.round(realSent.sentiment_score)));
    return {
      news_sentiment: realSent.news_sentiment ?? getSentimentLabel(s),
      social_sentiment: realSent.social_sentiment ?? getSentimentLabel(s),
      analyst_sentiment: realSent.analyst_sentiment ?? getSentimentLabel(s),
      institutional_sentiment: realSent.institutional_sentiment ?? getSentimentLabel(s),
      sentiment_score: s,
      key_news: Array.isArray(realSent.key_news) ? realSent.key_news : generateKeyNews(rng, ticker),
      social_trends: Array.isArray(realSent.social_trends)
        ? realSent.social_trends
        : generateSocialTrends(rng, ticker, horizon === 'INTRADAY' ? 1 : 0),
      data_source: `${ingested?.source ?? 'mixed'}:live-sentiment`,
    } as SentimentAnalysis;
  }

  const sentimentScore = Math.floor(rng() * 201) - 100;
  const newsSentiment = getSentimentLabel(sentimentScore);
  const socialSentiment = getSentimentLabel(sentimentScore + (rng() * 40 - 20));
  const analystSentiment = getSentimentLabel(sentimentScore + (rng() * 30 - 15));
  const institutionalSentiment = getSentimentLabel(sentimentScore + (rng() * 25 - 12.5));

  const keyNews = generateKeyNews(rng, ticker);
  // Intraday amplifies social volume: one extra trend item.
  const socialTrends = generateSocialTrends(rng, ticker, horizon === 'INTRADAY' ? 1 : 0);

  return {
    news_sentiment: newsSentiment,
    social_sentiment: socialSentiment,
    analyst_sentiment: analystSentiment,
    institutional_sentiment: institutionalSentiment,
    sentiment_score: sentimentScore,
    key_news: keyNews,
    social_trends: socialTrends,
  };
}

function getSentimentLabel(score: number): string {
  if (score >= 60) return 'VERY_POSITIVE';
  if (score >= 20) return 'POSITIVE';
  if (score >= -20) return 'NEUTRAL';
  if (score >= -60) return 'NEGATIVE';
  return 'VERY_NEGATIVE';
}

function generateKeyNews(rng: () => number, ticker: string): Array<{ title: string; summary: string; sentiment: string; timestamp: string; source: string }> {
  const newsTemplates = [
    { title: `${ticker} Reports Quarterly Earnings`, summary: `${ticker} announced quarterly results that were ${getRandomFromArray(rng, ['above', 'below', 'in line with'])} analyst expectations.`, sentiment: ['POSITIVE', 'NEGATIVE', 'NEUTRAL'][Math.floor(rng() * 3)] },
    { title: `${ticker} Announces New Product Launch`, summary: `${ticker} unveiled a new product line that analysts believe could ${getRandomFromArray(rng, ['boost', 'have minimal impact on', 'potentially harm'])} future revenues.`, sentiment: ['POSITIVE', 'NEUTRAL', 'NEGATIVE'][Math.floor(rng() * 3)] },
    { title: `${ticker} Faces Regulatory Scrutiny`, summary: `Regulators are investigating ${ticker} over concerns about ${getRandomFromArray(rng, ['data privacy', 'market competition', 'environmental impact'])}.`, sentiment: ['NEGATIVE', 'NEUTRAL', 'POSITIVE'][Math.floor(rng() * 3)] },
    { title: `${ticker} Upgraded by Major Brokerage`, summary: `A leading brokerage firm upgraded ${ticker} to ${getRandomFromArray(rng, ['Buy', 'Hold', 'Sell'])} citing ${getRandomFromArray(rng, ['strong fundamentals', 'valuation concerns', 'growth prospects'])}.`, sentiment: ['POSITIVE', 'NEUTRAL', 'NEGATIVE'][Math.floor(rng() * 3)] },
    { title: `${ticker} Announces Dividend Increase`, summary: `${ticker}'s board declared a quarterly dividend of $${(rng() * 2 + 0.5).toFixed(2)} per share, representing a ${(rng() * 10 + 2).toFixed(1)}% increase.`, sentiment: 'POSITIVE' },
  ];

  const numNewsItems = Math.floor(rng() * 3) + 1;
  const newsItems: any[] = [];
  for (let i = 0; i < numNewsItems; i++) {
    const templateIdx = Math.floor(rng() * newsTemplates.length);
    const template = newsTemplates[templateIdx]!;
    const daysAgo = Math.floor(rng() * 7);
    const date = new Date();
    date.setDate(date.getDate() - daysAgo);
    newsItems.push({
      title: template.title,
      summary: template.summary,
      sentiment: template.sentiment,
      timestamp: date.toISOString(),
      source: getRandomFromArray(rng, ['Bloomberg', 'Reuters', 'CNBC', 'Wall Street Journal', 'Financial Times']),
    });
  }
  return newsItems;
}

function generateSocialTrends(rng: () => number, ticker: string, extra = 0): string[] {
  const positiveTrends = [
    `${ticker} trending positively on social media with bullish sentiment`,
    `Increasing mentions of ${ticker} in investment forums`,
    `Social media buzz around ${ticker}'s recent product announcement`,
    `Positive investor sentiment growing for ${ticker} on Twitter and Reddit`,
  ];
  const negativeTrends = [
    `${ticker} facing criticism on social media for recent controversies`,
    `Negative sentiment growing around ${ticker} in online trading communities`,
    `Concerns raised about ${ticker}'s management on investor forums`,
    `Declining social media mentions for ${ticker} suggest waning interest`,
  ];
  const neutralTrends = [
    `Mixed sentiment for ${ticker} on social media platforms`,
    `Steady level of discussion around ${ticker} in investment circles`,
    `Normal social media activity for ${ticker} with no extreme sentiment`,
    `Balanced bullish and bearish views on ${ticker} across social platforms`,
  ];

  const numTrends = Math.floor(Math.abs(rng()) * 3) + 1 + extra;
  const trends: string[] = [];
  for (let i = 0; i < numTrends; i++) {
    const sentimentBias = Math.abs(rng());
    let selectedTrends: string[];
    if (sentimentBias > 0.6) selectedTrends = positiveTrends;
    else if (sentimentBias < 0.4) selectedTrends = negativeTrends;
    else selectedTrends = neutralTrends;
    const trendIndex = Math.floor(Math.abs(rng()) * selectedTrends.length);
    trends.push(selectedTrends[trendIndex]!);
  }
  return trends;
}

function getRandomFromArray(rng: () => number, array: any[]): any {
  const index = Math.floor(rng() * array.length);
  return array[index];
}

function generateAnalysisSummary(analyses: Record<string, any>): string {
  const tickers = Object.keys(analyses);
  if (tickers.length === 0) return 'No analyses performed';
  let totalScore = 0;
  let count = 0;
  for (const ticker in analyses) {
    if (Object.prototype.hasOwnProperty.call(analyses, ticker)) {
      totalScore += analyses[ticker].sentiment_score;
      count++;
    }
  }
  const avgScore = count > 0 ? totalScore / count : 0;
  return `Average sentiment score across ${tickers.length} ticker(s): ${avgScore.toFixed(1)}/100`;
}

function avgSentimentScore(analyses: Record<string, SentimentAnalysis>): number {
  const tickers = Object.keys(analyses);
  if (tickers.length === 0) return 0;
  const total = tickers.reduce((sum, t) => sum + (analyses[t]?.sentiment_score ?? 0), 0);
  return Math.round(total / tickers.length);
}

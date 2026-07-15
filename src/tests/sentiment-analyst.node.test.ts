// src/tests/sentiment-analyst.node.test.ts
// Unit tests for the Sentiment analyst handler (registry/logic/sentiment.ts).

import { sentimentHandler } from '../registry/logic/sentiment';
import { makeNodeSurface } from '../registry/logic/shared';
import { AgentState } from '../types/financial-analysis';

const surface = makeNodeSurface();

describe('Sentiment analyst handler', () => {
  const run = (over: Partial<AgentState> = {}): Promise<AgentState> =>
    sentimentHandler(
      {
        messages: [{ role: 'user', content: 'Analyze AAPL', timestamp: new Date().toISOString() }],
        current_date: '', tickers: ['AAPL'], company_name: 'AAPL',
        investment_thesis: '', final_decision: '', error: null,
        current_step: 'technical_analysis_complete', ...over,
      },
      surface,
    );

  it('should perform sentiment analysis for valid tickers', async () => {
    const result = await run();
    expect(result.tickers).toEqual(['AAPL']);
    expect(result.error).toBeNull();
    expect(result.current_step).toBe('sentiment_analysis_start');
    expect(result.messages).toHaveLength(3);
    const lastMessage = result.messages[result.messages.length - 1];
    expect(lastMessage.role).toBe('system');
    expect(lastMessage.content).toContain('Sentiment analysis completed');
  });

  it('should handle multiple tickers', async () => {
    const result = await run({ tickers: ['AAPL', 'MSFT'], company_name: 'AAPL, MSFT' });
    expect(result.tickers).toEqual(['AAPL', 'MSFT']);
    expect(result.error).toBeNull();
    expect(result.current_step).toBe('sentiment_analysis_start');
    expect(result.messages).toHaveLength(3);
    const lastMessage = result.messages[result.messages.length - 1];
    expect(lastMessage.role).toBe('system');
    expect(lastMessage.content).toContain('Sentiment analysis completed');
  });

  it('should handle empty tickers gracefully', async () => {
    const result = await run({ tickers: [], company_name: '' });
    expect(result.tickers).toEqual([]);
    expect(result.error).toContain('Sentiment analysis error');
    expect(result.current_step).toBe('sentiment_analysis_error');
    expect(result.messages).toHaveLength(3);
    const lastMessage = result.messages[result.messages.length - 1];
    expect(lastMessage.role).toBe('error');
    expect(lastMessage.content).toContain('Failed to perform sentiment analysis');
  });

  it('should update investment thesis with analysis results', async () => {
    const result = await run({ investment_thesis: 'Initial thesis: Strong technicals.' });
    expect(result.investment_thesis).toContain('Initial thesis: Strong technicals.');
    expect(result.investment_thesis).toContain('[SENTIMENT ANALYSIS]');
  });
});

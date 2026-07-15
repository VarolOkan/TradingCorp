// src/tests/risk-analyst.node.test.ts
// Unit tests for the Risk analyst handler (registry/logic/risk.ts).

import { riskHandler } from '../registry/logic/risk';
import { makeNodeSurface } from '../registry/logic/shared';
import { AgentState } from '../types/financial-analysis';

const surface = makeNodeSurface();

describe('Risk analyst handler', () => {
  const run = (over: Partial<AgentState> = {}): Promise<AgentState> =>
    riskHandler(
      {
        messages: [{ role: 'user', content: 'Analyze AAPL', timestamp: new Date().toISOString() }],
        current_date: '', tickers: ['AAPL'], company_name: 'AAPL',
        investment_thesis: '', final_decision: '', error: null,
        current_step: 'sentiment_analysis_complete', ...over,
      },
      surface,
    );

  it('should perform risk analysis for valid tickers', async () => {
    const result = await run();
    expect(result.tickers).toEqual(['AAPL']);
    expect(result.error).toBeNull();
    expect(result.current_step).toBe('risk_analysis_start');
    expect(result.messages).toHaveLength(3);
    const lastMessage = result.messages[result.messages.length - 1];
    expect(lastMessage.role).toBe('system');
    expect(lastMessage.content).toContain('Risk analysis completed');
  });

  it('should handle multiple tickers', async () => {
    const result = await run({ tickers: ['AAPL', 'MSFT'], company_name: 'AAPL, MSFT' });
    expect(result.tickers).toEqual(['AAPL', 'MSFT']);
    expect(result.error).toBeNull();
    expect(result.current_step).toBe('risk_analysis_start');
    expect(result.messages).toHaveLength(3);
    const lastMessage = result.messages[result.messages.length - 1];
    expect(lastMessage.role).toBe('system');
    expect(lastMessage.content).toContain('Risk analysis completed');
  });

  it('should handle empty tickers gracefully', async () => {
    const result = await run({ tickers: [], company_name: '' });
    expect(result.tickers).toEqual([]);
    expect(result.error).toContain('Risk analysis error');
    expect(result.current_step).toBe('risk_analysis_error');
    expect(result.messages).toHaveLength(3);
    const lastMessage = result.messages[result.messages.length - 1];
    expect(lastMessage.role).toBe('error');
    expect(lastMessage.content).toContain('Failed to perform risk analysis');
  });

  it('should update investment thesis with analysis results', async () => {
    const result = await run({ investment_thesis: 'Initial thesis: Strong fundamentals and technicals.' });
    expect(result.investment_thesis).toContain('Initial thesis: Strong fundamentals and technicals.');
    expect(result.investment_thesis).toContain('[RISK ANALYSIS]');
  });
});

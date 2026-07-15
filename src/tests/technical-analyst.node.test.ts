// src/tests/technical-analyst.node.test.ts
// Unit tests for the Technical analyst handler (registry/logic/technical.ts).

import { technicalHandler } from '../registry/logic/technical';
import { makeNodeSurface } from '../registry/logic/shared';
import { AgentState } from '../types/financial-analysis';

const surface = makeNodeSurface();

describe('Technical analyst handler', () => {
  const run = (over: Partial<AgentState> = {}): Promise<AgentState> =>
    technicalHandler(
      {
        messages: [{ role: 'user', content: 'Analyze AAPL', timestamp: new Date().toISOString() }],
        current_date: '', tickers: ['AAPL'], company_name: 'AAPL',
        investment_thesis: '', final_decision: '', error: null,
        current_step: 'fundamental_analysis_complete', ...over,
      },
      surface,
    );

  it('should perform technical analysis for valid tickers', async () => {
    const result = await run();
    expect(result.tickers).toEqual(['AAPL']);
    expect(result.error).toBeNull();
    expect(result.current_step).toBe('technical_analysis_start');
    expect(result.messages).toHaveLength(3);
    const lastMessage = result.messages[result.messages.length - 1];
    expect(lastMessage.role).toBe('system');
    expect(lastMessage.content).toContain('Technical analysis completed');
  });

  it('should handle multiple tickers', async () => {
    const result = await run({ tickers: ['AAPL', 'MSFT'], company_name: 'AAPL, MSFT' });
    expect(result.tickers).toEqual(['AAPL', 'MSFT']);
    expect(result.error).toBeNull();
    expect(result.current_step).toBe('technical_analysis_start');
    expect(result.messages).toHaveLength(3);
    const lastMessage = result.messages[result.messages.length - 1];
    expect(lastMessage.role).toBe('system');
    expect(lastMessage.content).toContain('Technical analysis completed');
  });

  it('should handle empty tickers gracefully', async () => {
    const result = await run({ tickers: [], company_name: '' });
    expect(result.tickers).toEqual([]);
    expect(result.error).toContain('Technical analysis error');
    expect(result.current_step).toBe('technical_analysis_error');
    expect(result.messages).toHaveLength(3);
    const lastMessage = result.messages[result.messages.length - 1];
    expect(lastMessage.role).toBe('error');
    expect(lastMessage.content).toContain('Failed to perform technical analysis');
  });

  it('should update investment thesis with analysis results', async () => {
    const result = await run({ investment_thesis: 'Initial thesis: Strong fundamentals.' });
    expect(result.investment_thesis).toContain('Initial thesis: Strong fundamentals.');
    expect(result.investment_thesis).toContain('[TECHNICAL ANALYSIS]');
  });
});

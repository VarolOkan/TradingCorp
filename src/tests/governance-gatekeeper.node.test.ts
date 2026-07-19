// src/tests/governance-gatekeeper.node.test.ts
// Unit tests for the Governance handler (registry/logic/governance.ts).

import { governanceHandler } from '../registry/logic/governance';
import { makeNodeSurface } from '../registry/logic/shared';
import { AgentState } from '../types/financial-analysis';

const surface = makeNodeSurface();

// Hermetic: pure-governance tests must not read a real decision-log file from
// disk (which would inject Phase 2 reflections and change the message count).
// The decision-log reflection is covered by decision-log-reflection.test.ts.
beforeAll(() => { process.env.DECISION_LOG_ENABLED = 'false'; });
afterAll(() => { delete process.env.DECISION_LOG_ENABLED; });

describe('Governance handler', () => {
  const run = (over: Partial<AgentState> = {}): Promise<AgentState> =>
    governanceHandler(
      {
        messages: [{ role: 'user', content: 'Analyze AAPL', timestamp: new Date().toISOString() }],
        current_date: '', tickers: ['AAPL'], company_name: 'AAPL',
        investment_thesis: '', final_decision: '', error: null,
        current_step: 'risk_analysis_complete', ...over,
      },
      surface,
    );

  it('should perform governance review for valid tickers', async () => {
    const result = await run();
    expect(result.tickers).toEqual(['AAPL']);
    expect(result.error).toBeNull();
    expect(result.current_step).toBe('governance_gatekeeper_start');
    expect(result.messages).toHaveLength(3);
    const lastMessage = result.messages[result.messages.length - 1];
    expect(lastMessage.role).toBe('system');
    expect(lastMessage.content).toContain('Governance review completed');
  });

  it('should handle multiple tickers', async () => {
    const result = await run({ tickers: ['AAPL', 'MSFT'], company_name: 'AAPL, MSFT' });
    expect(result.tickers).toEqual(['AAPL', 'MSFT']);
    expect(result.error).toBeNull();
    expect(result.current_step).toBe('governance_gatekeeper_start');
    expect(result.messages).toHaveLength(3);
    const lastMessage = result.messages[result.messages.length - 1];
    expect(lastMessage.role).toBe('system');
    expect(lastMessage.content).toContain('Governance review completed');
  });

  it('should handle empty tickers gracefully', async () => {
    const result = await run({ tickers: [], company_name: '' });
    expect(result.tickers).toEqual([]);
    expect(result.error).toContain('Governance review error');
    expect(result.current_step).toBe('governance_gatekeeper_error');
    expect(result.messages).toHaveLength(3);
    const lastMessage = result.messages[result.messages.length - 1];
    expect(lastMessage.role).toBe('error');
    expect(lastMessage.content).toContain('Failed to complete governance review');
  });

  it('should set final decision in state', async () => {
    const result = await run();
    expect(['APPROVE', 'REJECT']).toContain(result.final_decision);
    expect(result.investment_thesis).toContain('[GOVERNANCE ANALYSIS]');
  });
});

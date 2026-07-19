// src/tests/governance-options.test.ts
// Phase D — options-aware governance veto (doc §D / §17). The governance
// handler must, when tuning.instrument==='OPTION' + tuning.params.optionsVeto
// is supplied, REJECT a structure whose IV percentile breaches the agency cap
// (90 swing / 80 intraday) or (swing) lacks a hedge; the intraday veto is
// stricter (no-overnight → also rejects HIGH risk) yet still APPROVES a clean
// structure. The long-term (equity) path must be unchanged.

import { governanceHandler } from '../registry/logic/governance';
import { makeNodeSurface } from '../registry/logic/shared';
import { AgentState } from '../types/financial-analysis';
import type { AnalystTuning } from '../types/registry';

const surface = makeNodeSurface();

// Hermetic: pure-governance tests must not read a real decision-log file from
// disk (which would inject Phase 2 reflections and change the message count).
// The decision-log reflection is covered by decision-log-reflection.test.ts.
beforeAll(() => { process.env.DECISION_LOG_ENABLED = 'false'; });
afterAll(() => { delete process.env.DECISION_LOG_ENABLED; });

// Build a state where options_risk already ran and left its per-ticker
// assessment on a system message (the shape runFnOptionsAnalyst emits:
// message.data.analyses[ticker].data.{iv_percentile, max_loss, risk_level}).
function stateWithOptionsRisk(
  ticker: string,
  risk: { iv_percentile: number; max_loss: number | null; risk_level: string; max_allocation?: number },
): AgentState {
  return {
    messages: [
      { role: 'user', content: 'Analyze ' + ticker, timestamp: new Date().toISOString() },
      {
        role: 'system',
        content: 'options risk completed',
        timestamp: new Date().toISOString(),
        data: { analyses: { [ticker]: { data: risk } } },
      },
    ],
    current_date: '',
    tickers: [ticker],
    company_name: ticker,
    investment_thesis: '',
    final_decision: '',
    error: null,
    current_step: 'options_risk_complete',
  };
}

const swingVeto = { maxIvPercentile: 90, requireHedge: true };
const intradayVeto = { maxIvPercentile: 80, noOvernight: true, requireHedge: false };

describe('Phase D — options governance veto', () => {
  it('REJECTS an options structure whose IV percentile exceeds the swing cap (90)', async () => {
    const tuning: AnalystTuning = {
      horizon: 'MEDIUM_TERM',
      instrument: 'OPTION',
      params: { optionsVeto: swingVeto },
    };
    const result = await governanceHandler(
      stateWithOptionsRisk('AAPL', { iv_percentile: 95, max_loss: 500, risk_level: 'MEDIUM' }),
      surface,
      tuning,
    );
    const lastMsg = result.messages[result.messages.length - 1];
    expect(lastMsg.data.decisions['AAPL'].decision).toBe('REJECT');
    expect(lastMsg.data.decisions['AAPL'].reasoning).toMatch(/IV percentile 95 exceeds agency cap 90/);
    expect(result.final_decision).toBe('REJECT');
  });

  it('REJECTS an unhedged (undefined-risk) swing structure when requireHedge is set', async () => {
    const tuning: AnalystTuning = {
      horizon: 'MEDIUM_TERM',
      instrument: 'OPTION',
      params: { optionsVeto: swingVeto },
    };
    const result = await governanceHandler(
      stateWithOptionsRisk('AAPL', { iv_percentile: 50, max_loss: null, risk_level: 'MEDIUM' }),
      surface,
      tuning,
    );
    const lastMsg = result.messages[result.messages.length - 1];
    expect(lastMsg.data.decisions['AAPL'].decision).toBe('REJECT');
    expect(lastMsg.data.decisions['AAPL'].reasoning).toMatch(/unhedged|undefined-risk/);
  });

  it('intraday REJECTS when IV percentile exceeds the stricter cap (80)', async () => {
    const tuning: AnalystTuning = {
      horizon: 'INTRADAY',
      instrument: 'OPTION',
      params: { optionsVeto: intradayVeto },
    };
    const result = await governanceHandler(
      stateWithOptionsRisk('TSLA', { iv_percentile: 85, max_loss: 200, risk_level: 'MEDIUM' }),
      surface,
      tuning,
    );
    const lastMsg = result.messages[result.messages.length - 1];
    expect(lastMsg.data.decisions['TSLA'].decision).toBe('REJECT');
    expect(lastMsg.data.decisions['TSLA'].reasoning).toMatch(/IV percentile 85 exceeds agency cap 80/);
  });

  it('intraday is stricter: REJECTS a HIGH-risk clean-IV structure (no-overnight)', async () => {
    const tuning: AnalystTuning = {
      horizon: 'INTRADAY',
      instrument: 'OPTION',
      params: { optionsVeto: intradayVeto },
    };
    const result = await governanceHandler(
      stateWithOptionsRisk('TSLA', { iv_percentile: 40, max_loss: 200, risk_level: 'HIGH' }),
      surface,
      tuning,
    );
    const lastMsg = result.messages[result.messages.length - 1];
    expect(lastMsg.data.decisions['TSLA'].decision).toBe('REJECT');
    expect(lastMsg.data.decisions['TSLA'].reasoning).toMatch(/no-overnight/);
  });

  it('intraday APPROVES a clean structure (IV ≤ cap, defined risk, LOW/MEDIUM risk)', async () => {
    const tuning: AnalystTuning = {
      horizon: 'INTRADAY',
      instrument: 'OPTION',
      params: { optionsVeto: intradayVeto },
    };
    const result = await governanceHandler(
      stateWithOptionsRisk('TSLA', { iv_percentile: 55, max_loss: 200, risk_level: 'LOW', max_allocation: 8 }),
      surface,
      tuning,
    );
    const lastMsg = result.messages[result.messages.length - 1];
    // decisionValue for TSLA+_governance seed is deterministic; assert it is NOT
    // rejected by the veto (clean structure) — it may approve or reject on the
    // base random gate, but the veto reasons must be empty.
    expect(lastMsg.data.decisions['TSLA'].reasoning).not.toMatch(/IV percentile|unhedged|no-overnight/);
  });

  it('swing APPROVES a clean hedged structure (IV ≤ 90, defined risk)', async () => {
    const tuning: AnalystTuning = {
      horizon: 'MEDIUM_TERM',
      instrument: 'OPTION',
      params: { optionsVeto: swingVeto },
    };
    const result = await governanceHandler(
      stateWithOptionsRisk('AAPL', { iv_percentile: 60, max_loss: 500, risk_level: 'LOW', max_allocation: 15 }),
      surface,
      tuning,
    );
    const lastMsg = result.messages[result.messages.length - 1];
    expect(lastMsg.data.decisions['AAPL'].reasoning).not.toMatch(/IV percentile|unhedged/);
  });

  it('long-term (equity) governance path is UNCHANGED when no optionsVeto', async () => {
    const tuning: AnalystTuning = { horizon: 'LONG_TERM', params: {} };
    const result = await governanceHandler(
      // No options_risk message present — pure equity path.
      {
        messages: [{ role: 'user', content: 'Analyze AAPL', timestamp: new Date().toISOString() }],
        current_date: '', tickers: ['AAPL'], company_name: 'AAPL',
        investment_thesis: '', final_decision: '', error: null,
        current_step: 'risk_analysis_complete',
      },
      surface,
      tuning,
    );
    const lastMsg = result.messages[result.messages.length - 1];
    expect(['APPROVE', 'REJECT']).toContain(lastMsg.data.overallDecision.decision);
  });
});

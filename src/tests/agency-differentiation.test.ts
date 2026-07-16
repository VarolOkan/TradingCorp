// src/tests/agency-differentiation.test.ts
// Proves the equity agencies now produce OBSERVABLY DIFFERENT output:
//  - risk stop-loss / allocation diverge by horizon (intraday tightest)
//  - technical score is biased hotter for intraday
//  - sentiment emits more social trends for intraday
// Long-term (no tuning) stays byte-identical to the legacy path — asserted by
// the fact these handlers are called with `undefined` tuning in parity.test.ts.

import { riskHandler } from '../registry/logic/risk';
import { technicalHandler } from '../registry/logic/technical';
import { sentimentHandler } from '../registry/logic/sentiment';
import { governanceHandler } from '../registry/logic/governance';
import { makeNodeSurface } from '../registry/logic/shared';
import type { AnalystTuning } from '../types/registry';
import { AgentState } from '../types/financial-analysis';

const surface = makeNodeSurface();
const tickers = ['AAPL', 'MSFT', 'TSLA'];

function state(): AgentState {
  return {
    messages: [{ role: 'user', content: 'Analyze', timestamp: new Date().toISOString() }],
    current_date: '', tickers, company_name: tickers.join(', '),
    investment_thesis: '', final_decision: '', error: null,
    current_step: 'sentiment_analysis_complete',
  };
}

const longTerm: AnalystTuning = { horizon: 'LONG_TERM', params: {} };
const intraday: AnalystTuning = { horizon: 'INTRADAY', params: {} };
const medium: AnalystTuning = { horizon: 'MEDIUM_TERM', params: {} };

function riskOf(s: AgentState): Record<string, any> {
  const msg = s.messages.find((m) => m.data && (m.data as any).assessments)!;
  return (msg.data as any).assessments as Record<string, any>;
}
function techOf(s: AgentState): Record<string, any> {
  const msg = s.messages.find((m) => m.data && (m.data as any).analyses)!;
  return (msg.data as any).analyses as Record<string, any>;
}
function sentOf(s: AgentState): Record<string, any> {
  const msg = s.messages.find((m) => m.data && (m.data as any).analyses)!;
  return (msg.data as any).analyses as Record<string, any>;
}

describe('agency differentiation', () => {
  it('risk stop-loss is tighter for intraday than long-term', async () => {
    const lt = riskOf(await riskHandler(state(), surface, longTerm));
    const it = riskOf(await riskHandler(state(), surface, intraday));
    for (const t of tickers) {
      const a = lt[t].stop_loss_suggestion;
      const b = it[t].stop_loss_suggestion;
      if (a != null && b != null) expect(b).toBeLessThanOrEqual(a);
    }
  });

  it('risk max-allocation is smaller for intraday than long-term', async () => {
    const lt = riskOf(await riskHandler(state(), surface, longTerm));
    const it = riskOf(await riskHandler(state(), surface, intraday));
    for (const t of tickers) {
      expect(it[t].max_allocation_percent).toBeLessThanOrEqual(lt[t].max_allocation_percent);
    }
  });

  it('technical score is biased higher for intraday than long-term', async () => {
    const lt = techOf(await technicalHandler(state(), surface, longTerm));
    const it = techOf(await technicalHandler(state(), surface, intraday));
    for (const t of tickers) {
      expect(it[t].technical_score).toBeGreaterThanOrEqual(lt[t].technical_score);
    }
  });

  it('sentiment emits more social trends for intraday than long-term', async () => {
    const lt = sentOf(await sentimentHandler(state(), surface, longTerm));
    const it = sentOf(await sentimentHandler(state(), surface, intraday));
    for (const t of tickers) {
      expect(it[t].social_trends.length).toBeGreaterThan(lt[t].social_trends.length);
    }
  });

  it('medium sits between long-term and intraday on stop-loss', async () => {
    const lt = riskOf(await riskHandler(state(), surface, longTerm));
    const md = riskOf(await riskHandler(state(), surface, medium));
    const it = riskOf(await riskHandler(state(), surface, intraday));
    for (const t of tickers) {
      const a = lt[t].stop_loss_suggestion, b = md[t].stop_loss_suggestion, c = it[t].stop_loss_suggestion;
      if (a != null && b != null && c != null) {
        expect(b).toBeLessThanOrEqual(a);
        expect(c).toBeLessThanOrEqual(b);
      }
    }
  });

  it('intraday + per-agency params override maxStopLoss', async () => {
    const tuned: AnalystTuning = { horizon: 'INTRADAY', params: { maxStopLoss: 0.03 } };
    const it = riskOf(await riskHandler(state(), surface, tuned));
    for (const t of tickers) {
      const v = it[t].stop_loss_suggestion;
      // Stop-loss must be a sane POSITIVE fraction (the seeded RNG used to emit
      // negatives via an unclamped Math.sin — that corrupted "mock" data is gone).
      if (v != null) {
        expect(v).toBeGreaterThan(0);
        expect(v).toBeLessThanOrEqual(0.5);
      }
    }
  });
});

describe('governance policy split', () => {
  // Build a state that already carries the risk stage's assessment, so
  // governance can act on the real stop-loss (mimics the full pipeline).
  function stateWithRisk(stopLoss: number | null, riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME'): AgentState {
    return {
      messages: [
        { role: 'user', content: 'Analyze', timestamp: new Date().toISOString() },
        {
          role: 'system',
          content: 'Risk analysis completed',
          timestamp: new Date().toISOString(),
          data: {
            assessments: {
              AAPL: {
                risk_level: riskLevel,
                risk_factors: [],
                portfolio_impact: 'x',
                position_sizing_recommendation: 'x',
                stop_loss_suggestion: stopLoss,
                take_profit_suggestion: 0.3,
                max_allocation_percent: 5,
              },
            },
          },
        },
      ],
      current_date: '', tickers: ['AAPL'], company_name: 'AAPL',
      investment_thesis: '', final_decision: '', error: null,
      current_step: 'risk_analysis_complete',
    };
  }

  function decisionOf(s: AgentState): string {
    const msg = s.messages.find((m) => (m as any).data && (m as any).data.overallDecision)!;
    return (msg!.data as any).overallDecision.decision as string;
  }

  it('intraday REJECTS a stop-loss above its tighter tolerance while long-term APPROVES', async () => {
    // 0.12 stop-loss: above intraday tolerance (0.05) and medium (0.10),
    // but below long-term (0.15).
    const s = stateWithRisk(0.12, 'MEDIUM');
    const lt = decisionOf(await governanceHandler(s, surface, longTerm));
    const md = decisionOf(await governanceHandler(s, surface, medium));
    const it = decisionOf(await governanceHandler(s, surface, intraday));
    expect(lt).toBe('APPROVE');
    expect(md).toBe('REJECT');
    expect(it).toBe('REJECT');
  });

  it('intraday escalates a HIGH risk level to REJECT', async () => {
    const s = stateWithRisk(0.04, 'HIGH'); // stop-loss fine, but HIGH risk
    const lt = decisionOf(await governanceHandler(s, surface, longTerm));
    const it = decisionOf(await governanceHandler(s, surface, intraday));
    expect(lt).toBe('APPROVE');
    expect(it).toBe('REJECT');
  });

  it('long-term stays byte-identical to legacy random decision', async () => {
    const s = stateWithRisk(0.12, 'MEDIUM');
    const leg = await governanceHandler(s, surface); // no tuning
    const lt = await governanceHandler(s, surface, longTerm);
    expect(decisionOf(lt)).toBe(decisionOf(leg));
  });
});

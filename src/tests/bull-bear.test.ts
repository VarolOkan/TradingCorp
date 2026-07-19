// src/tests/bull-bear.test.ts
// Phase 1 (Bull/Bear Researcher debate): unit tests for the two declarative
// researchers + the governance gatekeeper's consumption of their output.
// Pure logic — no server / LangGraph / SQLite needed (mirrors
// governance.reflection.test.ts). Imports only the handlers.

import { declarativeHandler } from '../registry/logic/declarative';
import { governanceHandler } from '../registry/logic/governance';
import { setMockDisabled } from '../registry/logic/mockMode';
import type { AgentState } from '../types/financial-analysis';
import type { AnalystDef } from '../types/registry';
import type { NodeSurface } from '../registry/logic/shared';
import { ANALYST_DEFS } from '../registry/analysts';

const node: NodeSurface = {
  updateStep: (s, step) => ({ ...s, current_step: step }),
  addMessage: (s, role, content) => ({ ...s, messages: [...(s.messages || []), { role, content }] }),
  captureTrace: (s, trace) => ({ ...s, analystTraces: [...((s.analystTraces as any) || []), trace] }),
  emitProgress: () => {},
};

function baseState(): AgentState {
  return {
    messages: [], current_date: '2026-07-10', tickers: ['AAPL'], company_name: 'Apple',
    investment_thesis: '', final_decision: '', error: null, current_step: 'init', analystTraces: [],
  } as AgentState;
}

/** Run a researcher declaratively and return its produced state. */
async function runResearcher(id: 'bull_researcher' | 'bear_researcher', state: AgentState): Promise<AgentState> {
  const def = ANALYST_DEFS[id] as AnalystDef;
  return declarativeHandler(state, node, def, { horizon: 'LONG_TERM', params: {}, instrument: 'EQUITY' });
}

describe('Phase 1: Bull/Bear researchers', () => {
  it('bull_researcher produces a single bull_research trace with a verdict', async () => {
    const out = await runResearcher('bull_researcher', baseState());
    const trace = (out.analystTraces as any)!.find((t: any) => t.analyst === 'bull_researcher');
    expect(trace).toBeDefined();
    expect(trace.output.verdict).toMatch(/BULLISH|NEUTRAL|BEARISH/);
    expect(typeof trace.output.score).toBe('number');
    // Channel written on messages[].data.channels
    const msg = out.messages!.find((m: any) => Array.isArray(m.data?.channels) && m.data.channels.includes('bull_research'));
    expect(msg).toBeDefined();
    expect(msg.data.analyses.AAPL.verdict).toBe(trace.output.verdict);
  });

  it('bear_researcher produces a single bear_research trace with a verdict', async () => {
    const out = await runResearcher('bear_researcher', baseState());
    const trace = (out.analystTraces as any)!.find((t: any) => t.analyst === 'bear_researcher');
    expect(trace).toBeDefined();
    expect(trace.output.verdict).toMatch(/BULLISH|NEUTRAL|BEARISH/);
  });

  it('researchers are stage-3 debate nodes depending on the Analyst Team', () => {
    expect(ANALYST_DEFS.bull_researcher!.stage).toBe(3);
    expect(ANALYST_DEFS.bull_researcher!.dependsOn).toEqual(['fundamental', 'technical', 'sentiment']);
    expect(ANALYST_DEFS.bear_researcher!.stage).toBe(3);
    expect(ANALYST_DEFS.bear_researcher!.dependsOn).toEqual(['fundamental', 'technical', 'sentiment']);
  });

  it('governance reflects the debate (bull/bear notes + net lean) when present', async () => {
    let state = baseState();
    state = await runResearcher('bull_researcher', state);
    state = await runResearcher('bear_researcher', state);
    const out = await governanceHandler(state, node, { horizon: 'LONG_TERM', params: {} });
    const trace = out.analystTraces!.find((t: any) => t.analyst === 'governance')!;
    const notes = (trace.notes ?? []) as string[];
    expect(notes.some((n) => n.startsWith('Bull case:'))).toBe(true);
    expect(notes.some((n) => n.startsWith('Bear case:'))).toBe(true);
    expect(notes.some((n) => n.startsWith('Net debate lean:'))).toBe(true);
    // The debate is exposed on the governance output details + the message data.
    expect((trace.output as any).details.debate).toBeDefined();
    const msg = out.messages!.find((m: any) => m.data?.debate);
    expect(msg?.data.debate.length).toBeGreaterThan(0);
  });

  it('PARITY: governance with no debate channels emits no debate note', async () => {
    const out = await governanceHandler(baseState(), node, { horizon: 'LONG_TERM', params: {} });
    const trace = out.analystTraces!.find((t: any) => t.analyst === 'governance')!;
    const notes = (trace.notes ?? []) as string[];
    expect(notes.some((n) => n.startsWith('Bull case:') || n.startsWith('Bear case:'))).toBe(false);
    expect((trace.output as any).details.debate).toBeUndefined();
  });
});

/** Build an upstream Stage-2 pillar trace carrying a REAL per-ticker score in
 *  output.details.analyses[ticker][field] — the exact shape the fundamental/
 *  technical/sentiment handlers emit via captureTrace. */
function pillarTrace(analyst: string, ticker: string, field: string, value: number) {
  return {
    analyst,
    name: analyst,
    stage: 2,
    instructions: `${analyst} (test)`,
    inputs: [],
    weighting: [],
    output: { score: value, verdict: 'NEUTRAL', summary: 't', details: { analyses: { [ticker]: { [field]: value } } } },
  };
}

/** State pre-seeded with the three Stage-2 pillar traces the researchers read. */
function stateWithPillars(
  ticker: string,
  scores: { fundamental: number; technical: number; sentiment: number },
): AgentState {
  const s = baseState();
  s.tickers = [ticker];
  (s as any).analystTraces = [
    pillarTrace('fundamental', ticker, 'financial_health_score', scores.fundamental),
    pillarTrace('technical', ticker, 'technical_score', scores.technical),
    pillarTrace('sentiment', ticker, 'sentiment_score', scores.sentiment),
  ];
  return s;
}

describe('Phase 1: Stage-3 researchers consume REAL Stage-2 scores', () => {
  afterEach(() => setMockDisabled(null));

  it('bull_researcher reads upstream fundamental/technical/sentiment scores (not seeded)', async () => {
    const state = stateWithPillars('AAPL', { fundamental: 90, technical: 80, sentiment: 60 });
    const out = await runResearcher('bull_researcher', state);
    const trace = (out.analystTraces as any).find((t: any) => t.analyst === 'bull_researcher');

    // Deterministic expected score = weightedSum(0.4*90 + 0.35*80 + 0.25*60) = 36 + 28 + 15 = 79.
    expect(trace.output.score).toBe(79);
    expect(trace.output.verdict).toBe('BULLISH');
    // The consumed inputs echo the REAL upstream values, not seeded mock ranges.
    const input = trace.inputs.find((i: any) => i.ticker === 'AAPL');
    expect(input.data.fundamental_score).toBe(90);
    expect(input.data.technical_score).toBe(80);
    expect(input.data.sentiment_score).toBe(60);
    // Honest provenance note.
    expect((trace.notes ?? []).some((n: string) => n.startsWith('Inputs derived from live upstream analyst scores'))).toBe(true);
    // Data provenance is 'live' (real upstream scores consumed).
    expect(trace.dataProvenance).toBe('live');
  });

  it('bear_researcher inverts the same real scores (weak fundamentals → bearish)', async () => {
    const state = stateWithPillars('AAPL', { fundamental: 20, technical: 25, sentiment: 10 });
    const out = await runResearcher('bear_researcher', state);
    const trace = (out.analystTraces as any).find((t: any) => t.analyst === 'bear_researcher');
    // invert:true → contribution uses (100 - value):
    //   0.4*(100-20) + 0.35*(100-25) + 0.25*(100-10) = 32 + 26.25 + 22.5 = 80.75 → 81.
    expect(trace.output.score).toBe(81);
    expect(trace.output.verdict).toBe('BEARISH');
    const input = trace.inputs.find((i: any) => i.ticker === 'AAPL');
    expect(input.data.fundamental_score).toBe(20);
  });

  it('bull vs bear DIVERGE on the same real inputs (invert actually applied)', async () => {
    const pillars = { fundamental: 90, technical: 80, sentiment: 60 };
    const bull = (await runResearcher('bull_researcher', stateWithPillars('AAPL', pillars)))
      .analystTraces!.find((t: any) => t.analyst === 'bull_researcher') as any;
    const bear = (await runResearcher('bear_researcher', stateWithPillars('AAPL', pillars)))
      .analystTraces!.find((t: any) => t.analyst === 'bear_researcher') as any;
    // Strong pillars → bull high, bear low (mirror). Before the invert fix these
    // were identical (both read the same seeded ranges).
    expect(bull.output.score).toBe(79);
    expect(bear.output.score).toBe(21); // 0.4*10 + 0.35*20 + 0.25*40 = 4+7+10 = 21
    expect(bull.output.score).not.toBe(bear.output.score);
  });

  it('real scores CHANGE the output — different upstream → different verdict', async () => {
    const strong = await runResearcher('bull_researcher', stateWithPillars('AAPL', { fundamental: 95, technical: 90, sentiment: 75 }));
    const weak = await runResearcher('bull_researcher', stateWithPillars('AAPL', { fundamental: 30, technical: 25, sentiment: -20 }));
    const strongTrace = (strong.analystTraces as any).find((t: any) => t.analyst === 'bull_researcher');
    const weakTrace = (weak.analystTraces as any).find((t: any) => t.analyst === 'bull_researcher');
    expect(strongTrace.output.score).toBeGreaterThan(weakTrace.output.score);
    expect(strongTrace.output.verdict).toBe('BULLISH');
    expect(weakTrace.output.verdict).not.toBe('BULLISH');
  });

  it('PARITY: no upstream traces → seeded fallback still produces a valid verdict + honest note', async () => {
    const out = await runResearcher('bull_researcher', baseState());
    const trace = (out.analystTraces as any).find((t: any) => t.analyst === 'bull_researcher');
    expect(typeof trace.output.score).toBe('number');
    expect(trace.output.verdict).toMatch(/BULLISH|NEUTRAL|BEARISH/);
    expect((trace.notes ?? []).some((n: string) => n.includes('seeded parity fallback'))).toBe(true);
    // No live source → seeded-parity provenance (NOT mistaken for live data).
    expect(trace.dataProvenance).toBe('seeded-parity');
  });

  it('MOCK DISABLED: no upstream + mock off → empty (zeroed) output, honest not-fabricated note', async () => {
    setMockDisabled(true);
    const out = await runResearcher('bull_researcher', baseState());
    const trace = (out.analystTraces as any).find((t: any) => t.analyst === 'bull_researcher');
    expect(trace.output.score).toBe(0);
    expect((trace.notes ?? []).some((n: string) => n.includes('mock data disabled'))).toBe(true);
  });

  it('MOCK DISABLED but upstream present → still consumes the REAL scores (real data is not suppressed)', async () => {
    setMockDisabled(true);
    const state = stateWithPillars('AAPL', { fundamental: 90, technical: 80, sentiment: 60 });
    const out = await runResearcher('bull_researcher', state);
    const trace = (out.analystTraces as any).find((t: any) => t.analyst === 'bull_researcher');
    // Real upstream scores flow through regardless of the mock switch.
    const input = trace.inputs.find((i: any) => i.ticker === 'AAPL');
    expect(input.data.fundamental_score).toBe(90);
    expect(trace.output.score).toBe(79);
  });

  it('BUG REGRESSION: MOCK DISABLED + real upstream → note says "derived from live upstream", NOT "empty/not fabricated"', async () => {
    setMockDisabled(true);
    const state = stateWithPillars('AAPL', { fundamental: 90, technical: 80, sentiment: 60 });
    const out = await runResearcher('bull_researcher', state);
    const trace = (out.analystTraces as any).find((t: any) => t.analyst === 'bull_researcher');
    const notes: string[] = trace.notes ?? [];
    // Must NOT claim the output is empty / not fabricated — it consumed real Stage-2 scores.
    expect(notes.some((n) => n.includes('output is empty, not fabricated'))).toBe(false);
    // Must declare it derived from live upstream analyst scores.
    expect(notes.some((n) => n.includes('derived from live upstream analyst scores'))).toBe(true);
    expect(trace.output.score).toBe(79);
  });

  it('BUG REGRESSION (bear): MOCK DISABLED + real upstream → same honest "derived from live upstream" note', async () => {
    setMockDisabled(true);
    const state = stateWithPillars('AAPL', { fundamental: 20, technical: 25, sentiment: 10 });
    const out = await runResearcher('bear_researcher', state);
    const trace = (out.analystTraces as any).find((t: any) => t.analyst === 'bear_researcher');
    const notes: string[] = trace.notes ?? [];
    expect(notes.some((n) => n.includes('output is empty, not fabricated'))).toBe(false);
    expect(notes.some((n) => n.includes('derived from live upstream analyst scores'))).toBe(true);
  });

  it('(b) LIVE EVIDENCE: bull_researcher cites real price/RSI/news from ingested when present', async () => {
    const state = stateWithPillars('AAPL', { fundamental: 90, technical: 80, sentiment: 60 });
    (state as any).ingested = {
      bars: { AAPL: [{ interval: '1d', lookback_days: 30, bars: [
        { t: '2026-06-01', open: 180, high: 181, low: 179, close: 180, volume: 1e6 },
        { t: '2026-06-15', open: 190, high: 191, low: 189, close: 190, volume: 1e6 },
        { t: '2026-07-01', open: 210, high: 211, low: 209, close: 210, volume: 1e6 },
      ] }] },
      market: { AAPL: { price: 210 } },
      technical: { AAPL: { indicators: { sma_50: 195, sma_200: 180, rsi: 72 } } },
      sentiment: { AAPL: { headlines: ['Apple unveils record services revenue', 'Supplier warns of chip shortage'] } },
      source: 'mixed',
    };
    const out = await runResearcher('bull_researcher', state);
    const trace = (out.analystTraces as any).find((t: any) => t.analyst === 'bull_researcher');
    const notes: string[] = trace.notes ?? [];
    // Evidence note present and cites concrete REAL signals.
    expect(notes.some((n: string) => n.startsWith('Evidence (live ingested):'))).toBe(true);
    const evNote = notes.find((n: string) => n.startsWith('Evidence (live ingested):'))!;
    expect(evNote).toMatch(/above 50d SMA/);      // price 210 vs sma_50 195
    expect(evNote).toMatch(/RSI 72 \(overbought\)/);
    expect(evNote).toMatch(/record services revenue/); // real headline
    // Evidence also attached to the structured inputs for the drawer.
    const input = trace.inputs.find((i: any) => i.ticker === 'AAPL');
    expect(input.data.evidence).toBeDefined();
    expect(input.data.evidence.priceVsSma).toMatch(/above 50d SMA/);
    // Live upstream scores + live ingested evidence → provenance 'live'.
    expect(trace.dataProvenance).toBe('live');
  });

  it('(b) PARITY: no ingested → no "Evidence" note (score/verdict unchanged)', async () => {
    const state = stateWithPillars('AAPL', { fundamental: 90, technical: 80, sentiment: 60 });
    const out = await runResearcher('bull_researcher', state);
    const trace = (out.analystTraces as any).find((t: any) => t.analyst === 'bull_researcher');
    const notes: string[] = trace.notes ?? [];
    expect(notes.some((n: string) => n.startsWith('Evidence (live ingested):'))).toBe(false);
    expect(trace.output.score).toBe(79); // scoring unchanged
    const input = trace.inputs.find((i: any) => i.ticker === 'AAPL');
    expect(input.data.evidence).toBeUndefined();
  });
});

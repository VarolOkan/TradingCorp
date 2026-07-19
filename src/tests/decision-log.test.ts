// src/tests/decision-log.test.ts
// Phase 2 (persistent decision log): pure-module unit tests for the JSONL
// store + return/alpha math. Hermetic — points DECISION_LOG_PATH at a temp file.
import os from 'os';
import fs from 'fs';
import path from 'path';
import {
  appendDecision,
  getLastForTicker,
  getRecentLessons,
  computeRealizedReturn,
  computeAlphaVsSpy,
  type DecisionRecord,
} from '../server/decision-log';

const TMP = path.join(os.tmpdir(), `tc-decisionlog-${process.pid}-${Date.now()}.jsonl`);
process.env.DECISION_LOG_PATH = TMP;

function rec(over: Partial<DecisionRecord>): DecisionRecord {
  return {
    ts: '2026-07-10T00:00:00.000Z',
    tickers: ['AAPL'],
    agencyId: 'long-term',
    decision: 'APPROVE',
    confidence: 75,
    ...over,
  };
}

afterAll(() => { fs.rmSync(TMP, { force: true }); });

describe('decision-log store', () => {
  it('append + getLastForTicker round-trips', () => {
    appendDecision(rec({ tickers: ['AAPL'], decision: 'APPROVE' }));
    const got = getLastForTicker('AAPL', 1);
    expect(got).toHaveLength(1);
    expect(got[0]!.decision).toBe('APPROVE');
    expect(got[0]!.tickers).toEqual(['AAPL']);
  });

  it('is append-only: N appends => N lines', () => {
    const f = path.join(os.tmpdir(), `tc-dl-append-${process.pid}-${Date.now()}.jsonl`);
    process.env.DECISION_LOG_PATH = f;
    for (let i = 0; i < 5; i++) appendDecision(rec({ tickers: ['MSFT'], confidence: i }));
    const lines = fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim());
    expect(lines).toHaveLength(5);
    expect(getLastForTicker('MSFT', 1)[0]!.confidence).toBe(4);
    fs.rmSync(f, { force: true });
    process.env.DECISION_LOG_PATH = TMP;
  });

  it('getLastForTicker returns only that ticker', () => {
    appendDecision(rec({ tickers: ['AAPL'], decision: 'APPROVE' }));
    appendDecision(rec({ tickers: ['TSLA'], decision: 'REJECT' }));
    expect(getLastForTicker('TSLA', 1)[0]!.decision).toBe('REJECT');
    expect(getLastForTicker('AAPL', 1)[0]!.decision).toBe('APPROVE');
  });

  it('getRecentLessons excludes the current ticker and caps at limit', () => {
    const f = path.join(os.tmpdir(), `tc-dl-lessons-${process.pid}-${Date.now()}.jsonl`);
    process.env.DECISION_LOG_PATH = f;
    for (const t of ['AAPL', 'MSFT', 'TSLA', 'NVDA', 'AMZN', 'GOOG', 'META']) {
      appendDecision(rec({ tickers: [t], confidence: 50 }));
    }
    const lessons = getRecentLessons(5, 'AAPL');
    expect(lessons).toHaveLength(5);
    expect(lessons.every((l) => !l.tickers.includes('AAPL'))).toBe(true);
    // Newest first.
    expect(lessons[0]!.tickers[0]).toBe('META');
    fs.rmSync(f, { force: true });
    process.env.DECISION_LOG_PATH = TMP;
  });

  it('computeRealizedReturn math on a known price pair', () => {
    expect(computeRealizedReturn(100, 110)).toBeCloseTo(10);
    expect(computeRealizedReturn(100, 90)).toBeCloseTo(-10);
    expect(computeRealizedReturn(undefined, 90)).toBeNull();
    expect(computeRealizedReturn(0, 90)).toBeNull();
  });

  it('computeAlphaVsSpy math', () => {
    expect(computeAlphaVsSpy(10, 4)).toBeCloseTo(6);
    expect(computeAlphaVsSpy(-10, 4)).toBeCloseTo(-14);
    expect(computeAlphaVsSpy(null, 4)).toBeNull();
  });
});

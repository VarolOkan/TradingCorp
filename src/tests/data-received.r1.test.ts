// src/tests/data-received.r1.test.ts
// Phase R1 (RAW_DATA_DUMP.md): the annotation primitives that every analyst
// handler will use to record which ingested slice it consumed. These are pure
// annotation helpers — they never change analyst output, so they are
// parity-safe by construction.
import {
  annotateDataReceived,
  recordDataReceived,
} from '../registry/logic/shared';
import type { AgentState, DataReceivedEntry } from '../types/financial-analysis';

describe('Phase R1 — dataReceived annotation primitives', () => {
  it('annotateDataReceived builds a correct entry with no note', () => {
    const entry = annotateDataReceived(
      'technical',
      'AAPL',
      'ingested',
      [{ domain: 'bars', interval: '1d', source: 'yahoo', barsUsed: 252 }],
      'live',
    );
    expect(entry).toEqual({
      analyst: 'technical',
      ticker: 'AAPL',
      channel: 'ingested',
      blocks: [{ domain: 'bars', interval: '1d', source: 'yahoo', barsUsed: 252 }],
      provenance: 'live',
    });
    // note must be absent (exactOptionalPropertyTypes: not set)
    expect(entry.note).toBeUndefined();
  });

  it('annotateDataReceived forwards note only when provided', () => {
    const withNote = annotateDataReceived(
      'fundamental',
      'AAPL',
      'ingested',
      [{ domain: 'fundamental', source: 'mock' }],
      'seeded-parity',
      'price-proxy fallback (no ingested.fundamental)',
    );
    expect(withNote.note).toBe('price-proxy fallback (no ingested.fundamental)');

    const withoutNote = annotateDataReceived(
      'risk',
      'AAPL',
      'ingested',
      [{ domain: 'market', source: 'mock' }],
      'seeded-parity',
    );
    expect(withoutNote.note).toBeUndefined();
  });

  it('annotateDataReceived supports the optionsData channel + multi-block', () => {
    const entry = annotateDataReceived(
      'options_strategist',
      'TSLA',
      'optionsData',
      [
        { domain: 'option_chain', source: 'polygon', rows: 480 },
        { domain: 'greeks', source: 'polygon', rows: 480 },
        { domain: 'underlying', interval: '1d', source: 'yahoo', barsUsed: 90 },
      ],
      'mixed',
    );
    expect(entry.channel).toBe('optionsData');
    expect(entry.blocks).toHaveLength(3);
    expect(entry.provenance).toBe('mixed');
  });

  it('recordDataReceived appends to an existing array immutably', () => {
    const base: AgentState = {
      messages: [], current_date: '2026-07-11', tickers: ['AAPL'],
      company_name: 'Apple', investment_thesis: '', final_decision: '',
      error: null, current_step: 'start', dataReceived: [],
    };
    const e1 = annotateDataReceived('technical', 'AAPL', 'ingested', [{ domain: 'bars', source: 'mock', barsUsed: 1 }], 'seeded-parity');
    const e2 = annotateDataReceived('risk', 'AAPL', 'ingested', [{ domain: 'market', source: 'mock' }], 'seeded-parity');
    const after1 = recordDataReceived(base, e1);
    const after2 = recordDataReceived(after1, e2);

    expect(after1.dataReceived).toHaveLength(1);
    expect(after2.dataReceived).toHaveLength(2);
    // base untouched (immutability)
    expect(base.dataReceived).toHaveLength(0);
    // entries retained
    const dr: DataReceivedEntry[] = after2.dataReceived!;
    expect(dr[0]!.analyst).toBe('technical');
    expect(dr[1]!.analyst).toBe('risk');
  });

  it('recordDataReceived seeds the array when channel is absent', () => {
    const base: AgentState = {
      messages: [], current_date: '2026-07-11', tickers: ['AAPL'],
      company_name: 'Apple', investment_thesis: '', final_decision: '',
      error: null, current_step: 'start',
    };
    const e = annotateDataReceived('technical', 'AAPL', 'ingested', [{ domain: 'bars', source: 'mock' }], 'seeded-parity');
    const out = recordDataReceived(base, e);
    expect(Array.isArray(out.dataReceived)).toBe(true);
    expect(out.dataReceived).toHaveLength(1);
    // legacy state with no dataReceived stays falsy-equivalent for parity checks
    expect(base.dataReceived).toBeUndefined();
  });

  it('recordDataReceived is non-throwing on degenerate state', () => {
    // @ts-expect-error intentionally malformed to test the try/catch guard
    const out = recordDataReceived(null, { analyst: 'x', ticker: 'X', channel: 'ingested', blocks: [], provenance: 'mock' } as DataReceivedEntry);
    expect(out).toBeNull();
  });
});

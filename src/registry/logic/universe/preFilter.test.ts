// src/registry/logic/universe/preFilter.test.ts
// Phase 1 (TDD): the cheap, NETWORK-FREE pre-filter.
import { preFilterUniverse, type PreFilterInput } from './preFilter';

const BASE: PreFilterInput['symbols'] = [
  { ticker: 'BIG', name: 'BigCo', exchange: 'NYSE', isEtf: false, isTest: false, sector: 'Tech' },
  { ticker: 'PEN', name: 'Penny', exchange: 'NASDAQ', isEtf: false, isTest: false, sector: 'Tech' },
  { ticker: 'OTC', name: 'OtcOnly', exchange: 'OTC', isEtf: false, isTest: false, sector: 'Fin' },
  { ticker: 'ETF', name: 'SpyETF', exchange: 'NYSE', isEtf: true, isTest: false, sector: 'Fin' },
  { ticker: 'TEST', name: 'TestIssue', exchange: 'NASDAQ', isEtf: false, isTest: true, sector: 'Tech' },
  { ticker: 'ILT', name: 'Illiquid', exchange: 'NYSE', isEtf: false, isTest: false, sector: 'Energy' },
];

const QUOTES: PreFilterInput['quotes'] = [
  { ticker: 'BIG', price: 240, marketCap: 2.4e11, advUsd: 5.0e8, exchange: 'NYSE' }, // pass
  { ticker: 'PEN', price: 3.5, marketCap: 4e8, advUsd: 8e7, exchange: 'NASDAQ' }, // price<10, mktcap<2B
  { ticker: 'OTC', price: 40, marketCap: 5e9, advUsd: 6e7, exchange: 'OTC' }, // excluded by exchange
  { ticker: 'ETF', price: 450, marketCap: 4e11, advUsd: 9e8, exchange: 'NYSE' }, // ETF, dropped
  { ticker: 'TEST', price: 12, marketCap: 3e9, advUsd: 5e7, exchange: 'NASDAQ' }, // test issue, dropped
  { ticker: 'ILT', price: 60, marketCap: 8e9, advUsd: 9e6, exchange: 'NYSE' }, // ADV<20M
];

describe('preFilterUniverse', () => {
  it('drops penny / sub-cap / illiquid names', () => {
    const out = preFilterUniverse({ symbols: BASE, quotes: QUOTES });
    const tickers = out.map((q) => q.ticker);
    expect(tickers).toContain('BIG');
    expect(tickers).not.toContain('PEN'); // price 3.5, mktcap 400M
    expect(tickers).not.toContain('ILT'); // ADV 9M < 20M
  });

  it('drops OTC, ETFs and test issues before any quote lookup', () => {
    const out = preFilterUniverse({ symbols: BASE, quotes: QUOTES });
    const tickers = out.map((q) => q.ticker);
    expect(tickers).not.toContain('OTC'); // exchange not allowed
    expect(tickers).not.toContain('ETF'); // isEtf
    expect(tickers).not.toContain('TEST'); // isTest
  });

  it('keeps a symbol with no quote only when it passes the free-file gates', () => {
    // A NYSE non-etf/non-test name without a quote should still survive the
    // exchange/etf/test gates (quote gates just won't apply). We feed a quote
    // so it can also clear the price/cap/adv gates.
    const sym = { ticker: 'BIG', exchange: 'NYSE' as const, isEtf: false, isTest: false };
    const q = { ticker: 'BIG', price: 100, marketCap: 3e9, advUsd: 5e7 };
    const out = preFilterUniverse({ symbols: [sym], quotes: [q] });
    expect(out.map((x) => x.ticker)).toEqual(['BIG']);
  });

  it('applies the per-sector cap (maxPerSector=1 keeps only the first per sector)', () => {
    const syms = [
      { ticker: 'A', exchange: 'NYSE' as const, sector: 'Tech', isEtf: false, isTest: false },
      { ticker: 'B', exchange: 'NYSE' as const, sector: 'Tech', isEtf: false, isTest: false },
      { ticker: 'C', exchange: 'NYSE' as const, sector: 'Fin', isEtf: false, isTest: false },
    ];
    const qs = [
      { ticker: 'A', price: 100, marketCap: 3e9, advUsd: 5e7 },
      { ticker: 'B', price: 100, marketCap: 3e9, advUsd: 5e7 },
      { ticker: 'C', price: 100, marketCap: 3e9, advUsd: 5e7 },
    ];
    const out = preFilterUniverse({ symbols: syms, quotes: qs, criteria: { maxPerSector: 1 } });
    expect(out.length).toBe(2); // one Tech + one Fin
    const sectors = out.map((q) => q.sector);
    expect(sectors.filter((s) => s === 'Tech').length).toBe(1);
  });

  it('returns [] when quotes are missing for every symbol (graceful)', () => {
    const out = preFilterUniverse({ symbols: BASE });
    expect(out).toEqual([]);
  });
});

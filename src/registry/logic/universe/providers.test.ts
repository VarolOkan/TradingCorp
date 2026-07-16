// src/registry/logic/universe/providers.test.ts
// Phase 1: provider + index integration tests. NETWORK-FREE — every
// provider is driven by an injected mock fetch, so no real HTTP happens.
import { makeNasdaqTraderProvider, isPlainEquitySymbol } from './nasdaqTraderProvider';
import { makeSecProvider } from './secProvider';
import { makeWikipediaSp500Provider, makeSp500CsvProvider } from './wikipediaSp500Provider';
import { makeYahooQuoteProvider } from './quoteProvider';
import { getUniverse } from './index';
import type { FetchFn } from './sharedFetch';

// A tiny in-memory fetch mock keyed by URL substring.
function mockFetch(routes: Record<string, any>): FetchFn {
  return async (url: string) => {
    const key = Object.keys(routes).find((k) => url.includes(k));
    const body = key ? routes[key] : null;
    return {
      ok: Boolean(body),
      status: body ? 200 : 404,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
      json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
    };
  };
}

const NASDAQ_TXT =
  'Nasdaq Traded|Symbol|Security Name|Listing Exchange|Market Category|ETF|Round Lot Size|Test Issue|Financial Status|CQS Symbol|NASDAQ Symbol|NextShares\n' +
  'Y|AAPL|Apple Inc.|Q|Q|N|100|N|N|AAPL|AAPL|A|\n' +
  'Y|ZZZZ|Z Test|Q|Q|N|100|Y|N|ZZZZ|ZZZZ|A|\n' + // test issue -> dropped
  'Y|PENY|-penny Inc.|Q|Q|N|100|N|N|PENY|PENY|A|\n' + // will fail quote gates
  'Y|COF$N|Capital One N|Q|Q|N|100|N|N|COF$N|COF$N|A|\n' + // share-class $ -> dropped
  'Y|SES.W|Ses Warrant|N|N|N|100|N|N|SES.W|SES.W|N|\n' + // warrant .W -> dropped
  'Y|UNIT.U|Unit|N|N|N|100|N|N|UNIT.U|UNIT.U|N|\n'; // unit .U -> dropped

const SEC_JSON = {
  '0': { cik_str: 320193, ticker: 'AAPL', title: 'Apple Inc.' },
  '1': { cik_str: 789019, ticker: 'MSFT', title: 'Microsoft' },
};

const WP_JSON = {
  parse: {
    wikitext: {
      '*':
        '{| class="wikitable"\n|-\n| {{plainlist|...}} AAPL \n| Apple Inc. \n| Information Technology \n|-\n| {{plainlist|...}} MSFT \n| Microsoft \n| Technology \n|}',
    },
  },
};

const CSV = 'symbol,security,gics sector,gics sub-industry,headquarters,date added,cik,founded,date\nAAPL,Apple,Information Technology,foo,CA,2020,320193,1976,2020\nMSFT,Microsoft,Technology,bar,WA,2020,789019,1975,2020';

const YH_QUOTE = {
  quoteResponse: {
    result: [
      { symbol: 'AAPL', regularMarketPrice: 240, marketCap: 3.5e12, averageDailyVolume3Month: 5.0e7, exchangeName: 'NMS' },
      { symbol: 'MSFT', regularMarketPrice: 410, marketCap: 3.0e12, averageDailyVolume3Month: 3.0e7, exchangeName: 'NMS' },
    ],
  },
};

describe('universe providers', () => {
  it('nasdaqTrader drops Test Issues and maps exchanges (raw provider keeps non-equity lines)', async () => {
    const p = makeNasdaqTraderProvider({ fetchFn: mockFetch({ nasdaqtraded: NASDAQ_TXT }) });
    const syms = await p.fetchSymbols();
    // Raw provider is faithful to the file: ZZZZ (test issue) dropped, but the
    // non-equity derivatives (COF$N, SES.W, UNIT.U) are KEPT here — they are
    // filtered out later, at universe-assembly time in getUniverse().
    expect(syms.map((s) => s.ticker)).toEqual(['AAPL', 'PENY', 'COF$N', 'SES.W', 'UNIT.U']);
    expect(syms[0]!.exchange).toBe('NASDAQ');
  });

  it('isPlainEquitySymbol accepts common stocks and rejects derivative lines', () => {
    expect(isPlainEquitySymbol('AAPL')).toBe(true);
    expect(isPlainEquitySymbol('BRK.B')).toBe(false); // class suffix
    expect(isPlainEquitySymbol('COF$N')).toBe(false); // NASDAQ share-class
    expect(isPlainEquitySymbol('SES.W')).toBe(false); // warrant
    expect(isPlainEquitySymbol('UNIT.U')).toBe(false); // unit
    expect(isPlainEquitySymbol('Z-RIGHT')).toBe(false); // separator
  });

  it('getUniverse drops non-equity symbols from the broad pool (not the fallback)', async () => {
    const fetchFn = mockFetch({ nasdaqtraded: NASDAQ_TXT });
    const out = await getUniverse({ providerId: 'nasdaqtrader', fetchFn });
    const tickers = out.quotes.map((q) => q.ticker);
    expect(tickers).toContain('AAPL');
    expect(tickers).not.toContain('COF$N');
    expect(tickers).not.toContain('SES.W');
    expect(tickers).not.toContain('UNIT.U');
    expect(out.trace.usedFallback).toBe(false);
    // The provider step records exactly how many were dropped + why.
    const providerStep = out.trace.steps.find((s) => s.source === 'nasdaqtrader');
    expect(providerStep?.result).toContain('dropped 3 non-equity symbol');
    expect(providerStep?.result).toContain('COF$N');
  });

  it('sec returns broad pool with cik', async () => {
    const p = makeSecProvider({ fetchFn: mockFetch({ company_tickers: SEC_JSON }) });
    const syms = await p.fetchSymbols();
    expect(syms.map((s) => s.ticker).sort()).toEqual(['AAPL', 'MSFT']);
    expect(syms[0]!.cik).toBeDefined();
  });

  it('wikipedia parses tickers + GICS sector', async () => {
    const p = makeWikipediaSp500Provider({ fetchFn: mockFetch({ 'api.php': WP_JSON }) });
    const syms = await p.fetchSymbols();
    expect(syms.map((s) => s.ticker).sort()).toEqual(['AAPL', 'MSFT']);
    expect(syms[0]!.sector).toBeTruthy();
  });

  it('csv mirror parses', async () => {
    const p = makeSp500CsvProvider({ fetchFn: mockFetch({ sp500: CSV }) });
    const syms = await p.fetchSymbols();
    expect(syms.map((s) => s.ticker).sort()).toEqual(['AAPL', 'MSFT']);
  });
});

describe('quote provider', () => {
  it('batches and maps Yahoo v7 quote', async () => {
    const qp = makeYahooQuoteProvider({ fetchFn: mockFetch({ quote: YH_QUOTE }) });
    const q = await qp.batchQuotes(['AAPL', 'MSFT']);
    expect(q).toHaveLength(2);
    expect(q[0]!.price).toBe(240);
    expect(q[0]!.advUsd).toBeGreaterThan(0);
  });

  it('returns [] on 404 (graceful, no throw)', async () => {
    const qp = makeYahooQuoteProvider({ fetchFn: mockFetch({}) });
    const q = await qp.batchQuotes(['AAPL']);
    expect(q).toEqual([]);
  });

  it('retries on 429 and succeeds once a 200 arrives (honors Retry-After)', async () => {
    let calls = 0;
    const flaky: FetchFn = async (url: string) => {
      calls += 1;
      if (calls === 1) {
        return { ok: false, status: 429, text: async () => '', json: async () => ({}), headers: { 'retry-after': '0' } };
      }
      return { ok: true, status: 200, text: async () => '', json: async () => YH_QUOTE };
    };
    const qp = makeYahooQuoteProvider({ fetchFn: flaky, backoffMs: 1 });
    const q = await qp.batchQuotes(['AAPL', 'MSFT']);
    expect(q).toHaveLength(2);
    expect(calls).toBe(2); // one 429, one 200
  });

  it('stops retrying on hard 403 (no recovery)', async () => {
    let calls = 0;
    const blocked: FetchFn = async () => {
      calls += 1;
      return { ok: false, status: 403, text: async () => '', json: async () => ({}) };
    };
    const qp = makeYahooQuoteProvider({ fetchFn: blocked, backoffMs: 1 });
    const q = await qp.batchQuotes(['AAPL']);
    expect(q).toEqual([]);
    expect(calls).toBe(1); // did NOT loop on 403
  });
});

describe('wikipedia provider (retry)', () => {
  it('retries transient 429 then succeeds', async () => {
    let calls = 0;
    const flaky: FetchFn = async () => {
      calls += 1;
      if (calls === 1) return { ok: false, status: 429, text: async () => '', json: async () => ({}) };
      return { ok: true, status: 200, text: async () => '', json: async () => WP_JSON };
    };
    const p = makeWikipediaSp500Provider({ fetchFn: flaky });
    const syms = await p.fetchSymbols();
    expect(syms.map((s) => s.ticker).sort()).toEqual(['AAPL', 'MSFT']);
    expect(calls).toBe(2);
  });
});

describe('getUniverse (index)', () => {
  it('builds a pre-filtered universe from nasdaqtrader + Yahoo quotes', async () => {
    const fetchFn = mockFetch({
      nasdaqtraded: NASDAQ_TXT,
      quote: YH_QUOTE,
    });
    const out = await getUniverse({ providerId: 'nasdaqtrader', fetchFn, skipQuotes: false });
    // AAPL has a passing quote (price 240, big cap/ADV); PENY has NO quote
    // so it cannot clear the priced gates -> dropped.
    const tickers = out.quotes.map((q) => q.ticker);
    expect(tickers).toContain('AAPL');
    expect(tickers).not.toContain('PENY');
  });

  it('falls back to DEFAULT_UNIVERSE when every provider fails', async () => {
    const fetchFn = mockFetch({}); // everything 404
    const out = await getUniverse({ providerId: 'nasdaqtrader', fetchFn });
    expect(out.quotes.map((q) => q.ticker)).toEqual(expect.arrayContaining(['AAPL', 'MSFT']));
  });

  it('keeps the LIVE pool (unpriced) when quotes are blocked, NOT the 25-ticker fallback', async () => {
    // nasdaqtrader succeeds, but the Yahoo quote route is absent (blocked/429).
    const fetchFn = mockFetch({ nasdaqtraded: NASDAQ_TXT });
    const out = await getUniverse({ providerId: 'nasdaqtrader', fetchFn });
    expect(out.trace.origin).toBe('live');
    expect(out.trace.usedFallback).toBe(false);
    // The broad pool is preserved (AAPL + PENY both present, unpriced) and the
    // hardcoded mega-cap list is NOT injected.
    const tickers = out.quotes.map((q) => q.ticker);
    expect(tickers).toContain('AAPL');
    expect(tickers).toContain('PENY');
    expect(tickers).not.toContain('GOOGL'); // GOOGL is only in DEFAULT_UNIVERSE
    expect(out.trace.note).toContain('NOT the 25-ticker hardcoded fallback');
  });

  it('uses the cache when present (no fetch of symbols)', async () => {
    let loads = 0;
    const cache = {
      load: () => {
        loads += 1;
        return { symbols: [], quotes: [{ ticker: 'CACHED', price: 100, marketCap: 1e11, advUsd: 1e8 }] };
      },
      save: () => {},
    };
    const out = await getUniverse({ providerId: 'nasdaqtrader', fetchFn: mockFetch({}), cache });
    expect(loads).toBe(1);
    expect(out.quotes.map((q) => q.ticker)).toEqual(['CACHED']);
  });
});

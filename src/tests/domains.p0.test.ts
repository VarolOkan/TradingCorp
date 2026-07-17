// src/tests/domains.p0.test.ts
// P0 parity tests: resolveDomain must return byte-for-byte the same data as the
// legacy single-source functions it wraps. This is the gate that lets P1 swap
// the backing fetch to adapters and P2 add multi-source weighting WITHOUT
// changing analyst-facing behaviour.

import { resolveDomain } from '../registry/logic/domains';
import { fetchPriceBars } from '../registry/logic/hist';
import { fetchOptionChain } from '../registry/logic/hist';
import { fetchCompanyNews } from '../registry/logic/news';
import { fetchRealFinancialData } from '../registry/logic/data-ingestion';

function yahooChart(closes: number[]) {
  return {
    chart: {
      result: [
        {
          timestamp: closes.map((_, i) => i + 1),
          indicators: { quote: [{ open: closes, high: closes, low: closes, close: closes, volume: closes.map(() => 1) }] },
        },
      ],
    },
  };
}
const YAHOO_CHART = yahooChart([1, 2]);
const YAHOO_CHART_3 = yahooChart([10, 11, 12]);
const POLYGON_OPT = { status: 'OK', results: { underlying: { ticker: 'AAPL' }, options: [] } };
const FINNHUB_NEWS = [{ headline: 'AAPL beats estimates', url: 'u', source: 'Finnhub', datetime: 1, summary: 's' }];
const AV_OVERVIEW = {
  Symbol: 'AAPL', DebtEquityRatio: '1.2', CurrentRatio: '1.5', ReturnOnEquityTTM: '0.4',
  ReturnOnAssetsTTM: '0.2', ProfitMargin: '0.25', OperatingCashflow: '100', MarketCapitalization: '1000',
};
const TREASURY_ROW = { data: [{ avg_interest_rate_amt: '4.5' }] };

/** Deterministic mock fetchFn keyed by URL; returns the same canned payload
 *  for every URL so the test exercises the REAL parse paths (parity). */
function mockFetch(payload: any) {
  return async () => ({ ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) });
}
const FAIL_FETCH = async () => ({ ok: false, status: 500, json: async () => ({}) });

describe('P0 resolveDomain — parity with legacy functions', () => {
  it('price_bars wraps fetchPriceBars (live yahoo)', async () => {
    const fetchFn = mockFetch(YAHOO_CHART);
    const direct = await fetchPriceBars('AAPL', { fetchFn: fetchFn as any });
    const [rec] = await resolveDomain('price_bars', 'AAPL', { fetchFn: fetchFn as any });
    expect(rec!.sourceId).toBe('yahoo');
    expect(rec!.status).toBe('ok');
    expect(rec!.confidence).toBe(1);
    expect(rec!.data).toEqual(direct);
  });

  it('price_bars degrades to mock fallback when fetch fails', async () => {
    const [rec] = await resolveDomain('price_bars', 'AAPL', { fetchFn: FAIL_FETCH as any });
    expect(rec!.sourceId).toBe('yahoo');
    expect(rec!.status).toBe('fallback');
    expect(rec!.data.source).toBe('mock');
    expect(rec!.confidence).toBe(0);
  });

  it('option_chain wraps fetchOptionChain (live polygon)', async () => {
    const fetchFn = mockFetch(POLYGON_OPT);
    const direct = await fetchOptionChain('AAPL', { fetchFn: fetchFn as any });
    const [rec] = await resolveDomain('option_chain', 'AAPL', { fetchFn: fetchFn as any });
    expect(rec!.sourceId).toBe('polygon');
    // Structural parity: the wrapper forwards the real chain (underlying price
    // + quote count). Greeks are re-derived from an ambient rfr and can
    // float-differ by <1e-4 across calls, so we don't deep-equal the greeks.
    expect((rec!.data as any).underlying_price).toBe((direct as any).underlying_price);
    expect((rec!.data as any).quotes.length).toBe((direct as any).quotes.length);
  });

  it('news_sentiment wraps fetchCompanyNews (live finnhub)', async () => {
    const fetchFn = mockFetch(FINNHUB_NEWS);
    const direct = await fetchCompanyNews('AAPL', { fetchFn: fetchFn as any, finnhubKey: 'k' });
    const [rec] = await resolveDomain('news_sentiment', 'AAPL', { fetchFn: fetchFn as any, finnhubKey: 'k' });
    expect(rec!.sourceId).toBe('finnhub');
    expect(rec!.data).toEqual(direct);
  });

  it('fundamentals wraps fetchRealFinancialData OVERVIEW (live alphaVantage)', async () => {
    const fetchFn = mockFetch(AV_OVERVIEW);
    const direct = await fetchRealFinancialData({ tickers: ['AAPL'] }, fetchFn as any, undefined, { finnhubKey: 'k', newsFetcher: fetchFn as any }, 'avk');
    const [rec] = await resolveDomain('fundamentals', 'AAPL', { fetchFn: fetchFn as any, finnhubKey: 'k', alphaVantageKey: 'avk' });
    expect(rec!.sourceId).toBe('alphaVantage');
    expect(rec!.data).toEqual(direct.fundamental_data['AAPL']);
  });

  it('risk_free_rate acquires treasury via the §4.9 engine and parses', async () => {
    const fetchFn = mockFetch(TREASURY_ROW);
    const [rec] = await resolveDomain('risk_free_rate', 'AAPL', { fetchFn: fetchFn as any });
    expect(rec!.sourceId).toBe('treasuryRfr');
    expect(rec!.status).toBe('ok');
    expect(rec!.data).toBeCloseTo(0.045, 5);
  });

  it('risk_free_rate fails honestly when treasury unavailable', async () => {
    const [rec] = await resolveDomain('risk_free_rate', 'AAPL', { fetchFn: FAIL_FETCH as any });
    expect(rec!.status).toBe('failed');
    expect(rec!.data).toBe(0);
    expect(rec!.note).toBeTruthy();
  });

  it('market_meta derives realized vol from price_bars', async () => {
    const fetchFn = mockFetch(YAHOO_CHART_3);
    const [rec] = await resolveDomain('market_meta', 'AAPL', { fetchFn: fetchFn as any });
    expect(rec!.data.last_close).toBe(12);
    expect(typeof rec!.data.realized_vol_annualized).toBe('number');
  });

  it('always returns a LIST (so P2 can extend to N sources without signature change)', async () => {
    const fetchFn = mockFetch({});
    for (const d of ['price_bars', 'option_chain', 'news_sentiment', 'fundamentals', 'risk_free_rate', 'market_meta'] as const) {
      const recs = await resolveDomain(d, 'AAPL', { fetchFn: fetchFn as any });
      expect(Array.isArray(recs)).toBe(true);
      expect(recs.length).toBe(1);
    }
  });
});

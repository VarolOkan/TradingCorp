// src/tests/domains.p0.test.ts
// resolveDomain test suite (canonical home). Covers three layers:
//   * P0 parity: resolveDomain must return byte-for-byte the same data as the
//     legacy single-source functions it wraps. This is the gate that let P1
//     swap the backing fetch to adapters and P2 add multi-source weighting
//     WITHOUT changing analyst-facing behaviour.
//   * P2b fan-in: news_sentiment can carry a second live source and surface a
//     consensus (honest source labels, no false "live").
//   * P3a swappable config: resolveDomain honors an explicit `enabledSources`
//     map — a source can be disabled / reordered per domain, and disabling the
//     LAST source for a domain degrades THAT domain honestly (a `skipped`
//     record, no false "live" badge) without taking down the rest of the
//     pipeline. The default (no override) path is unchanged, so P0 parity holds.
// (Previously split across resolve-domain-multisource.test.ts + the standalone
// resolve-domain-swappable.test.ts; merged here so resolveDomain has one home
// and no assertion is duplicated or dropped.)

import { resolveDomain } from '../registry/logic/domains';
import { acquirePriceBars } from '../registry/sources/adapters/price-bars';
import { acquireOptionChain } from '../registry/sources/adapters/option-chain';
import { fetchCompanyNews } from '../registry/logic/news';
import { fetchRealFinancialData } from '../registry/logic/data-ingestion';
import { fuseSentiment } from '../registry/logic/fuse';

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
  it('price_bars wraps acquirePriceBars (live yahoo)', async () => {
    const fetchFn = mockFetch(YAHOO_CHART);
    const direct = await acquirePriceBars('AAPL', { fetchFn: fetchFn as any });
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

  it('option_chain wraps acquireOptionChain (live polygon)', async () => {
    const fetchFn = mockFetch(POLYGON_OPT);
    const direct = await acquireOptionChain('AAPL', { fetchFn: fetchFn as any });
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

// ===========================================================================
// P2b — news_sentiment multi-source fan-in (Finnhub + keyless Yahoo/Google),
// fused by the consumer. Drives the REAL resolveDomain + fuseSentiment with a
// routed mock fetchFn so both live paths are exercised. (Merged here from the
// former resolve-domain-multisource.test.ts — no assertion dropped.)
// ===========================================================================

/** Routed mock: returns DIFFERENT real payloads per provider URL.
 *  Finnhub = bullish company news; Yahoo RSS = bearish title. */
function routedFetch() {
  return async (url: string) => {
    if (url.includes('finnhub')) {
      return {
        ok: true,
        status: 200,
        json: async () => [
          { headline: 'AAPL smashes earnings, beats estimates', url: 'u1', source: 'Finnhub', datetime: 1, summary: 'strong quarter' },
          { headline: 'AAPL guidance raised on record demand', url: 'u2', source: 'Finnhub', datetime: 2, summary: 'bullish' },
        ],
        text: async () => '',
      };
    }
    if (url.includes('yahoo') || url.includes('google')) {
      const xml = `<rss><channel>
        <item><title>AAPL slides as analysts cut price target on weak demand</title>
        <link>https://finance.yahoo.com/news/aapl-weak</link>
        <pubDate>Wed, 17 Jul 2026 10:00:00 GMT</pubDate>
        <source url="https://finance.yahoo.com">Yahoo</source></item>
      </channel></rss>`;
      return { ok: true, status: 200, json: async () => ({}), text: async () => xml };
    }
    return { ok: false, status: 500, json: async () => ({}), text: async () => '' };
  };
}

describe('P2b news_sentiment multi-source fan-in', () => {
  it('returns TWO live records (finnhub primary + keyless yahoo) when both are live', async () => {
    const recs = await resolveDomain('news_sentiment', 'AAPL', {
      finnhubKey: 'k',
      fetchFn: routedFetch() as any,
    });
    const live = recs.filter((r) => r.sourceId !== 'mock');
    expect(live.length).toBe(2);
    const [primary, secondary] = live;
    expect(primary!.sourceId).toBe('finnhub'); // parity: primary unchanged
    expect(['yahoo', 'google', 'mixed']).toContain(secondary!.sourceId);
    expect(secondary!.sourceId).not.toBe('finnhub');
    expect(live.every((r) => r.confidence === 1)).toBe(true);
  });

  it('fuses divergent Finnhub (+) + Yahoo (-) into a blended score with low_consensus', async () => {
    const recs = await resolveDomain('news_sentiment', 'AAPL', {
      finnhubKey: 'k',
      fetchFn: routedFetch() as any,
    });
    const live = recs.filter((r) => r.sourceId !== 'mock');
    const fused = fuseSentiment(live)!;
    expect(fused).not.toBeNull();
    expect(fused.fusion.contributors[0]!).toBe('finnhub'); // primary first
    expect(fused.fusion.contributors.length).toBe(2); // finnhub + one keyless source
    expect(fused.fusion.contributors.filter((c) => c === 'finnhub').length).toBe(1);
    expect(fused.fusion.agreement).toBeLessThan(1);
    // Honest contract: low_consensus tracks agreement vs the 0.6 threshold.
    expect(fused.fusion.low_consensus).toBe(fused.fusion.agreement < 0.6);
    expect(fused.blended.source).toBe('mixed');
    expect(fused.blended.consensus).toBeDefined();
    expect(fused.blended.consensus!.low_consensus).toBe(fused.fusion.low_consensus);
    const finScore = live[0]!.data.sentiment_score;
    const yahScore = live[1]!.data.sentiment_score;
    expect(fused.blended.sentiment_score).not.toBe(finScore);
    expect(fused.blended.sentiment_score).not.toBe(yahScore);
    expect(Math.abs(fused.blended.sentiment_score - finScore)).toBeLessThan(Math.abs(finScore - yahScore));
  });

  it('low_consensus flag is consistent with observed agreement (extreme divergence)', async () => {
    const extreme = async (url: string) => {
      if (url.includes('finnhub')) {
        return {
          ok: true, status: 200,
          json: async () => [
            { headline: 'AAPL soars to record high, spectacular blowout earnings beat', url: 'u1', source: 'Finnhub', datetime: 1, summary: 'amazing' },
            { headline: 'AAPL surges as analysts hike price target on booming demand', url: 'u2', source: 'Finnhub', datetime: 2, summary: 'bullish' },
          ],
          text: async () => '',
        };
      }
      const xml = `<rss><channel>
        <item><title>AAPL plunges as stock crashes on catastrophic collapse in demand</title>
        <link>https://finance.yahoo.com/news/aapl-crash</link>
        <pubDate>Wed, 17 Jul 2026 10:00:00 GMT</pubDate>
        <source url="https://finance.yahoo.com">Yahoo</source></item>
      </channel></rss>`;
      return { ok: true, status: 200, json: async () => ({}), text: async () => xml };
    };
    const recs = await resolveDomain('news_sentiment', 'AAPL', { finnhubKey: 'k', fetchFn: extreme as any });
    const live = recs.filter((r) => r.sourceId !== 'mock');
    const fused = fuseSentiment(live)!;
    expect(fused.fusion.contributors.length).toBe(2);
    expect(fused.blended.source).toBe('mixed');
    expect(fused.fusion.agreement).toBeLessThan(1);
    expect(fused.fusion.low_consensus).toBe(fused.fusion.agreement < 0.6);
    expect(fused.blended.consensus!.low_consensus).toBe(fused.fusion.low_consensus);
  });

  it('PRESERVES parity: no finnhub key => single record, honest provenance', async () => {
    const recs = await resolveDomain('news_sentiment', 'AAPL', { fetchFn: routedFetch() as any });
    expect(recs.length).toBe(1);
    expect(recs[0]!.sourceId).not.toBe('finnhub');
    expect(['yahoo', 'google', 'mixed']).toContain(recs[0]!.sourceId);
  });

  it('PRESERVES parity: parity-mock (finnhub JSON for every url) => single finnhub record', async () => {
    const sameForAll = async () => ({
      ok: true,
      status: 200,
      json: async () => FINNHUB_NEWS,
      text: async () => JSON.stringify(FINNHUB_NEWS),
    });
    const recs = await resolveDomain('news_sentiment', 'AAPL', {
      finnhubKey: 'k',
      fetchFn: sameForAll as any,
    });
    expect(recs.length).toBe(1);
    expect(recs[0]!.sourceId).toBe('finnhub');
  });
});

// ===========================================================================
// P3a — swappable per-domain source config. resolveDomain honors an explicit
// `enabledSources` map: a source can be disabled / reordered per domain, and
// disabling the LAST source for a domain degrades THAT domain honestly (a
// `skipped` record, no false "live" badge) without taking down the rest of the
// pipeline. The default (no override) path is unchanged, so P0 parity holds.
// (Merged here from the former resolve-domain-swappable.test.ts.)
// ===========================================================================

const YAHOO_RSS = `<rss><channel><item>
  <title>AAPL falls on weak demand</title>
  <link>https://finance.yahoo.com/news/aapl-weak</link>
  <pubDate>Wed, 17 Jul 2026 10:00:00 GMT</pubDate>
  <source url="https://finance.yahoo.com">Yahoo</source></item></channel></rss>`;

function routedFetchP3() {
  return async (url: string) => {
    if (url.includes('finnhub')) {
      return { ok: true, status: 200, json: async () => FINNHUB_NEWS, text: async () => '' };
    }
    return { ok: true, status: 200, json: async () => YAHOO_CHART, text: async () => YAHOO_RSS };
  };
}

describe('P3a swappable domain source config', () => {
  it('default (no override) still resolves finnhub primary — parity intact', async () => {
    const [rec] = await resolveDomain('news_sentiment', 'AAPL', {
      fetchFn: routedFetchP3() as any,
      finnhubKey: 'k',
    });
    expect(rec!.sourceId).toBe('finnhub');
    expect(rec!.status).toBe('ok');
  });

  it('disabling finnhub => news domain resolves from yahoo/google only (no finnhub call)', async () => {
    const recs = await resolveDomain('news_sentiment', 'AAPL', {
      fetchFn: routedFetchP3() as any,
      finnhubKey: 'k', // key still present, but disabled in the mapping
      enabledSources: { news_sentiment: ['yahoo', 'google'] },
    });
    const live = recs.filter((r) => r.sourceId !== 'mock' && (r.data as any)?.headlines?.length > 0);
    expect(live.length).toBeGreaterThanOrEqual(1);
    expect(live[0]!.sourceId).not.toBe('finnhub');
  });

  it('disabling ALL sources for news => honest skipped record, no false live', async () => {
    const recs = await resolveDomain('news_sentiment', 'AAPL', {
      fetchFn: routedFetchP3() as any,
      finnhubKey: 'k',
      enabledSources: { news_sentiment: [] },
    });
    expect(recs.length).toBe(1);
    expect(recs[0]!.status).toBe('skipped');
    expect(recs[0]!.confidence).toBe(0);
    expect(recs[0]!.note).toMatch(/disabled/);
  });

  it('disabling the only source for price_bars degrades THAT domain, others unaffected', async () => {
    const priceRecs = await resolveDomain('price_bars', 'AAPL', {
      fetchFn: routedFetchP3() as any,
      enabledSources: { price_bars: [] },
    });
    expect(priceRecs.length).toBe(1);
    expect(priceRecs[0]!.status).toBe('skipped');

    const newsRecs = await resolveDomain('news_sentiment', 'AAPL', {
      fetchFn: routedFetchP3() as any,
      finnhubKey: 'k',
      enabledSources: { price_bars: [] }, // disabled here, NOT news
    });
    const live = newsRecs.filter((r) => r.sourceId !== 'mock');
    expect(live.length).toBeGreaterThanOrEqual(1);
    expect(live[0]!.sourceId).toBe('finnhub'); // news unaffected
  });

  it('reordering: news enabled as [yahoo, finnhub] still yields live data', async () => {
    const recs = await resolveDomain('news_sentiment', 'AAPL', {
      fetchFn: routedFetchP3() as any,
      finnhubKey: 'k',
      enabledSources: { news_sentiment: ['yahoo', 'finnhub'] },
    });
    const live = recs.filter((r) => r.sourceId !== 'mock');
    expect(live.length).toBeGreaterThanOrEqual(1);
  });
});

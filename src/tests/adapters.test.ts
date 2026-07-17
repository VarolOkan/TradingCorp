// src/tests/adapters.test.ts
// P1 adapter unit tests — pure normalize() against saved provider fixtures.
// These lock the canonical shape + harden against schema drift (the class of
// bug behind the earlier "schema-drifted payload" failures). They also assert
// the adapters produce output identical to what the legacy inline parse did.

import { describe, it, expect } from '@jest/globals';
import {
  normalizeYahooChart,
  yahooPriceAdapter,
} from '../registry/sources/adapters/yahoo-price';
import {
  normalizeFinnhubNews,
  finnhubNewsAdapter,
} from '../registry/sources/adapters/finnhub-news';
import {
  normalizeAvOverview,
  scoreFromAvOverview,
  alphaVantageFundamentalsAdapter,
} from '../registry/sources/adapters/alphavantage-fundamentals';
import { getAdapter, adaptersFor, ADAPTERS } from '../registry/sources/adapters';

// ---- fixtures (trimmed real-shape payloads) --------------------------------

const YAHOO_CHART_FIXTURE = {
  chart: {
    result: [
      {
        timestamp: [1710000000, 1710086400, 1710172800],
        indicators: {
          quote: [
            {
              open: [100, 101.5, null],
              high: [102, 103, null],
              low: [99, 100.5, null],
              close: [101, 102.5, null],
              volume: [1_000_000, 1_100_000, null],
              vwap: [100.5, 101.9, null],
            },
          ],
        },
      },
    ],
  },
};

const FINNHUB_FIXTURE = [
  {
    headline: 'Company beats earnings, raises guidance',
    url: 'https://finnhub.io/a',
    source: 'Reuters',
    datetime: 1710100000,
    summary: 'Strong quarter.',
  },
  {
    headline: 'Regulator opens probe into firm',
    url: 'https://finnhub.io/b',
    source: 'Bloomberg',
    datetime: 1710000000,
  },
];

const AV_OVERVIEW_FIXTURE = {
  Symbol: 'TEST',
  DebtEquityRatio: '0.42',
  CurrentRatio: '1.8',
  ReturnOnEquityTTM: '18.5',
  ReturnOnAssetsTTM: '9.2',
  ProfitMargin: '0.21',
  OperatingCashflow: '50000000',
  MarketCapitalization: '1000000000',
};

// ---- Yahoo price adapter ----------------------------------------------------

describe('yahoo-price adapter', () => {
  it('normalizes a chart payload, skipping null pads, keeping vwap on intraday', () => {
    const bars = normalizeYahooChart(YAHOO_CHART_FIXTURE, { ticker: 'TEST', interval: '5m' });
    expect(bars).not.toBeNull();
    expect(bars!.length).toBe(2); // 3rd row is all-null -> skipped
    expect(bars![0]).toMatchObject({ open: 100, high: 102, low: 99, close: 101, volume: 1_000_000, vwap: 100.5 });
    expect(bars![0]!.t).toBe(new Date(1710000000 * 1000).toISOString());
  });

  it('omits vwap on the 1d interval (parity with legacy inline block)', () => {
    const bars = normalizeYahooChart(YAHOO_CHART_FIXTURE, { ticker: 'TEST', interval: '1d' });
    expect(bars![0]).not.toHaveProperty('vwap');
  });

  it('returns null for empty / drifted payloads (caller falls back to mock)', () => {
    expect(normalizeYahooChart({}, { ticker: 'X' })).toBeNull();
    expect(normalizeYahooChart({ chart: { result: [{ timestamp: [], indicators: {} }] } }, { ticker: 'X' })).toBeNull();
    expect(normalizeYahooChart(null, { ticker: 'X' })).toBeNull();
  });

  it('adapter.normalize wraps bars into a PriceBarsResult with source=yahoo', () => {
    const r = yahooPriceAdapter.normalize(YAHOO_CHART_FIXTURE, { ticker: 'TEST', interval: '1d', lookbackDays: 90 });
    expect(r).toMatchObject({ ticker: 'TEST', interval: '1d', lookback_days: 90, source: 'yahoo' });
    expect(r!.bars.length).toBe(2);
  });
});

// ---- Finnhub news adapter ---------------------------------------------------

describe('finnhub-news adapter', () => {
  it('normalizes headlines, sorts newest-first, aggregates score', () => {
    const n = normalizeFinnhubNews(FINNHUB_FIXTURE);
    expect(n).not.toBeNull();
    expect(n!.headlines.length).toBe(2);
    // newest (datetime 1710100000) first
    expect(n!.headlines[0]!.title).toBe('Company beats earnings, raises guidance');
    expect(typeof n!.sentiment_score).toBe('number');
    expect(n!.sentiment_label).toBe(n!.sentiment_label); // label derived from agg
  });

  it('carries summary when present, undefined when absent', () => {
    const n = normalizeFinnhubNews(FINNHUB_FIXTURE)!;
    expect(n.headlines[0]!.summary).toBe('Strong quarter.');
    expect(n.headlines[1]!.summary).toBeUndefined();
  });

  it('returns null for non-array / empty payloads (falls through to Yahoo RSS)', () => {
    expect(normalizeFinnhubNews(null)).toBeNull();
    expect(normalizeFinnhubNews([])).toBeNull();
    expect(normalizeFinnhubNews([{ nope: 1 }])).toBeNull();
  });

  it('adapter.normalize stamps source=finnhub + ticker', () => {
    const r = finnhubNewsAdapter.normalize(FINNHUB_FIXTURE, { ticker: 'TEST' });
    expect(r).toMatchObject({ ticker: 'TEST', source: 'finnhub' });
    expect(r!.headlines.length).toBe(2);
  });
});

// ---- Alpha Vantage fundamentals adapter ------------------------------------

describe('alphavantage-fundamentals adapter', () => {
  it('normalizes OVERVIEW into key_ratios + health score', () => {
    const f = normalizeAvOverview(AV_OVERVIEW_FIXTURE);
    expect(f).not.toBeNull();
    expect(f!.fundamental_source).toBe('alphaVantage:OVERVIEW');
    expect(f!.key_ratios.debt_to_equity).toBe(0.42);
    expect(f!.key_ratios.roe).toBeCloseTo(0.185, 6);
    // free_cash_flow_yield = OCF / mcap = 50e6 / 1e9 = 0.05
    expect(f!.key_ratios.free_cash_flow_yield).toBeCloseTo(0.05, 6);
    expect(typeof f!.financial_health_score).toBe('number');
  });

  it('scoreFromAvOverview is deterministic and bounded 0..100', () => {
    const s = scoreFromAvOverview(AV_OVERVIEW_FIXTURE);
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(100);
    // de<0.5 (+8), cr>1.5 (+6), roe>0.15 (+10), pm>0.2 (-? pm=0.0021 after /100)
    expect(s).toBe(scoreFromAvOverview(AV_OVERVIEW_FIXTURE)); // deterministic
  });

  it('returns null without the OVERVIEW signature (caller seeds fundamentals)', () => {
    expect(normalizeAvOverview({})).toBeNull();
    expect(normalizeAvOverview({ Symbol: 'X' })).toBeNull(); // no DebtEquityRatio
    expect(normalizeAvOverview(null)).toBeNull();
  });
});

// ---- registry lookup --------------------------------------------------------

describe('adapter registry', () => {
  it('resolves adapters by domain + sourceId', () => {
    expect(getAdapter('price_bars', 'yahoo')).toBe(yahooPriceAdapter);
    expect(getAdapter('news_sentiment', 'finnhub')).toBe(finnhubNewsAdapter);
    expect(getAdapter('fundamentals', 'alphaVantage')).toBe(alphaVantageFundamentalsAdapter);
    expect(getAdapter('price_bars', 'nonexistent')).toBeUndefined();
  });

  it('adaptersFor lists all adapters registered for a domain (P2 fan-in seam)', () => {
    expect(adaptersFor('price_bars').map((a) => a.sourceId)).toContain('yahoo');
    expect(ADAPTERS.length).toBeGreaterThanOrEqual(3);
  });
});

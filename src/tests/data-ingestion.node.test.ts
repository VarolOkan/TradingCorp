// src/tests/data-ingestion.node.test.ts
// Unit tests for the Data Ingestion handler (registry/logic/data-ingestion.ts).

import { dataIngestionHandler, fetchFinancialData, fetchRealFinancialData, getDateDaysAgo } from '../registry/logic/data-ingestion';
import { makeNodeSurface } from '../registry/logic/shared';
import { AgentState } from '../types/financial-analysis';

const surface = makeNodeSurface();

describe('Data Ingestion handler', () => {
  const run = (over: Partial<AgentState> = {}): Promise<AgentState> =>
    dataIngestionHandler(
      {
        messages: [{ role: 'user', content: 'Analyze AAPL', timestamp: new Date().toISOString() }],
        current_date: '', tickers: ['AAPL'], company_name: 'AAPL',
        investment_thesis: '', final_decision: '', error: null,
        current_step: 'orchestrator_processing', ...over,
      },
      surface,
    );

  it('should fetch data for valid tickers', async () => {
    const result = await run();
    expect(result.tickers).toEqual(['AAPL']);
    expect(result.error).toBeNull();
    expect(result.current_step).toBe('data_ingestion_start');
    expect(result.messages).toHaveLength(3);
    const lastMessage = result.messages[result.messages.length - 1];
    expect(lastMessage.role).toBe('system');
    expect(lastMessage.content).toContain('Data ingestion completed');
    const secondToLast = result.messages[result.messages.length - 2];
    expect(secondToLast.role).toBe('system');
    expect(secondToLast.content).toContain('Fetching data for');
  });

  it('should handle multiple tickers', async () => {
    const result = await run({ tickers: ['AAPL', 'MSFT', 'GOOGL'], company_name: 'AAPL, MSFT, GOOGL' });
    expect(result.tickers).toEqual(['AAPL', 'MSFT', 'GOOGL']);
    expect(result.error).toBeNull();
    expect(result.current_step).toBe('data_ingestion_start');
    expect(result.messages).toHaveLength(3);
    const lastMessage = result.messages[result.messages.length - 1];
    expect(lastMessage.role).toBe('system');
    expect(lastMessage.content).toContain('Data ingestion completed');
    const secondToLast = result.messages[result.messages.length - 2];
    expect(secondToLast.role).toBe('system');
    expect(secondToLast.content).toContain('Fetching data for');
  });

  it('should handle empty tickers gracefully', async () => {
    const result = await run({ tickers: [], company_name: '' });
    expect(result.tickers).toEqual([]);
    expect(result.error).toContain('Data ingestion error');
    expect(result.current_step).toBe('data_ingestion_error');
    expect(result.messages).toHaveLength(3);
    const lastMessage = result.messages[result.messages.length - 1];
    expect(lastMessage.role).toBe('error');
    expect(lastMessage.content).toContain('Failed to fetch financial data');
    const secondToLast = result.messages[result.messages.length - 2];
    expect(secondToLast.role).toBe('system');
    expect(secondToLast.content).toContain('Fetching data for 0 ticker(s)');
  });

  it('should handle invalid input gracefully', async () => {
    const result = await run({ tickers: ['INVALID'], company_name: 'INVALID' });
    expect(result.tickers).toEqual(['INVALID']);
    expect(result.error).toBeNull();
    expect(result.current_step).toBe('data_ingestion_start');
    expect(result.messages).toHaveLength(3);
    const lastMessage = result.messages[result.messages.length - 1];
    expect(lastMessage.role).toBe('system');
    expect(lastMessage.content).toContain('Data ingestion completed');
  });

  describe('fetchFinancialData', () => {
    it('should return mock data with correct structure', async () => {
      const result = await fetchFinancialData({
        tickers: ['AAPL'],
        data_types: ['FUNDAMENTAL', 'TECHNICAL', 'SENTIMENT', 'MARKET'],
        date_range: { start: '2024-01-01', end: '2024-03-01' },
      });
      expect(result).toHaveProperty('fundamental_data');
      expect(result).toHaveProperty('technical_data');
      expect(result).toHaveProperty('sentiment_data');
      expect(result).toHaveProperty('market_data');
      expect(result).toHaveProperty('data_quality');
      expect(result).toHaveProperty('errors');
      expect(result.fundamental_data.AAPL).toBeDefined();
      expect(result.technical_data.AAPL).toBeDefined();
      expect(result.sentiment_data.AAPL).toBeDefined();
      expect(result.market_data.AAPL).toBeDefined();
    });

    it('should handle multiple tickers in mock data', async () => {
      const result = await fetchFinancialData({
        tickers: ['AAPL', 'MSFT'],
        data_types: ['FUNDAMENTAL', 'TECHNICAL', 'SENTIMENT', 'MARKET'],
        date_range: { start: '2024-01-01', end: '2024-03-01' },
      });
      expect(result.fundamental_data.AAPL).toBeDefined();
      expect(result.fundamental_data.MSFT).toBeDefined();
      expect(result.technical_data.AAPL).toBeDefined();
      expect(result.technical_data.MSFT).toBeDefined();
      expect(result.sentiment_data.AAPL).toBeDefined();
      expect(result.sentiment_data.MSFT).toBeDefined();
      expect(result.market_data.AAPL).toBeDefined();
      expect(result.market_data.MSFT).toBeDefined();
    });
  });

  describe('getDateDaysAgo', () => {
    it('should return correct date string', () => {
      const dateStr = getDateDaysAgo(30);
      expect(/^\d{4}-\d{2}-\d{2}$/.test(dateStr)).toBe(true);
      const date = new Date(dateStr);
      const today = new Date();
      const diffDays = Math.floor((today.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));
      expect(diffDays).toBeGreaterThanOrEqual(29);
      expect(diffDays).toBeLessThanOrEqual(31);
    });
  });

  describe('fetchRealFinancialData (Phase 4.1 — live Yahoo)', () => {
    const closes = Array.from({ length: 250 }, (_, i) => 150 + Math.sin(i / 10) * 20 + i * 0.1);
    const yahooChart = {
      chart: {
        result: [
          {
            meta: {
              previousClose: 190.5,
              fiftyTwoWeekHigh: 220.1,
              fiftyTwoWeekLow: 150.2,
              currency: 'USD',
            },
            timestamp: Array.from({ length: 250 }, (_, i) => i + 1),
            indicators: {
              quote: [
                {
                  open: closes.map((c) => c - 1),
                  high: closes.map((c) => c + 2),
                  low: closes.map((c) => c - 2),
                  close: closes,
                  volume: closes.map((_, i) => 1000 + i),
                },
              ],
            },
          },
        ],
      },
    };
    const liveFetch = async () => ({ ok: true, status: 200, json: async () => yahooChart });

    it('pulls REAL market + technical from Yahoo when a fetch is injected', async () => {
      const out = await fetchRealFinancialData({ tickers: ['AAPL'] }, liveFetch as any);
      expect(out.data_quality.liveSources).toContain('yahoo');
      expect(out.data_quality.sources).toContain('Yahoo Finance (live)');
      // market_data is real (last close of the 250-bar fixture)
      expect(out.market_data.AAPL.price).toBeCloseTo(closes[closes.length - 1], 1);
      expect(out.market_data.AAPL.previous_close).toBe(190.5);
      expect(out.market_data.AAPL.volume).toBe(1000 + 249);
      // technical indicators derived from real closes
      expect(out.technical_data.AAPL.indicators.sma_20).not.toBeNull();
      expect(out.technical_data.AAPL.indicators.sma_200).not.toBeNull();
      expect(out.technical_data.AAPL.indicators.rsi).not.toBeNull();
      // fundamental + sentiment remain mock (no tokenless provider) but present
      expect(out.fundamental_data.AAPL.income_statement.revenue).toBeDefined();
      expect(out.sentiment_data.AAPL.news_sentiment).toBeDefined();
    });

    it('degrades to mock market/technical when Yahoo is unreachable', async () => {
      const downFetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
      const out = await fetchRealFinancialData({ tickers: ['AAPL'] }, downFetch as any);
      expect(out.data_quality.liveSources).toHaveLength(0);
      expect(out.data_quality.sources).toContain('Yahoo Finance (mock)');
      // output shape still complete (parity)
      expect(out.market_data.AAPL.market_cap).toBeDefined();
      expect(out.technical_data.AAPL.indicators.sma_20).toBeDefined();
    });
  });

  describe('fetchRealFinancialData (Phase B — live Alpha Vantage OVERVIEW fundamentals)', () => {
    const overviewJson = {
      Symbol: 'AAPL',
      DebtEquityRatio: '1.45',
      CurrentRatio: '0.88',
      ReturnOnEquityTTM: '147',
      ReturnOnAssetsTTM: '22',
      ProfitMargin: '24',
      OperatingCashflow: '110000000000',
      MarketCapitalization: '3000000000000',
    };
    const avFetch = async () => ({ ok: true, status: 200, json: async () => overviewJson });

    it('pulls REAL fundamental ratios when an Alpha Vantage key is supplied', async () => {
      const out = await fetchRealFinancialData(
        { tickers: ['AAPL'] },
        avFetch as any,
        undefined,
        undefined,
        'AV_TEST_KEY',
      );
      const kr = out.fundamental_data.AAPL.key_ratios;
      expect(kr.debt_to_equity).toBeCloseTo(1.45, 2);
      expect(kr.current_ratio).toBeCloseTo(0.88, 2);
      expect(kr.roe).toBeCloseTo(1.47, 2); // API returns 147 → 1.47
      expect(kr.profit_margin).toBeCloseTo(0.24, 2);
      expect(out.fundamental_data.AAPL.fundamental_source).toBe('alphaVantage:OVERVIEW');
      // Honest source labelling — NOT the old "Alpha Vantage (mock)".
      expect(out.data_quality.sources).toContain('Alpha Vantage (live fundamentals)');
      expect(out.data_quality.sources).not.toContain('Alpha Vantage (mock)');
      expect(out.data_quality.liveSources).toContain('alphaVantage');
    });

    it('falls back to seeded fundamentals when no key is supplied', async () => {
      const out = await fetchRealFinancialData({ tickers: ['AAPL'] }, avFetch as any);
      // No key → no live fundamentals; seeded shape present, no AV label.
      expect(out.fundamental_data.AAPL.fundamental_source).toBeUndefined();
      expect(out.data_quality.sources).not.toContain('Alpha Vantage (live fundamentals)');
      expect(out.data_quality.liveSources).not.toContain('alphaVantage');
      // Seeded shape still structurally valid.
      expect(out.fundamental_data.AAPL.key_ratios).toBeDefined();
    });

    it('falls back to seeded fundamentals when OVERVIEW returns no ratios', async () => {
      const emptyFetch = async () => ({ ok: true, status: 200, json: async () => ({ Note: 'Thank you for using Alpha Vantage!' }) });
      const out = await fetchRealFinancialData({ tickers: ['AAPL'] }, emptyFetch as any, undefined, undefined, 'AV_TEST_KEY');
      expect(out.fundamental_data.AAPL.fundamental_source).toBeUndefined();
      expect(out.data_quality.liveSources).not.toContain('alphaVantage');
    });

    it('reports honest completeness/freshness when AV is live but Yahoo is not', async () => {
      // Yahoo down, Alpha Vantage up.
      const dualFetch = async (url: string) => {
        if (/alphavantage\.co/.test(url)) {
          return { ok: true, status: 200, json: async () => ({
            Symbol: 'AAPL', DebtEquityRatio: '1.45', CurrentRatio: '0.88',
            ReturnOnEquityTTM: '147', ReturnOnAssetsTTM: '22', ProfitMargin: '24',
            OperatingCashflow: '110000000000', MarketCapitalization: '3000000000000',
          }) };
        }
        return { ok: false, status: 500, json: async () => ({}) }; // Yahoo unreachable
      };
      const out = await fetchRealFinancialData({ tickers: ['AAPL'] }, dualFetch as any, undefined, undefined, 'AV_TEST_KEY');
      expect(out.data_quality.liveSources).toContain('alphaVantage');
      // completeness reflects partial live (90-95), NOT the seeded 80-99 baseline,
      // and freshness is 0 (a live source answered).
      expect(out.data_quality.completeness).toBeGreaterThanOrEqual(90);
      expect(out.data_quality.freshness).toBe(0);
    });
  });
});

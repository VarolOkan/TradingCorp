// src/tests/data-ingestion.profile.test.ts
// Phase C (DATA_AND_THESIS_ENHANCEMENT §3.1/§3.4): horizon-aware equity ingestion.
// Exercises the profile mapping + the horizon-appropriate bar fetch WITHOUT the
// SQLite-backed server, so it runs even where better-sqlite3 can't load.
import {
  equityProfileFromTuning,
  fetchEquityBars,
} from '../registry/logic/data-ingestion';
import type { AnalystTuning } from '../types/registry';

const tuning = (horizon: 'LONG_TERM' | 'MEDIUM_TERM' | 'INTRADAY'): AnalystTuning => ({
  horizon,
  params: {},
});

describe('equityProfileFromTuning', () => {
  it('long-term → 5y daily', () => {
    const p = equityProfileFromTuning(tuning('LONG_TERM'));
    expect(p).toEqual({ lookbackDays: 1825, intervals: ['1d'], fundamentals: '5y' });
  });

  it('medium-term → 1y daily + 5m (60m not in BarInterval type)', () => {
    const p = equityProfileFromTuning(tuning('MEDIUM_TERM'));
    expect(p).toEqual({ lookbackDays: 365, intervals: ['1d', '5m'], fundamentals: '1y' });
  });

  it('intraday → 5d 1m + 5m', () => {
    const p = equityProfileFromTuning(tuning('INTRADAY'));
    expect(p).toEqual({ lookbackDays: 5, intervals: ['1m', '5m'], fundamentals: 'quick' });
  });

  it('explicit params override the horizon default', () => {
    const p = equityProfileFromTuning({ horizon: 'LONG_TERM', params: { lookbackDays: 365, intervals: ['1d', '5m'] } });
    expect(p.lookbackDays).toBe(365);
    expect(p.intervals).toEqual(['1d', '5m']);
  });

  it('no tuning → long-term default (parity: legacy behaviour)', () => {
    const p = equityProfileFromTuning();
    expect(p).toEqual({ lookbackDays: 1825, intervals: ['1d'], fundamentals: '5y' });
  });
});

describe('fetchEquityBars', () => {
  // Mock a Yahoo chart response. The real fetcher reads parallel arrays from
  // indicators.quote[0] (q.open[i], q.close[i], ...), NOT an array of bar objects.
  const mockYahoo = (bars: number[]) => async (_url: string) => {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        chart: {
          result: [
            {
              timestamp: bars.map((_, i) => i * 86400),
              indicators: {
                quote: [
                  {
                    open: bars.slice(),
                    high: bars.slice(),
                    low: bars.slice(),
                    close: bars.slice(),
                    volume: bars.map(() => 1000),
                  },
                ],
              },
            },
          ],
        },
      }),
    };
  };

  it('intraday profile fetches 1m + 5m bars', async () => {
    const { series, source } = await fetchEquityBars('AAPL', equityProfileFromTuning(tuning('INTRADAY')), mockYahoo([1, 2, 3, 4, 5]));
    expect(series.map((s) => s.interval).sort()).toEqual(['1m', '5m']);
    expect(source).toBe('yahoo');
  });

  it('long-term profile fetches 1d bars only', async () => {
    const { series, source } = await fetchEquityBars('AAPL', equityProfileFromTuning(tuning('LONG_TERM')), mockYahoo([1, 2, 3]));
    expect(series.map((s) => s.interval)).toEqual(['1d']);
    expect(series[0]!.bars.length).toBe(3);
    expect(source).toBe('yahoo');
  });

  it('falls back to deterministic mock bars when no fetchFn', async () => {
    const { series, source } = await fetchEquityBars('AAPL', equityProfileFromTuning(tuning('LONG_TERM')));
    expect(source).toBe('mock');
    expect(series[0]!.bars.length).toBeGreaterThan(0);
    // Deterministic: same ticker+profile yields the same bar count twice.
    const { series: again } = await fetchEquityBars('AAPL', equityProfileFromTuning(tuning('LONG_TERM')));
    expect(again[0]!.bars.length).toBe(series[0]!.bars.length);
  });

  it('is horizon-aware: long-term and intraday fetch DIFFERENT intervals', async () => {
    const long1 = await fetchEquityBars('AAPL', equityProfileFromTuning(tuning('LONG_TERM')), mockYahoo([1, 2, 3]));
    const intra1 = await fetchEquityBars('AAPL', equityProfileFromTuning(tuning('INTRADAY')), mockYahoo([1, 2, 3]));
    expect(long1.series.map((s) => s.interval)).toEqual(['1d']);
    expect(intra1.series.map((s) => s.interval).sort()).toEqual(['1m', '5m']);
  });
});

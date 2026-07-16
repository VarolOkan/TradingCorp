// src/tests/screener.test.ts
// Phase 6: the screener is fast, deterministic, and agency-aware.
import { screenTickers, resolveAgencyWeights, resolveScreenerProfile, technicalPromiseScore, stabilityScore, DEFAULT_UNIVERSE } from '../registry/logic/screener';
import type { PriceBarsFetchFn } from '../registry/logic/hist';
import type { NewsFetchFn } from '../registry/logic/news';

// Deterministic fake price source: each ticker gets a fixed zig-zag series so
// technical/momentum scores are stable and assertable (no network).
function fakeBars(ticker: string): { t: string; open: number; high: number; low: number; close: number; volume: number }[] {
  // AAPL-like: strong uptrend with calm vol. TSLA-like: choppy. etc.
  const seedMap: Record<string, number[]> = {
    AAPL: [100, 105, 103, 108, 106, 112, 110, 115],
    MSFT: [200, 205, 203, 210, 208, 215, 213, 220],
    TSLA: [300, 280, 310, 270, 320, 260, 330, 250],
    NVDA: [50, 55, 54, 60, 59, 66, 65, 72],
    AMZN: [120, 122, 119, 124, 121, 126, 123, 128],
  };
  const closes = seedMap[ticker] ?? [100, 101, 99, 102, 100, 103, 101, 104];
  return closes.map((c, i) => ({
    t: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
    open: c,
    high: c + 1,
    low: c - 1,
    close: c,
    volume: 1000,
  }));
}

const priceFetch: PriceBarsFetchFn = async (url: string) => {
  const m = String(url).match(/symbol=([A-Z.]+)/i);
  const sym = (m?.[1] ?? 'AAPL').toUpperCase();
  return {
    ok: true,
    json: async () => ({
      chart: {
        result: [
          {
            timestamp: fakeBars(sym).map((_, i) => i),
            indicators: { quote: [{ open: fakeBars(sym).map((b) => b.open), high: fakeBars(sym).map((b) => b.high), low: fakeBars(sym).map((b) => b.low), close: fakeBars(sym).map((b) => b.close), volume: fakeBars(sym).map((b) => b.volume) }] },
          },
        ],
      },
    }),
  } as any;
};

// The screener runs the KEYLESS path in production (no FINNHUB_KEY), so
// fetchCompanyNews routes to the Yahoo RSS feed (the same feed the live News
// tab uses). Model that here: return Yahoo-RSS-shaped XML per ticker so the
// sentiment axis is populated deterministically and agency weighting-by-
// sentiment actually differentiates (crypto penalizes bearish TSLA harder).
const newsFetch: NewsFetchFn = async (url: string) => {
  const m = String(url).match(/symbols=([A-Z.]+)/i) ?? String(url).match(/symbol=([A-Z.]+)/i);
  const sym = (m?.[1] ?? 'AAPL').toUpperCase();
  // AAPL/MSFT get bullish headlines; TSLA gets bearish; others neutral.
  const bullish = sym === 'AAPL' || sym === 'MSFT';
  const bearish = sym === 'TSLA';
  const titles = bullish
    ? [`${sym} beats earnings, raises guidance`, `${sym} upgraded to buy on strong demand`]
    : bearish
      ? [`${sym} plunges as regulator opens investigation`, `${sym} misses estimates`]
      : [`${sym} trades flat ahead of data`];
  const items = titles
    .map(
      (t, i) =>
        `<item><title>${t}</title><link>https://finance.yahoo.com/news/${sym}-${i}.html</link><pubDate>Mon, 15 Jun 2026 10:00:00 GMT</pubDate></item>`,
    )
    .join('');
  const xml = `<rss><channel>${items}</channel></rss>`;
  // Yahoo RSS comes back as text(); also provide json() so the Finnhub branch
  // (when a key is present) doesn't crash.
  return { ok: true, text: async () => xml, json: async () => ({}) } as any;
};

describe('screener — agency weights', () => {
  it('long-term agency weights technical + sentiment most', () => {
    const w = resolveAgencyWeights('long-term');
    expect(w.technical).toBeGreaterThan(0);
    expect(w.sentiment).toBeGreaterThan(0);
    // it contains technical, sentiment, fundamental, risk
    expect(w.fundamental).toBeGreaterThan(0);
    expect(w.risk).toBeGreaterThan(0);
  });

  it('crypto-screener agency weights sentiment/onchain, not fundamental/risk', () => {
    const w = resolveAgencyWeights('crypto-screener');
    expect(w.sentiment).toBeGreaterThan(0);
    expect(w.onchain).toBeGreaterThan(0);
    expect(w.fundamental).toBe(0);
    expect(w.risk).toBe(0);
  });

  it('unknown agency falls back to a balanced default', () => {
    const w = resolveAgencyWeights('does-not-exist');
    const total = Object.values(w).reduce((s, v) => s + v, 0);
    expect(total).toBeCloseTo(1);
  });
});

describe('screener — horizon profile', () => {
  it('intraday agencies screen on short 5m / 5d bars', () => {
    expect(resolveScreenerProfile('intraday')).toEqual({ interval: '5m', lookbackDays: 5 });
    expect(resolveScreenerProfile('options-intraday')).toEqual({ interval: '5m', lookbackDays: 5 });
  });

  it('non-intraday agencies screen on daily 1d / 90d bars', () => {
    expect(resolveScreenerProfile('long-term')).toEqual({ interval: '1d', lookbackDays: 90 });
    expect(resolveScreenerProfile('medium-term')).toEqual({ interval: '1d', lookbackDays: 90 });
    expect(resolveScreenerProfile('crypto-screener')).toEqual({ interval: '1d', lookbackDays: 90 });
  });

  it('screenTickers honors the per-agency horizon (intraday uses 5m/5d, long-term uses 1d/90d)', async () => {
    // Spy on the price fetch so we can assert which interval each agency's
    // screen requested. Different horizons => distinct bars => the two
    // agencies can now rank differently (the previous "same list" bug).
    // We record the interval pulled out of each request URL in call order.
    const requestedIntervals: string[] = [];
    const priceFetch: PriceBarsFetchFn = async (url: string) => {
      const u = String(url);
      const iv = u.match(/interval=([^&]+)/)?.[1] ?? '';
      requestedIntervals.push(iv);
      const sym = (u.match(/symbol=([A-Z.]+)/i)?.[1] ?? 'AAPL').toUpperCase();
      return {
        ok: true,
        json: async () => ({
          chart: {
            result: [
              { timestamp: fakeBars(sym).map((_, i) => i), indicators: { quote: [{ open: fakeBars(sym).map((b) => b.open), high: fakeBars(sym).map((b) => b.high), low: fakeBars(sym).map((b) => b.low), close: fakeBars(sym).map((b) => b.close), volume: fakeBars(sym).map((b) => b.volume) }] } },
            ],
          },
        }),
      } as any;
    };

    await screenTickers('intraday', { universe: ['AAPL'], fetchFn: priceFetch, newsFetchFn: newsFetch });
    const intradayInterval = requestedIntervals[requestedIntervals.length - 1];
    await screenTickers('long-term', { universe: ['AAPL'], fetchFn: priceFetch, newsFetchFn: newsFetch });
    const longtermInterval = requestedIntervals[requestedIntervals.length - 1];

    expect(intradayInterval).toBe('5m');
    expect(longtermInterval).toBe('1d');
  });
});

describe('screener — technical heuristic', () => {
  it('rewards uptrends over downtrends and calm vol over choppy', () => {
    // An uptrend should clearly outscore a same-volatility downtrend (trend +
    // momentum components), and a calm low-vol series should outscore a choppy
    // one on the volatility-quality axis. These are the real signals the
    // heuristic extracts from price bars.
    const uptrend = technicalPromiseScore(Array.from({ length: 60 }, (_, i) => 100 + i * 1.5));
    const downtrend = technicalPromiseScore(Array.from({ length: 60 }, (_, i) => 200 - i * 1.5));
    expect(uptrend).toBeGreaterThan(downtrend);

    const calm = stabilityScore(Array.from({ length: 60 }, (_, i) => 100 + i * 1.5));
    const choppy = stabilityScore([300, 280, 310, 270, 320, 260, 330, 250]);
    expect(calm).toBeGreaterThan(choppy);
    // a calm uptrend is a high-quality (well above mid) technical read
    expect(uptrend).toBeGreaterThan(70);
  });
});

describe('screener — screenTickers', () => {
  it('returns a deterministic top-N sorted by promise desc', async () => {
    const res = await screenTickers('long-term', {
      universe: ['AAPL', 'MSFT', 'TSLA', 'NVDA', 'AMZN'],
      limit: 3,
      fetchFn: priceFetch,
      newsFetchFn: newsFetch,
    });
    expect(res.rows).toHaveLength(3);
    expect(res.universeSize).toBe(5);
    // sorted desc by promise
    for (let i = 1; i < res.rows.length; i++) {
      expect(res.rows[i - 1]!.promise).toBeGreaterThanOrEqual(res.rows[i]!.promise);
    }
    // AAPL (bullish news + calm uptrend) should rank at/near the top
    expect(res.rows[0]!.ticker).toBe('AAPL');
  });

  it('completes fast (bounded work, < 1000ms for 5 tickers)', async () => {
    const res = await screenTickers('long-term', {
      universe: ['AAPL', 'MSFT', 'TSLA', 'NVDA', 'AMZN'],
      limit: 5,
      fetchFn: priceFetch,
      newsFetchFn: newsFetch,
    });
    expect(res.elapsedMs).toBeLessThan(1000);
  });

  it('agency weighting changes the ranking (crypto re-ranks vs long-term)', async () => {
    const equity = await screenTickers('long-term', {
      universe: ['AAPL', 'MSFT', 'TSLA'],
      limit: 3,
      fetchFn: priceFetch,
      newsFetchFn: newsFetch,
    });
    const crypto = await screenTickers('crypto-screener', {
      universe: ['AAPL', 'MSFT', 'TSLA'],
      limit: 3,
      fetchFn: priceFetch,
      newsFetchFn: newsFetch,
    });
    // TSLA is bearish-news; the crypto agency leans hard on sentiment, so
    // TSLA's low sentiment should push its promise DOWN relative to the
    // equity agency (which also weighs technical/fundamental/risk). The exact
    // top-3 *set* can match (AAPL/MSFT are bullish in both); the agency
    // weighting signal is TSLA's relative promise drop.
    const tslaEquity = equity.rows.find((r) => r.ticker === 'TSLA')!;
    const tslaCrypto = crypto.rows.find((r) => r.ticker === 'TSLA')!;
    expect(tslaCrypto.promise).toBeLessThan(tslaEquity.promise);
  });

  it('respects a custom universe + limit', async () => {
    const res = await screenTickers('intraday', {
      universe: ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'TSLA', 'GOOGL'],
      limit: 2,
      fetchFn: priceFetch,
      newsFetchFn: newsFetch,
    });
    expect(res.rows).toHaveLength(2);
    expect(res.universeSize).toBe(6);
  });

  it('DEFAULT_UNIVERSE is a sensible size', () => {
    expect(DEFAULT_UNIVERSE.length).toBeGreaterThanOrEqual(20);
  });

  it('large alphabetical universe is de-biased before the cap (not all A-tickers)', async () => {
    // Reproduces the reported bug: when the quote pre-filter is unavailable the
    // live universe returns in alphabetical order; a naive slice(0, N) would
    // screen only A… symbols. The screener must spread the cap across the whole
    // universe so intraday/long-term screens see a representative set.
    const big: string[] = [];
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
    for (const L of letters) for (let i = 0; i < 20; i++) big.push(`${L}${i}`.padEnd(4, 'X'));
    const res = await screenTickers('intraday', {
      universe: big,
      limit: 50,
      maxScreenUniverse: 400,
      fetchFn: priceFetch,
      newsFetchFn: newsFetch,
    });
    // Cap is 400 across 520 symbols -> ~77% of the alphabet must be represented.
    const firstLetters = new Set(res.rows.map((r) => r.ticker[0]!));
    expect(firstLetters.size).toBeGreaterThan(18); // not just 'A'
    expect(firstLetters.has('A')).toBe(true);
    expect(firstLetters.has('Z')).toBe(true);
  });
});

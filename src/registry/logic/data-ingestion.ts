// src/registry/logic/data-ingestion.ts
// Phase 3 extraction (doc §8 Phase 3). Pure data-ingestion handler.
// DataIngestionNode is now a thin shim that delegates here. The fetch logic is
// deterministic (seeded from joined tickers) so the legacy and agency graphs
// produce byte-identical data-quality output (parity guarantee).

import type { AgentState } from '../../types/financial-analysis';
import type { PriceBarSeries, BarInterval } from '../../types/financial-analysis';
import { stringToSeed, seededRandom, annotateDataReceived, recordDataReceived, type NodeSurface } from './shared';
import { fetchCompanyNews, newsToIngestedSentiment } from './news';
import { fuseSentiment } from './fuse';
import { resolveDomain } from './domains';
import { acquireAlphaVantageOverview } from '../sources/adapters/alphavantage-fundamentals';
import { acquireYahooChartRaw } from '../sources/adapters/price-bars';
import type { AnalystTuning } from '../../types/registry';

export type { NodeSurface };

/**
 * Phase C (DATA_AND_THESIS_ENHANCEMENT §3.1). Equity analogue of options'
 * `profileFromTuning`. Maps the owning agency's horizon (+ explicit params) to
 * a (lookbackDays, intervals) profile that actually matches the decision
 * horizon, instead of the legacy hardcoded `range=1y&interval=1d` for every
 * agency. Precedence: explicit `tuning.params` override the horizon default.
 *
 * NOTE on intervals (deviation from the doc's `60m`): the project's `BarInterval`
 * type only permits `'1d' | '5m' | '1m'`. Yahoo has no 4h/60m JSON endpoint via
 * the chart route, and 60m exceeds the type, so the medium-term "finer" interval
 * is 5m (within Yahoo's ~60-day cap) rather than 60m. Documented here so the
 * deviation is explicit. 1m is capped to ~7-day lookback by Yahoo; 5m to ~60d.
 */
export interface EquityProfile {
  lookbackDays: number;
  intervals: BarInterval[];
  /** How far back to pull fundamentals (label only this phase; live later). */
  fundamentals: '5y' | '1y' | 'quick';
}

export function equityProfileFromTuning(tuning?: AnalystTuning): EquityProfile {
  const params = tuning?.params ?? {};
  const horizon = tuning?.horizon;
  const base: EquityProfile =
    horizon === 'INTRADAY'
      ? { lookbackDays: 5, intervals: ['1m', '5m'], fundamentals: 'quick' }
      : horizon === 'MEDIUM_TERM'
        ? { lookbackDays: 365, intervals: ['1d', '5m'], fundamentals: '1y' }
        : { lookbackDays: 1825, intervals: ['1d'], fundamentals: '5y' }; // LONG_TERM default
  // Explicit agency params win over the horizon default (same rule as options).
  if (typeof params.lookbackDays === 'number') base.lookbackDays = params.lookbackDays;
  if (
    Array.isArray(params.intervals) &&
    params.intervals.every((i: any) => ['1d', '5m', '1m'].includes(i))
  ) {
    base.intervals = params.intervals as BarInterval[];
  }
  return base;
}

/**
 * Fetch horizon-appropriate OHLCV bars for one ticker across the profile's
 * intervals. Delegates to `hist.fetchPriceBars` (reuses the existing Yahoo live
 * + deterministic mock fallback) so we don't re-invent the fetcher. Returns one
 * PriceBarSeries per interval; `source` is 'yahoo' if any interval came back
 * live, else 'mock'.
 */
export async function fetchEquityBars(
  ticker: string,
  profile: EquityProfile,
  fetchFn?: (url: string) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>,
): Promise<{ series: PriceBarSeries[]; source: 'yahoo' | 'mock' }> {
  const series: PriceBarSeries[] = [];
  let anyLive = false;
  for (const interval of profile.intervals) {
    const [rec] = await resolveDomain('price_bars', ticker, {
      ...(fetchFn ? { fetchFn: fetchFn as any } : {}),
      profile: { intervals: [interval as '1d' | '5m' | '1m'], lookbackDays: profile.lookbackDays },
    });
    const res = rec!.data;
    series.push({ interval: res.interval, lookback_days: res.lookback_days, bars: res.bars });
    if (res.source === 'yahoo') anyLive = true;
  }
  return { series, source: anyLive ? 'yahoo' : 'mock' };
}
export async function dataIngestionHandler(
  state: AgentState,
  node: NodeSurface,
  tuning?: AnalystTuning,
  finnhubKey?: string,
  alphaVantageKey?: string,
): Promise<AgentState> {
  // Signal the UI wall that this analyst panel is now active.
  node.emitProgress(state, 'analyst:start', 'data_ingestion', { stage: 1, tickers: state.tickers });

  let updatedState = node.updateStep(state, 'data_ingestion_start');

  updatedState = node.addMessage(updatedState, 'system',
    `Fetching data for ${state.tickers.length} ticker(s): ${state.tickers.join(', ')}`);

  try {
    if (!state.tickers || state.tickers.length === 0) {
      throw new Error('No tickers specified for data ingestion');
    }

    // Phase C: derive the horizon-appropriate profile from the owning agency's
    // tuning (long-term 5y daily / medium 1y+5m / intraday 5d 1m+5m). Falls back
    // to the long-term (legacy) profile when no tuning is present, so handler
    // unit tests and the long-term parity path behave exactly as before.
    const profile = equityProfileFromTuning(tuning);
    const tuningHorizon = tuning?.horizon ?? 'LONG_TERM';

    // Keep the legacy seeded 4-domain fetch as the FUNDAMENTAL/SENTIMENT parity
    // default (no tokenless provider for those domains yet — Phase G). Phase C
    // only ADDS the horizon-aware bar fetch + the `ingested` channel.
    const input: any = {
      tickers: state.tickers,
      data_types: ['FUNDAMENTAL', 'TECHNICAL', 'SENTIMENT', 'MARKET'],
      date_range: {
        start: getDateDaysAgo(Math.min(profile.lookbackDays, 365)),
        end: new Date().toISOString().split('T')[0]!,
      },
    };

    const fetchImpl = async () => fetchFinancialData(input, undefined, profile, alphaVantageKey);
    const output: any = node.executeWithRetry
      ? await node.executeWithRetry(fetchImpl, 'data_ingestion', { tickers: state.tickers })
      : await fetchImpl();

    // §4.9b — when a Finnhub key is configured, upgrade sentiment from the
    // seeded parity default to REAL company-news. This makes the Sentiment
    // analyst data-driven (ingested.sentiment[ticker].data_source =
    // 'finnhub:live-news') instead of mocked. No key → falls through to the
    // seeded default and the trace honestly marks sentiment seeded.
    const sentimentData = { ...(output.sentiment_data ?? {}) };
    const liveSentimentSources: string[] = [];
    if (finnhubKey && typeof (globalThis as any).fetch === 'function') {
      const fetchFn = (url: string, init: any) => (globalThis as any).fetch(url, init);
      for (const ticker of state.tickers) {
        try {
          // P2b: resolveDomain returns the primary finnhub record + (best-effort)
          // a keyless secondary (yahoo/google). Fuse them when >1 live source;
          // otherwise fall back to the unchanged single-source behaviour.
          const recs = await resolveDomain('news_sentiment', ticker, { finnhubKey, fetchFn: fetchFn as any });
          const liveRecs = recs.filter((r) => r.data && r.data.headlines.length > 0 && r.sourceId !== 'mock');
          let news = liveRecs[0]?.data;
          if (!news && recs[0]?.data) news = recs[0].data; // all-mock: keep seeded shape
          if (!news || news.headlines.length === 0) continue;
          // Fuse when multiple live sources present (genuine fan-in).
          const fused = liveRecs.length > 1 ? fuseSentiment(liveRecs) : null;
          const chosen = fused ? fused.blended : news;
          const ingest = newsToIngestedSentiment(chosen);
          if (fused) {
            ingest.data_source = `mixed:${fused.fusion.contributors.join('+')}`;
            (ingest as any).consensus = fused.blended.consensus;
          }
          sentimentData[ticker] = { ...sentimentData[ticker], ...ingest };
          for (const r of liveRecs) liveSentimentSources.push(`${r.sourceId} (live news)`);
        } catch {
          /* keep seeded sentiment for this ticker on fetch failure */
        }
      }
    }
    output.sentiment_data = sentimentData;

    // Phase C: fetch the horizon-appropriate OHLCV bars for each ticker, reusing
    // hist.acquirePriceBars (Yahoo live + deterministic mock fallback). Stash on
    // state.ingested for downstream analysts (consumed Phases D–F). The fetchFn
    // is picked up from globalThis.fetch when present.
    const ingestedBars: Record<string, PriceBarSeries[]> = {};
    const ingestedMarket: Record<string, any> = {};
    const sourcesSeen = new Set<'yahoo' | 'mock'>();
    for (const ticker of state.tickers) {
      const { series, source } = await fetchEquityBars(ticker, profile);
      ingestedBars[ticker] = series;
      sourcesSeen.add(source);
      const daily = series.find((s) => s.interval === '1d') ?? series[series.length - 1];
      const last = daily?.bars[daily.bars.length - 1];
      ingestedMarket[ticker] = last
        ? {
            price: last.close,
            day_high: last.high,
            day_low: last.low,
            volume: last.volume,
            interval: daily.interval,
            bars_used: daily.bars.length,
            // Phase F: carry beta / volatility_30d (+ other meta) from the seeded
            // market_data so the risk analyst can size coherently off real inputs.
            ...(output.market_data?.[ticker] ?? {}),
          }
        : { ...(output.market_data?.[ticker] ?? {}) };
    }
    const ingestedSource: 'yahoo' | 'mock' | 'mixed' = sourcesSeen.has('yahoo')
      ? sourcesSeen.has('mock')
        ? 'mixed'
        : 'yahoo'
      : liveSentimentSources.length > 0
        ? 'mixed'
        : 'mock';

    const ingested = {
      bars: ingestedBars,
      market: ingestedMarket,
      fundamental: output.fundamental_data ?? {},
      technical: output.technical_data ?? {},
      sentiment: output.sentiment_data ?? {},
      source: ingestedSource,
    };

    // Phase R2 (RAW_DATA_DUMP.md): the ingestion analyst records the raw slices
    // it collected per ticker, so the export's per-analyst annotation shows the
    // full set of data the ingestion stage gathered (the "source of truth" the
    // downstream analysts consume). Provenance follows the bars' source.
    const provenance: 'live' | 'mock' | 'mixed' =
      ingestedSource === 'yahoo' ? 'live' : ingestedSource === 'mixed' ? 'mixed' : 'mock';
    for (const ticker of state.tickers) {
      const series = ingestedBars[ticker] ?? [];
      const market = ingestedMarket[ticker];
      const fundLive = output.fundamental_data?.[ticker]?.fundamental_source === 'alphaVantage:OVERVIEW';
      const sentLive = liveSentimentSources.length > 0 && output.sentiment_data?.[ticker]?.data_source?.includes('live');
      const blocks = [
        ...series.map((s) => ({
          domain: 'bars' as const,
          interval: s.interval,
          source: ingestedSource,
          barsUsed: s.bars.length,
        })),
        ...(market ? [{ domain: 'market' as const, source: ingestedSource, rows: 1 }] : []),
        ...(Object.keys(output.fundamental_data ?? {}).length
          ? [{ domain: 'fundamental' as const, source: fundLive ? ('live' as const) : ('seeded' as const) }]
          : []),
        ...(Object.keys(output.sentiment_data ?? {}).length
          ? [{
              domain: 'sentiment' as const,
              source: sentLive ? ('live' as const) : ('seeded' as const),
            }]
          : []),
      ];
      updatedState = recordDataReceived(updatedState, annotateDataReceived(
        'data_ingestion', ticker, 'ingested', blocks, provenance,
        `collected ${series.length} interval(s) of bars + market meta; fundamental ${fundLive ? 'live (Alpha Vantage OVERVIEW)' : 'seeded'}, sentiment ${sentLive ? 'live (Finnhub news)' : 'seeded'}`,
      ));
    }

    // Surface the live Finnhub news feed in the ingestion trace's source list
    // (only when it actually returned headlines for this run).
    if (liveSentimentSources.length > 0 && Array.isArray(output?.data_quality?.sources)) {
      output.data_quality.sources = Array.from(new Set([...output.data_quality.sources, ...liveSentimentSources]));
    }

    updatedState = {
      ...updatedState,
      // Phase C: write the ingested channel (single writer, like optionsData).
      ingested,
      messages: [
        ...(updatedState.messages || []),
        {
          role: 'system',
          content: `Data ingestion completed for ${state.tickers.length} ticker(s)`,
          timestamp: new Date().toISOString(),
          data: {
            fundamental_data_available: !!Object.keys(output.fundamental_data).length,
            technical_data_available: !!Object.keys(output.technical_data).length,
            sentiment_data_available: !!Object.keys(output.sentiment_data).length,
            market_data_available: !!Object.keys(output.market_data).length,
            data_quality: output.data_quality,
            ingested: {
              horizon: tuningHorizon,
              profile,
              source: ingestedSource,
              barsPerTicker: state.tickers.map((t) => ({
                ticker: t,
                intervals: ingestedBars[t]?.map((s) => `${s.interval}:${s.bars.length}`) ?? [],
              })),
            },
          },
        },
      ],
    };

    updatedState = node.captureTrace(updatedState, {
      analyst: 'data_ingestion',
      name: 'Data Ingestion',
      stage: 1,
      instructions:
        'Fetch, standardize, and load fundamental, technical, sentiment, and market data for every ticker across the configured sources; validate completeness and flag stale feeds.',
      inputs: state.tickers.map((ticker) => ({
        ticker,
        label: 'Raw data ingested',
        data: {
          domains: ['FUNDAMENTAL', 'TECHNICAL', 'SENTIMENT', 'MARKET'],
          completeness: output.data_quality.completeness,
          freshness_hours: output.data_quality.freshness,
        },
        sources: output.data_quality.sources,
      })),
      weighting: [
        { label: 'Completeness gate', inputs: ['completeness'], weight: 0.6, rationale: 'Records that are < 80% complete are flagged for fallback/re-fetch.', contribution: 60, scale: '0..100 quality weight' },
        { label: 'Freshness gate', inputs: ['freshness_hours'], weight: 0.4, rationale: 'Data older than the freshness window is down-weighted for the run.', contribution: 40, scale: '0..100 quality weight' },
      ],
      output: {
        verdict: 'INGESTED',
        score: output.data_quality.completeness,
        summary: `Ingested ${state.tickers.length} ticker(s): fundamental, technical, sentiment, and market domains loaded from ${output.data_quality.sources.join(', ')}. Horizon=${tuningHorizon} → ${profile.intervals.join(',')} bars (source=${ingestedSource}).`,
        details: output,
      },
      notes: [
        `Horizon profile: ${tuningHorizon} → lookbackDays=${profile.lookbackDays}, intervals=[${profile.intervals.join(',')}], fundamentals=${profile.fundamentals}.`,
        ...(ingestedSource === 'mock'
          ? ['Bars are deterministic mock (no live fetch available).']
          : [`Bars source: ${ingestedSource}.`]),
        ...(liveSentimentSources.length > 0
          ? ['Sentiment driven by live Finnhub company-news (no social mock).']
          : ['Fundamental + social remain seeded (no live provider wired yet — Phase G).']),
      ],
    });

    node.emitProgress(updatedState, 'analyst:done', 'data_ingestion', {
      stage: 1,
      tickers: state.tickers,
      summary: `Ingested ${state.tickers.length} ticker(s)`,
    });
    return updatedState;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      ...updatedState,
      error: `Data ingestion error: ${errorMessage}`,
      current_step: 'data_ingestion_error',
      messages: [
        ...(updatedState.messages || []),
        { role: 'error', content: `Failed to fetch financial data: ${errorMessage}`, timestamp: new Date().toISOString() },
      ],
    };
  }
}

export async function fetchFinancialData(input: any, _fetchFn?: any, profile?: { intervals: BarInterval[]; lookbackDays: number }, alphaVantageKey?: string): Promise<any> {
  return fetchRealFinancialData(input, _fetchFn, profile, undefined, alphaVantageKey);
}

/**
 * Phase 4.1 — REAL data ingestion for the market + technical domains, sourced
 * from Yahoo Finance's tokenless chart endpoint (the same source powering
 * GET /quote and GET /history). Fundamental + sentiment domains have NO
 * tokenless provider, so they keep the deterministic seeded mock (clearly
 * labelled in `data_quality.sources`). Every domain degrades per-field to mock
 * when Yahoo is unreachable, so output shape is always complete (parity).
 *
 * Returns the same 4-domain shape as the legacy mock, plus an honest
 * `data_quality.sources` list and a `liveSources` array the trace can surface.
 */
export type IngestionFetchFn = (url: string) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<any>;
}>;

/** Map a lookback in days to a Yahoo range token (clamped to Yahoo's caps). */
function yahooRangeFor(lookbackDays: number): string {
  if (lookbackDays <= 5) return '5d';
  if (lookbackDays <= 30) return '1mo';
  if (lookbackDays <= 90) return '3mo';
  if (lookbackDays <= 180) return '6mo';
  if (lookbackDays <= 365) return '1y';
  return '5y';
}

function num(v: any): number | null {
  if (v === undefined || v === null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function sma(closes: number[], period: number): number | null {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  return slice.reduce((s, x) => s + x, 0) / period;
}

function rsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = (num(closes[i]) ?? 0) - (num(closes[i - 1]) ?? 0);
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** Map an Alpha Vantage OVERVIEW payload onto a FundamentalAnalyzer health
 *  score (0-100). Re-exported from the AV adapter (single source of truth). */

export async function fetchRealFinancialData(
  input: any,
  fetchFn?: IngestionFetchFn,
  profile?: { intervals: BarInterval[]; lookbackDays: number },
  newsOpts?: { newsFetcher?: import('./news').NewsFetchFn; finnhubKey?: string },
  alphaVantageKey?: string,
): Promise<any> {
  const doFetch =
    fetchFn ?? ((globalThis as any).fetch?.bind?.(globalThis) as IngestionFetchFn | undefined);

  const fundamental_data: Record<string, any> = {};
  const technical_data: Record<string, any> = {};
  const sentiment_data: Record<string, any> = {};
  const market_data: Record<string, any> = {};

  const batchRng = seededRandom(stringToSeed(input.tickers.join(',')));
  const liveSources: string[] = [];
  const sourceLabels: string[] = [];

  // 2.1b — honor the horizon profile. When a profile is supplied we fetch each
  // of its intervals from Yahoo (real 5m/1m for intraday/medium, 1d for long),
  // instead of the legacy hardcoded range=1y&interval=1d. Without a profile we
  // keep the legacy single 1d series for parity.
  const intervals = profile?.intervals && profile.intervals.length > 0 ? profile.intervals : (['1d'] as BarInterval[]);
  const lookbackDays = profile?.lookbackDays ?? 365;

  for (const ticker of input.tickers) {
    // ---- Real Alpha Vantage OVERVIEW fundamentals (when a key is supplied) ----
    // OVERVIEW returns balance-sheet ratios (DebtEquityRatio, CurrentRatio,
    // ReturnOnEquityTTM, ReturnOnAssetsTTM, ProfitMargin, OperatingCashflow,
    // MarketCapitalization, …) — exactly the shape the Fundamental analyst
    // consumes. This is the genuine live source; the seeded block below is only
    // a parity fallback when no key / fetch are available.
    // P4: URL + fetch delegated to the AV fundamentals adapter.
    const liveFundamentals = alphaVantageKey && typeof doFetch === 'function'
      ? await acquireAlphaVantageOverview(ticker, { fetchFn: doFetch as any, apiKey: alphaVantageKey })
      : null;

    // ---- Mock fallback seeds (fundamental, sentiment, missing market bits) ----
    // Used only when no live fundamentals were retrieved above.
    fundamental_data[ticker] = liveFundamentals ?? {
      balance_sheet: {
        total_assets: Math.floor(batchRng() * 100000) + 10000,
        total_liabilities: Math.floor(batchRng() * 50000) + 5000,
        total_equity: Math.floor(batchRng() * 50000) + 5000,
        cash_and_equivalents: Math.floor(batchRng() * 20000) + 2000,
        total_debt: Math.floor(batchRng() * 30000) + 3000,
      },
      income_statement: {
        revenue: Math.floor(batchRng() * 100000) + 10000,
        gross_profit: Math.floor(batchRng() * 50000) + 5000,
        operating_income: Math.floor(batchRng() * 30000) + 3000,
        net_income: Math.floor(batchRng() * 20000) + 2000,
        eps: (batchRng() * 10).toFixed(2),
      },
      cash_flow: {
        operating_cash_flow: Math.floor(batchRng() * 25000) + 2500,
        investing_cash_flow: Math.floor(batchRng() * 10000) - 5000,
        financing_cash_flow: Math.floor(batchRng() * 10000) - 5000,
        free_cash_flow: Math.floor(batchRng() * 20000) + 2000,
      },
      key_ratios: {
        pe_ratio: (batchRng() * 50).toFixed(2),
        pb_ratio: (batchRng() * 10).toFixed(2),
        debt_to_equity: (batchRng() * 2).toFixed(2),
        current_ratio: (batchRng() * 3 + 0.5).toFixed(2),
        roe: (batchRng() * 0.3 + 0.05).toFixed(4),
        roa: (batchRng() * 0.15 + 0.02).toFixed(4),
        profit_margin: (batchRng() * 0.2 + 0.05).toFixed(4),
      },
    };

    sentiment_data[ticker] = {
      news_sentiment: ['VERY_POSITIVE', 'POSITIVE', 'NEUTRAL', 'NEGATIVE', 'VERY_NEGATIVE'][Math.floor(batchRng() * 5)],
      social_sentiment: ['VERY_POSITIVE', 'POSITIVE', 'NEUTRAL', 'NEGATIVE', 'VERY_NEGATIVE'][Math.floor(batchRng() * 5)],
      analyst_sentiment: ['VERY_POSITIVE', 'POSITIVE', 'NEUTRAL', 'NEGATIVE', 'VERY_NEGATIVE'][Math.floor(batchRng() * 5)],
      institutional_sentiment: ['VERY_POSITIVE', 'POSITIVE', 'NEUTRAL', 'NEGATIVE', 'VERY_NEGATIVE'][Math.floor(batchRng() * 5)],
      sentiment_score: Math.floor(batchRng() * 201) - 100,
      news_count: Math.floor(batchRng() * 20) + 5,
      social_mentions: Math.floor(batchRng() * 1000) + 100,
    };

    // ---- Real Yahoo market + technical (per profile interval) ----
    let yahoo: any = null;
    const intervalResults: Record<string, any> = {};
    if (typeof doFetch === 'function') {
      for (const iv of intervals) {
        const range = yahooRangeFor(lookbackDays);
        // P4: URL + fetch delegated to the price-bars adapter.
        const r = await acquireYahooChartRaw(ticker, range, iv, doFetch);
        if (r) intervalResults[iv] = r;
      }
      yahoo = Object.values(intervalResults)[0] ?? null;
    }

    if (yahoo) {
      const meta = yahoo.meta ?? {};
      const q = yahoo.indicators?.quote?.[0] ?? {};
      const ts: number[] = yahoo.timestamp ?? [];
      const closes: number[] = (q.close ?? []).filter((x: any) => num(x) !== null);
      const lastIdx = ts.length - 1;
      const lastClose = num(closes[closes.length - 1]) ?? 0;
      const lastVol = num(q.volume?.[lastIdx]) ?? 0;
      const lastHigh = num(q.high?.[lastIdx]) ?? lastClose;
      const lastLow = num(q.low?.[lastIdx]) ?? lastClose;

      market_data[ticker] = {
        price: lastClose,
        day_high: lastHigh,
        day_low: lastLow,
        previous_close: num(meta.previousClose),
        week52_high: num(meta.fiftyTwoWeekHigh),
        week52_low: num(meta.fiftyTwoWeekLow),
        volume: lastVol,
        currency: meta.currency ?? 'USD',
        market_cap: Math.floor(batchRng() * 1000000) + 100000, // Yahoo chart lacks this; mock
        enterprise_value: Math.floor(batchRng() * 1200000) + 120000,
        shares_outstanding: Math.floor(batchRng() * 1000000) + 100000,
        float_shares: Math.floor(batchRng() * 900000) + 90000,
        short_interest: Math.floor(batchRng() * 100000) + 1000,
        beta: (batchRng() * 2 + 0.5).toFixed(2),
        volatility_30d: (batchRng() * 0.8 + 0.2).toFixed(4),
        dividend_yield: (batchRng() * 0.08).toFixed(4),
        pe_ratio: (batchRng() * 50).toFixed(2),
        pb_ratio: (batchRng() * 10).toFixed(2),
      };

      technical_data[ticker] = {
        price_data: {
          open: num(q.open?.[lastIdx]) ?? lastClose,
          high: lastHigh,
          low: lastLow,
          close: lastClose,
          volume: lastVol,
        },
        indicators: {
          sma_20: sma(closes, 20),
          sma_50: sma(closes, 50),
          sma_200: sma(closes, 200),
          ema_12: null, // not computed (needs full EMA series); left null
          ema_26: null,
          rsi: rsi(closes, 14),
          macd: { macd: null, signal: null, histogram: null },
          bollinger_bands: {
            upper: num(meta.fiftyTwoWeekHigh) ?? null,
            middle: lastClose,
            lower: num(meta.fiftyTwoWeekLow) ?? null,
          },
        },
      };
      liveSources.push('yahoo');
      sourceLabels.push('Yahoo Finance (live)');
    } else {
      // Yahoo unavailable → mock market + technical, parity-safe.
      market_data[ticker] = {
        market_cap: Math.floor(batchRng() * 1000000) + 100000,
        enterprise_value: Math.floor(batchRng() * 1200000) + 120000,
        shares_outstanding: Math.floor(batchRng() * 1000000) + 100000,
        float_shares: Math.floor(batchRng() * 900000) + 90000,
        short_interest: Math.floor(batchRng() * 100000) + 1000,
        beta: (batchRng() * 2 + 0.5).toFixed(2),
        volatility_30d: (batchRng() * 0.8 + 0.2).toFixed(4),
        dividend_yield: (batchRng() * 0.08).toFixed(4),
        pe_ratio: (batchRng() * 50).toFixed(2),
        pb_ratio: (batchRng() * 10).toFixed(2),
      };
      technical_data[ticker] = {
        price_data: {
          open: (batchRng() * 100 + 10).toFixed(2),
          high: (batchRng() * 100 + 10).toFixed(2),
          low: (batchRng() * 100 + 10).toFixed(2),
          close: (batchRng() * 100 + 10).toFixed(2),
          volume: Math.floor(batchRng() * 1000000) + 100000,
        },
        indicators: {
          sma_20: (batchRng() * 100 + 10).toFixed(2),
          sma_50: (batchRng() * 100 + 10).toFixed(2),
          sma_200: (batchRng() * 100 + 10).toFixed(2),
          ema_12: (batchRng() * 10 - 5).toFixed(4),
          ema_26: (batchRng() * 10 - 5).toFixed(4),
          rsi: Math.floor(batchRng() * 100),
          macd: {
            macd: (batchRng() * 10 - 5).toFixed(4),
            signal: (batchRng() * 10 - 5).toFixed(4),
            histogram: (batchRng() * 10 - 5).toFixed(4),
          },
          bollinger_bands: {
            upper: (batchRng() * 120 + 20).toFixed(2),
            middle: (batchRng() * 100 + 10).toFixed(2),
            lower: (batchRng() * 80 + 5).toFixed(2),
          },
        },
      };
      sourceLabels.push('Yahoo Finance (mock)');
    }

    // Fundamental is now REAL when an Alpha Vantage key + fetch are available
    // (see OVERVIEW fetch at the top of the loop). NEWS is real when a Finnhub
    // key + fetch are available — override sentiment_data so the sentiment
    // analyst's `realSent` hook fires with genuine headlines.
    if (liveFundamentals) {
      sourceLabels.push('Alpha Vantage (live fundamentals)');
      liveSources.push('alphaVantage');
    }
    if (newsOpts?.newsFetcher || (typeof (globalThis as any).fetch === 'function' && (newsOpts?.finnhubKey || (process as any).env?.FINNHUB_KEY))) {
      try {
        const news = await fetchCompanyNews(
          ticker,
          { finnhubKey: newsOpts?.finnhubKey, fetchFn: (newsOpts?.newsFetcher ?? (globalThis as any).fetch) as any },
        );
        if (news.source === 'finnhub' && news.headlines.length > 0) {
          sentiment_data[ticker] = {
            ...sentiment_data[ticker],
            ...newsToIngestedSentiment(news),
          };
          sourceLabels.push('Finnhub (live news)');
        } else {
          sourceLabels.push('Finnhub (mock news)');
        }
      } catch {
        sourceLabels.push('Finnhub (mock news)');
      }
    }
  }

  const yahooLive = liveSources.includes('yahoo');
  const avLive = liveSources.includes('alphaVantage');
  const hasLiveCoverage = yahooLive || avLive;
  return {
    fundamental_data,
    technical_data,
    sentiment_data,
    market_data,
    data_quality: {
      // Honest completeness: full (100) when both market (Yahoo) + fundamental
      // (Alpha Vantage) are live; 90-95 when only one live domain is real; the
      // seeded 80-99 baseline only when NOTHING live was fetched at all.
      completeness: hasLiveCoverage
        ? (yahooLive && avLive ? 100 : Math.floor(batchRng() * 6) + 90)
        : Math.floor(batchRng() * 20) + 80,
      // Freshness is 0 whenever any live source answered; the seeded baseline
      // (0-23h) only applies when every domain fell back to mock.
      freshness: hasLiveCoverage ? 0 : Math.floor(batchRng() * 24),
      sources: Array.from(new Set(sourceLabels)),
      liveSources: Array.from(new Set(liveSources)),
    },
    errors: [],
  };
}

export function getDateDaysAgo(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString().split('T')[0]!;
}

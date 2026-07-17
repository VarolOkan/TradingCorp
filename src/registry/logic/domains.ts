// src/registry/logic/domains.ts
// P0 of the multi-source architecture (see docs/MULTI_SOURCE_ARCHITECTURE.md).
//
// `resolveDomain(domain, ticker, ctx)` is the SINGLE entry point analysts will
// use to get data. In P0 it is a PARITY-PRESERVING wrapper: it calls the
// EXISTING single-source functions (fetchPriceBars, fetchOptionChain,
// fetchCompanyNews, fetchRealFinancialData, acquireSource+parseTreasuryRfr) and
// wraps each result in a ONE-ELEMENT `NormalizedRecord<T>[]`.
//
// P0 invariant: output is byte-for-byte identical to calling those functions
// directly (proven by domains.p0.test.ts). P1 swaps the backing calls for
// adapter.normalize(); P2 makes the list multi-element and adds weighting. The
// analyst-facing signature (a LIST) never changes.

import type { DataDomain, DomainRecords, ResolveDomainCtx } from '../types/domains';
import { mkRecord } from '../types/domains';
import type { DataSourceSpec } from '../../types/registry';
import { fetchPriceBars, fetchOptionChain, parseTreasuryRfr } from './hist';
import { fetchCompanyNews } from './news';
import { fetchRealFinancialData } from './data-ingestion';
import { acquireSource } from '../sources/acquire';
import { DEFAULT_SOURCE_URIS } from '../analyst-config-schema';
import { domainSourceConfigStore } from '../../server/domain-source-config';

/**
 * P3b — resolve the effective enabled-source list for a domain.
 * - undefined  -> no UI/config override; caller falls back to the compile-time
 *   DOMAIN_SOURCES default (byte-for-byte the legacy behaviour, so P0 parity
 *   survives when nothing is configured in the Settings UI).
 * - string[]   -> an explicit override (possibly empty = all disabled).
 * Reads the persisted DomainSourceConfigStore only when an override exists, so
 * an unconfigured server behaves exactly as before.
 */
function getDomainEnabledSources(domain: DataDomain): string[] | undefined {
  const d = domain as Parameters<typeof domainSourceConfigStore.isOverridden>[0];
  return domainSourceConfigStore.isOverridden(d) ? domainSourceConfigStore.get(d) : undefined;
}

/** P1 seam: today the live source id is hard-coded per branch; later sourced
 *  from AnalystConfigStore domain→sources mapping. Kept as constants so the
 *  P2 diff is small. */
const LEGACY_SOURCE_ID = {
  price_bars: 'yahoo',
  option_chain: 'polygon',
  news_sentiment: 'finnhub',
  fundamentals: 'alphaVantage',
  risk_free_rate: 'treasuryRfr',
  market_meta: 'yahoo',
} as const;

function isLiveSource(source: string): boolean {
  return source !== 'mock' && source !== 'seed';
}

export async function resolveDomain<D extends DataDomain>(
  domain: D,
  ticker: string,
  ctx: ResolveDomainCtx = {},
): Promise<DomainRecords<D>> {
  const doFetch = ctx.fetchFn;
  const sym = ticker.trim().toUpperCase();

  // P3 — swappable per-domain source mapping. When the caller supplies an
  // explicit enabled list for THIS domain, resolveDomain honours it (enable /
  // disable / reorder). When the list is explicitly empty, the domain degrades
  // HONESTLY (single `skipped` record) instead of fabricating a live source or
  // taking down the whole pipeline. When no override is supplied, resolveDomain
  // falls back to the persisted DomainSourceConfigStore (set via the Settings
  // UI, P3b); if that is also unset, the compile-time DOMAIN_SOURCES default
  // applies. So: ctx override > UI config > default. P0 parity holds for the
  // no-override / default path.
  const explicit = ctx.enabledSources?.[domain];
  const enabled: string[] | undefined =
    explicit !== undefined
      ? explicit
      : getDomainEnabledSources(domain);
  if (enabled !== undefined) {
    if (enabled.length === 0) {
      return [mkRecord(
        LEGACY_SOURCE_ID[domain],
        'skipped',
        null as any,
        0,
        `all sources disabled for domain '${domain}'`,
      )] as unknown as DomainRecords<D>;
    }
  }

  switch (domain) {
    case 'price_bars': {
      const r = await fetchPriceBars(sym, {
        interval: ctx.profile?.intervals?.[0] ?? '1d',
        lookbackDays: ctx.profile?.lookbackDays ?? 90,
        fetchFn: doFetch as any,
      });
      const live = r.source === 'yahoo';
      return [mkRecord(LEGACY_SOURCE_ID.price_bars, live ? 'ok' : 'fallback', r, live ? 1 : 0, live ? 'live' : 'mock fallback')] as DomainRecords<D>;
    }

    case 'option_chain': {
      const r = await fetchOptionChain(sym, {
        fetchFn: doFetch as any,
        ...(ctx.apiKey ? { apiKey: ctx.apiKey } : {}),
      });
      const live = isLiveSource(r.source);
      return [mkRecord(LEGACY_SOURCE_ID.option_chain, live ? 'ok' : 'fallback', r, live ? 1 : 0, live ? `live (${r.source})` : 'mock fallback')] as DomainRecords<D>;
    }

    case 'news_sentiment': {
      // P3: honour the per-domain enabled set when supplied. The primary fetch
      // is finnhub (with key) IFF 'finnhub' is enabled, else the keyless
      // yahoo/google chain. A keyless secondary is appended only when finnhub
      // is the primary AND a keyless source ('yahoo'/'google') is enabled.
      const wantFinnhub = enabled !== undefined ? enabled.includes('finnhub') : true;
      const allowKeyless = enabled !== undefined
        ? enabled.some((s) => s === 'yahoo' || s === 'google')
        : true;
      const primary = await fetchCompanyNews(sym, {
        fetchFn: doFetch as any,
        finnhubKey: wantFinnhub ? ctx.finnhubKey : undefined,
      });
      const pLive = isLiveSource(primary.source);
      const records = [
        mkRecord(primary.source, pLive ? 'ok' : 'fallback', primary, pLive ? 1 : 0, pLive ? `live (${primary.source})` : 'mock fallback'),
      ] as DomainRecords<D>;

      if (pLive && primary.source === 'finnhub' && allowKeyless && typeof doFetch === 'function') {
        try {
          const secondary = await fetchCompanyNews(sym, { fetchFn: doFetch as any });
          if (isLiveSource(secondary.source) && secondary.source !== 'finnhub' && secondary.headlines.length > 0) {
            (records as any[]).push(
              mkRecord(secondary.source, 'ok', secondary, 1, `live (${secondary.source})`),
            );
          }
        } catch {
          /* second source is best-effort; primary alone is fine */
        }
      }
      return records;
    }

    case 'fundamentals': {
      const newsOpts: Record<string, any> = {};
      if (ctx.finnhubKey !== undefined) newsOpts.finnhubKey = ctx.finnhubKey;
      if (doFetch !== undefined) newsOpts.newsFetcher = doFetch;
      const res = await fetchRealFinancialData(
        { tickers: [sym] },
        doFetch as any,
        undefined,
        newsOpts as any,
        ctx.alphaVantageKey,
      );
      const data = (res.fundamental_data?.[sym] ?? null) as any;
      const live = typeof data?.fundamental_source === 'string' && data.fundamental_source.startsWith('alphaVantage');
      return [mkRecord(LEGACY_SOURCE_ID.fundamentals, live ? 'ok' : 'fallback', data, live ? 1 : 0, live ? 'live (alphaVantage:OVERVIEW)' : 'seeded fallback')] as DomainRecords<D>;
    }

    case 'risk_free_rate': {
      // Flows through the EXISTING §4.9 engine (no standalone fetcher exists).
      const spec: DataSourceSpec = {
        id: LEGACY_SOURCE_ID.risk_free_rate,
        type: 'rest',
        endpoint: DEFAULT_SOURCE_URIS.treasuryRfr as string,
        auth: 'none',
        fields: ['data'],
        okPath: 'data[0]',
        label: 'Treasury RFR',
        sources: ['US Treasury'],
        timeoutMs: 8000,
        retries: 1,
        onError: 'degrade',
      };
      const res = await acquireSource(spec, { fetchFn: doFetch as any, ticker: sym });
      const row = (res.data as any)?.data?.[0];
      const rfr = row ? parseTreasuryRfr(row) : null;
      if (res.ok && rfr != null) {
        return [mkRecord(LEGACY_SOURCE_ID.risk_free_rate, 'ok', rfr, 1, 'live (treasury)')] as DomainRecords<D>;
      }
      return [mkRecord(LEGACY_SOURCE_ID.risk_free_rate, 'failed', 0, 0, res.reason ?? 'treasury unavailable')] as DomainRecords<D>;
    }

    case 'market_meta': {
      // P0: derived from price_bars (realized vol + last close). mkt cap not
      // available without fundamentals; left undefined. P2 may add a dedicated
      // source. Kept honest: confidence reflects the backing price_bars source.
      const r = await fetchPriceBars(sym, {
        interval: ctx.profile?.intervals?.[0] ?? '1d',
        lookbackDays: ctx.profile?.lookbackDays ?? 90,
        fetchFn: doFetch as any,
      });
      const live = r.source === 'yahoo';
      const closes = r.bars.map((b) => b.close).filter((c): c is number => typeof c === 'number');
      const meta: Record<string, any> = { source_id: r.source, last_close: closes[closes.length - 1] ?? null };
      if (closes.length >= 2) {
        const rets: number[] = [];
        for (let i = 1; i < closes.length; i++) {
          if ((closes[i - 1] ?? 0) > 0) rets.push(Math.log((closes[i] ?? 0) / (closes[i - 1] ?? 1)));
        }
        const mean = rets.reduce((s, x) => s + x, 0) / rets.length;
        const varc = rets.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, rets.length - 1);
        meta.realized_vol_annualized = Math.sqrt(varc * 252);
      }
      return [mkRecord(LEGACY_SOURCE_ID.market_meta, live ? 'ok' : 'fallback', meta, live ? 1 : 0, live ? 'live' : 'mock fallback')] as DomainRecords<D>;
    }
  }
}

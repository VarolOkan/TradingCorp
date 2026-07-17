// src/registry/sources/adapters/alphavantage-fundamentals.ts
// P1: pure parse for Alpha Vantage OVERVIEW payload -> canonical fundamentals.
// Extracted from data-ingestion.ts fetchRealFinancialData inline block
// (behavior-identical), including the scoreFromAvOverview health banding.

import type { SourceAdapter, AdapterContext } from './types';

function num(v: any): number | null {
  if (v === undefined || v === null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Map an AV OVERVIEW payload onto a 0-100 health score (same banding as the
 *  FundamentalAnalyzer's scoreFromRatios). Extracted verbatim. */
export function scoreFromAvOverview(j: any): number {
  const de = num(j.DebtEquityRatio) ?? 0.5;
  const cr = num(j.CurrentRatio) ?? 1.2;
  const roe = (num(j.ReturnOnEquityTTM) ?? 0) / 100;
  const pm = (num(j.ProfitMargin) ?? 0) / 100;
  let score = 60;
  score += de < 0.5 ? 8 : -8;
  score += cr > 1.5 ? 6 : cr < 1 ? -6 : 0;
  score += roe > 0.15 ? 10 : roe < 0.05 ? -6 : 0;
  score += pm > 0.2 ? 8 : pm < 0.05 ? -6 : 0;
  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Parse an AV OVERVIEW payload into the Fundamental analyst's live shape.
 * Returns null when the payload lacks the OVERVIEW signature (Symbol +
 * DebtEquityRatio), so the caller falls back to the seeded fundamentals.
 */
export function normalizeAvOverview(raw: unknown): Record<string, any> | null {
  const j = raw as any;
  if (!(j && j.Symbol && j.DebtEquityRatio !== undefined)) return null;
  const fcfYield = (() => {
    const ocf = num(j.OperatingCashflow);
    const mcap = num(j.MarketCapitalization);
    return ocf !== null && mcap && mcap > 0 ? ocf / mcap : null;
  })();
  return {
    fundamental_source: 'alphaVantage:OVERVIEW',
    financial_health_score:
      num(j.ProfitMargin) !== null && num(j.ReturnOnEquityTTM) !== null
        ? scoreFromAvOverview(j)
        : undefined,
    key_ratios: {
      debt_to_equity: num(j.DebtEquityRatio) ?? 0,
      current_ratio: num(j.CurrentRatio) ?? 0,
      roe: (num(j.ReturnOnEquityTTM) ?? 0) / 100,
      roa: (num(j.ReturnOnAssetsTTM) ?? 0) / 100,
      profit_margin: (num(j.ProfitMargin) ?? 0) / 100,
      free_cash_flow_yield: fcfYield !== null ? fcfYield : 0,
    },
  };
}

export const alphaVantageFundamentalsAdapter: SourceAdapter<'fundamentals'> = {
  sourceId: 'alphaVantage',
  domain: 'fundamentals',
  normalize(raw, _ctx: AdapterContext) {
    return normalizeAvOverview(raw);
  },
};

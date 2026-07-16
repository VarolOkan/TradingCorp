// src/registry/logic/options-handlers.ts
// Phase B. fn handlers for the options analysts. The 6 analytical handlers are
// thin `compute` closures over runFnOptionsAnalyst (one trace + one message +
// thesis append each). The ingestion handler is bespoke because it WRITES
// state.optionsData for the downstream analysts (mirrors data-ingestion.ts).

import type { AgentState } from '../../types/financial-analysis';
import type { HistoricalBundle, PriceBarSeries } from '../../types/financial-analysis';
import type { AnalystTuning } from '../../types/registry';
import type { NodeSurface } from './shared';
import { annotateDataReceived, recordDataReceived } from './shared';
import { buildVolSurface } from './vol-surface';
import { OPTIONS_INSTRUCTIONS } from '../../prompts/options-instructions';
import {
  runFnOptionsAnalyst,
  resolveBundle,
  profileFromTuning,
  clamp,
  frontExpiry,
  atmStrike,
  type FnAnalystConfig,
} from './options-shared';
import {
  resolveLiveOptionsBundle,
  generateMockBundle,
  parsePolygonChainResults,
  parsePolygonAggregates,
  parseTreasuryRfr,
  type OptionChainResult,
  type LiveOptionsResult,
} from './hist';
import type { AnalystAcquisition } from '../sources';
import { DEFAULT_RFR, yearsToExpiry, bsGreeks } from './greeks';

/**
 * Extract an annualized risk-free rate (0..1) from a Treasury avg_interest_rates
 * data row. Treasury publishes a PERCENT (e.g. 4.32); normalize to 0..1.
 * Returns undefined when the row has no usable rate (so callers keep DEFAULT_RFR).
 */
function numOrRate(row: any): number | undefined {
  const v = parseTreasuryRfr(row);
  return v === null ? undefined : v;
}

/**
 * Compose a HistoricalBundle from §4.9-engine-acquired raw payloads (already
 * fetched + validated by acquireForAnalyst). Each live piece is overlaid on the
 * deterministic mock base; any missing piece keeps its mock fallback so output
 * shape is always complete (parity: a partial live response never throws). This
 * is the single point where options_ingestion consumes the engine's result.
 */
async function resolveEngineBundle(
  ticker: string,
  profile: any,
  parts: { chainPayload?: any; histPayload?: any; rfr?: number | undefined },
): Promise<LiveOptionsResult> {
  const base = generateMockBundle(ticker, profile);
  const rfr = typeof parts.rfr === 'number' && Number.isFinite(parts.rfr) ? parts.rfr : DEFAULT_RFR;

  // Option chain (Polygon v3 snapshot results array).
  let option_chain = base.option_chain;
  let expiries = base.expiries;
  let underlying_price = base.underlying_price;
  let chainLive = false;
  if (parts.chainPayload) {
    const parsed: OptionChainResult | null = parsePolygonChainResults(parts.chainPayload, ticker);
    if (parsed && parsed.quotes.length > 0) {
      option_chain = parsed.quotes;
      expiries = parsed.expiries;
      underlying_price = parsed.underlying_price;
      chainLive = true;
    }
  }

  // Price bars (Polygon v2 aggregates results array).
  let price_bars: PriceBarSeries[] = base.price_bars;
  let barsLive = false;
  if (parts.histPayload) {
    const bars = parsePolygonAggregates(parts.histPayload, '1d');
    if (bars.length > 0) {
      price_bars = [{ interval: '1d', lookback_days: bars.length, bars }];
      barsLive = true;
    }
  }

  // Greeks are re-derived with the (possibly live) rfr so they stay consistent.
  const greeks = option_chain.map((q: any) => {
    const ttm = yearsToExpiry(`${q.expiry}T00:00:00.000Z`, new Date());
    const g = bsGreeks(q.type, underlying_price, q.strike, ttm, rfr, q.iv);
    return {
      expiry: q.expiry,
      strike: q.strike,
      type: q.type,
      delta: parseFloat(g.delta.toFixed(4)),
      gamma: parseFloat(g.gamma.toFixed(6)),
      vega: parseFloat(g.vega.toFixed(4)),
      theta: parseFloat(g.theta.toFixed(4)),
      rho: parseFloat(g.rho.toFixed(4)),
      iv_in: q.iv,
      underlying_price,
      ttm_years: parseFloat(ttm.toFixed(6)),
      rfr,
    };
  });

  const live = chainLive && barsLive;
  return {
    ticker,
    underlying_price,
    price_bars,
    option_chain,
    greeks,
    rfr,
    expiries,
    iv_history: base.iv_history,
    mock: !live,
    source: live ? 'polygon' : 'mock',
  };
}

// ------------------------------------------------------------------ ingestion

/**
 * options_ingestion — fetch the HistoricalBundle per ticker and stash it on
 * state.optionsData so every downstream options analyst reads ONE shared,
 * deterministic dataset. Mirrors data-ingestion.ts (quality message + trace),
 * but for the derivatives contract.
 */
export async function optionsIngestionHandler(
  state: AgentState,
  node: NodeSurface,
  tuning?: AnalystTuning,
  /** §4.9 acquisition result (sourceStatus + raw merged payloads). When the
   *  engine successfully fetched live Polygon/Treasury sources, we prefer those
   *  already-acquired payloads (no re-fetch, key not re-read). When the engine
   *  degraded (no key), we fall back to resolveLiveOptionsBundle's mock path —
   *  parity: no key = deterministic mock, unchanged behaviour. */
  acquired?: AnalystAcquisition,
): Promise<AgentState> {
  node.emitProgress(state, 'analyst:start', 'options_ingestion', { stage: 1, tickers: state.tickers });
  let updatedState = node.updateStep(state, 'options_ingestion_start');
  updatedState = node.addMessage(updatedState, 'system',
    `Fetching option chains for ${state.tickers.length} ticker(s): ${state.tickers.join(', ')}`);

  try {
    if (!Array.isArray(state.tickers) || state.tickers.length === 0) {
      throw new Error('No tickers specified for options ingestion');
    }

    const optionsData: Record<string, any> = {};
    const inputs: Array<{ ticker: string; label: string; data: Record<string, any>; sources: string[] }> = [];
    let anyLive = false;
    const profile = profileFromTuning(tuning);
    // Engine acquisition is the gate: if it fetched live Polygon/Treasury, the
    // raw payloads sit in `acquired.merged` keyed by source field ('results').
    const merged: Record<string, any> = acquired?.merged ?? {};
    const srcStatus = acquired?.sourceStatus ?? {};
    const engineHasChain = (srcStatus['polygonOptions'] === 'ok' || srcStatus['polygonOptions'] === 'fallback') && merged.options_results;
    const engineHasHist = (srcStatus['polygonHist'] === 'ok' || srcStatus['polygonHist'] === 'fallback') && merged.agg_results;
    const engineRfr = (srcStatus['treasuryRfr'] === 'ok' || srcStatus['treasuryRfr'] === 'fallback') && Array.isArray(merged.data) && merged.data.length > 0
      ? numOrRate(merged.data[0])
      : undefined;

    for (const ticker of state.tickers) {
      // Force a fresh fetch (ignore any pre-existing map) so ingestion is the
      // single writer of the shared bundle. Omit the key entirely (exactOptionalPropertyTypes).
      const { optionsData: _omit, ...freshState } = updatedState;
      // Phase I: pull LIVE price bars + option chain when the §4.9 engine
      // already acquired them (key present), else degrade gracefully to the
      // deterministic mock bundle via resolveLiveOptionsBundle (parity: no key
      // = mock, unchanged behaviour).
      let bundle: LiveOptionsResult;
      if (engineHasChain || engineHasHist || engineRfr !== undefined) {
        const parts: { chainPayload?: any; histPayload?: any; rfr?: number | undefined } = {};
        if (engineHasChain) parts.chainPayload = merged.options_results;
        if (engineHasHist) parts.histPayload = merged.agg_results;
        if (engineRfr !== undefined) parts.rfr = engineRfr;
        bundle = await resolveEngineBundle(ticker, profile, parts);
      } else {
        bundle = await resolveLiveOptionsBundle(ticker, profile);
      }
      optionsData[ticker] = bundle;
      if (bundle.source === 'polygon') anyLive = true;
      const liveSource =
        bundle.source === 'polygon'
          ? ['Polygon Options (live)', 'Yahoo (live)']
          : ['Polygon Options (mock)', 'Yahoo (mock)'];
      inputs.push({
        ticker,
        label: 'Option chain + underlying + greeks',
        data: {
          spot: bundle.underlying_price,
          expiries: bundle.expiries.length,
          chain_rows: bundle.option_chain.length,
          greeks_rows: bundle.greeks.length,
          bar_series: bundle.price_bars.map((s) => s.interval).join(','),
          rfr: bundle.rfr,
          mock: bundle.mock === true,
          source: bundle.source,
        },
        sources: liveSource,
      });

      // Phase R3 (RAW_DATA_DUMP.md): the options ingestion analyst records the
      // raw derivatives slices it collected per ticker, so the export's
      // per-analyst annotation shows the full set of data gathered.
      const provenance: 'live' | 'mock' | 'mixed' =
        bundle.source === 'mock' ? 'mock' : bundle.source === 'polygon' || bundle.source === 'yahoo' ? 'live' : 'mixed';
      const underlying = bundle.price_bars.find((s) => s.interval === '1d') ?? bundle.price_bars[0];
      const blocks: Array<{ domain: 'option_chain' | 'greeks' | 'underlying' | 'iv_history'; interval?: string; source: string; rows?: number; barsUsed?: number }> = [];
      if (bundle.option_chain.length > 0) blocks.push({ domain: 'option_chain', source: bundle.source, rows: bundle.option_chain.length });
      if (bundle.greeks.length > 0) blocks.push({ domain: 'greeks', source: bundle.source, rows: bundle.greeks.length });
      if (underlying && underlying.bars.length > 0) blocks.push({ domain: 'underlying', interval: underlying.interval, source: bundle.source, barsUsed: underlying.bars.length });
      if (bundle.iv_history.length > 0) blocks.push({ domain: 'iv_history', source: bundle.source, rows: bundle.iv_history.length });
      updatedState = recordDataReceived(updatedState, annotateDataReceived(
        'options_ingestion', ticker, 'optionsData', blocks, provenance,
        `collected option chain (${bundle.option_chain.length} rows) + greeks (${bundle.greeks.length}) + underlying bars + IV history`,
      ));
    }

    updatedState = {
      ...updatedState,
      optionsData,
      messages: [
        ...(updatedState.messages || []),
        {
          role: 'system',
          content: `Options ingestion completed for ${state.tickers.length} ticker(s)`,
          timestamp: new Date().toISOString(),
          data: {
            option_chain_data: true,
            underlying_data: true,
            greeks_data: true,
            channels: ['option_chain_data', 'underlying_data', 'greeks_data'],
          },
        },
      ],
    };

    updatedState = node.captureTrace(updatedState, {
      analyst: 'options_ingestion',
      name: 'Options Data Ingestion',
      stage: 1,
      instructions: OPTIONS_INSTRUCTIONS.options_ingestion,
      inputs,
      weighting: [
        { label: 'Chain completeness', inputs: ['chain_rows'], weight: 0.6, rationale: 'Strikes must span ±10 around spot across the requested expiries.', contribution: 60, scale: '0..100 quality weight' },
        { label: 'Greeks consistency', inputs: ['greeks_rows'], weight: 0.4, rationale: 'Every strike carries BS-derived greeks so BS(mid)≈mid.', contribution: 40, scale: '0..100 quality weight' },
      ],
      output: {
        verdict: 'INGESTED',
        summary: `Ingested option chains for ${state.tickers.length} ticker(s): underlying bars, full chain, and per-strike greeks loaded.`,
        details: { tickers: state.tickers, profile: profileFromTuning(tuning) },
      },
      notes:
        anyLive
          ? ['Live Polygon option chain + Yahoo price bars wired into ingestion.']
          : ['Mock chain + BS greeks — set POLYGON_API_KEY to wire live Polygon data.'],
    });

    node.emitProgress(updatedState, 'analyst:done', 'options_ingestion', {
      stage: 1, tickers: state.tickers, summary: `Ingested ${state.tickers.length} option chain(s)`,
    });
    return updatedState;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      ...updatedState,
      error: `Options ingestion error: ${errorMessage}`,
      current_step: 'options_ingestion_error',
      messages: [
        ...(updatedState.messages || []),
        { role: 'error', content: `Failed to ingest option chains: ${errorMessage}`, timestamp: new Date().toISOString() },
      ],
    };
  }
}

// ----------------------------------------------------------- vol_surface (2)

export async function volSurfaceHandler(state: AgentState, node: NodeSurface, tuning?: AnalystTuning): Promise<AgentState> {
  const cfg: FnAnalystConfig = {
    id: 'vol_surface', name: 'Volatility Surface Analyst', stage: 2,
    instructions: OPTIONS_INSTRUCTIONS.vol_surface,
    channels: ['vol_surface_analysis'], thesisLabel: 'VOL SURFACE',
    inputLabel: 'IV skew + term structure', sources: ['Option chain IVs', 'IV history'],
    weighting: [
      { label: 'Exploitable skew', inputs: ['skew_slope'], weight: 0.5, rationale: 'Steeper put skew = more premium/structure edge.', contribution: 50, scale: '0..100' },
      { label: 'Term premium', inputs: ['term_slope'], weight: 0.3, rationale: 'Positive term slope rewards calendars.', contribution: 30, scale: '0..100' },
      { label: 'IV vs realized', inputs: ['iv_percentile'], weight: 0.2, rationale: 'Rich IV favors selling; cheap favors buying.', contribution: 20, scale: '0..100' },
    ],
    compute: (_ticker, bundle) => {
      const useFrontMonth = tuning?.horizon === 'INTRADAY';
      const vs = buildVolSurface(bundle, { useFrontMonth });
      let score = 50;
      score += clamp(Math.abs(vs.skew_slope) * 100, 0, 25); // exploitable skew
      score += clamp(vs.term_slope * 200, -15, 15);         // term premium
      score += clamp((vs.iv_percentile - 50) / 5, -20, 20); // rich vs cheap
      score = Math.round(clamp(score, 0, 100));
      const verdict = vs.iv_percentile >= 66 ? 'RICH' : vs.iv_percentile <= 33 ? 'CHEAP' : 'FAIR';
      return {
        data: { atm_iv: vs.atm_iv, skew_slope: vs.skew_slope, term_slope: vs.term_slope, iv_percentile: vs.iv_percentile, iv_rank: vs.iv_rank, flags: vs.flags },
        score, verdict,
        summary: `IV ${vs.atm_iv} (pct ${vs.iv_percentile}) skew ${vs.skew_slope} term ${vs.term_slope} → ${verdict}`,
      };
    },
  };
  return runFnOptionsAnalyst(state, node, cfg, tuning);
}

// -------------------------------------------------------- options_pricing (2)

export async function optionsPricingHandler(state: AgentState, node: NodeSurface, tuning?: AnalystTuning): Promise<AgentState> {
  const cfg: FnAnalystConfig = {
    id: 'options_pricing', name: 'Options Pricing Analyst', stage: 2,
    instructions: OPTIONS_INSTRUCTIONS.options_pricing,
    channels: ['options_pricing_analysis'], thesisLabel: 'OPTIONS PRICING',
    inputLabel: 'Fair value vs market', sources: ['Option chain (bid/ask/last/IV)', 'BS greeks'],
    weighting: [
      { label: 'Edge size', inputs: ['edge_pct'], weight: 0.6, rationale: 'Larger fair-value gap = more edge.', contribution: 60, scale: '0..100' },
      { label: 'Liquidity', inputs: ['open_interest'], weight: 0.4, rationale: 'Tight spread + OI make the edge tradable.', contribution: 40, scale: '0..100' },
    ],
    compute: (_ticker, bundle) => {
      const exp = frontExpiry(bundle);
      const k = exp ? atmStrike(bundle, exp) : Math.round(bundle.underlying_price);
      // Compare last vs a BS re-price using the chain IV (edge from bid/ask mid vs last).
      const rows = bundle.option_chain.filter((r) => r.expiry === exp && r.strike === k);
      let bestEdge = 0; let liquidity = 0; let picked = 'C';
      for (const r of rows) {
        const mid = (r.bid + r.ask) / 2;
        const edge = mid > 0 ? Math.abs(mid - r.last) / mid : 0;
        if (edge >= bestEdge) { bestEdge = edge; liquidity = r.open_interest; picked = r.type; }
      }
      const edgePct = parseFloat((bestEdge * 100).toFixed(2));
      let score = 50 + clamp(edgePct * 3, 0, 30) + clamp(liquidity / 1000, 0, 20);
      score = Math.round(clamp(score, 0, 100));
      const verdict = edgePct >= 3 ? 'EDGE' : edgePct >= 1 ? 'THIN_EDGE' : 'NO_EDGE';
      return {
        data: { expiry: exp, strike: k, type: picked, edge_pct: edgePct, open_interest: liquidity },
        score, verdict,
        summary: `ATM ${k}${picked} edge ${edgePct}% (OI ${liquidity}) → ${verdict}`,
      };
    },
  };
  return runFnOptionsAnalyst(state, node, cfg, tuning);
}

// --------------------------------------------------------- options_greeks (2)

export async function optionsGreeksHandler(state: AgentState, node: NodeSurface, tuning?: AnalystTuning): Promise<AgentState> {
  const cfg: FnAnalystConfig = {
    id: 'options_greeks', name: 'Options Greeks Analyst', stage: 2,
    instructions: OPTIONS_INSTRUCTIONS.options_greeks,
    channels: ['options_greeks_analysis'], thesisLabel: 'OPTIONS GREEKS',
    inputLabel: 'Net greek budget', sources: ['Per-strike greeks'],
    weighting: [
      { label: 'Intentional theta', inputs: ['net_theta'], weight: 0.4, rationale: 'Positive theta = paid to wait.', contribution: 40, scale: '0..100' },
      { label: 'Bounded gamma', inputs: ['net_gamma'], weight: 0.3, rationale: 'Low |gamma| avoids pin/explode risk.', contribution: 30, scale: '0..100' },
      { label: 'Vega control', inputs: ['net_vega'], weight: 0.3, rationale: 'Small |vega| limits vol blow-up.', contribution: 30, scale: '0..100' },
    ],
    compute: (_ticker, bundle) => {
      const exp = frontExpiry(bundle);
      const k = exp ? atmStrike(bundle, exp) : Math.round(bundle.underlying_price);
      // Model a long ATM call vs short one-strike-OTM call (a vertical): net greeks.
      const rows = bundle.greeks.filter((g) => g.expiry === exp && g.type === 'C');
      const longLeg = rows.find((g) => g.strike === k);
      const shortLeg = rows.filter((g) => g.strike > k).sort((a, b) => a.strike - b.strike)[0];
      const nd = (longLeg?.delta ?? 0) - (shortLeg?.delta ?? 0);
      const ng = (longLeg?.gamma ?? 0) - (shortLeg?.gamma ?? 0);
      const nv = (longLeg?.vega ?? 0) - (shortLeg?.vega ?? 0);
      const nt = (longLeg?.theta ?? 0) - (shortLeg?.theta ?? 0);
      let score = 50 + clamp(nt * 100, -20, 20) + clamp((0.01 - Math.abs(ng)) * 1500, -30, 15) + clamp((1 - Math.abs(nv)) * 30, -30, 30);
      score = Math.round(clamp(score, 0, 100));
      const budgetOk = Math.abs(ng) < 0.02 && Math.abs(nv) < 3;
      return {
        data: { net_delta: +nd.toFixed(4), net_gamma: +ng.toFixed(6), net_vega: +nv.toFixed(4), net_theta: +nt.toFixed(4), greek_budget_ok: budgetOk },
        score, verdict: budgetOk ? 'CONTROLLED' : 'EXPOSED',
        summary: `Δ${nd.toFixed(2)} Γ${ng.toFixed(4)} V${nv.toFixed(2)} Θ${nt.toFixed(2)} → ${budgetOk ? 'CONTROLLED' : 'EXPOSED'}`,
      };
    },
  };
  return runFnOptionsAnalyst(state, node, cfg, tuning);
}

// ----------------------------------------------------------- options_risk (3)

export async function optionsRiskHandler(state: AgentState, node: NodeSurface, tuning?: AnalystTuning): Promise<AgentState> {
  const cfg: FnAnalystConfig = {
    id: 'options_risk', name: 'Options Risk Analyst', stage: 3,
    instructions: OPTIONS_INSTRUCTIONS.options_risk,
    channels: ['options_risk_assessment'], thesisLabel: 'OPTIONS RISK',
    inputLabel: 'Structure risk + sizing', sources: ['Net greeks', 'IV percentile', 'Chain liquidity'],
    weighting: [
      { label: 'Max-loss defined', inputs: ['max_loss'], weight: 0.5, rationale: 'Undefined risk is auto-EXTREME.', contribution: 50, scale: 'categorical' },
      { label: 'IV-crush exposure', inputs: ['iv_percentile'], weight: 0.3, rationale: 'High IV percentile short vol → crush risk.', contribution: 30, scale: 'categorical' },
      { label: 'Greek blow-up', inputs: ['net_vega'], weight: 0.2, rationale: 'Vega/gamma beyond band caps size.', contribution: 20, scale: 'categorical' },
    ],
    compute: (_ticker, bundle, t) => {
      const useFrontMonth = t?.horizon === 'INTRADAY';
      const vs = buildVolSurface(bundle, { useFrontMonth });
      // Model a defined-risk vertical: max loss = strike spacing − credit (approx spacing).
      const exp = frontExpiry(bundle);
      const strikes = Array.from(new Set(bundle.greeks.filter((g) => g.expiry === exp).map((g) => g.strike))).sort((a, b) => a - b);
      const spacing = strikes.length >= 2 ? (strikes[1]! - strikes[0]!) : 5;
      const maxLoss = spacing * 100; // one contract, defined risk
      const ivCap = t?.horizon === 'INTRADAY' ? 95 : 90;
      const ivCrush = vs.iv_percentile > ivCap;
      // Sizing: smaller for intraday / high IV.
      let maxAlloc = t?.horizon === 'INTRADAY' ? 8 : 15;
      if (vs.iv_percentile > 70) maxAlloc = Math.round(maxAlloc * 0.7);
      const riskLevel = ivCrush ? 'EXTREME' : vs.iv_percentile > 70 ? 'HIGH' : vs.iv_percentile > 40 ? 'MEDIUM' : 'LOW';
      const score = riskLevel === 'EXTREME' ? 10 : riskLevel === 'HIGH' ? 40 : riskLevel === 'MEDIUM' ? 65 : 85;
      return {
        data: {
          max_loss: maxLoss, iv_percentile: vs.iv_percentile, iv_crush_risk: ivCrush,
          max_allocation: maxAlloc, hard_exit: `${(spacing * 1.5).toFixed(0)} pt debit stop`, risk_level: riskLevel,
        },
        score, verdict: riskLevel,
        summary: `Defined max loss $${maxLoss}, IV pct ${vs.iv_percentile} (cap ${ivCap}) → ${riskLevel}, alloc ${maxAlloc}%`,
      };
    },
  };
  return runFnOptionsAnalyst(state, node, cfg, tuning);
}

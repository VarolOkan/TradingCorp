// src/registry/agencies.ts
// Defines the three shipped agencies: long-term (default), medium-term, intraday.
// Each agency = name + the ordered list of analyst refs it uses.
// Overrides: agencies can override ANY field per analyst for THIS agency only;
// omitted fields fall back to the defaults in ANALYST_DEFS (analysts.ts).

import type { AgencyDef } from '../types/registry';

export const AGENCIES: Record<string, AgencyDef> = {
  'long-term': {
    id: 'long-term',
    name: 'Long-Term Investment',
    description: 'Full 7-node pipeline for long-term equity analysis. Matches the current production pipeline exactly — each analyst uses its default fn handler with long-term horizons.',
    horizon: 'LONG_TERM',
    assetClass: 'EQUITY',
    screenerInterval: '1d',
    screenerLookbackDays: 90,
    default: true,
    // No overrides — pure defaults from ANALYST_DEFS
    analysts: [
      { id: 'orchestrator' },
      { id: 'data_ingestion' },
      { id: 'fundamental' },
      { id: 'technical' },
      { id: 'sentiment' },
      { id: 'risk' },
      { id: 'governance' },
    ],
  },

  'medium-term': {
    id: 'medium-term',
    name: 'Medium-Term (1–3 mo)',
    description: 'Same 7 analysts but each carries timeHorizon=MEDIUM_TERM via params, demonstrating config reuse without new ids or code.',
    horizon: 'MEDIUM_TERM',
    assetClass: 'EQUITY',
    screenerInterval: '4h',
    screenerLookbackDays: 45,
    analysts: [
      { id: 'orchestrator' },
      { id: 'data_ingestion' },
      { id: 'fundamental', params: { timeHorizon: 'MEDIUM_TERM' } },
      { id: 'technical',   params: { timeHorizon: 'MEDIUM_TERM' } },
      { id: 'sentiment',   params: { timeHorizon: 'MEDIUM_TERM' } },
      { id: 'risk',        params: { timeHorizon: 'MEDIUM_TERM' } },
      { id: 'governance' },
    ],
  },

  intraday: {
    id: 'intraday',
    name: 'Intraday',
    description: 'Same 7 analysts tuned for 5m–1h horizons. Technical gets faster lookback, sentiment is high-frequency, and every analyst carries horizon=INTRADAY.',
    horizon: 'INTRADAY',
    assetClass: 'EQUITY',
    screenerInterval: '5m',
    screenerLookbackDays: 5,
    analysts: [
      { id: 'orchestrator' },
      { id: 'data_ingestion' },
      { id: 'fundamental', params: { horizon: 'INTRADAY' } },
      { id: 'technical',   params: { horizon: 'INTRADAY', lookbackBars: 5, rsiThreshold: 55 } },
      { id: 'sentiment',   params: { horizon: 'INTRADAY', sourceMix: 'social-heavy' } },
      { id: 'risk',        params: { horizon: 'INTRADAY' } },
      { id: 'governance' },
    ],
  },

  'crypto-screener': {
    id: 'crypto-screener',
    name: 'Crypto Screener',
    description: '4-node agency proving the framework supports a different NODE COUNT and completely DIFFERENT nodes: a brand-new declarative onchain analyst + reused ingestion/sentiment/governance. Short-horizon crypto triage. (Crypto universe source is TBD — the screener falls back to the equity universe today.)',
    horizon: 'SHORT_TERM',
    assetClass: 'CRYPTO',
    screenerInterval: '1d',
    screenerLookbackDays: 90,
    // Hidden from the selectable list until real crypto universe + on-chain
    // sources land. Flip on with ENABLE_CRYPTO_AGENCY=true — all hooks
    // (onchain analyst, CRYPTO asset class, resolver, tests) stay intact.
    hidden: true,
    analysts: [
      // Reuses the lifted ingestion fn handler (same as data_ingestion).
      { id: 'data_ingestion' },
      // Brand-new declarative analyst — no TS handler, pure JSON logic.
      { id: 'onchain' },
      // Reused analyst, overridden param (social-heavy mix for crypto).
      { id: 'sentiment', params: { sourceMix: 'social-heavy' } },
      // Reused gatekeeper, stricter policy for crypto (no mock fallback).
      { id: 'governance', onAllSourcesFailed: { action: 'fail' } },
    ],
  },

  // ============================ Phase C: Options agencies ============================
  // Instrument OPTION. Membership + params per spec §4.1/§4.2. Both reuse the
  // options analyst defs added in Phase B (no new handler code). Equity path
  // is untouched — these are opt-in agencies selected from the dropdown.

  'options-swing': {
    id: 'options-swing',
    name: 'Options Swing (days–weeks)',
    description: 'Calendar/diagonal/simple vertical structures on a multi-day to multi-week horizon. Emphasizes IV rank/skew edge + thematic direction; slower greeks (theta is a slow bleed, vega matters). Instrument: OPTION.',
    horizon: 'MEDIUM_TERM',
    instrument: 'OPTION',
    assetClass: 'OPTION',
    screenerInterval: '1d',
    screenerLookbackDays: 90,
    // Pipeline (8 nodes) per spec §4.1
    analysts: [
      { id: 'orchestrator' },
      { id: 'options_ingestion', params: { lookbackDays: 90, intervals: ['1d'], expiries: 'monthly+weekly' } },
      { id: 'vol_surface', params: { horizon: 'MEDIUM_TERM' } },
      { id: 'options_pricing', params: { targetStructures: ['vertical', 'calendar'] } },
      { id: 'options_greeks', params: { focus: 'vega/theta' } },
      { id: 'options_flow', params: { horizon: 'MEDIUM_TERM' } },
      { id: 'options_risk', params: { maxThetaBurnPct: 1.5, ivCrushGuard: true } },
      { id: 'governance', params: { vetoExtreme: true, instrument: 'OPTION', optionsVeto: { maxIvPercentile: 90, requireHedge: true } } },
    ],
  },

  'options-intraday': {
    id: 'options-intraday',
    name: 'Options Intraday (minutes–hours)',
    description: '0DTE / same-day structures, gamma scalping, fast underlying technical timing. Emphasizes tight liquidity, fast theta, intraday vol expansion; strict risk (no overnight gap, strict stop). Instrument: OPTION.',
    horizon: 'INTRADAY',
    instrument: 'OPTION',
    assetClass: 'OPTION',
    screenerInterval: '5m',
    screenerLookbackDays: 5,
    // Pipeline (9 nodes — adds options_technical timing) per spec §4.2
    analysts: [
      { id: 'orchestrator' },
      { id: 'options_ingestion', params: { lookbackDays: 5, intervals: ['5m', '1m'], expiries: 'weekly+0dte' } },
      { id: 'options_technical', params: { horizon: 'INTRADAY', lookbackBars: 5 } },
      { id: 'vol_surface', params: { horizon: 'INTRADAY', useFrontMonth: true } },
      { id: 'options_pricing', params: { targetStructures: ['0dte', 'vertical'], minLiquidity: true } },
      { id: 'options_greeks', params: { focus: 'gamma/delta', rollUp: 'net' } },
      { id: 'options_flow', params: { horizon: 'INTRADAY' } },
      { id: 'options_risk', params: { maxThetaBurnPct: 0.5, strictLiquidity: true, noOvernight: true } },
      { id: 'governance', params: { vetoExtreme: true, instrument: 'OPTION', optionsVeto: { maxIvPercentile: 80, maxStopLoss: 0.03, requireHedge: false } } },
    ],
  },
};

export const AGENCY_IDS = Object.keys(AGENCIES);

/** Find the default agency (exactly one must have default:true). */
export function defaultAgency(): AgencyDef {
  const found = Object.values(AGENCIES).find((a) => a.default);
  if (!found) {
    // Fallback — first entry is long-term
    return AGENCIES['long-term']!;
  }
  return found;
}
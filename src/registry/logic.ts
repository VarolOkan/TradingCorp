// src/registry/logic.ts
// Maps each AnalystDef.fn key to a concrete logic handler (a function that
// takes AgentState + NodeSurface and returns the updated state). Handlers are
// the SINGLE source of truth for analyst behaviour — the old `*.node.ts`
// shim subclasses are gone; every handler is registered here as a plain
// function bound to the shared `makeNodeSurface()`.
//
// GenericAnalystNode resolves `def.logic.fn` via `getLogicHandler` — so the
// data-driven AgencyGraph runs exactly the same code as a direct call. No
// graph-builder change is needed to add an analyst: add a def + register its
// handler here.

import { AgentState } from '../types/financial-analysis';
import type { AnalystTuning } from '../types/registry';
import { makeNodeSurface, type NodeSurface } from './logic/shared';
import { orchestratorHandler } from './logic/orchestrator';
import { dataIngestionHandler } from './logic/data-ingestion';
import { fundamentalHandler } from './logic/fundamental';
import { technicalHandler } from './logic/technical';
import { sentimentHandler } from './logic/sentiment';
import { riskHandler } from './logic/risk';
import { governanceHandler } from './logic/governance';
import {
  optionsIngestionHandler,
  volSurfaceHandler,
  optionsPricingHandler,
  optionsGreeksHandler,
  optionsRiskHandler,
} from './logic/options-handlers';

import type { AnalystAcquisition } from './sources';

/** Signature of every analyst logic handler. The third arg is the NodeSurface
 *  the node injects (so it can capture/relay progress); the second is optional
 *  tuning (agency horizon + per-analyst params). When tuning is omitted the
 *  handler reproduces the legacy long-term behaviour byte-for-byte. The optional
 *  4th arg carries the §4.9 acquisition result (sourceStatus + merged payloads)
 *  so ingestion analysts can consume live data the engine already fetched. */
export type AnalystFn = (
  state: AgentState,
  tuning?: AnalystTuning,
  surface?: NodeSurface,
  acquired?: AnalystAcquisition,
) => Promise<AgentState>;

// One shared surface — every handler records progress/messages/traces through
// it, so behaviour is identical regardless of which graph invokes the handler.
const sharedSurface = makeNodeSurface();

/** Registry of fn-key -> handler. The fn key lives on each AnalystDef.logic.fn
 *  (see src/registry/analysts.ts). To register a brand-new analyst you add an
 *  entry here; the graph builder wires it automatically. The handler is called
 *  with the live tuning (if any) and the node-supplied surface so medium/intraday
 *  agencies diverge and the node can capture the analyst:done event. */
export const ANALYST_LOGIC_REGISTRY: Record<string, AnalystFn> = {
  orchestrate: (s, t, surf) => orchestratorHandler(s, surf ?? sharedSurface, t),
  ingest: (s, t, surf) => dataIngestionHandler(s, surf ?? sharedSurface, t),
  fundamentalAnalysis: (s, t, surf) => fundamentalHandler(s, surf ?? sharedSurface, t),
  technicalAnalysis: (s, t, surf) => technicalHandler(s, surf ?? sharedSurface, t),
  sentimentAnalysis: (s, t, surf) => sentimentHandler(s, surf ?? sharedSurface, t),
  riskAssessment: (s, t, surf) => riskHandler(s, surf ?? sharedSurface, t),
  governanceDecision: (s, t, surf) => governanceHandler(s, surf ?? sharedSurface, t),
  // ---- Phase B: options analysts (fn) ----
  optionsIngest: (s, t, surf, acquired) => optionsIngestionHandler(s, surf ?? sharedSurface, t, acquired),
  volSurfaceAnalysis: (s, t, surf) => volSurfaceHandler(s, surf ?? sharedSurface, t),
  optionsPricingAnalysis: (s, t, surf) => optionsPricingHandler(s, surf ?? sharedSurface, t),
  optionsGreeksAnalysis: (s, t, surf) => optionsGreeksHandler(s, surf ?? sharedSurface, t),
  optionsRiskAssessment: (s, t, surf) => optionsRiskHandler(s, surf ?? sharedSurface, t),
  // NB: options_flow + options_technical are DECLARATIVE (no fn) per spec §125 table.
};

/** Resolve a fn key to its handler, throwing on unknown keys. */
export function getLogicHandler(fnKey: string): AnalystFn {
  const handler = ANALYST_LOGIC_REGISTRY[fnKey];
  if (!handler) {
    throw new Error(`No logic handler registered for fn key: "${fnKey}"`);
  }
  return handler;
}

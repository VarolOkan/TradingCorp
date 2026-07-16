// src/types/registry.ts
// TypeScript types for the declarative analyst and agency registry.
// These are the "schema" documented in docs/EXTENDING_ANALYSTS.md (analyst/agency defs).
// They complement (but do not replace) the runtime types in financial-analysis.ts.

// ---- Analyst kind ----
export type AnalystKind = 'orchestrator' | 'ingestion' | 'analyst' | 'gatekeeper';

// ---- Horizon (used by AgencyDef) ----
export type AnalysisHorizon = 'INTRADAY' | 'SHORT_TERM' | 'MEDIUM_TERM' | 'LONG_TERM';

// ---- Per-run tuning passed to a handler ----
// Carries the owning agency's horizon + instrument plus the analyst's own
// `params` so a handler can bias its (otherwise ticker-seeded) mock output per
// agency and branch on instrument class (EQUITY vs OPTION) instead of guessing
// from the agency id string.
// `undefined` / `null` means "no tuning" → handlers MUST fall back to the
// legacy long-term behaviour so direct handler calls stay parity-safe.
export interface AnalystTuning {
  horizon: AnalysisHorizon;
  params: Record<string, any>;
  /** Instrument class of the owning agency (threaded from AgencyDef). */
  instrument?: 'EQUITY' | 'OPTION';
}

// ---- Data source specification (one source per entry) ----
// Each analyst may reach out to MULTIPLE external sources individually.
export interface DataSourceSpec {
  /** Stable source id (e.g. 'yahoo', 'alpha'). Used as the sourceStatus key. */
  id?: string;
  from?: string;                  // source id or upstream analyst id
  fields: string[];               // data fields consumed from this source
  label: string;                  // user-facing label for the trace
  sources: string[];              // human-readable source names (e.g. ["Yahoo", "Alpha Vantage"])

  // ---- §4.9 multi-source acquisition fields ----
  type?: 'rest' | 'graphql' | 'ws' | 'ingestion' | 'analyst';
  endpoint?: string;              // URL template (if rest/graphql)
  auth?: 'none' | 'bearer' | 'apikey';   // auth attachment policy
  timeoutMs?: number;             // per-source timeout (default 5000)
  retries?: number;               // local retry count (default 2)
  required?: boolean;             // if true and fails → escalate to analyst-level failure
  onError?: 'skip' | 'degrade' | 'fallback' | 'fail';  // what to do on failure (default 'skip')
  fallbackSourceId?: string;      // if onError='fallback' — try this source instead
  /** Optional JSON path (dot + [n] notation) into the response that MUST exist
   *  for the payload to count as valid. Used when a source wraps its fields in
   *  a nested envelope (e.g. Yahoo `{ chart: { result: [...] } }`) so the
   *  top-level field check in validatePayload doesn't false-negative. */
  okPath?: string;
}

// ---- Declarative feature extraction ----
export interface FeatureSpec {
  key: string;                    // feature name (referenced in weighting inputs)
  label?: string;                 // display label
  source?: string;                // "dataSources.X" or "features.Y"
  formula?: string;               // arithmetic expression
  aggregation?: 'avg' | 'sum' | 'min' | 'max' | 'last';
  scale?: {                       // optional rescale from input range to output range
    in: [number, number];
    out: [number, number];
  };
}

// ---- Weighting step (trace "Weighting → Output" tab and scoring) ----
export interface WeightingStepSpec {
  label: string;                  // e.g. "Profitability (ROE/margin)"
  inputs: string[];               // feature keys consumed
  weight: number;                 // decimal [0..1]; sum across all steps should be 1.0
  rationale: string;              // why this weight was chosen
  scale?: string;                 // descriptive (e.g. "0..100 score weight")
  contribution?: number;          // computed at runtime
}

// ---- Declarative logic vs function-key ----
export interface LogicSpec {
  mode: 'declarative' | 'fn';

  // Declarative path (mode='declarative')
  weighting?: WeightingStepSpec[];
  score?: {
    from: 'weightedSum';
    range: [number, number];      // [min, max] for clamping/display
    round?: boolean;
  };
  verdict?: {
    from: 'score' | 'field';
    mapping: Array<{ if: '>=' | '<' | '==' ; value: number; then: string }>;
    default?: string;              // fallback when no mapping matches
  };
  summaryTemplate?: string;       // e.g. "{role} {score}/100 → {verdict}"

  // Fn path (mode='fn')
  fn?: string;                    // key into AnalystLogicRegistry
  params?: Record<string, any>;   // intraday/medium-tuning
  /** Phase F LLM step config. When present + enabled, the handler calls the
   *  LLM with the selected flavor's instructions. Long-term ships enabled:false
   *  (parity guard — no accidental LLM use). */
  llm?: {
    enabled: boolean;
    model?: string;
    temperature?: number;
    summarizeField?: string;      // data field summarized + sent as the user msg
  };
}

// ---- Output contract ----
export interface OutputSpec {
  channels?: string[];            // state keys to write to (e.g. ['technical_analysis'])
  storeInMessages?: boolean;      // if true, store in messages[].data
  verdictField?: string;          // field name for verdict in output
  scoreField?: string;            // field name for score in output
}

// ---- Mock / simulation spec (rng-based seed for deterministic demos) ----
export interface MockSpec {
  generator: 'seeded' | 'fn';
  seedFrom: 'ticker';             // deterministic per ticker
  ranges?: Record<string, [number, number]>;  // field -> [min, max] for uniform random
  flags?: Array<{ if: string; then: string }>;
}

// ---- Multi-flavor Role & Instructions (Phase F, docs §10) ----
/**
 * A flavor is one named Role & Instructions bundle for an analyst. The selected
 * flavor's `instructions` override `AnalystDef.prompt` at graph-build time
 * (inside `getGraph`/`mergeFlavors`), flowing into both the trace and the LLM
 * call. At least one flavor per analyst MUST ship (the store refuses to delete
 * the last remaining one).
 */
export interface AnalystFlavor {
  id: string;            // stable flavor id, e.g. 'default' | 'conservative' | uuid
  name: string;          // display label, e.g. 'Balanced', 'Momentum-leaning'
  role: string;          // one-line role line (replaces def.role in the trace header)
  instructions: string;  // the full system prompt the LLM runs under
  isDefault?: boolean;   // exactly one flavor per analyst is the default
  modelRole?: 'deep-thought' | 'scanner' | 'flexible'; // §12.4 — which LLM role this flavor uses (defaults deep-thought)
  /**
   * Per-flavor LLM opt-in (docs §10.7). When true AND a provider token is
   * configured for the resolved role, the analyst's LLM step fires for runs
   * using this flavor. When false/absent, the step is skipped (handler verdict
   * stands) — preserving the long-term parity guard until the user explicitly
   * enables a flavor. `mergeFlavors` flips the resolved def's
   * `logic.llm.enabled` to this value on the per-run clone only.
   */
  enabled?: boolean;
}

// ---- FULL analyst definition (the canonical default) ----
export interface AnalystDef {
  /** Unique id (snake_case). Must match the key in ANALYST_DEFS. */
  id: string;
  /** Node kind — determines generic-node control flow branch. */
  kind: AnalystKind;
  /** Display name. */
  name: string;
  /** Short role line (under the name in the wall). */
  role: string;
  /** Pipeline stage (1=intake, 2=analysis, 3=decision). */
  stage: 1 | 2 | 3;
  /** Accent color (hex) for the panel. */
  accent: string;
  /** Two-letter monogram. */
  monogram?: string;
  /** Instruction prompt (shown in trace "Instructions" tab). */
  prompt?: string;
  /** Analyst ids whose outputs this analyst consumes (for trace wiring). */
  dependsOn?: string[];
  /** External data sources this analyst reaches out to (§4.9). */
  dataSources?: DataSourceSpec[];
  /** Declarative feature extraction specs. */
  features?: FeatureSpec[];
  /** Logic definition (declarative score+verdict or fn key). */
  logic: LogicSpec;
  /** Output contract. */
  output?: OutputSpec;
  /** Mock sub-tasks for wall simulation. */
  tasks?: string[];
  /** Mock/simulation spec. */
  mock?: MockSpec;
  /** Analyst-level policy when ALL sources fail (§4.9). */
  onAllSourcesFailed?: { action: 'fail' | 'degrade' | 'useMock' };
  /**
   * Per-run tuning propagated from the owning agency (agency horizon + the
   * per-analyst `params` from the AgencyAnalystRef). `undefined` means "no
   * agency context" — handlers must treat this as the legacy default so that
   * direct handler calls and the long-term agency reproduce the old output
   * byte-for-byte. This is what makes the medium-term / intraday agencies
   * produce observably different analysis from long-term.
   */
  params?: Record<string, any>;
  /** Shipped default flavor set (Phase F). At least one required; one isDefault. */
  flavors?: AnalystFlavor[];
  /** The flavor id selected for the current run (set by getGraph/mergeFlavors). */
  flavorId?: string;
  /** §12.4 — resolved LLM model role (set by getGraph/mergeFlavors). Drives runAnalystLLM provider selection. */
  modelRole?: 'deep-thought' | 'scanner' | 'flexible';
}

// ---- Per-analyst reference inside an agency ----
// Each entry specifies the analyst id (must exist in ANALYST_DEFS)
// plus optional field overrides for THIS agency only.
export interface AgencyAnalystRef {
  id: string;
  name?: string;
  role?: string;
  accent?: string;
  stage?: 1 | 2 | 3;
  monogram?: string;
  prompt?: string | { key: string };
  dependsOn?: string[];
  dataSources?: DataSourceSpec[];
  onAllSourcesFailed?: { action: 'fail' | 'degrade' | 'useMock' };
  features?: FeatureSpec[];
  logic?: LogicSpec;
  output?: OutputSpec;
  tasks?: string[];
  mock?: MockSpec;
  params?: Record<string, any>;    // passed to the fn handler for tuning
  /** Selected flavor id (Phase F). Injected by getGraph/mergeFlavors; tags the run. */
  flavorId?: string;
  /** §12.4 — resolved LLM model role for this ref (flavor.modelRole → agency override). Injected by mergeFlavors. */
  modelRole?: 'deep-thought' | 'scanner' | 'flexible';
}

// ---- Agency definition ----
export interface AgencyDef {
  id: string;
  name: string;
  description: string;
  horizon: AnalysisHorizon;
  /** Instrument class this agency trades. Optional → existing equity agencies
   *  default to 'EQUITY' (backward compatible). Options agencies set 'OPTION'.
   *  @deprecated use `assetClass` (adds CRYPTO). Kept for backward compat. */
  instrument?: 'EQUITY' | 'OPTION';
  /** Asset class this agency screens. Drives the screener's instrument intent
   *  and (for CRYPTO) signals a future crypto universe source. Optional →
   *  derived: OPTION if `instrument==='OPTION'`, else 'EQUITY'. */
  assetClass?: 'EQUITY' | 'OPTION' | 'CRYPTO';
  /** Explicit screener bar interval. Optional → derived from `horizon`
   *  (INTRADAY ⇒ 5m, else 1d) by resolveScreenerProfile. */
  screenerInterval?: '1m' | '5m' | '1h' | '4h' | '1d';
  /** Explicit screener lookback in days. Optional → derived from `horizon`
   *  (INTRADAY ⇒ 5, else 90). */
  screenerLookbackDays?: number;
  /** Minimum average DAILY bar volume (shares) a screener result must clear.
   *  Optional → 0 means "no minimum" (the default, so existing agencies are
   *  unaffected). Set in the Agency settings dialog; applied as a floor on the
   *  row's avgVolume. The universe pre-filter also uses it (via
   *  averageDailyVolume3Month) so a high floor trims cheaply before bars. */
  minVolumeDaily?: number;
  /** EXACTLY ONE agency in AGENCIES should have default: true. */
  default?: boolean;
  /** When true, the agency is NOT exposed as a selectable option unless the
   *  env flag ENABLE_CRYPTO_AGENCY=true is set. Used to keep not-yet-ready
   *  agencies (e.g. crypto-screener, whose universe/on-chain sources are TBD)
   *  defined in the registry (so all hooks/tests stay intact) without showing
   *  them in the UI. Toggle via env, not a code change. */
  hidden?: boolean;
  /** Ordered list of analyst refs (defines graph node order). */
  analysts: AgencyAnalystRef[];
}

// ---- Validation result ----
/** Returns a list of error messages (empty = valid). */
export type ValidationResult = string[];

// ---- Helper: resolve a fully-merged AnalystDef from an AgencyAnalystRef ----
export function resolveAnalystDef(
  ref: AgencyAnalystRef,
  defaults: Record<string, AnalystDef>,
): AnalystDef {
  const base = defaults[ref.id];
  if (!base) throw new Error(`Unknown analyst id: ${ref.id}`);

  // Start from base (all required fields present), then apply non-undefined overrides.
  // We do Object.assign + field-by-field instead of spreading because tsconfig has
  // exactOptionalPropertyTypes: true, which rejects spread-introduced `undefined`
  // on optional properties.
  const result = Object.assign({}, base) as AnalystDef;

  // Scalar overrides (match AnalystDef field by field)
  if (ref.name !== undefined) result.name = ref.name;
  if (ref.role !== undefined) result.role = ref.role;
  if (ref.accent !== undefined) result.accent = ref.accent;
  if (ref.stage !== undefined) result.stage = ref.stage;
  if (ref.monogram !== undefined) result.monogram = ref.monogram;
  if (ref.prompt !== undefined) {
    result.prompt = typeof ref.prompt === 'string' ? ref.prompt : ref.prompt.key;
  }
  if (ref.dependsOn !== undefined) result.dependsOn = ref.dependsOn;
  if (ref.onAllSourcesFailed !== undefined) result.onAllSourcesFailed = ref.onAllSourcesFailed;

  // Array/object overrides (preserve base default if ref doesn't override)
  if (ref.dataSources !== undefined) result.dataSources = ref.dataSources;
  if (ref.features !== undefined) result.features = ref.features;
  if (ref.output !== undefined) result.output = ref.output;
  if (ref.tasks !== undefined) result.tasks = ref.tasks;
  if (ref.mock !== undefined) result.mock = ref.mock;

  // Per-analyst tuning (agency horizon is added at graph-build time, not here).
  if (ref.params !== undefined) result.params = ref.params;
  // Selected flavor tag (Phase F). Sets def.flavorId so the trace + LLM know
  // which Role & Instructions ran.
  if (ref.flavorId !== undefined) result.flavorId = ref.flavorId;
  // §12.4 resolved LLM model role (flavor.modelRole → agency override), used by
  // runAnalystLLM to pick the provider/model/token.
  if (ref.modelRole !== undefined) result.modelRole = ref.modelRole;

  // logic is non-optional — always resolved from ref or base
  if (ref.logic !== undefined) result.logic = ref.logic;

  return result;
  // Note: ref.params is copied onto AnalystDef.params; the owning agency's
  // horizon is layered on top by the graph builder (AgencyGraph) at runtime.
}
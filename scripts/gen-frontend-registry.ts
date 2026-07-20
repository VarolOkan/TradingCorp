// scripts/gen-frontend-registry.ts
// Build-time registry hydration (closes §4 hardcoded-mirror).
//
// The backend `src/registry/{analysts,agencies}.ts` is the single source of
// truth for the analyst + agency catalogs. The frontend previously duplicated
// that data by hand in `frontend/src/components/analysts/*.ts`, which drifted
// and required a manual edit every time an analyst/agency was added.
//
// This script projects the backend truth into frontend-shaped TS modules
// (`*.generated.ts`) so the frontend is hydrated from the backend
// automatically. Wire it into `prebuild` (and `dev` via `predev`) so the
// generated files are always current; the existing `agency-mirror.test.ts`
// still guards against drift (it now compares the generated files to the
// backend, catching any generator-logic regression).
//
// Run: `npx tsx scripts/gen-frontend-registry.ts`

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ANALYST_DEFS } from '../src/registry/analysts';
import { AGENCIES } from '../src/registry/agencies';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '../frontend/src/components/analysts');

// ---------------------------------------------------------------------------
// Projection: backend AnalystDef -> frontend AnalystMeta
// ---------------------------------------------------------------------------

interface FrontendAnalystMeta {
  id: string;
  name: string;
  role: string;
  accent: string;
  monogram: string;
  stage: 1 | 2 | 3 | 4;
  tasks: string[];
}

function projectAnalyst(def: (typeof ANALYST_DEFS)[string]): FrontendAnalystMeta {
  return {
    id: def.id,
    name: def.name,
    role: def.role,
    accent: def.accent,
    monogram: def.monogram ?? def.id.slice(0, 2).toUpperCase(),
    stage: def.stage,
    tasks: def.tasks ?? [],
  };
}

const analysts = Object.values(ANALYST_DEFS).map(projectAnalyst);
const analystIds = analysts.map((a) => a.id);

// ---------------------------------------------------------------------------
// Projection: backend AgencyDef -> frontend AgencyMeta
// ---------------------------------------------------------------------------

interface FrontendAgencyMeta {
  id: string;
  name: string;
  description: string;
  analysts: string[];
  isDefault?: boolean;
  horizon?: string;
  instrument?: 'EQUITY' | 'OPTION';
  assetClass?: 'EQUITY' | 'OPTION' | 'CRYPTO';
  screenerInterval?: '1m' | '5m' | '1h' | '4h' | '1d';
  screenerLookbackDays?: number;
  minVolumeDaily?: number;
  hidden?: boolean;
}

function projectAgency(def: (typeof AGENCIES)[string]): FrontendAgencyMeta {
  return {
    id: def.id,
    name: def.name,
    description: def.description,
    // Frontend stores the ordered analyst id list (backend stores refs).
    analysts: def.analysts.map((ref) => ref.id),
    isDefault: def.default,
    horizon: def.horizon,
    instrument: def.instrument,
    assetClass: def.assetClass ?? def.instrument,
    screenerInterval: def.screenerInterval,
    screenerLookbackDays: def.screenerLookbackDays,
    // Backend defaults minVolumeDaily to 0 (no floor); the frontend's legacy
    // default is 100_000, so preserve that for parity with prior UI behavior.
    minVolumeDaily: def.minVolumeDaily && def.minVolumeDaily > 0 ? def.minVolumeDaily : 100_000,
    hidden: def.hidden,
  };
}

const agencies = Object.values(AGENCIES).map(projectAgency);
const agencyIds = agencies.map((a) => a.id);
const defaultAgency = agencies.find((a) => a.isDefault)?.id ?? agencyIds[0]!;

// ---------------------------------------------------------------------------
// TS emit helpers
// ---------------------------------------------------------------------------

function indent(n: number): string {
  return '  '.repeat(n);
}

function emitAnalystMetaArray(items: FrontendAnalystMeta[]): string {
  const lines: string[] = ['['];
  for (const a of items) {
    lines.push(indent(1) + '{');
    lines.push(indent(2) + `id: ${JSON.stringify(a.id)},`);
    lines.push(indent(2) + `name: ${JSON.stringify(a.name)},`);
    lines.push(indent(2) + `role: ${JSON.stringify(a.role)},`);
    lines.push(indent(2) + `accent: ${JSON.stringify(a.accent)},`);
    lines.push(indent(2) + `monogram: ${JSON.stringify(a.monogram)},`);
    lines.push(indent(2) + `stage: ${a.stage},`);
    lines.push(indent(2) + `tasks: ${JSON.stringify(a.tasks)},`);
    lines.push(indent(1) + '},');
  }
  lines.push('];');
  return lines.join('\n');
}

function emitAgencyRecord(items: FrontendAgencyMeta[]): string {
  const lines: string[] = ['{'];
  for (const a of items) {
    lines.push(indent(1) + [`${JSON.stringify(a.id)}: {`].join(''));
    lines.push(indent(2) + `id: ${JSON.stringify(a.id)},`);
    lines.push(indent(2) + `name: ${JSON.stringify(a.name)},`);
    lines.push(indent(2) + `description: ${JSON.stringify(a.description)},`);
    lines.push(indent(2) + `analysts: ${JSON.stringify(a.analysts)},`);
    if (a.isDefault !== undefined) lines.push(indent(2) + `isDefault: ${a.isDefault},`);
    if (a.horizon !== undefined) lines.push(indent(2) + `horizon: ${JSON.stringify(a.horizon)},`);
    if (a.instrument !== undefined) lines.push(indent(2) + `instrument: ${JSON.stringify(a.instrument)},`);
    if (a.assetClass !== undefined) lines.push(indent(2) + `assetClass: ${JSON.stringify(a.assetClass)},`);
    if (a.screenerInterval !== undefined) lines.push(indent(2) + `screenerInterval: ${JSON.stringify(a.screenerInterval)},`);
    if (a.screenerLookbackDays !== undefined) lines.push(indent(2) + `screenerLookbackDays: ${a.screenerLookbackDays},`);
    if (a.minVolumeDaily !== undefined) lines.push(indent(2) + `minVolumeDaily: ${a.minVolumeDaily},`);
    if (a.hidden !== undefined) lines.push(indent(2) + `hidden: ${a.hidden},`);
    lines.push(indent(1) + '},');
  }
  lines.push('};');
  return lines.join('\n');
}

function emitAnalystsGenerated(): string {
  const union = analystIds.map((id) => JSON.stringify(id)).join(' | ');
  return `// AUTO-GENERATED by scripts/gen-frontend-registry.ts — DO NOT EDIT BY HAND.
// Source of truth: src/registry/analysts.ts (ANALYST_DEFS).
// Regenerate with: npm run gen:registry

export type AnalystId =
  | ${union};

export interface AnalystMeta {
  id: AnalystId;
  name: string;
  /** Short role line shown under the name. */
  role: string;
  /** Accent color (used for border/glow). */
  accent: string;
  /** Two-letter monogram in the panel header. */
  monogram: string;
  /** Stage number (1 = intake, 2 = analysis, 3 = debate/research, 4 = decision). */
  stage: 1 | 2 | 3 | 4;
  /** Mock sub-tasks cycled through per ticker during a simulated run. */
  tasks: string[];
}

// Union catalog across ALL agencies (includes onchain + options analysts).
// The per-agency composition is owned by agencies.generated.ts, NOT here.
export const ANALYSTS: AnalystMeta[] = ${emitAnalystMetaArray(analysts)};

export const ANALYST_IDS: AnalystId[] = ${JSON.stringify(analystIds)};

export function analystById(id: AnalystId): AnalystMeta {
  const found = ANALYSTS.find((a) => a.id === id);
  if (!found) throw new Error(\`Unknown analyst: \${id}\`);
  return found;
}
`;
}

function emitAgenciesGenerated(): string {
  return `// AUTO-GENERATED by scripts/gen-frontend-registry.ts — DO NOT EDIT BY HAND.
// Source of truth: src/registry/agencies.ts (AGENCIES).
// Regenerate with: npm run gen:registry

export type AgencyId = string;

export interface AgencyMeta {
  id: string;
  name: string;
  description: string;
  /** Ordered analyst ids that make up this agency (defines the wall order). */
  analysts: string[];
  /** true for the one default agency (cannot be deleted). */
  isDefault?: boolean;
  /** horizon label for display. */
  horizon?: string;
  instrument?: 'EQUITY' | 'OPTION';
  /** Asset class this agency screens (EQUITY / OPTION / CRYPTO). */
  assetClass?: 'EQUITY' | 'OPTION' | 'CRYPTO';
  /** Explicit screener bar interval (optional — derived from horizon if unset). */
  screenerInterval?: '1m' | '5m' | '1h' | '4h' | '1d';
  /** Explicit screener lookback in days (optional — derived from horizon if unset). */
  screenerLookbackDays?: number;
  /** Minimum average DAILY bar volume (shares) the agency screens for. */
  minVolumeDaily?: number;
  /** True when gated off by default (env ENABLE_CRYPTO_AGENCY to reveal). */
  hidden?: boolean;
}

// Static defaults — overwritten by applyRegistryAgencies() at runtime (hydrated
// from GET /registry). Generated from the backend AGENCIES registry.
export const AGENCIES: Record<string, AgencyMeta> = ${emitAgencyRecord(agencies)};

export const AGENCY_IDS: string[] = ${JSON.stringify(agencyIds)};

export const DEFAULT_AGENCY: AgencyId = ${JSON.stringify(defaultAgency)};

export function agencyById(id: string): AgencyMeta {
  const found = AGENCIES[id];
  if (!found) throw new Error(\`Unknown agency: \${id}\`);
  return found;
}
`;
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(resolve(OUT_DIR, 'analysts.generated.ts'), emitAnalystsGenerated(), 'utf8');
writeFileSync(resolve(OUT_DIR, 'agencies.generated.ts'), emitAgenciesGenerated(), 'utf8');

console.log(
  `[gen-frontend-registry] wrote ${analysts.length} analysts + ${agencies.length} agencies ` +
    `to ${OUT_DIR.replace(resolve(__dirname, '..'), '.')}`,
);

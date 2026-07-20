// frontend/src/components/analysts/analysts.ts
// Static metadata for the analyst panels shown in the AnalystWall.
//
// This catalog is now GENERATED from the backend source of truth
// (src/registry/analysts.ts → ANALYST_DEFS) by scripts/gen-frontend-registry.ts.
// It is no longer hand-maintained: adding an analyst to ANALYST_DEFS and running
// `npm run gen:registry` (wired into prebuild) updates this automatically — no
// manual frontend edit required. The drift guard lives in
// frontend/src/test/agency-mirror.test.ts.
//
// NOTE: this list is the UNION of analysts across ALL agencies (it includes
// `onchain`, which only the crypto-screener agency uses). The per-agency
// composition — i.e. which analysts appear as wall cards — is owned by
// agencies.ts (generated), NOT here. The three equity agencies (long-term /
// medium-term / intraday) are 7-card equity pipelines; crypto-screener is a
// 4-card set that includes onchain. So a docstring that says "7 entries" refers
// to a single equity agency's wall, not this catalog.

export type { AnalystId, AnalystMeta } from './analysts.generated';
export { ANALYSTS, ANALYST_IDS, analystById } from './analysts.generated';

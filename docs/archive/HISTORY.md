# Shipped Feature Plans — History

This file consolidates the implementation plans for work that has **shipped and
been verified**. The original per-feature design docs were folded in here so the
`docs/` folder stays lean; the canonical "how the system is built" reference is
`PHASED_DEVELOPMENT.md` and `ARCHITECTURE.md`.

Each entry below records what was delivered and why it can be trusted (test
evidence at the time it shipped). Open work is tracked in `KNOWN_ISSUES.md`.

---

## 1. Agency Differentiation (was `AGENCY_DIFFERENTIATION.md`)

**Status: IMPLEMENTED & VERIFIED.** Made the three equity agencies
(`long-term` / `medium-term` / `intraday`) produce observably different output
and gave `governance` a real horizon-dependent policy split.

- Every fn handler gained an optional `tuning?: AnalystTuning` arg (parity-safe:
  absent ⇒ identical to the pre-change path).
- `resolveAnalystDef()` now forwards `ref.params` + `horizon` to handlers
  (`src/types/registry.ts`, `AgencyGraph` → `GenericAnalystNode`).
- Per-handler differentiation: `technical` / `sentiment` / `risk` / `governance`
  / `fundamental` read `params`/`horizon` (lookback, sensitivity, thresholds,
  stop-loss, veto-extreme).
- Shipped across phases A–F, test-gated between phases.
- Evidence at ship time: backend Jest 158 passed, frontend Vitest 92 passed,
  `vite build` clean; long-term output byte-identical to pre-change with no
  tuning.

---

## 2. Data-Feed Sufficiency & Thesis Presentation (was `DATA_AND_THESIS_ENHANCEMENT.md`)

**Status: SHIPPED (Phases A–H).** Two root causes fixed + thesis redesign.

- **R1** Equity ingestion was horizon-blind (hardcoded `1y/1d`) and didn't write
  a shared channel. Fixed: `data-ingestion.ts` became horizon-aware
  (`profileFromTuning`) and writes `state.ingested` (fundamental / technical /
  sentiment / market).
- **R2** No equity analyst consumed ingested data (each reseeded its own RNG).
  Fixed: downstream analysts consume `state.ingested` when present.
- **Thesis** rebuilt as a one-glance verdict summary derived from real
  `analystTraces` + final decision (`thesisSummary` field; additive, parity-safe).
  `ResultsPanel.tsx` restyled dark/scannable.
- Build log + deviations captured in the original doc's §8 before consolidation.

---

## 3. Raw Data Dump & Per-Analyst Traceability (was `RAW_DATA_DUMP.md`)

**Status: SHIPPED (R1–R4 + R5 UI drawer).** Companion to #2 above.

- On report export, persists a machine-readable JSON dump of all raw data
  collected by the data-ingestion analysts, annotated per-analyst
  (`dataReceived`) so the UI can re-show the exact slice each analyst received.
- Additive and parity-safe — produced only at export from data already on
  `AgentState`; no analyst output changed, parity tests unaffected.
- R5 delivered a report viewer drawer showing per-analyst `dataReceived`.
- Replay / re-load of `AgentState` from the dump was explicitly deferred.

---

## 4. Agency Re-org + Agency CRUD (was `AGENCY_REORG_AND_PERSISTENCE.md`)

**Status: SHIPPED (superseded the original "DESIGN" status).** Originally written
as a design awaiting a storage decision; the feature was later built and is
documented in `AGENCY-REARCHITECTURE.md`.

- Re-arrange existing analysts within an agency (add / remove / reorder) + "feeds
  into" wiring, plus agency Add / Delete in General settings.
- Persistence: permanent, per-user (json/sqlite registry store, merged over
  compiled `AGENCIES` at boot — same pattern as custom analysts).

---

## 5. Removed process docs

- `AUTONOMOUS_BUILD_PROMPT.md` — a one-time "paste into a fresh chat" handoff
  prompt used to run `OPTIONS_AND_AGENCY_EXPANSION.md` unattended. Pure process
  cruft once the work landed; removed.

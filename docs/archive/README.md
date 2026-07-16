# docs/archive — Superseded design documents

These documents were the **design contracts and implementation plans** for work
that has since shipped and been verified by the test suite. They are kept for
**traceability** (why a decision was made, the original constraints) but are no
longer the authoritative reference. For current behavior, use the active docs at
`docs/`: `ARCHITECTURE.md`, `EXTENDING_ANALYSTS.md`, `SETUP.md`,
`KNOWN_ISSUES.md`, and `docs/openapi.json`.

| File | What it was | Now |
|------|-------------|-----|
| `PHASED_DEVELOPMENT.md` | The original phased, test-gated build plan + TradingAgents lineage + stage rules. | Superseded by the **Phased plan** table in the root `README.md` (Phases 1–20, all ✅ Done). |
| `AGENCY-REARCHITECTURE.md` | The contract for moving from 7 hardcoded node classes to the registry-driven `AnalystDef`/`AgencyDef` model. | Implemented and verified; the as-built picture is in `ARCHITECTURE.md`. |
| `CARD_SETTINGS_PANEL.md` | Plan for the per-analyst card Settings panel (weights/flavors/credentials). | Shipped; current behavior documented in `KNOWN_ISSUES.md` §9. |
| `OPTIONS_AND_AGENCY_EXPANSION.md` | Design for the options trading agencies + historical data layer. | Implemented; the as-built options data layer is in `ARCHITECTURE.md` › *Options agencies & data layer*. |
| `HISTORY.md` | Consolidated shipped-feature plans (agency differentiation, data-feed/thesis, raw-data dump, agency re-org/CRUD). | Folded into the root `README.md` phased table and `KNOWN_ISSUES.md`. |

> Internal cross-links inside these files still point at the old `docs/` names
> (e.g. `./PHASED_DEVELOPMENT.md`). They are historical and not maintained; use
> the active docs above for current paths.

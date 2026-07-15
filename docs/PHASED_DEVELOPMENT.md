# Phased Development Plan

This document is the single source of truth for how the Financial Analysis
Pipeline is being rebuilt. It supersedes the ad-hoc notes from the original
"fix the broken run" phase and captures:

1. The **original `TradingAgents`** layout this project was adapted from.
2. The **rules that apply at each stage** (information gathering → analysis →
   trading decision), as described in the initial design.
3. How those map onto our 7-node LangGraph pipeline.
4. The **phased, test-gated delivery** the rewrite is executed in.

---

## 1. Origin: the `TradingAgents` reference layout

The backend graph is adapted from the open-source **TradingAgents**
(Python/LangGraph) reference design. That design is a three-layer,
debate-driven multi-agent system:

```
                        ┌──────────────────────────────────────────┐
   user query  ───────▶ │  LAYER 1 — INFORMATION GATHERING TEAM      │
                        │   • Bull Researcher  (optimistic case)    │
                        │   • Bear Researcher   (pessimistic case)  │
                        │   • Research Analyst (neutral, synthesizes)│
                        │   • News / Social Researchers              │
                        └───────────────────┬──────────────────────┘
                                            │
                        ┌───────────────────▼──────────────────────┐
                        │  LAYER 2 — ANALYSIS TEAMS                 │
                        │   • Fundamental Analyst                   │
                        │   • Technical Analyst                    │
                        │   • Sentiment Analyst                    │
                        │   • Risk Analyst                          │
                        └───────────────────┬──────────────────────┘
                                            │
                        ┌───────────────────▼──────────────────────┐
                        │  LAYER 3 — TRADING DECISION              │
                        │   • Risky Debate (aggressive advocate)   │
                        │   • Safe Debate  (conservative advocate) │
                        │   • Trading Manager (final call)          │
                        └──────────────────────────────────────────┘
```

Key ideas borrowed from that reference:
- **Adversarial perspective-taking** — a Bull and a Bear researcher force both
  sides of the thesis to be argued before analysis.
- **Specialist analysis teams** — each analytical dimension (fundamental,
  technical, sentiment, risk) is its own agent.
- **A risk-aware final arbiter** — the last stage weighs aggressive vs.
  conservative positions and makes the call.
- **Preservation-first override** — our domain adaptation makes capital
  preservation the binding constraint on the final decision.

---

## 2. Stage rules (as described in the initial design)

These are the rules that govern behavior at each stage. They are the contract
the rewrite must preserve and eventually enforce with real LLM agents.

### Stage 1 — Information Gathering
- **Bull/Bear balance**: every ticker must have *both* an optimistic and a
  pessimistic research pass before synthesis. No one-sided theses.
- **Neutral synthesis**: the Research Analyst merges Bull + Bear into a single
  neutral brief; it must not cherry-pick.
- **Source coverage**: news + social signal are gathered as distinct streams and
  kept separate until sentiment analysis.
- **Freshness**: data is stamped with `current_date`; stale (pre-date) inputs are
  flagged, not silently used.

### Stage 2 — Analysis Teams
Each analyst produces a structured object and a per-ticker recommendation with a
direction and a confidence:

| Analyst | Rule |
|---------|------|
| **Fundamental** | Must report moat/durability and explicit red flags; conclusion is `BULLISH`/`NEUTRAL`/`BEARISH` with a confidence %. |
| **Technical** | Must emit trend + at least one indicator signal (RSI/MACD) and support/resistance; conclusion is a directional `signal`. |
| **Sentiment** | Must separate news, social, and analyst/institutional sentiment; aggregates to a net sentiment. |
| **Risk** | Must produce a `risk_level` (LOW/MEDIUM/HIGH), position-sizing recommendation, stop-loss and take-profit, and max allocation %. |

- **Independence**: analysts do not read each other's outputs in this build
  (they run sequentially on the same ingested data, not in parallel, to avoid
  LangGraph concurrent-write errors — see KNOWN_ISSUES #4b).
- **No silent passes**: an analyst that cannot compute a field must return an
  explicit "insufficient data" marker rather than `null`.

### Stage 3 — Trading Decision (preservation-first)
- **Risky vs. Safe debate**: an aggressive advocate and a conservative advocate
  argue the synthesized analysis; the conservative case carries the
  **preservation-first tie-breaker** — when return potential and capital safety
  conflict, safety wins.
- **Gatekeeper veto**: the `GovernanceGatekeeperNode` is the mandatory final
  arbiter. It can **override and REJECT** any ticker that fails
  preservation-first criteria, regardless of analyst consensus.
- **Approval conditions** (attached whenever a decision is `APPROVE`):
  - position size ≤ **5%** of portfolio
  - stop-loss at **15–20%** below entry
  - continued monitoring for fundamental deterioration
- **Confidence & reasoning**: every decision ships a numeric `confidence` and a
  human-readable `reasoning` + `preservation_rationale` (this fixed the historic
  "REJECTED (undefined% confidence)" bug).

---

## 3. Mapping to our 7-node LangGraph pipeline

```
user query
   │
   ▼
[1] Orchestrator            ── parses tickers + options (depth/horizon/risk)
   │
   ▼
[2] Data Ingestion         ── gathers fundamental/technical/sentiment/market
   │                          (Stage 1 data collection; Bull/Bear split is a
   │                           future enhancement)
   ▼
[3] Fundamental Analyst     ── Stage 2
   ▼
[4] Technical Analyst       ── Stage 2
   ▼
[5] Sentiment Analyst       ── Stage 2
   ▼
[6] Risk Analyst            ── Stage 2
   ▼
[7] Governance Gatekeeper   ── Stage 3 (Risky/Safe debate + veto + decision)
   │
   ▼
  END  (normalized analysis_complete emitted to the client)
```

| TradingAgents layer | Our node(s) |
|---------------------|-------------|
| Information Gathering (Bull/Bear/Research/News) | Data Ingestion (+ future Bull/Bear researchers) |
| Analysis Teams (Fundamental/Technical/Sentiment/Risk) | nodes 3–6 |
| Trading Decision (Risky/Safe/Manager) | Governance Gatekeeper (preservation-first arbiter) |

The `GovernanceGatekeeperNode` currently uses a deterministic seeded RNG for the
demo decision (see KNOWN_ISSUES #2); the *rule structure* (veto, conditions,
confidence/reasoning, preservation rationale) is already encoded and is what the
rewrite must preserve when real LLM agents replace the mock logic.

---

## 4. Phased, test-gated delivery

Each phase is built and **unit-tested** before the user verifies it, then we
wait for an explicit "proceed" before the next phase. App code is developed under
`frontend/` (React + Vite + TypeScript); backend under `src/`.

| Phase | Scope | Status | Tests |
|-------|-------|--------|-------|
| **0** | *Prior*: fix broken run (MODULE_NOT_FOUND, Tailwind, Socket 404, LangGraph crash, concurrent-update, ENOTFOUND). | ✅ Done | jest 42/42 |
| **1** | Vite + React + TS scaffold; Tailwind; `tsconfig.frontend.json`; smoke tests. Clean `package.json` (drop `next`, vanilla `public/`, `src/pages`). Server serves `frontend/dist`. | ✅ Done | build ✅, vitest 2/2 |
| **2** | `SettingsDialog` component + backend `POST /config` (Option B: in-memory, per-session, read at analysis time). `ConnectionSettings` model (baseUri, accessToken, extra). Token never logged/echoed. | ✅ Done | jest + vitest, both with coverage |
| **3** | Core analysis UI: `AnalysisForm` (ticker + session input), `ResultsPanel` (decision/confidence/reasoning/preservation/conditions/risk), `AnalysisView` composition, `useAnalysis` hook streaming over Socket.IO `analysis_start` / `analysis_complete` / `analysis_error`. Wire into `App`. | ✅ Done | vitest 37/37, 94% stmts |
| **4** | Clean visualization class structure + **D3** `RelationsGraph` (nodes/edges radial layout, group colors, data-join updates). `Visualization` base class + `registry` factory + `relationsFromResult`. `RelationsGraphView` React wrapper wired into `AnalysisView`. | ✅ Done | vitest 55/55 (types.ts 0%), overall 94.94% stmts |
| **5** | Final wiring/verify + docs sync. (SPA serving done in Phase 1; all phases complete, tested, and docs synced in Phase 5.) | ✅ Done | full `npm test` |
| **6** | **Analyst Wall + drill-down traceability.** Real-time per-analyst panels driven by `analyst_start`/`analyst_done` (new `useAnalystRun` hook). Backend `analystTraces` channel + `captureTrace()` (via `makeNodeSurface()` in `src/registry/logic/shared.ts`) in every analyst handler; shipped on `analysis_complete`. Frontend slide-in `AnalystTraceDrawer` (4 tabs + breadcrumb traceability). | ✅ Done | jest 70/70; vitest ~99 across 14 files (incl. drawer + wall tests) |
| **7** | **Auto-connect with retry.** `App.tsx` connects on load, up to 3 attempts with a live countdown in the Connect button (`Connecting… (3→2→1)`), then `-FAILED-`. Socket.IO reconnection disabled so the countdown is deterministic. | ✅ Done | App tests (mocked socket, fake timers) |
| **8** | **Agency registry (data-driven graph).** `src/registry/{analysts,agencies}.ts` + `AnalystDef`/`AgencyDef` types; `AgencyGraph` builder; `GenericAnalystNode` dispatches via `getLogicHandler` (parity by construction). Backend `registry.test.ts` asserts count + integrity. The single runtime is the data-driven `AgencyGraph`; `buildLegacyGraph()` returns the `long-term` agency (the retired hardcoded graph's 1:1 successor). The per-analyst `*.node.ts` shims + `BaseNode` were later deleted in the Phase 12 cleanup. | ✅ Done | jest + parity test (long-term agency well-formed + deterministic) |
| **9** | **Declarative (no-LLM) analyst + new agency.** `onchain` analyst defined pure-JSON (`logic.mode:'declarative'`, weighted-sum score → verdict); `src/registry/logic/declarative.ts` engine. New `crypto-screener` agency (4 nodes: ingestion + onchain + sentiment + governance) proving a different NODE COUNT and different nodes. | ✅ Done | `crypto-screener.test.ts` (1 trace, non-zero score, rendered summary) |
| **10** | **B1 per-source credentials.** `POST /analyst-config` stores server-side `session:analystId:sourceId` (never echoed); `resolveToken` falls back to global `runtimeConfig.token`. Frontend `AnalystSourceDialog` + ⚙ gear (hidden unless an analyst declares `rest`/`graphql` source with `auth!=='none'`). | ✅ Done | `analyst-config.test.ts` (token never in response body) |
| **11** | **Phase-4.5 agency-first UX.** Agency dropdown moved ABOVE the ticker input (first decision). Analyst wall ungated — renders the selected agency's cards immediately on load (no ticker required). `long-term`/`medium-term`/`intraday` agencies expanded to the full 8-node set (added `onchain`); `crypto-screener` stays 4-node so switching visibly changes the wall. `AnalysisView` test locks the contract. | ✅ Done | vitest 92/92 (incl. new AnalysisView tests) |

### Phase exit criteria (every phase)
- `npm test` (server jest + UI vitest, both with coverage) green.
- `npx tsc --noEmit` (backend) clean.
- `npm run build` produces `frontend/dist`.
- New behavior has unit tests covering the happy path + at least one edge case.

### Definition of done for the rewrite
- Single front-end (`frontend/`), no Next.js / vanilla remnants.
- Settings supplied via in-app dialog → `POST /config`; token never logged or
  bundled.
- Each TradingAgents stage rule (§2) is represented in code or explicitly
  tracked as a future enhancement in KNOWN_ISSUES.
- Coverage reported for both backend (`coverage/`) and frontend (`coverage-ui/`).

---

## 5. What remains (post-Phase 11)

The phased plan (Phases 0–11) is **complete and test-gated**. The repo is a
fully functional **mock-driven demo**: every analyst node, the governance
decision, and the `onchain` declarative analyst run on deterministic seeded
data — there are **no live market API integrations yet**. Remaining work is
capability, not phase-completion:

1. **Live data + real LLM agents (the natural "Phase 12").** KNOWN_ISSUES #2
   (governance uses a seeded RNG) and the §2 Stage-1 Bull/Bear split are
   both tracked as future enhancements. Nothing in the plan turns these live —
   that is the biggest open workstream.
2. **Stage-1 Bull/Bear researchers.** PHASED_DEVELOPMENT §2 calls them a
   "future enhancement"; the mapping table notes the Bull/Bear split is not yet
   implemented. Currently Data Ingestion is a single node.
3. **B1 credentials are half-wired.** The ⚙ gear + `POST /analyst-config`
   exist, but no analyst currently declares a `rest`/`graphql` source with
   `auth !== 'none'`, so the gear stays hidden and stored tokens are never
   consumed by a real upstream call.
4. **Frontend ↔ backend agency mirror drift (action item).** The frontend
   agency mirrors (`frontend/src/components/analysts/{agencies,analysts}.ts`)
   are edited by hand and must stay in lockstep with the backend
   `src/registry/{agencies,analysts}.ts`. As of Phase 11 the frontend
   `long-term`/`medium-term`/`intraday` mirrors carry **8** analysts
   (added `onchain`), while the backend `long-term` agency is still asserted
   to be **exactly 7** (production-parity contract in `registry.test.ts`).
   This intentional fork should be reconciled: either add `onchain` to the
   backend `long-term` agency (and bump the "exactly 7" assertion) or
   document the frontend as the "preview" layout. See
   `docs/ADDING_AN_ANALYST.md` for the sync rule.
5. **Equity agencies are composition-clones.** `long-term`/`medium-term`/
   `intraday` share the same 8-node set; only horizon/`params` differ
   (which the frontend mirror does not even encode), so the dropdown only
   visibly changes the wall when `crypto-screener` (4 nodes) is selected.

See `docs/ADDING_AN_ANALYST.md` for the recipe to add an analyst (with a
worked "Intraday Momentum" example).

# Financial Analysis Pipeline

A multi-agent financial analysis system built on **LangGraph** (TypeScript), a
**React + Vite** single-page front-end, and **Socket.IO** real-time streaming.
It orchestrates specialized analyst agents (fundamental, technical, sentiment,
risk) and a governance gatekeeper that enforces a **preservation-first**
investment philosophy. The backend graph is adapted from the open-source
**TradingAgents** reference design (see [PHASED_DEVELOPMENT.md](./PHASED_DEVELOPMENT.md)).

> Status: functional scaffold. Data ingestion, analysis, and decisions currently
> use **deterministic mock/seeded data** — there are no live market API
> integrations yet. See [KNOWN_ISSUES.md](./KNOWN_ISSUES.md). The **Analyst Wall**
> (real-time per-analyst streaming) and the **drill-down trace drawer** (click any
> analyst panel → Instructions / Data / Weighting→Output / Sources, with
> breadcrumb traceability) are implemented; the trace values come from the mock
> outputs. The UI **auto-connects** on load (up to 3 retries, countdown in the
> Connect button).

## Key facts

- **Front-end (SPA):** `frontend/` — React 18 + TypeScript, built with Vite 5, styled with Tailwind.
- **Real-time analysis server:** `npm run server` → Socket.IO + Express on `:3001`.
- **Orchestration engine:** `src/orchestration/financial-graph.ts` (`buildLegacyGraph()` → `AgencyGraph` built from the registry) — Orchestrator → Data Ingestion → Fundamental → Technical → Sentiment → Risk → Governance.
- **Agents:** defined as `AnalystDef` in `src/registry/analysts.ts`; logic lives in `src/registry/logic/*.ts` handlers run by `src/nodes/generic-analyst.node.ts`. No per-analyst node classes.
- **Drill-down traces:** `captureTrace` (`makeNodeSurface()` in `src/registry/logic/shared.ts`) + `src/prompts/analyst-instructions.ts`; shipped as `analystTraces` on `analysis_complete`. Front-end drawer: `frontend/src/components/analysts/AnalystTraceDrawer.tsx`.
- **Types/contracts:** `src/types/financial-analysis.ts` (incl. `AnalystTrace`, `AnalystId`) and `frontend/src/types.ts`.
- **Tests:** `npm test` runs backend (Jest) + front-end (Vitest, Testing Library), **both with coverage**.

## What "preservation-first" means

The `GovernanceGatekeeperNode` is a mandatory veto agent. It can override every
analyst and reject a ticker when capital-preservation criteria aren't met.
Approvals carry explicit conditions: position size ≤ 5% of portfolio, stop-loss
at 15–20% below entry, and monitoring for fundamental deterioration. See the
stage rules in [PHASED_DEVELOPMENT.md](./PHASED_DEVELOPMENT.md#2-stage-rules-as-described-in-the-initial-design).

## Quick start

```bash
cd financial-analysis-pipeline
npm install
cp .env.example .env      # optional; sensible defaults exist
npm test                  # verify backend + frontend suites pass (with coverage)
npm run dev:all            # one command: backend (:3001) + Vite dev server (:5173)
# …or two terminals:
npm run server            # terminal A: Socket.IO analysis server on :3001
npm run dev               # terminal B: Vite dev server on :5173 (proxies to :3001)
```

Open http://localhost:5173.

## Documentation map

- [PHASED_DEVELOPMENT.md](./PHASED_DEVELOPMENT.md) — TradingAgents lineage, stage rules, phased test-gated plan (canonical build reference)
- [ARCHITECTURE.md](./ARCHITECTURE.md) — graph topology, node responsibilities, data flow, real-time server
- [HISTORY.md](./HISTORY.md) — shipped feature plans consolidated (agency differentiation, data-feed/thesis, raw-data dump, agency re-org/CRUD)
- [AGENCY-REARCHITECTURE.md](./AGENCY-REARCHITECTURE.md) — registry-driven agent/agency contract (analyst/agency defs, merge rules)
- [CARD_SETTINGS_PANEL.md](./CARD_SETTINGS_PANEL.md) — per-card Settings panel (weights/flavors/credentials)
- [OPTIONS_AND_AGENCY_EXPANSION.md](./OPTIONS_AND_AGENCY_EXPANSION.md) — options trading agencies + historical data layer (design + code)
- [ADDING_AN_ANALYST.md](./ADDING_AN_ANALYST.md) — recipe to add a new analyst (declarative + fn paths), worked Intraday Momentum example
- [SETUP.md](./SETUP.md) — install, config, environment variables, running, scripts
- [KNOWN_ISSUES.md](./KNOWN_ISSUES.md) — current limitations and open bugs
- **API docs (OpenAPI/Swagger):** the live REST API is documented in
  [openapi.json](./openapi.json). View it in the UI via **Settings → Connection →
  "View API docs ↗"** (opens `/api-docs/` against the configured Backend URI), or
  serve `docs/openapi.json` in any Swagger UI.

## Repository layout

```
financial-analysis-pipeline/
├── docs/                 # documentation (this folder)
├── frontend/             # React + Vite SPA (new front-end)
│   ├── index.html
│   ├── src/
│   │   ├── main.tsx
│   │   ├── App.tsx
│   │   ├── index.css     # Tailwind entry
│   │   ├── types.ts      # shared types (AnalysisResult, ConnectionSettings, …)
│   │   ├── components/   # SettingsDialog, AnalysisForm, ResultsPanel, RelationsGraphView, AnalysisView, analysts/ (AnalystWall + AnalystTraceDrawer)
│   │   ├── api/          # /config client (Phase 2)
│   │   ├── hooks/        # useAnalysis (Phase 3) + useAnalystRun (per-analyst streaming)
│   │   ├── visualizations/ # Visualization base, RelationsGraph, registry (Phase 4)
│   │   └── test/         # Vitest setup + specs
│   └── dist/             # production build output (generated)
├── src/                  # Backend (TypeScript, run via tsx)
│   ├── nodes/            # agent implementations (one file per agent)
│   ├── orchestration/    # LangGraph StateGraph wiring
│   ├── server/           # Socket.IO + Express real-time server (serves frontend/dist)
│   ├── tests/            # Jest unit tests (one per node)
│   ├── types/            # shared TypeScript interfaces
│   ├── utils/            # logger, retry-handler
│   └── config.ts         # env-driven configuration
├── vite.config.ts        # Vite + Vitest config (root: frontend/, proxies to :3001)
├── tsconfig.frontend.json
├── tailwind.config.js
├── postcss.config.js
├── jest.config.js
├── package.json
└── .env.example
```

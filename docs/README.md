# TradingCorp

A multi-agent financial analysis system built on **LangGraph** (TypeScript), a
**React + Vite** single-page front-end, and **Socket.IO** real-time streaming.
It orchestrates specialized analyst agents (fundamental, technical, sentiment,
risk) and a governance gatekeeper that enforces a **preservation-first**
investment philosophy. The backend graph is adapted from the open-source
**TradingAgents** reference design; see [ARCHITECTURE.md](./ARCHITECTURE.md).

> Status: functional. The **Stock Screener** and the **Market Data Card** (quote
> / history / options / news) run on **live data**: Yahoo (tokenless price/
> history/quote), the Nasdaq listed directory (screener universe), Alpha Vantage
> `OVERVIEW` (fundamentals, keyed), Finnhub `company-news` (sentiment, keyed),
> and a live option chain from **Massive/Polygon** (`api.massive.com`, when
> entitled) → **CBOE free delayed feed** (no key) as the real fallback. The
> ingestion path feeds these live inputs to the analysts; only the per-analyst
> **scoring/weighting** logic and the vol-surface remain deterministic models
> (see [KNOWN_ISSUES.md](./KNOWN_ISSUES.md) §2). Provenance is surfaced honestly
> (LIVE/DELAYED/MOCK badges + per-domain source notes). **AI agents: read
> [`../AGENT.md`](../AGENT.md) first** (deploy rule, data sources, honesty bar).
> The **Analyst Wall**
> (real-time per-analyst streaming) and the **drill-down trace drawer** (click
> any analyst panel → Instructions / Data / Weighting→Output / Sources, with
> breadcrumb traceability) are implemented. The UI **auto-connects** on load (up
> to 3 retries, countdown in the Connect button).

## Key facts

- **Front-end (SPA):** `frontend/` — React 18 + TypeScript, built with Vite 5, styled with Tailwind.
- **Real-time analysis server:** `npm run server` → Socket.IO + Express (default `:3001`, configurable via `PORT`/`HOST`).
- **Orchestration engine:** registry-driven `AgencyGraph` built from `src/registry/agencies.ts` + `analysts.ts`; one generic `GenericAnalystNode` runs each `AnalystDef`. No per-analyst node classes.
- **Agents:** defined as `AnalystDef` in `src/registry/analysts.ts`; logic lives in `src/registry/logic/*.ts`.
- **Drill-down traces:** `captureTrace` (`makeNodeSurface()` in `src/registry/logic/shared.ts`) + `src/prompts/analyst-instructions.ts`; shipped as `analystTraces` on `analysis_complete`. Front-end drawer: `frontend/src/components/analysts/AnalystTraceDrawer.tsx`.
- **Stock Screener:** `GET /screener` + `src/registry/logic/screener.ts` — LLM-free, live-universe screen. **Exact selection standards & per-agency rubric:** [SCREENER_STANDARDS.md](./SCREENER_STANDARDS.md).
- **Types/contracts:** `src/types/financial-analysis.ts` (incl. `AnalystTrace`, `AnalystId`) and `frontend/src/types.ts`.
- **Tests:** `npm test` runs backend (Jest) + front-end (Vitest, Testing Library), **both with coverage**.

## What "preservation-first" means

The `GovernanceGatekeeperNode` is a mandatory veto agent. It can override every
analyst and reject a ticker when capital-preservation criteria aren't met.
Approvals carry explicit conditions: position size ≤ 5% of portfolio, stop-loss
at 15–20% below entry, and monitoring for fundamental deterioration. See
[ARCHITECTURE.md](./ARCHITECTURE.md) for the as-built picture.

## Quick start

```bash
cd TradingCorp
npm install
cp .env.example .env      # optional; sensible defaults exist
npm test                  # verify backend + frontend suites pass (with coverage)
npm run dev:all            # one command: backend + Vite dev server (:5173)
# …or two terminals:
npm run server            # terminal A: Socket.IO analysis server
npm run dev               # terminal B: Vite dev server on :5173 (proxies to backend)
```

Open the Vite URL (default http://localhost:5173). For a LAN host, start with
`HOST=0.0.0.0 PORT=8091 npm run dev:all` and open that host:port.

## Documentation map

- [ARCHITECTURE.md](./ARCHITECTURE.md) — graph topology, node responsibilities, data flow, real-time server
- [EXTENDING_ANALYSTS.md](./EXTENDING_ANALYSTS.md) — add an analyst or agency (declarative + fn + options paths; merged concept+recipe)
- [SCREENER_STANDARDS.md](./SCREENER_STANDARDS.md) — Stock Screener selection standards & traceability
- [SETUP.md](./SETUP.md) — install, config, environment variables, running, scripts
- [KNOWN_ISSUES.md](./KNOWN_ISSUES.md) — current limitations and open bugs
- **API docs (OpenAPI/Swagger):** the live REST API is documented in
  [openapi.json](./openapi.json). View it in the UI via **Settings → Connection →
  "View API docs ↗"** (opens `/api-docs/` on the SPA's own origin), or serve
  `docs/openapi.json` in any Swagger UI.
- [archive/](./archive/) — superseded design docs (agency re-architecture contract,
  card-settings plan, options-agency expansion design, the original phased
  development plan, shipped-feature history). Kept for traceability; the active
  references above are the source of truth.

## Repository layout

```
TradingCorp/
├── docs/                 # documentation (this folder)
│   ├── archive/          # superseded design docs (historical)
│   └── openapi.json      # REST API spec (served live at /api-docs)
├── frontend/             # React 18 + Vite 5 SPA (TypeScript)
│   ├── index.html
│   ├── src/
│   │   ├── main.tsx
│   │   ├── App.tsx
│   │   ├── index.css     # Tailwind directives + all app CSS
│   │   ├── types.ts      # shared types (AnalysisResult, ConnectionSettings, …)
│   │   ├── components/   # AnalysisForm/View, ResultsPanel, SettingsDialog, ScreenerPanel,
│   │   │                 #   WatchlistBar, MarketDataCard, PriceChart, ReportsCalendar/ReportModal,
│   │   │                 #   analysts/ (AnalystWall + AnalystTraceDrawer + Agency/Sources dialogs),
│   │   │                 #   compare/ (multi-ticker perf + correlation)
│   │   ├── api/          # one typed client per route group (config, llm-config, registry,
│   │   │                 #   report, history, screener, news, quote, options-history, …)
│   │   ├── hooks/        # useAnalysis + useAnalystRun (per-analyst streaming)
│   │   ├── lib/          # watchlist.ts (localStorage store)
│   │   ├── visualizations/ # RelationsGraph + Visualization registry
│   │   └── test/         # Vitest setup + specs
│   └── dist/             # production build output (generated)
├── src/                  # Backend (TypeScript, run via tsx)
│   ├── server/           # Socket.IO + Express server (serves frontend/dist);
│   │                     #   *-routes.ts + report/decision-log/registry-store + LLM vault
│   ├── orchestration/    # AgencyGraph builder + financial-graph shim
│   ├── registry/         # analysts.ts + agencies.ts + logic/*.ts handlers + sources/ (multi-source)
│   ├── nodes/            # generic-analyst.node.ts (the single data-driven node)
│   ├── prompts/          # analyst-instructions.ts + options-instructions.ts
│   ├── types/            # financial-analysis.ts + registry.ts (AgentState, decisions, traces)
│   ├── config.ts         # env-driven configuration
│   ├── utils/            # logger, retry-handler, parse-query
│   └── tests/            # Jest backend specs + fixtures
├── vite.config.ts        # Vite + Vitest config (root: frontend/, proxies to backend)
├── tsconfig.json / tsconfig.frontend.json
├── postcss.config.js     # Tailwind + autoprefixer (no separate tailwind.config.js)
├── jest.config.js
├── package.json
└── .env.example
```

# TradingCorp
![Build](https://img.shields.io/badge/build-passing-brightgreen)
![Tests](https://img.shields.io/badge/tests-860%2B-blue)
![License](https://img.shields.io/badge/license-MIT-blue.svg)
![TypeScript](https://img.shields.io/badge/made%20with-TypeScript-3178c6)
![Stack](https://img.shields.io/badge/stack-React%20%7C%20LangGraph%20%7C%20Socket.IO-9cf)


Multi-agent AI system for **preservation-first** investment analysis. A backend
orchestrates several specialist agents (fundamental, technical, sentiment, risk)
and a governance gatekeeper, streams their reasoning to the browser in real time
over Socket.IO, and renders the result in a React single-page app.

> Philosophy: capital preservation overrides potential returns. The governance
> gatekeeper can veto any analysis that fails preservation-first criteria.

---

## Table of contents

- [Architecture](#architecture)
- [Tech stack](#tech-stack)
- [Project layout](#project-layout)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Analysis request / response contract](#analysis-request--response-contract)
- [Settings dialog & runtime config (Option B)](#settings-dialog--runtime-config-option-b)
- [Analyst Wall & drill-down traceability](#analyst-wall--drill-down-traceability)
- [Auto-connect with retry](#auto-connect-with-retry)
- [Testing](#testing)
- [Known issues](#known-issues)
- [Documentation index](#documentation-index)

---

## Architecture

```
┌────────────────────────┐      Socket.IO (real-time)    ┌────────────────────────────┐
│  React + Vite SPA      │  ───────────────────────────▶ │  Express + Socket.IO       │
│  (frontend/)           │  request_analysis / config    │  server (src/server/)      │
│  - AnalysisForm        │  request_analysis / config    │  FinancialAnalysisGraph    │
│  - ResultsPanel        │                               │  (LangGraph orchestration) │
│  - RelationsGraphView  │  ◀─────────────────────────── │                            │
│  - SettingsDialog      │  analysis_start / complete /  │                            │
└────────────────────────┘                               └────────────────────────────┘
        │                                                          │
        │ POST /config (Option B)                                  ▼
        └─────────────────────────────────────────   Specialist agents → Governance gatekeeper
```

- **Backend**: Express serves the API + Socket.IO transport. The
  `FinancialAnalysisGraph` (LangGraph `StateGraph`) runs the agents
  sequentially — Orchestrator → Data Ingestion → Fundamental → Technical →
  Sentiment → Risk → Governance — and the server emits a **normalized**
  `analysis_complete` payload (real `decision` / `confidence` / `reasoning`,
  never `undefined`). During a run it also streams per-analyst progress
  (`analyst_start` / `analyst_done`) that drives the **Analyst Wall**, and
  attaches a structured `analystTraces` array used by the **drill-down drawer**.
- **Frontend**: a Vite-built React SPA under `frontend/`. In dev, Vite proxies
  `/socket.io`, `/config` and `/api` to the backend on `:3001`. In production the
  backend serves the built `frontend/dist`. On load the app **auto-connects** to
  the backend, retrying up to 3 times (countdown shown in the Connect button)
  before giving up and letting the user intervene.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full data-flow and
LangGraph state schema.

## Graphify (code knowledge graph for AI agents)

To cut the tokens an LLM agent spends re-reading the codebase, the repo ships a
[Graphify](https://graphify.com/) knowledge graph. It statically parses the code
(on-device, 36 languages, no telemetry — safe for the encrypted credential
vault) into a typed graph and serves it over MCP so an agent retrieves only the
relevant subgraph for a task instead of grepping/dumping whole files.

- **Build / refresh:** `npm run graphify` — code-only AST extract + clustering
  into `.graphify/` (no LLM key needed). To also index the Markdown docs, set an
  LLM key (`GOOGLE_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`) and run
  `npm run graphify:docs`. Requires `pip install "graphifyy[mcp]"` (the `[mcp]`
  extra is needed to run the server).
- **Query it:** `.mcp.json` at the repo root already points an MCP client at
  `.graphify/graph.json` (`python -m graphify.serve`). On the deploy host, change
  the `command` to the host `python` (with `graphifyy[mcp]` installed) or run
  `graphify install` to auto-wire assistants. CLI equivalents: `graphify explain
  "<symbol>"`, `graphify query "<question>"`, `graphify affected "<symbol>"`.
- **Git:** `.graphify/graph.json` + `.graphify/GRAPH_REPORT.md` are committed
  (shareable, so teammates skip re-indexing); `cache/`, `graph.html` and the rest
  stay gitignored.
- **Measured impact:** orienting on a symbol (e.g. `resolveLiveOptionsBundle`)
  returns file+line + traced connections in ~180 tokens vs ~462k tokens to read
  the whole corpus — a ~2500× saving on that task.
- Full convention + caveats: [`AGENT.md` §10](../AGENT.md).

## Demo

<p align="center">
  <img src="screenshots/demo.gif" alt="TradingCorp demo" width="800"/>
</p>

*Watch the Options Agency screen a watchlist, run an analyst-driven screener, and surface each analyst's work and generated results — all from the dashboard.*

## Screenshots

![Options Agency screener](screenshots/DateSelector.jpg)
*Just a preview — Allows you to switch Agencies ( different workflows ), Create Watchlist, 
kick off a stock screener based on selected Agency, Company info, such as charts Quotes,
Options chain, and current news articles. Display of each Analysts work, and the generated Results.
Store the report for later review.

The UI allows you to fully configure the Agency, Analysts, and LLM models used

the top-N most promising tickers for the selected
agency, scored against its analyst composition (promise bar + Tech / Sent /
Mom / Verdict), with a → Analyze hand-off into the analysis tool.*

---

## Tech stack

| Layer        | Choice                                                        |
|--------------|---------------------------------------------------------------|
| Frontend     | React 18 + TypeScript, built with **Vite 5**                  |
| Styling      | Tailwind CSS 3 (PostCSS)                                      |
| Real-time    | Socket.IO (client + server v4)                                |
| Visualization | **D3.js 7** — candlestick/volume `PriceChart` + relations graph (in active use) |
| Backend      | Node.js + Express 4, TypeScript via `tsx`                     |
| Orchestration| LangGraph (`@langchain/langgraph`) `StateGraph`               |
| Tests        | Jest (backend) + Vitest + Testing Library (frontend)          |

---

## Project layout

```
TradingCorp/
├── frontend/                         # React 18 + Vite 5 SPA (TypeScript)
│   ├── index.html
│   ├── src/
│   │   ├── main.tsx
│   │   ├── App.tsx
│   │   ├── index.css                 # Tailwind directives + all app CSS
│   │   ├── types.ts                  # shared types (AnalysisResult, ConnectionSettings, AnalystTrace, …)
│   │   ├── components/               # top-level views & panels
│   │   │   ├── AnalysisForm.tsx  AnalysisView.tsx  ResultsPanel.tsx
│   │   │   ├── SettingsDialog.tsx  AnalystSettingsDialog.tsx
│   │   │   ├── ReportsCalendar.tsx  ReportModal.tsx  RawDataDrawer.tsx   # saved-report browser + tooltips
│   │   │   ├── ScreenerPanel.tsx  WatchlistBar.tsx  MarketDataCard.tsx  PriceChart.tsx
│   │   │   ├── RelationsGraphView.tsx
│   │   │   ├── analysts/             # AnalystWall + AnalystTraceDrawer + Agency/Sources dialogs
│   │   │   │   ├── AnalystWall.tsx  AnalystTraceDrawer.tsx
│   │   │   │   ├── AgencySelect.tsx  AgencySettingsDialog.tsx  AgencyReorgDialog.tsx
│   │   │   │   ├── SourcesTab.tsx  DomainSourcesTab.tsx           # swappable-source config UI
│   │   │   │   └── analysts.ts  agencies.ts  analystConfigSchema.ts   # frontend mirror of the registry
│   │   │   └── compare/              # multi-ticker compare (perf chart, correlation matrix)
│   │   ├── api/                      # one typed client per backend route group
│   │   │   ├── configClient.ts  llmConfigClient.ts  registryClient.ts
│   │   │   ├── reportClient.ts  historyClient.ts  screenerClient.ts  newsClient.ts
│   │   │   ├── quoteClient.ts  optionsHistoryClient.ts  serverLogClient.ts
│   │   │   ├── analystConfigClient.ts  analystParamsClient.ts  analystFlavorsClient.ts
│   │   │   └── domainSourceClient.ts
│   │   ├── hooks/                    # useAnalysis (socket run) + useAnalystRun (per-analyst streaming)
│   │   ├── lib/                      # watchlist.ts (localStorage helpers)
│   │   ├── visualizations/           # RelationsGraph + Visualization registry
│   │   └── test/                     # Vitest setup + specs
│   └── dist/                         # production build output (gitignored)
├── src/                              # Backend (TypeScript, Express + Socket.IO)
│   ├── server/
│   │   ├── index.ts                  # entry; wires all routes, serves frontend/dist
│   │   ├── socket.ts                 # Socket.IO analysis streaming
│   │   ├── *-routes.ts               # REST routes: config, llm-config, registry, report, history,
│   │   │                             #   screener, news, quote, options-history, domain-source,
│   │   │                             #   analyst-config/params/flavors, server-log, api-docs
│   │   ├── report.ts / report-routes.ts   # report generation (md/html/pdf/json) + durable .meta.json sidecars
│   │   ├── decision-log.ts           # persistent JSONL decision log (gated, parity-safe)
│   │   ├── registry-store.ts         # SQLite-persisted registry overrides (applyAllOverridesToRegistry)
│   │   ├── llm-sqlite.ts / llm-json-store.ts / llm-vault.ts   # LLM config + credential storage
│   │   └── connection-config.ts  domain-source-config.ts  quote.ts  thesis-summary.ts  dataDir.ts
│   ├── orchestration/                # agency-graph.ts (AgencyGraph builder) + financial-graph.ts
│   ├── registry/                     # data-driven analyst/agency registry
│   │   ├── analysts.ts  agencies.ts  logic.ts  prompts.ts  validate.ts  analyst-config-schema.ts
│   │   ├── logic/                    # per-analyst handlers: fundamental, technical, sentiment, news,
│   │   │                             #   risk, governance, options-handlers, screener, greeks, vol-surface,
│   │   │                             #   hist, fuse (fusion), data-ingestion, orchestrator, declarative, …
│   │   ├── sources/                  # multi-source data acquisition (acquire.ts + index.ts)
│   │   └── types/                    # domain source typing
│   ├── nodes/                        # generic-analyst.node.ts (single data-driven node; no subclasses)
│   ├── prompts/                      # analyst-instructions.ts + options-instructions.ts (role prompts)
│   ├── types/                        # financial-analysis.ts + registry.ts (AgentState, decisions, traces)
│   ├── config.ts                     # server config (PORT, bindHost, data sources)
│   ├── utils/                        # logger, retry-handler, parse-query
│   └── tests/                        # Jest backend specs + fixtures
├── docs/                             # ARCHITECTURE, SETUP, KNOWN_ISSUES, EXTENDING_ANALYSTS,
│                                     #   SCREENER_STANDARDS, README, openapi.json
├── vite.config.ts                    # Vite + Vitest config (root: frontend/, proxies to :3001)
├── tsconfig.json / tsconfig.frontend.json
├── jest.config.js                    # backend test config
├── postcss.config.js                 # Tailwind + autoprefixer (no separate tailwind.config.js)
├── package.json
└── .env.example
```

---

## Quick start

Prerequisites: Node.js 18+ (developed on Node 22), npm.

```bash
# 1. Install dependencies
npm install

# 2. Configure environment (optional — sensible defaults exist)
cp .env.example .env
#   edit .env if you need a non-default PORT / HOST / data-source key

# 3. Run both processes with one command (recommended for local dev)
npm run dev:all
#   → starts the backend (:3001) and Vite dev server (:5173) together via concurrently

# 3b. …or run them in two terminals:
# Terminal 1 — backend (Socket.IO + REST on :3001)
npm run server

# Terminal 2 — Vite front-end (on :5173, proxies /socket.io and /config to :3001)
npm run dev

# 5. (Optional) production build + serve
npm run build      # builds frontend/dist
npm run start      # builds then launches the backend, which serves frontend/dist
```

Open http://localhost:5173. The app **auto-connects** on load (up to 3 retries,
shown as a countdown in the Connect button). Enter a ticker (e.g. `AAPL, MSFT`),
run the analysis, and the Analyst Wall streams each agent's progress live. Once a
run completes, click any analyst panel to open the **drill-down trace drawer**.

---

## Configuration

Server configuration lives in [`src/config.ts`](src/config.ts) and is overridable
via environment variables (template: [`.env.example`](.env.example)).

| Variable                   | Default            | Purpose                                                        |
|----------------------------|--------------------|----------------------------------------------------------------|
| `PORT`                     | `3001`             | Backend HTTP / Socket.IO port                                  |
| `HOST`                     | `localhost`        | Display name in logs                                           |
| `SOCKET_ORIGIN`            | `http://localhost:3000,http://localhost:3001,http://localhost:5173` | Socket.IO CORS allowed origins (comma-separated list, or `*` for any). The Vite dev origin `:5173` is included by default. |
| `DEFAULT_ANALYSIS_DEPTH`   | `STANDARD`         | `QUICK` \| `STANDARD` \| `DEEP`                                |
| `DEFAULT_TIME_HORIZON`     | `MEDIUM_TERM`      | `SHORT_TERM` \| `MEDIUM_TERM` \| `LONG_TERM`                  |
| `DEFAULT_RISK_TOLERANCE`   | `MODERATE`         | `CONSERVATIVE` \| `MODERATE` \| `AGGRESSIVE`                  |
| `LOG_LEVEL`                | `info`             | Logging verbosity                                              |
| `ALPHA_VANTAGE_API_KEY`    | _(empty)_          | Alpha Vantage `OVERVIEW` fundamentals (consumed live when set; also configurable via the encrypted vault in Settings) |

**Binding note:** the server binds to `0.0.0.0` (all interfaces) by default via
`bindHost`. If `HOST` is an unresolvable hostname (e.g. `linux-1sou.AtHome` on a
different machine) the bind falls back to `0.0.0.0` so `server.listen()` doesn't
throw `ENOTFOUND`. Logs still show the configured `HOST` name.

> Runtime connection settings (backend **URI** and **access token**) are NOT set
> here — they are supplied at runtime through the in-app **Settings dialog**
> (see below). This keeps secrets out of `.env` and lets the user point the UI at
> any backend instance.

---

## Analysis request / response contract

**Client → server** (`request_analysis` over Socket.IO):

```ts
{ tickers: string[], options: { depth, time_horizon, risk_tolerance } }
```

**Server → client** events:

| Event                | Payload                                   |
|----------------------|-------------------------------------------|
| `welcome`            | `{ message, serverId, timestamp }`        |
| `analysis_start`     | `{ tickers, timestamp, message }`         |
| `analyst_start`      | `{ analyst, ticker, task }`               |
| `analyst_done`       | `{ analyst, ticker, progress, status }`   |
| `analysis_complete`  | normalized `AnalysisResult` (see below)   |
| `analysis_error`     | `{ error, timestamp }`                    |

The `analyst_start` / `analyst_done` events stream per-analyst progress and drive
the **Analyst Wall** (one panel per analyst that fills/shimmers as the run
streams). The `analysis_complete` payload is **normalized** by the server so the
UI never sees `undefined`. It carries the standard result fields plus an
`analystTraces` array:

```ts
{
  decision: 'APPROVE' | 'REJECT' | 'ERROR',
  confidence: number | null,
  reasoning: string,
  preservation_rationale: string | null,
  conditions: string[],
  tickers: string[],
  company_name: string,
  investment_thesis: string,
  final_decision: string,
  error: string | null,
  fundamental_analysis: any | null,
  technical_analysis: any | null,
  sentiment_analysis: any | null,
  risk_assessment: Record<string, any> | null,
  decisions: Record<string, any>,
  riskAssessments: Record<string, any>,
  analystTraces: AnalystTrace[]   // per-analyst drill-down records (see below)
}
```

Each `AnalystTrace` documents how that analyst reached its output:

```ts
interface AnalystTrace {
  analyst: AnalystId;          // 'orchestrator' | 'fundamental' | 'technical' | 'sentiment' | 'risk' | 'governance'
  name: string;
  instructions: string;        // TradingAgents-style role prompt it ran under
  inputs: { ticker: string; label?: string; data: Record<string, any>; sources: string[] }[];
  weighting: { label: string; weight: number; inputs: string[]; contribution?: number; scale?: string; rationale: string }[];
  output: { verdict?: string; score?: number; summary: string; details?: any };
  notes?: string[];
  timestamp: string;
}
```

The rich `InvestmentDecision` (with `confidence`/`reasoning`) is extracted from
the governance node's output message on the server side — this is what fixes the
historical "REJECTED (undefined% confidence)" bug.

---

## Settings dialog & runtime config (Option B)

The user asked for a **Settings dialog** to supply any **URI**, **access-token**,
or other required information, and chose **Option B**: the settings are posted to
a backend `POST /config` endpoint and the backend reads them at analysis time
(per-session, in-memory — not persisted to disk).

- **`ConnectionSettings` model** (`frontend/src/types.ts`):
  ```ts
  { baseUri: string; accessToken: string; extra: Record<string, string> }
  ```
- The dialog (Phase 2) collects the backend base URI, access token, and free-form
  extra fields, then `POST`s them to `/config`.
- The backend stores them in memory and applies them when handling
  `request_analysis` (e.g. targeting the configured `baseUri`, attaching the
  `accessToken` to upstream data-source calls). The token is **never logged** and
  **never embedded in the client bundle**.

> Option B (vs. passing settings on the Socket.IO handshake) keeps the UI a clean
> config surface and lets the same backend serve multiple frontends with
> different runtime config.

---

## Analyst Wall & drill-down traceability

The dashboard shows an **Analyst Wall** — one framed panel per analyst (Orchestrator,
Fundamental, Technical, Sentiment, Risk, Governance). While an analysis runs, the
backend streams `analyst_start` / `analyst_done` events and each panel shimmers and
fills to show the analyst currently working on each ticker.

After a run completes, **click any analyst panel** (it becomes clickable once its
trace is available) to open a **right-side slide-in drawer** (not a modal) with
four drill-down pillars:

1. **Instructions** — the selected **flavor's** Role & Instructions the analyst
   ran under. After you edit + save a flavor in the settings dialog, this tab
   shows the **live saved text immediately** (tagged with a green "● live" badge)
   — no re-run required.
2. **Data Received** — expandable per-ticker rows showing the exact inputs, with
   the source(s) that fed each row.
3. **Weighting → Output** — visual weighting bars plus the per-step logic
   (input → weight → contribution) that produced the analyst's verdict/score.
4. **Sources** — a flat list of every source consulted.

Each analyst card also shows a single **⚙ gear** (→ `✓` once fully configured)
that opens a **tabbed** `AnalystSettingsDialog` (`[Sources]` `[Role & Instructions]`
`[Weights]`).

**Breadcrumb traceability:** from the Weighting tab you can click any input name
(e.g. `debt_to_equity`) and the drawer jumps to the Data tab and highlights the
exact source field it drew from — a clickable `analyst › ticker › field` path at
the top of the drawer lets you trace any output value back to its origin. An
in-drawer analyst switcher lets you move laterally between analysts without closing.

> The trace data is captured from each analyst handler's output (see `captureTrace()`
> in `makeNodeSurface()` — `src/registry/logic/shared.ts`). Because the analysis
> currently runs on **mock/seeded data** (see KNOWN_ISSUES #2), the numbers are
> illustrative — but the capture wiring is real and will carry live inputs once
> real data sources are wired in. The **Quote panel** below the form, however, is
> already live (Yahoo, tokenless).

---

## Stock Screener

The **Stock Screener** sits above the market row and finds the **top-N most
promising tickers for the currently selected agency**, fast (LLM-free). It is
driven by `GET /screener?agencyId=&limit=&universe=` and
`src/registry/logic/screener.ts`.

**How it scores.** Each candidate is scored on **cheap, LLM-free signals
only** — technical / momentum / volatility derived from price bars
(`fetchPriceBars`) and news sentiment (`fetchCompanyNews` + `scoreHeadline`).
The blend is weighted by **which analysts the selected agency actually
contains** (`resolveAgencyWeights`), so a crypto agency leans on
sentiment/onchain while a long-term equity agency leans on technical +
fundamental + sentiment. A bounded-concurrency pool (6 in-flight) keeps it
quick.

**Real data, honest badge.** The candidate universe is pulled **live** from the
NasdaqTrader listed-directory (~13k symbols; `UNIVERSE_PROVIDER=sp500` switches
to a Wikipedia/CSV S&P 500 list). Per-ticker price bars come **live from Yahoo
(tokenless, delayed ~15–20 min)**, falling back to `mock` bars only when the
chart endpoint is throttled. The screen result carries a
**semantically honest badge** — it is *not* a UI bug when it reads `DELAYED`:

| Badge | Meaning | When |
|-------|---------|------|
| `LIVE`  | Real universe + every row on live bars | Reserved for a future sub-second feed |
| `DELAYED` | Real universe; some rows on mock bars | **Normal case.** Shows `N/M live` sub-count |
| `MOCK` | Universe fell back **and** zero live rows | Only when no live source is reachable at all |

A **Data lineage** block under the table shows the universe pipeline
(listed → parsed → pre-filtered → final pool, with source + `LIVE`/`CACHE`/`FALLBACK`
origin badge) and warns **only** when the universe genuinely fell back. The
**Promise** column is a stacked bar / number / top-axis label; the **Run**
button shows a **live running timer** during the 30–40s screen; and a **field
legend** explains every column (Promise / Tech / Sent / Mom / Verdict). Click
any column header to sort. Each row has a **→ Analyze** button that sends the
ticker straight into the analysis tool.

See [`docs/openapi.json`](docs/openapi.json) (`GET /screener`) for the full
response schema. The screener's root-cause fixes (Yahoo 429 retry +
circuit-breaker, Nasdaq parser guards) are covered in `docs/KNOWN_ISSUES.md §11`.

---

## Auto-connect with retry

On load the app attempts to connect to the Socket.IO backend automatically — this
covers the "refresh the UI" case. It tries **up to 3 times**: each attempt gets a
~4s timeout, and the **Connect button shows a live countdown** (`Connecting… (3)`
→ `Connecting… (2)` → `Connecting… (1)`). On the first successful connection it
settles to `Connected` and the button reads `Connect` (disabled). If all three
attempts fail it shows **`-FAILED-`** and waits for the user to click to retry
manually. Socket.IO's own internal reconnection is disabled so the countdown is
deterministic and visible (the retry loop is owned by `App.tsx`).

---

## Testing

| Suite        | Command                          | Framework            | Coverage |
|--------------|----------------------------------|----------------------|----------|
| **All**      | `npm test`                       | Jest + Vitest        | both     |
| Backend      | `npm run test:server`            | Jest + ts-jest       | ✓ (`coverage/`) — **~540 tests, 64 suites** |
| Frontend     | `npm run test:ui`                | Vitest + Testing Library | ✓ (`coverage-ui/`) — **322 tests, 39 files**  |

> A handful of backend suites (`llm-config`, `llm-sqlite`, `news`,
> `data-received.r2`, `server-log`) are **environment-gated** — they need a
> writable store path / `LLM_VAULT_PASSPHRASE` / a live news transport and will
> fail in a bare sandbox with no vault or keys. Run them where those are
> configured. All frontend suites and the core backend logic suites are green
> unconditionally.

```bash
npm test            # runs test:server (jest, coverage) THEN test:ui (vitest, coverage)
npm run test:server # backend jest suite + coverage report
npm run test:ui     # frontend vitest suite + coverage report
```

- Backend coverage is configured in `jest.config.js` (`collectCoverageFrom` →
  `src/**/*.ts`, excluding types/tests).
- Frontend coverage is configured in `vite.config.ts` (`test.coverage`, v8
  provider, scoped to `frontend/src`).
- HTML/LCOV reports land in `coverage/` (backend) and `coverage-ui/` (frontend).

---

## Known issues

- The orchestrator's `parseQuery()` still contains hardcoded test strings
  (documented in [`docs/KNOWN_ISSUES.md`](docs/KNOWN_ISSUES.md)).
- The per-analyst **scoring/weighting** logic is still the deterministic model,
  but it now consumes **live inputs**: Yahoo price/history, Alpha Vantage
  fundamentals (keyed), Finnhub news/sentiment (keyed), and a live option chain
  from **Massive/Polygon** (entitled) → **CBOE free delayed feed** (no key)
  before any mock. The unified **`MarketDataCard`** shows real company name,
  price, ranges, volume, a D3 price chart, and a real option chain with
  feed-provided/derived greeks. Provenance is surfaced honestly (LIVE/DELAYED/
  MOCK badges + per-domain source notes); the vol-surface remains a deterministic
  mock.
- Full details and the external-data integration roadmap:
  [`docs/KNOWN_ISSUES.md`](docs/KNOWN_ISSUES.md).
- **AI agents working in this repo: read [`AGENT.md`](AGENT.md) first** — it holds
  the deploy procedure (two-copies gotcha), data-source rules, and the
  semantic-honesty bar.

---

## Documentation index

- [`docs/README.md`](docs/README.md) — project overview + documentation map
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — LangGraph DAG, Socket.IO + SPA flow, node responsibilities
- [`docs/EXTENDING_ANALYSTS.md`](docs/EXTENDING_ANALYSTS.md) — add an analyst/agency (declarative + fn + options paths)
- [`docs/SCREENER_STANDARDS.md`](docs/SCREENER_STANDARDS.md) — Stock Screener selection standards & traceability (how/why it picks tickers)
- [`docs/SETUP.md`](docs/SETUP.md) — install, env table, run scripts
- [`docs/ARCHITECTURE.md §Multi-Source Data Architecture`](docs/ARCHITECTURE.md#multi-source-data-architecture-vendor-agnostic-fan-in) — vendor-agnostic multi-source plan (data domains + adapters + fan-in/weighting; phased rework)
- [`docs/KNOWN_ISSUES.md`](docs/KNOWN_ISSUES.md) — limitations & workarounds
- [`docs/archive/`](docs/archive/) — superseded design docs (historical, kept for traceability)
- **Live REST API docs** — served by the running server at **`/api-docs`** (Swagger UI v5, dark mode). The OpenAPI 3.0 document lives at [`docs/openapi.json`](docs/openapi.json) and is kept in sync with the route handlers. Covers all REST endpoints including `GET /news`, `GET /screener`, and the analyst/agency CRUD endpoints; the Watchlist / Portfolio layer is frontend-only (`localStorage`), so it has no backend endpoint.

---

## License

MIT

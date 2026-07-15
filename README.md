# Financial Analysis Pipeline

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
- [Frontend rewrite — phased plan](#frontend-rewrite--phased-plan)
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
        │ POST /config (Option B)                                 ▼
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

---

## Tech stack

| Layer        | Choice                                                        |
|--------------|---------------------------------------------------------------|
| Frontend     | React 18 + TypeScript, built with **Vite 5**                  |
| Styling      | Tailwind CSS 3 (PostCSS)                                      |
| Real-time    | Socket.IO (client + server v4)                                |
| Visualization (future) | **D3.js 7** (relations graph, added as a dependency now) |
| Backend      | Node.js + Express 4, TypeScript via `tsx`                     |
| Orchestration| LangGraph (`@langchain/langgraph`) `StateGraph`               |
| Tests        | Jest (backend) + Vitest + Testing Library (frontend)          |

---

## Project layout

```
financial-analysis-pipeline/
├── frontend/                 # React + Vite SPA (new)
│   ├── index.html
│   ├── src/
│   │   ├── main.tsx
│   │   ├── App.tsx
│   │   ├── index.css         # Tailwind entry
│   │   ├── types.ts          # shared types (AnalysisResult, ConnectionSettings, AnalystTrace, …)
│   │   ├── components/       # SettingsDialog, AnalysisForm, ResultsPanel, RelationsGraphView, AnalysisView
│   │   │   └── analysts/     # AnalystWall (real-time per-analyst panels) + AnalystTraceDrawer (drill-down)
│   │   ├── hooks/            # useAnalysis (Phase 3 socket hook) + useAnalystRun (per-analyst streaming)
│   │   ├── api/              # (Phase 2) /config client
│   │   └── test/             # Vitest setup + specs
│   └── dist/                 # production build output (gitignored)
├── src/                      # Backend (TypeScript)
│   ├── server/index.ts       # Express + Socket.IO entry; serves frontend/dist
│   ├── orchestration/        # AgencyGraph builder + buildLegacyGraph shim
│   ├── registry/             # analysts.ts (AnalystDefs) + agencies.ts (AgencyDefs) + logic/*.ts handlers + logic.ts registry
│   ├── nodes/                # generic-analyst.node.ts (the single data-driven node; no per-analyst subclasses)
│   ├── prompts/              # analyst-instructions.ts (TradingAgents-style role prompts for the trace drawer)
│   ├── types/                # financial-analysis.ts (AgentState, InvestmentDecision, AnalystTrace, …)
│   ├── config.ts             # server config (PORT, bindHost, data sources)
│   └── utils/                # logger, retry-handler, parse-query, rng/seed helpers
├── docs/                     # ARCHITECTURE, SETUP, KNOWN_ISSUES, README
├── vite.config.ts            # Vite + Vitest config (root: frontend/, proxies to :3001)
├── tsconfig.frontend.json    # bundler-resolution tsconfig for the SPA
├── tailwind.config.js        # content scans frontend/src
├── postcss.config.js
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
| `ALPHA_VANTAGE_API_KEY`    | _(empty)_          | Reserved for future data-source integration (not yet consumed)|

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

## Frontend rewrite — phased plan

The original repo had **two** frontends — a raw vanilla `public/index.html` and a
partial Next.js app — neither wired to a clean build. It was rewritten to a single
**React + Vite SPA** delivered in phases, each verified (build + unit tests)
before the next begins.

| Phase | Scope | Status |
|-------|-------|--------|
| **1** | Vite + React + TS scaffold; Tailwind; `tsconfig.frontend.json`; smoke tests. **Build green, tests green.** `package.json` cleaned (removed `next`, vanilla `public/`, `src/pages`), server now serves `frontend/dist`. | ✅ Done |
| **2** | `SettingsDialog` component + backend `POST /config` (Option B) + unit tests. | ✅ Done |
| **3** | Core analysis UI: `AnalysisForm`, normalized `ResultsPanel`, streaming `useAnalysis` hook over `analysis_start`/`analysis_complete`/`analysis_error` + unit tests. | ✅ Done |
| **4** | Clean visualization class structure + **D3** `RelationsGraph` (real nodes/edges render, wired via `RelationsGraphView`) + unit tests. | ✅ Done |
| **5** | Final wiring/verify + docs sync. (SPA serving done in Phase 1; all phases complete and tested.) | ✅ Done |
| **6** | **Analyst Wall** (real-time per-analyst panels driven by `analyst_start`/`analyst_done`) + **drill-down trace drawer** (slide-in, 4 pillars: Instructions / Data / Weighting→Output / Sources) with breadcrumb traceability back to source fields. Backend `analystTraces` captured per node (`captureTrace`) and shipped on `analysis_complete`. | ✅ Done |
| **7** | **Auto-connect with retry** — app connects on load, up to 3 attempts with a live countdown in the Connect button (`Connecting… (3→2→1)`), then `-FAILED-` awaiting manual retry. Socket.IO internal reconnection disabled so the countdown is deterministic. | ✅ Done |
| **8** | **Per-analyst tabbed settings dialog** — each analyst card shows ONE ⚙ gear opening a tabbed `AnalystSettingsDialog` (`[Sources]` `[Role & Instructions]` `[Weights]`); the former two-gear design + `AnalystSourceDialog` were removed. Role & Instructions edits show **live** in the trace drawer immediately (no re-run). | ✅ Done |
| **9** | **Live market data (Phase 3)** — after a symbol is entered, tokenless `GET /quote` (Yahoo) surfaces company name + price + day/52-week range + volume, `GET /history` surfaces OHLCV bars, and `GET /options-history` (Polygon, keyed) surfaces option chains. Each degrades to a `note` on source failure. Verified live (AAPL, MSFT). | ✅ Done |
| **10** | **Unified market card (Phase M)** — replaced the three separate `QuotePanel` / `HistoryPanel` / `OptionsChainPanel` rows with a single **`MarketDataCard`** per ticker (`Chart` / `Quote` / `History` / `Options` tabs). The Chart tab renders a D3 candlestick + volume chart (custom `PriceChart`, TradingView-style crosshair + hover tooltip) with 1D/5M/1M interval toggles. Orphaned panels + their tests deleted. | ✅ Done |
| **11** | **Real-data technical verdict (2.1)** — the Technical Analyst is now fully data-driven from real Yahoo OHLCV bars: trend / momentum / volatility / support-resistance / score are *derived* from price history (SMA stack, higher-highs/lows, RSI+MACD, return volatility, swing S/R, max drawdown). The seeded RNG is now a **no-bars fallback only**, not mixed into live runs. Ingestion now honors the horizon profile (real 5m/1m bars for intraday/medium, not a hardcoded 1y/1d). Trace `notes` honestly report "derived from real Yahoo OHLCV bars" vs "seeded fallback". 8 new unit tests (`src/tests/technical-realbars.test.ts`). | ✅ Done |
| **12** | **Analysis-grade chart (item 3)** — `PriceChart` is no longer decorative: it computes **client-side** SMA 20/50/200, EMA 12/26, Bollinger Bands (20,2), VWAP, and RSI(14) overlays from the bars it already has, each toggleable. RSI renders as its own 0–100 sub-pane (30/50/70 guides). The **technical analyst's `support_resistance` levels are plotted as dashed green (support) / red (resistance) annotation lines** with right-axis labels, bridging the *real* chart to the *analyst's* conclusions. `AnalysisView` threads `result.technical_analysis[symbol]` into `MarketDataCard`; a `SMA/EMA/BB/VWAP/RSI` studies toggle row drives visibility. Wheel-zoom + crosshair + tooltip preserved (tooltip shows hovered indicator values). | ✅ Done |
| **13** | **Live news + sentiment feed (item 4)** — a real **News / Sentiment** tab in `MarketDataCard`: `GET /news?symbol=` (new `news-routes.ts`) pulls **Finnhub `/company-news`** headlines (tokenless after a free `FINNHUB_KEY`) and scores each with a **deterministic keyword-polarity model** (no LLM — auditable, free). When Finnhub is reachable, `data-ingestion.ts` overrides `sentiment_data[ticker]` with the real news score + `key_news`, so the **Sentiment Analyst's existing `realSent` hook fires** and turns its seeded verdict into a real one (zero analyst-code changes). The tab shows the real headline list (title / source / time / polarity chip) + aggregate sentiment, and — after an analysis run — the **Sentiment Analyst's own scored read** (news/social/analyst/institutional breakdown) threaded from `result.sentiment_analysis[symbol]`. Degrades to a shaped seeded headline set when no key/network. 9 backend + 2 frontend new tests. | ✅ Done |
| **14** | **Comparable / multi-ticker analysis (item 5)** — a **Compare** toggle appears above the market-row when 2–5 tickers are in the current run. Compare mode replaces the per-ticker cards with a centerpiece `CompareView`: (1) a **normalized relative-performance chart** (each ticker rebased to 100, overlaid SVG lines + legend), (2) a **pairwise return-correlation matrix** (Pearson, color-coded green/red), and (3) a **side-by-side verdict table** (technical score/verdict + sentiment score per ticker, sourced from `result.technical_analysis[symbol]` / `sentiment_analysis[symbol]`). Price series are fetched live via `GET /history` (real when reachable, shaped mock otherwise) — same degradation pattern as the other market cards. Pure helpers in `compareUtils.ts` (normalizeToBase / dailyReturns / pearson / correlationMatrix / alignTail) are unit-tested with injected bars. 12 + 3 new tests. | ✅ Done |
| **15** | **Stock Screener (item 6)** — `GET /screener?agencyId=&limit=&universe=` returns the **top-N most-promising tickers for the currently selected agency**, fast. `src/registry/logic/screener.ts` scores a candidate universe against the **agency's actual analyst composition** (derived axis weights from `agencies.ts`) using only **cheap, LLM-free signals**: `fetchPriceBars` (technical / momentum / volatility) + `fetchCompanyNews` / `scoreHeadline` (sentiment). A **bounded-concurrency pool (6 in-flight)** keeps it quick; the response includes `elapsedMs` + per-axis scores + a `topAxis` tag so the UI can label *why* each ticker ranked. Frontend `ScreenerPanel` sits above the market-row with a **Run** button, a top-N table (promise bar + tech / sentiment / momentum / verdict), an **elapsed-time readout**, and a **→ Analyze** button that sends the pick straight into the analysis tool. | ✅ Done |
| **16** | **Watchlist / Portfolio layer (item 7)** — the persistent "my tickers" home. `src/lib/watchlist.ts` is an SSR-safe `localStorage` store with a reactive `useWatchlist()` hook (module-level pub/sub keeps every consumer in sync). `WatchlistBar` renders above the form so returning users land on a **portfolio view** (saved-symbol chips + add input), not a one-shot form; clicking a chip **deep-dives** through the analysis tool (`MarketDataCard`), and a × removes it. `MarketDataCard` gained a **watch star** (controlled `watched`/`onToggleWatch` props, falling back to the shared store when uncontrolled) so starring a market card promotes it into the watchlist — closing the loop between one-shot research and a saved portfolio. | ✅ Done |
| **17** | **Options Greeks in the Options tab** — each option quote now carries **Black–Scholes greeks (Δ/Γ/ν/Θ/ρ)** re-derived from its implied volatility (`bsGreeks` in `src/registry/logic/greeks.ts`, already the project's single pricing source of truth). `GET /options-history` now returns a `greeks[]` array (one row per quote, computed for both the live Polygon chain and the mock fallback — so Greeks show even with no key/network). `MarketDataCard`'s Options tab renders a **separate per-strike Greeks subtable** (Call/Put side, Δ/Γ/ν/Θ/ρ) below the Call/Put table; vega is shown per 1 vol-point (ν/100) and theta per day (Θ/365), with a footnote explaining the scaling. No new data provider required. | ✅ Done |

---

## Testing

| Suite        | Command                          | Framework            | Coverage |
|--------------|----------------------------------|----------------------|----------|
| **All**      | `npm test`                       | Jest + Vitest        | both     |
| Backend      | `npm run test:server`            | Jest + ts-jest       | ✓ (`coverage/`) — **434 tests, 51 suites** |
| Frontend     | `npm run test:ui`                | Vitest + Testing Library | ✓ (`coverage/`) — **240 tests, 37 files**  |

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
- The per-analyst analysis inputs are still deterministic seeded demo logic
  (no live feed behind a credential for the analysis itself). **However**, live
  **company-name + market data** now ships: after you enter a ticker, the unified
  **`MarketDataCard`** shows the real company name, price, day range, 52-week
  range, and volume via the tokenless `GET /quote` (Yahoo) endpoint, plus a D3
  price chart (`GET /history`) and an option chain (`GET /options-history`).
- Full details and the external-data integration roadmap:
  [`docs/KNOWN_ISSUES.md`](docs/KNOWN_ISSUES.md).

---

## Documentation index

- [`docs/README.md`](docs/README.md) — project overview
- [`docs/PHASED_DEVELOPMENT.md`](docs/PHASED_DEVELOPMENT.md) — TradingAgents lineage, stage rules, phased test-gated plan
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — LangGraph DAG, Socket.IO + SPA flow, stage rules
- [`docs/SETUP.md`](docs/SETUP.md) — install, env table, run scripts
- [`docs/KNOWN_ISSUES.md`](docs/KNOWN_ISSUES.md) — limitations & workarounds
- **Live REST API docs** — served by the running server at **`/api-docs`** (Swagger UI v5, dark mode). The OpenAPI 3.0 document lives at [`docs/openapi.json`](docs/openapi.json) and is kept in sync with the route handlers. Covers all REST endpoints including `GET /news` (item 4) and `GET /screener` (item 6); the Watchlist / Portfolio layer (item 7) is frontend-only (`localStorage`), so it has no backend endpoint.

---

## License

MIT

# AGENT.md — TradingCorp (operating guide for AI coding agents)

This file is the **first thing to read** before changing code in this repo. It is
kept intentionally opinionated and short. The long-form references live in
`docs/` (see the Documentation index at the bottom).

> NOTE: this project was built/maintained by an AI agent (Hermes) in lockstep
> with the user. The conventions below encode hard-won lessons — follow them
> literally, not approximately.

---

## 1. What this repo is

A **multi-agent financial analysis system** (preservation-first philosophy):
- **Backend**: TypeScript, run via `tsx`. LangGraph `StateGraph` orchestrates
  analyst agents (fundamental / technical / sentiment / risk) + a governance
  gatekeeper. Real-time over Socket.IO + Express (`src/server/index.ts`).
- **Frontend**: React 18 + Vite 5 SPA (`frontend/`), Tailwind, D3 charts.
- **Philosophy**: DATA SOURCES MUST BE HONEST. A "MOCK" badge is correct when
  data is synthetic; a "DELAYED"/"LIVE" badge is required when it's real. Never
  stamp MOCK on a live universe and never hide a real source behind a mock label.
  (The user verifies by eyeballing the running UI — see §6.)

## 2. CRITICAL — two copies of the code, only ONE runs

There are **two working trees**:
- `/home/opencode/workspace/TradingCorp` — the source you edit here.
- `~/projects/XAss/TradingCorp` — the **deployed, running** copy the user sees.

**They do NOT auto-sync.** Edits in the workspace never reach the running server
until you copy them over and restart. A bug that "keeps coming back" is almost
always this lag.

**Deploy procedure (do this after ANY backend/frontend change you want the user
to see):**
```bash
# from the workspace repo:
SRC=/home/opencode/workspace/TradingCorp
DST=~/projects/XAss/TradingCorp
# copy changed backend source trees
cp -r $SRC/src $DST/
# copy changed frontend source
cp -r $SRC/frontend/src $DST/frontend/src
# copy changed configs/tests as needed
cp $SRC/package.json $DST/ 2>/dev/null || true
# rebuild the SPA + restart the server
cd $DST
OLD_PID=$(lsof -ti tcp:8091 2>/dev/null || true)
[ -n "$OLD_PID" ] && kill $OLD_PID
npm run build            # vite build -> frontend/dist
HOST=10.9.200.188 PORT=8091 REGISTRY_STORE_DRIVER=json \
  ENABLE_CRYPTO_AGENCY=false DATA_DIR=.my_data DISABLE_MOCK_DATA=1 \
  npm run dev:all &
```
Adjust the port/PID (8091 is the deployed host port; 3001 is the default dev
port). Always confirm the running UI reflects the change before declaring done.

## 3. Build / run / test commands (authoritative)

```bash
npm install                # install deps (node 18+, developed on 22; uses tsx)
npm run server             # backend (Socket.IO + Express) via tsx, default :3001
npm run dev                # Vite dev server :5173 (proxies /socket.io /config /api to :3001)
npm run dev:all            # both, concurrently
npm run build              # vite build -> frontend/dist (also npm rebuild better-sqlite3)
npm test                   # Backend (jest --coverage) THEN Frontend (vitest --coverage)
npm run test:server        # backend jest only
npm run test:ui            # frontend vitest only
npx tsc --noEmit           # backend type-check (see §7 for the known baseline)
```

- **Backend tests**: `src/tests/*.test.ts` (Jest + ts-jest).
- **Frontend tests**: `frontend/src/test/*.test.ts(x)` (Vitest + Testing Library).
- **Coverage is mandatory in `npm test`** (the user wants to see source coverage).
  Backend uses `@jest-coverage`; frontend uses `@vitest/coverage-v8`.
- The user prefers **React + Vite SPA** (not Next.js/vanilla). New UI goes in
  `frontend/src/components/`.

## 4. Data-source wiring (READ BEFORE touching ingestion/options)

Live data is wired through the **registry `DataSourceSpec` + `acquire`** path, not
env vars alone. Credentials are stored in an **encrypted LLM vault** at runtime
(via the in-app Settings dialog / `POST /analyst-config`), NOT committed to
`.env`. Trim whitespace on token save.

| Domain        | Live source(s)                                            | Fallback |
|---------------|-----------------------------------------------------------|----------|
| Quote/Price/History | Yahoo Finance (tokenless, delayed ~15–20m)          | seeded `generateBars` (parity-safe) |
| Fundamentals  | Alpha Vantage `OVERVIEW` (keyed)                         | seeded `fundamental_data` |
| Sentiment/News| Finnhub `company-news` (free key)                        | seeded headlines (no social mock) |
| Options chain | **Massive/Polygon** (`/v3/snapshot/options/{ticker}`, Bearer) when entitled | **CBOE free delayed feed** (`cdn.cboe.com/.../{TICKER}.json`, no key) → then seeded |
| Risk-free rate| `api.fiscaldata.treasury.gov` (tokenless)               | constant |

**Key facts the user has corrected us on (do not re-break):**
- The options **greeks** come from CBOE's feed (Δ/Γ/ν/Θ/ρ) when present, else are
  re-derived by `bsGreeks()` in `src/registry/logic/greeks.ts` from the contract
  IV. CBOE's `iv` is a **decimal already** (0.77 = 77%) — do NOT divide by 100.
- The option-chain **spot** must come from CBOE `current_price` (real underlying),
  NOT a median-strike heuristic. Wrong spot → delta pins to ±1.0 (the historical
  bug).
- The options endpoint targets **`api.massive.com`**, NOT `api.polygon.io`
  (Massive = the user's key provider). Runtime endpoints, the `[Test]` probe
  (`/v3/reference/dividends`, ticker-independent, Bearer), and
  `DEFAULT_SOURCE_URIS` all use `api.massive.com`.
- Yahoo's crumb/quote endpoint is currently returning **429** — it is a dead
  fallback; do not "fix" options by routing to Yahoo. CBOE is the real free feed.
- Non-credentialed sources (Treasury RFR) are intentionally **excluded** from the
  credentialed-sources Settings UI — keep them hardcoded/backend-configured, not
  shown as token-entry fields.

## 5. Semantic-honesty bar (UI badges / notes / banners)

The user treats a **status badge that contradicts the underlying data as a BUG**.
Rules:
- Gate the "MOCK — no live source" banner on `dataHealth.sourcesOk > 0` (shows
  only when genuinely zero live sources), not on a hardcoded condition.
- A "skipped"/"MOCK" label must not appear when a live probe actually passed.
- Source badges: `LIVE` (near real-time, Polygon/Massive entitled), `DELAYED`
  (CBOE/Yahoo tokenless real, delayed), `MOCK` (synthetic only).
- Side-pane / trace notes must be derived from provenance (`live|proxy|seeded`
  per ticker via `data_source`), never hardcoded. "seeded fallback" wording is
  fine when data is genuinely seeded — only a FALSE mock claim is the bug.
- The visible MOCK warning is styled **small + orange** (`.quote-warn` in
  `frontend/src/index.css`: `font-size:.8rem; color:#f59e0b`). Keep it that way.

## 6. Validation culture (the user verifies by eyeballing the running UI)

- After a UI/data fix, **actually deploy (§2) and check the running app**, don't
  just read code. The user reports bugs as UX symptoms and expects end-to-end
  working behavior.
- Prefer validating against the **real provider** (live `curl` / engine probe)
  over code-reading. E.g. greeks were validated by comparing `bsGreeks()` against
  real CBOE greeks on ~700 contracts (delta mean err 0.008, p95 0.022) — see
  `src/tests/greeks-cboe-parity.test.ts`.
- Settings edits must render **LIVE immediately** (re-fetch + re-render), not
  behind a "next run" hint.

## 7. Known TypeScript baseline (don't chase these)

`npx tsc --noEmit` has a small set of **pre-existing** errors that are NOT yours
to fix unless explicitly asked:
- `src/registry/logic/hist.ts:424-425` (mock-generator baseline).
- occasional `payload: never` in `generic-analyst.node.ts` (legacy).
These are expected; a clean `tsc` here means "only the known baselines remain,"
not "zero errors."

## 8. Self-documenting UIs the user expects

- Long async ops (Screener 30–40s, analysis runs) must show a **live running
  timer / progress**, not a frozen label.
- Tables get a **field legend** per column (Promise / Tech / Sent / Mom / Verdict).
- Loading states show real progress; never a spinner that hides what's happening.

## 9. Testing conventions the user enforces

- **Phased, test-gated delivery**: build one phase (with unit tests), stop for the
  user to verify, wait for "proceed" before the next. Do NOT barrel through.
- **GIT**: do not commit until the user has run the tests. Leave changes in the
  working tree between phases. Respect BLOCKED on destructive commands (leave
  artifacts if declined).
- Live-network tests must **skip cleanly offline** (use `RUN_LIVE_CBOE=1` style
  env flags; the global `src/tests/setup.ts` stubs `fetch` to reject unless that
  flag is set). The fixture-based parity test (`greeks-cboe-parity.test.ts`) is
  always-on and uses `src/tests/fixtures/cboe-nvda-greeks.json` (a captured real
  CBOE sample).
- Deterministic fixtures beat live fetches in CI.

## 10. Tooling decision — Graphify (codebase knowledge graph for LLM context)

**Decision: ADOPT AS AN AID (pilot recommended), NOT a substitute for the
conventions in this file.** Status: verified-facts captured below; do a
time-boxed pilot before relying on it.

**What Graphify is** (site: `https://graphify.com/`, GitHub `Graphify-Labs/
graphify` — *verified 2026-07-17*): an **open-source, on-device, MIT-licensed**
codebase knowledge graph for AI coding assistants. It statically parses the
repo (on-device **tree-sitter across 36 languages**, so TypeScript + React/TSX
are fully covered), builds a typed entity/relationship graph, and writes
`graph.json` into the repo. An LLM agent then queries the graph over an **MCP
server** or the **CLI** (`graphify query`, `graphify.serve`) instead of
grepping/dumping whole files — retrieving only the **relevant subgraph** for a
task and tracing every answer to a real file+line. Installs as a **skill in 17
assistants** (Claude Code, Cursor, Copilot, Codex, Gemini CLI, Aider, …) plus an
MCP server; PyPI package is **`graphifyy`** (two y's).

**Directly answers the earlier open questions (now verified, not assumed):**
- **Offline / no exfiltration — SAFE for this repo.** Marketing: *"Every hosted
  indexer asks you to ship your repo to someone else's cloud first. Graphify
  doesn't, because it can't: there is no server in the loop."* Parsing runs
  locally, no telemetry, code stays on your machine. The encrypted credential
  vault in this repo is never sent anywhere. ✔
- **Language support — YES.** 36 languages incl. TS/TSX. ✔
- **Integration — MCP + CLI + skill.** Drop the MCP server into the coding
  assistant; `/graphify .` indexes; `graphify query` retrieves. ✔

**Why it helps HERE:**
- This repo is large (backend `src/` + a mirrored frontend `analysts.ts`,
  60+ backend test files, 322 frontend tests). An agent orienting on a task
  currently reads many files; subgraph retrieval ("show everything touching
  `resolveLiveOptionsBundle`") cuts that dramatically.
- The frontend **mirrors** the backend registry (`frontend/src/components/
  analysts/{agencies,analysts}.ts` duplicate `src/registry/`) — a known drift
  risk guarded by `agency-mirror.test.ts`. A code graph makes cross-tree impact
  analysis trivial.

**Token-saving claims (VENDOR claims from the site — not independently
benchmarked on this repo):** the site advertises *"Cut Your Claude Token
Consumption By 70x"* and a *"79× Token Reduction, Zero Vector Database"*
(MemMachine) case study. Treat these as marketing upper bounds; measure on our
own tasks before quoting them.

**PILOT RUN — EXECUTED 2026-07-17 (results below).** Index the codebase with the
repo's npm script (output goes to `.graphify/`, honored via `GRAPHIFY_OUT`):
```bash
pip install "graphifyy[mcp]"     # one-time; the [mcp] extra is REQUIRED to run the server
npm run graphify                 # code-only AST extract + cluster → .graphify/
# include the 16 Markdown docs too (needs an LLM key, see caveat below):
npm run graphify:docs
```
The repo already ships a working `.mcp.json` (points at `.graphify/graph.json`
via `python -m graphify.serve`). To let the agent query the graph, either use
that file or run `graphify install` to auto-wire 17 assistants. NOTE: the
`.mcp.json` here hardcodes this sandbox's venv path (`/tmp/gf-venv/bin/python`);
on the deploy host, change it to the host's `python` (with `graphifyy[mcp]`
installed) or run `graphify install`.
```json
{ "mcpServers": { "graphify": { "command": "python",
    "args": ["-m", "graphify.serve", ".graphify/graph.json"] } } }
```
(the `graphify install` skill auto-wires 17 assistants instead).
- **Result:** 1684 nodes / 3994 edges / 84 communities over 242 code files
  (`.graphify/graph.json`, ~2.0 MB; `.graphify/GRAPH_REPORT.md` + graph.html
  generated). `explain resolveLiveOptionsBundle` returns file+line + traced
  connections in ~179 tokens; reading the whole ~1.8 MB / ~462k-token code
  corpus to orient is the alternative — a **~2500× orientation saving** on that
  task. `query` and `affected` (reverse-impact) traversals work and make the
  frontend/backend registry-drift analysis trivial.
- **Docs caveat (verified):** `--code-only` (used by `npm run graphify`) skips
  the 16 Markdown docs — Graphify needs an LLM key (or a local Ollama /
  OpenAI-compatible endpoint) to *semantically* extract docs. With no key set,
  `npm run graphify:docs` will still skip them and ask for a key
  (`GOOGLE_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`, or
  `OPENAI_BASE_URL` + `OPENAI_MODEL` for a self-hosted model). Code-only
  indexing needs no key and is the token-saving core.
- **Git:** `.graphify/` is gitignored by default. Graphify's own docs say
  `graph.json` + `GRAPH_REPORT.md` are *meant to be committed* so teammates skip
  re-indexing; the `cache/` dir and `graph.html` visualizer are regenerable.
  Un-ignore those two files if you want the shareable graph in git.
- Keep the human-written conventions in this file as the **source of truth** —
  the graph retrieves files; it does NOT encode the deploy/credential/honesty
  rules in §1–§9.

> Note: the *original* `Graphify-Labs/graphify` GitHub org referenced earlier
> may redirect to the current product (graphify.com / `graphifyy`). The
> capability is the same: static code graph → subgraph retrieval → fewer tokens.
> Confirm the exact install command from the live docs (`/docs/mcp-tools`) when
> piloting.

## 11. Documentation index (source of truth)

- `README.md` — project overview, config, request/response contract, phased plan.
- `docs/README.md` — overview + doc map.
- `docs/ARCHITECTURE.md` — LangGraph DAG, Socket.IO + SPA flow, node responsibilities.
- `docs/KNOWN_ISSUES.md` — current limitations + integration roadmap.
- `docs/EXTENDING_ANALYSTS.md` — add an analyst/agency.
- `docs/SCREENER_STANDARDS.md` — Screener selection standards.
- `docs/SETUP.md` — install/run/config.
- `docs/MULTI_SOURCE_ARCHITECTURE.md` — vendor-agnostic multi-source plan (data domains + adapters + fan-in/weighting; phased rework NOT yet scheduled).
- `docs/archive/` — superseded design docs (historical only).
- `docs/openapi.json` — REST API spec (served live at `/api-docs`).

**Keep docs in sync with code.** When you change behavior, update the relevant
doc + add a phased-plan row in `README.md` before declaring the task done.

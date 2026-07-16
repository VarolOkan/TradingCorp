# Setup & Usage

## Prerequisites

- Node.js 18+ (developed on Node 22). The back-end depends on Socket.IO 4,
  LangGraph 0.2; the front-end on React 18 + Vite 5 + Tailwind 3.
- npm
- The server runs TypeScript directly via `tsx` (a devDependency). The front-end
  is built with Vite; no separate Next.js build step exists anymore.

## Install

```bash
cd TradingCorp
npm install
```

`npm install` pulls the runtime deps (`express`, `socket.io`, `langgraph`,
`react`, `d3`, …) and dev deps (`vite`, `@vitejs/plugin-react`, `vitest`,
`@testing-library/*`, `jest`, `ts-jest`, `@vitest/coverage-v8`, `tailwindcss`,
`postcss`, `autoprefixer`, `tsx`, …).

## Configuration

Configuration is env-driven via `dotenv` (`src/config.ts` reads `.env` from the
project root). All values have sensible defaults — `.env` is optional.

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3001` | Port for the Socket.IO/Express server |
| `HOST` | `localhost` | Display name in logs |
| `SOCKET_ORIGIN` | `http://localhost:3000,http://localhost:3001,http://localhost:5173` | Allowed CORS origins for Socket.IO (comma-separated list, or `*` for any). Defaults already include the Vite dev origin `:5173`. |
| `DEFAULT_ANALYSIS_DEPTH` | `STANDARD` | `QUICK` \| `STANDARD` \| `DEEP` |
| `DEFAULT_TIME_HORIZON` | `MEDIUM_TERM` | `SHORT_TERM` \| `MEDIUM_TERM` \| `LONG_TERM` |
| `DEFAULT_RISK_TOLERANCE` | `MODERATE` | `CONSERVATIVE` \| `MODERATE` \| `AGGRESSIVE` |
| `LOG_LEVEL` | `info` | Logger verbosity |
| `ALPHA_VANTAGE_API_KEY` | *(empty)* | Reserved for future data-source integration |

Copy the template to get started:

```bash
cp .env.example .env
```

## Running

One command (recommended for local dev):

```bash
npm run dev:all      # concurrently starts the backend (:3001) AND the Vite dev server (:5173)
```

Or two terminals:

```bash
# Terminal A — real-time analysis server (Socket.IO on :3001)
npm run server          # runs `tsx src/server/index.ts`
                          # (also serves frontend/dist when a build exists)

# Terminal B — Vite front-end dev server (on :5173, proxies /socket.io & /config to :3001)
npm run dev             # or: npm run build && npm run server
```

> IMPORTANT: the front-end dev server proxies `/socket.io`, `/config` and
> `/api` to `http://localhost:3001`, so the browser only ever talks to the Vite
> origin (`:5173`). If the Socket.IO server is not running, the browser console
> shows `GET http://localhost:5173/socket.io ... 404 (Not Found)` — that 404 is a
> *symptom* of the backend being down, not a client bug.

Other scripts (`package.json`):

| Script | Command | Notes |
|--------|---------|-------|
| `npm run dev:all` | `concurrently "npm run server" "npm run dev"` | Starts backend + Vite dev server together |
| `npm run dev` | `vite --config vite.config.ts` | Vite dev server on :5173 (proxies to :3001) |
| `npm run build` | `vite build --config vite.config.ts` | Builds the SPA to `frontend/dist` |
| `npm run start` | `npm run build && npm run server` | Build SPA, then launch backend (serves `frontend/dist`) |
| `npm run server` | `tsx src/server/index.ts` | Socket.IO + Express analysis server |
| `npm run server:watch` | `tsx watch src/server/index.ts` | Auto-restart on change |
| `npm test` | `npm run test:server && npm run test:ui` | **Backend (jest + coverage) then front-end (vitest + coverage)** |
| `npm run test:server` | `jest --coverage` | Backend suite + `coverage/` report |
| `npm run test:ui` | `vitest run --coverage --config vite.config.ts` | Front-end suite + `coverage-ui/` report |
| `npm run lint` | `eslint src --ext .ts,.tsx` | Lint (requires eslint config) |

> NOTE: the `main` field in `package.json` points at `src/server/index.ts`
> (TypeScript). Always start the backend with `npm run server` (tsx), not by
> requiring a compiled `main`.

## Type-check

```bash
npx tsc --noEmit      # backend, passes clean
```

The front-end is type-checked by Vite/Vitest via `tsconfig.frontend.json`
(bundler resolution); no separate `tsc` step is needed for the SPA.

## Tests (with coverage)

```bash
npm test              # backend jest (10 suites, 70 tests) + front-end vitest (14 files, ~99 tests)
```

- Backend tests live in `src/tests/*.test.ts` and cover each node's
  parsing/processing logic plus the config routes and the streaming
  `analysis_complete` (including the `analystTraces` drill-down payload).
  Coverage report → `coverage/`.
- Front-end tests live in `frontend/src/test/*.test.ts(x)`. Coverage report →
  `coverage-ui/`.
- Run a single layer with `npm run test:server` or `npm run test:ui`.

/// <reference types="vitest/config" />
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Vite config for the TradingCorp React SPA.
// - Dev server proxies /socket.io and /config to the Express backend.
//   The backend port is taken from PORT (server side) or VITE_SERVER_PORT
//   (here) and defaults to 3001. To run on a different port, start BOTH with
//   the same value, e.g.:
//     PORT=8091 npm run server        # backend on 8091
//     VITE_SERVER_PORT=8091 npm run dev  # dev server proxies to 8091
//   (or just `PORT=8091 npm run dev:all` — the script forwards PORT to the
//   backend and VITE_SERVER_PORT to Vite.)
//   so the browser only ever talks to the Vite dev origin.
// - `base: './'` so the production build is servable from any sub-path by Express.
// Backend port: server reads env PORT; here we read VITE_SERVER_PORT, falling
// back to PORT, then to the 3001 default. One env var controls the whole stack.
const backendPort = process.env.VITE_SERVER_PORT || process.env.PORT || '3001';
const backendTarget = `http://localhost:${backendPort}`;
export default defineConfig({
  // The SPA source lives in ./frontend; Vite reads index.html from here.
  root: 'frontend',
  plugins: [react()],
  base: './',
  server: {
    port: 5173,
    // Bind all interfaces so the dev site is reachable via the LAN IP (e.g.
    // http://10.9.200.188:5173), not just localhost. Pairs with the backend
    // binding 0.0.0.0 when HOST is set to a specific address.
    host: true,
    proxy: {
      '/socket.io': {
        target: backendTarget,
        ws: true,
        changeOrigin: true,
      },
      '/config': {
        target: backendTarget,
        changeOrigin: true,
      },
      '/api': {
        target: backendTarget,
        changeOrigin: true,
      },
      // Phase F/G API routes that don't share the /config or /api prefix:
      //   /llm-config (+ /llm-config/status), /analyst-flavors, /analyst-params,
      //   /analyst-config, /health. Without these, SettingsDialog's LLM tab and
      //   the per-analyst flavor/source dialogs fetch the SPA HTML from Vite
      //   (which returns no JSON) and render empty in dev.
      '/llm-config': { target: backendTarget, changeOrigin: true },
      '/analyst-flavors': { target: backendTarget, changeOrigin: true },
      '/analyst-params': { target: backendTarget, changeOrigin: true },
      '/analyst-config': { target: backendTarget, changeOrigin: true },
      '/health': { target: backendTarget, changeOrigin: true },
      // Phase I: symbol → company name + basic market data.
      '/quote': { target: backendTarget, changeOrigin: true },
      // Phase I: historical OHLCV price bars (equity + underlying).
      '/history': { target: backendTarget, changeOrigin: true },
      // Phase I: options historical chains (Polygon). Mock fallback when no key.
      '/options-history': { target: backendTarget, changeOrigin: true },
      // Phase J: live server-log tail for the Settings → Server Log tab. Without
      // this, the tab fetches the SPA HTML from Vite (returns no log text).
      '/server-log': { target: backendTarget, changeOrigin: true },
      // Phase C: report export (POST /reports, GET /reports/*).
      '/reports': { target: backendTarget, changeOrigin: true },
      // Phase 1: per-user agency re-org + agency CRUD (GET/PUT/POST/DELETE
      // /registry and /registry/agency/*). Without this, the re-org dialog
      // and the Settings → Agencies tab fetch the SPA HTML from Vite
      // (returns no JSON) and throw "Unexpected token '<'".
      '/registry': { target: backendTarget, changeOrigin: true },
      // API docs (Swagger UI at /api-docs + spec at /api-docs/openapi.json).
      // The "View API docs" button opens the SAME-ORIGIN path /api-docs/ (so it
      // goes through Vite in dev, which proxies here), instead of the Settings
      // Backend URI — that URI is often a bare localhost:3001 or a LAN host the
      // browser can't reach, which produced "This site can't be reached".
      '/api-docs': { target: backendTarget, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  test: {
    // Use the forks pool: the threads pool deadlocks on useAnalystRun.test.ts
    // (the worker never returns, hanging the whole frontend suite). Forks is
    // reliable here and only marginally slower for this project's size.
    pool: 'forks',
    environment: 'jsdom',
    globals: true,
    setupFiles: './frontend/src/test/setup.ts',
    css: true,
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage-ui',
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.test.{ts,tsx}',
        'src/test/**',
        'src/main.tsx',
        'src/**/*.d.ts',
      ],
      reporter: ['text', 'text-summary', 'lcov'],
    },
  },
});

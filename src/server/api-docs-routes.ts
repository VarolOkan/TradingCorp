// src/server/api-docs-routes.ts
// Serves the OpenAPI spec + a self-contained Swagger UI page so the REST API
// can be browsed from the frontend (Settings → Connection → "View API docs").
//
//   GET /api-docs           -> Swagger UI HTML (loads swagger-ui from a CDN,
//                              points at /api-docs/openapi.json).
//   GET /api-docs/openapi.json -> the raw OpenAPI 3.0 document (docs/openapi.json).
//
// The spec file is authored by hand at docs/openapi.json (kept in sync with the
// route handlers). No extra npm dependency: Swagger UI is pulled from the public
// unpkg CDN by the browser, and the JSON is read straight off disk.

import type { Express } from 'express';
import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';

// Resolve docs/openapi.json relative to the compiled/tsx source location.
// __dirname is src/server (tsx) or dist/server (build); docs/ sits at repo root.
function specPath(): string {
  const candidates = [
    path.join(__dirname, '..', '..', 'docs', 'openapi.json'),
    path.join(process.cwd(), 'docs', 'openapi.json'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0]!;
}

const SWAGGER_HTML = `<!doctype html>
<html lang="en" class="dark-mode">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Financial Analysis Pipeline — API docs</title>
    <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
    <style>
      /* Swagger UI v5 ships a maintained dark theme, activated by the
         html.dark-mode class (252 dark-mode rules in swagger-ui.css that cover
         the info block, servers dropdown + label, opblock cards, endpoint paths,
         and collapse arrows). We enable it and set color-scheme so native form
         controls (the server <select>, scrollbars) also go dark. A few small
         overrides handle elements v5 leaves at a low-contrast grey. */
      :root { color-scheme: dark; }
      html.dark-mode { background: #1c2022; }
      html.dark-mode body {
        margin: 0;
        background: #1c2022;
        color: #e2e8f0;
      }
      /* Hide the redundant swagger-ui top bar (logo) — keeps the page clean. */
      html.dark-mode .swagger-ui .topbar { display: none; }
      /* v5 leaves the collapse arrows at a dim grey (#b7bcbf); bump them so they
         read clearly on the dark opblock / models cards. */
      html.dark-mode .swagger-ui .opblock-control-arrow svg,
      html.dark-mode .swagger-ui .model-box-control svg,
      html.dark-mode .swagger-ui .models-control svg { fill: #e2e8f0 !important; }
      /* The servers <select> + computed-url code chip use native rendering;
         force them dark so they don't pop as white-on-dark. */
      html.dark-mode .swagger-ui .servers select,
      html.dark-mode .swagger-ui select,
      html.dark-mode .swagger-ui input[type="text"],
      html.dark-mode .swagger-ui textarea,
      html.dark-mode .swagger-ui .servers .computed-url code {
        background: #1c2022 !important;
        color: #e2e8f0 !important;
        border: 1px solid #3b4858 !important;
      }
      ::-webkit-scrollbar { width: 10px; height: 10px; }
      ::-webkit-scrollbar-track { background: #1c2022; }
      ::-webkit-scrollbar-thumb { background: #3b4858; border-radius: 6px; }
    </style>
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js" crossorigin></script>
    <script>
      window.onload = function () {
        window.ui = SwaggerUIBundle({
          url: '/api-docs/openapi.json',
          dom_id: '#swagger-ui',
          deepLinking: true,
          presets: [SwaggerUIBundle.presets.apis],
          layout: 'BaseLayout',
        });
      };
    </script>
  </body>
</html>`;

export function registerApiDocsRoutes(app: Express): void {
  // Raw OpenAPI document.
  app.get('/api-docs/openapi.json', (_req, res) => {
    try {
      const raw = fs.readFileSync(specPath(), 'utf8');
      res.type('application/json').send(raw);
    } catch (e) {
      res
        .status(500)
        .json({ error: `openapi spec unavailable: ${(e as Error).message}` });
    }
  });

  // Swagger UI page — served on both /api-docs and /api-docs/ (Express
  // non-strict routing treats them the same; serve HTML directly rather than
  // redirecting, which would loop). The spec URL is absolute so it resolves
  // regardless of the trailing slash.
  app.get('/api-docs', (_req, res) => {
    res.type('text/html').send(SWAGGER_HTML);
  });

  logger.info('API docs available at /api-docs');
}

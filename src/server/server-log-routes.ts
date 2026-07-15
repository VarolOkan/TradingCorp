// src/server/server-log-routes.ts
// GET /server-log?lines=200 -> last N lines of the persistent server log file.
// Lets the frontend Settings dialog show live server traces (LLM calls, etc.).
import type { Express } from 'express';
import fs from 'fs';
import { LOG_FILE_PATH } from '../utils/logger';

function tailFile(filePath: string, lines: number): string {
  if (!fs.existsSync(filePath)) return '(no log file yet)';
  const buf = fs.readFileSync(filePath);
  const text = buf.toString('utf8');
  const all = text.split(/\n/);
  // Drop a trailing empty entry if present.
  if (all.length && all[all.length - 1] === '') all.pop();
  return all.slice(Math.max(0, all.length - lines)).join('\n');
}

export function registerServerLogRoutes(app: Express): void {
  app.get('/server-log', (req, res) => {
    try {
      const lines = Math.min(2000, Math.max(1, Number(req.query.lines) || 200));
      const content = tailFile(LOG_FILE_PATH, lines);
      res.type('text/plain').send(content);
    } catch (e) {
      res.status(500).type('text/plain').send(`(error reading log: ${(e as Error).message})`);
    }
  });
}

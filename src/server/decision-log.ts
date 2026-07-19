// src/server/decision-log.ts
// Phase 2 (persistent decision log + realised-return feedback).
//
// Append-only JSONL store of completed-run decision records. Pure module: no
// server, no SQLite, no network — mirrors the proven RegistryJsonStore file
// pattern so it is fully unit-testable and hermetic (path overridable via
// DECISION_LOG_PATH). Every run appends one record; on the next run for the
// same ticker the realised return (vs SPY) is recomputed and a reflection is
// generated (see src/registry/logic/governance.ts).
import fs from 'fs';
import os from 'os';
import path from 'path';

export interface DecisionRecord {
  /** ISO timestamp of when the run completed. */
  ts: string;
  /** Tickers analysed in this run. */
  tickers: string[];
  /** Agency id (e.g. 'long-term'). */
  agencyId: string;
  /** Final decision for the run (APPROVE | REJECT | ERROR). */
  decision: 'APPROVE' | 'REJECT' | 'ERROR';
  /** Governance confidence 0-100, or null when not produced. */
  confidence: number | null;
  /** Net Bull/Bear debate lean (BULLISH | BEARISH | BALANCED), if the debate ran. */
  debateLean?: 'BULLISH' | 'BEARISH' | 'BALANCED' | null;
  /** Per-analyst verdicts at decision time (illustrative / seeded OK). */
  verdicts?: { fundamental?: string; technical?: string; sentiment?: string };
  /** Ingested price at decision time, keyed by ticker (honest `asOf`). */
  prices?: Record<string, number>;
  /** SPY price at decision time (enables alpha computation on the next run). */
  spyPrice?: number;
  /** Realised return % vs entry, filled in on a LATER run when recomputed. */
  realizedReturn?: number | null;
  /** Alpha vs SPY %, filled in on a later run when recomputed. */
  alphaVsSpy?: number | null;
  /** One-paragraph reflection generated on the next run (if any). */
  reflection?: string;
  /** Free-form note (e.g. why the record is partial). */
  note?: string;
}

function defaultLogPath(): string {
  const override = process.env.DECISION_LOG_PATH;
  if (override) return override;
  return path.join(os.homedir(), '.tradingcorp', 'decision-log.jsonl');
}

function ensureFile(filePath: string): void {
  const dir = path.dirname(filePath);
  if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, '', { flag: 'a' });
}

/** Append a decision record as one JSON line. Returns the stored record. */
export function appendDecision(record: DecisionRecord, filePath: string = defaultLogPath()): DecisionRecord {
  ensureFile(filePath);
  fs.appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf8');
  return record;
}

function readAll(filePath: string): DecisionRecord[] {
  if (!fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, 'utf8');
  const out: DecisionRecord[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as DecisionRecord);
    } catch {
      // Skip malformed lines rather than crash the caller.
    }
  }
  return out;
}

/** Most recent `n` records for a ticker (newest last). */
export function getLastForTicker(ticker: string, n = 1, filePath: string = defaultLogPath()): DecisionRecord[] {
  const matches = readAll(filePath).filter((r) => Array.isArray(r.tickers) && r.tickers.includes(ticker));
  return matches.slice(-Math.max(1, n));
}

/** Most recent records across all tickers, optionally excluding one ticker.
 *  Capped at `limit`; newest first. */
export function getRecentLessons(limit = 5, excludeTicker?: string, filePath: string = defaultLogPath()): DecisionRecord[] {
  let all = readAll(filePath);
  if (excludeTicker) all = all.filter((r) => !Array.isArray(r.tickers) || !r.tickers.includes(excludeTicker));
  return all.slice(-limit).reverse();
}

/** Realised return % from an entry price to a current price. Null if undefined. */
export function computeRealizedReturn(entryPrice: number | undefined, currentPrice: number | undefined): number | null {
  if (typeof entryPrice !== 'number' || typeof currentPrice !== 'number' || entryPrice === 0) return null;
  return ((currentPrice - entryPrice) / entryPrice) * 100;
}

/** Alpha vs SPY: asset return minus SPY return (both %). Null if undefined. */
export function computeAlphaVsSpy(assetReturn: number | null, spyReturn: number | null): number | null {
  if (assetReturn == null || spyReturn == null) return null;
  return assetReturn - spyReturn;
}

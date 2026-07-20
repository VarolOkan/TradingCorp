// src/utils/logger.ts
// Simple logging utility for the financial analysis pipeline.
//
// Logs to the console AND, when LOG_FILE is set (or by default to ./logs/server.log),
// to a rotating file so server-side traces survive (no log file existed before).
// DEBUG-level traces are always captured to the file; the console honors LOG_LEVEL.

import fs from 'fs';
import path from 'path';
import { config } from '../config';

/** Log levels */
export const LogLevel = {
  ERROR: 0,
  WARN: 1,
  INFO: 2,
  DEBUG: 3,
};

// Resolve the log file path. Default: ./logs/server.log next to cwd.
let LOG_FILE = process.env.LOG_FILE || path.join(process.cwd(), 'logs', 'server.log');
/**
 * Override the resolved log file path at runtime. Used by tests to point the
 * logger at an isolated temp file without re-importing modules under
 * jest.isolateModules (which segfaults under the parallel worker pool). The
 * shared logger instance also redirects here so file output stays consistent.
 */
export function setLogFile(p: string): void {
  LOG_FILE = p;
  // Re-open the write stream against the new path.
  if (logFh) { try { logFh.end(); } catch { /* ignore */ } logFh = null; }
}
let logFh: fs.WriteStream | null = null;
function ensureLogFh(): fs.WriteStream | null {
  if (logFh === null) {
    try {
      fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
      logFh = fs.createWriteStream(LOG_FILE, { flags: 'a' });
    } catch {
      logFh = null; // file logging best-effort; console still works
    }
  }
  return logFh;
}

/**
 * Logger class
 */
export class Logger {
  private level: number;

  constructor(level: string = config.logLevel) {
    this.level = this.getLevelFromString(level);
  }

  /** Convert string log level to numeric value */
  private getLevelFromString(level: string): number {
    switch (level.toUpperCase()) {
      case 'ERROR': return LogLevel.ERROR;
      case 'WARN': return LogLevel.WARN;
      case 'INFO': return LogLevel.INFO;
      case 'DEBUG': return LogLevel.DEBUG;
      default: return LogLevel.INFO;
    }
  }

  /** Check if a log level is enabled */
  private isLevelEnabled(level: number): boolean {
    return level <= this.level;
  }

  /** Append a line to the log file (always, including DEBUG). */
  private toFile(line: string): void {
    const fh = ensureLogFh();
    if (fh) {
      try { fh.write(line + '\n'); } catch { /* ignore */ }
    }
  }

  /** Log an error message */
  error(message: string, ...meta: any[]): void {
    const ts = new Date().toISOString();
    const line = `[ERROR] ${ts} - ${message}`;
    if (this.isLevelEnabled(LogLevel.ERROR)) {
      console.error(line, ...meta);
    }
    this.toFile(line + (meta.length ? ' ' + safeMeta(meta) : ''));
  }

  /** Log a warning message */
  warn(message: string, ...meta: any[]): void {
    const ts = new Date().toISOString();
    const line = `[WARN] ${ts} - ${message}`;
    if (this.isLevelEnabled(LogLevel.WARN)) {
      console.warn(line, ...meta);
    }
    this.toFile(line + (meta.length ? ' ' + safeMeta(meta) : ''));
  }

  /** Log an info message */
  info(message: string, ...meta: any[]): void {
    const ts = new Date().toISOString();
    const line = `[INFO] ${ts} - ${message}`;
    if (this.isLevelEnabled(LogLevel.INFO)) {
      console.log(line, ...meta);
    }
    this.toFile(line + (meta.length ? ' ' + safeMeta(meta) : ''));
  }

  /** Log a debug message */
  debug(message: string, ...meta: any[]): void {
    const ts = new Date().toISOString();
    const line = `[DEBUG] ${ts} - ${message}`;
    // Console honors the level; the file always gets DEBUG traces.
    if (this.isLevelEnabled(LogLevel.DEBUG)) {
      console.log(line, ...meta);
    }
    this.toFile(line + (meta.length ? ' ' + safeMeta(meta) : ''));
  }
}

function safeMeta(meta: any[]): string {
  try {
    return JSON.stringify(meta, (_k, v) => (typeof v === 'string' && v.length > 500 ? v.slice(0, 500) + '…' : v));
  } catch {
    return '[unserializable]';
  }
}

// Export a default logger instance
export const logger = new Logger();
/** Current resolved log file path (mutable via setLogFile). */
export const LOG_FILE_PATH = LOG_FILE;
/** Read the current resolved log file path (reflects setLogFile changes). */
export function getLogFile(): string {
  return LOG_FILE;
}

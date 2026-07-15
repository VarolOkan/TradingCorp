// frontend/src/lib/watchlist.ts
// Phase 7 (Watchlist / Portfolio): persistent "my tickers" backed by
// localStorage, with a tiny pub/sub so every consumer (the WatchlistBar and
// the per-card star toggle) stays in sync without prop-drilling.
//
// SSR-safe: in a non-browser env (tests without jsdom, SSR) we fall back to an
// in-memory store so nothing throws.
import { useEffect, useState, useCallback } from 'react';

const STORAGE_KEY = 'fap:watchlist';

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

let memoryStore: string[] = [];

function readRaw(): string[] {
  if (!isBrowser()) return memoryStore;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function writeRaw(list: string[]): void {
  if (!isBrowser()) {
    memoryStore = [...list];
    return;
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    /* quota / disabled storage — keep in-memory only */
  }
}

// Module-level listener set so multiple hooks render-reactively off one store.
const listeners = new Set<() => void>();

function normalize(sym: string): string {
  return sym.trim().toUpperCase();
}

function emit(): void {
  listeners.forEach((fn) => fn());
}

export function getWatchlist(): string[] {
  return readRaw();
}

export function isWatched(symbol: string): boolean {
  return readRaw().includes(normalize(symbol));
}

export function toggleWatch(symbol: string): boolean {
  const sym = normalize(symbol);
  if (!sym) return false;
  const current = readRaw();
  const next = current.includes(sym) ? current.filter((s) => s !== sym) : [...current, sym];
  writeRaw(next);
  emit();
  return next.includes(sym);
}

export function addWatch(symbol: string): void {
  const sym = normalize(symbol);
  if (!sym || isWatched(sym)) return;
  writeRaw([...readRaw(), sym]);
  emit();
}

export function removeWatch(symbol: string): void {
  const sym = normalize(symbol);
  if (!isWatched(sym)) return;
  writeRaw(readRaw().filter((s) => s !== sym));
  emit();
}

/**
 * Reactive watchlist hook. Returns the current list plus toggle/add/remove
 * actions. Re-renders the consumer whenever ANY watchlist mutation happens
 * (including from another component), so the WatchlistBar and card stars stay
 * consistent.
 */
export function useWatchlist(): {
  symbols: string[];
  isWatched: (s: string) => boolean;
  toggle: (s: string) => boolean;
  add: (s: string) => void;
  remove: (s: string) => void;
} {
  const [symbols, setSymbols] = useState<string[]>(() => readRaw());

  useEffect(() => {
    const sync = () => setSymbols(readRaw());
    listeners.add(sync);
    // hydrate in case another tab/storage changed underneath us
    sync();
    return () => {
      listeners.delete(sync);
    };
  }, []);

  const toggle = useCallback((s: string) => toggleWatch(s), []);
  const add = useCallback((s: string) => addWatch(s), []);
  const remove = useCallback((s: string) => removeWatch(s), []);

  return { symbols, isWatched: (s) => symbols.includes(normalize(s)), toggle, add, remove };
}

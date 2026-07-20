// frontend/src/lib/uiPrefs.ts
// Frontend-only UI preferences (like the watchlist store). These are display
// preferences that don't belong to the backend ConnectionSettings model — they
// are persisted to localStorage so they survive reloads and are applied on the
// next render without a server round-trip.

const PAGE_MAX_WIDTH_KEY = 'tc:pageMaxWidth';

/** Hard floor / ceiling so a bad value can't make the app unusable. */
export const PAGE_MAX_WIDTH_MIN = 320;
export const PAGE_MAX_WIDTH_MAX = 4000;
export const PAGE_MAX_WIDTH_DEFAULT = 960;

function clampPageMaxWidth(px: number): number {
  if (!Number.isFinite(px)) return PAGE_MAX_WIDTH_DEFAULT;
  return Math.min(PAGE_MAX_WIDTH_MAX, Math.max(PAGE_MAX_WIDTH_MIN, Math.round(px)));
}

function storageAvailable(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

/** Read the persisted page max-width (px). Falls back to 960. */
export function getPageMaxWidth(): number {
  if (!storageAvailable()) return PAGE_MAX_WIDTH_DEFAULT;
  const raw = window.localStorage.getItem(PAGE_MAX_WIDTH_KEY);
  if (raw == null) return PAGE_MAX_WIDTH_DEFAULT;
  const n = Number(raw);
  return Number.isFinite(n) ? clampPageMaxWidth(n) : PAGE_MAX_WIDTH_DEFAULT;
}

/** Persist the page max-width (px). Returns the clamped value actually stored. */
export function setPageMaxWidth(px: number): number {
  const clamped = clampPageMaxWidth(px);
  if (storageAvailable()) {
    try {
      window.localStorage.setItem(PAGE_MAX_WIDTH_KEY, String(clamped));
    } catch {
      /* storage full / blocked — non-fatal, in-memory state still applies */
    }
  }
  return clamped;
}

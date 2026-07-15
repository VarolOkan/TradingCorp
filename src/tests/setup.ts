// jest setup (setupFilesAfterEnv): makes live-source acquisition deterministic.
//
// The registry now declares credentialed REST dataSources (e.g. Yahoo, Alpha
// Vantage, Finnhub) so the per-card Settings panel can collect a token + URI.
// Those sources are "live" (isLiveSource === true), so acquireForAnalyst will
// call global.fetch at runtime. In tests we have no network, so we stub fetch to
// reject instantly — the engine takes its onError:'degrade' path and falls back
// to mock data. This keeps the parity/determinism tests fast and offline-stable
// while still exercising the real acquisition + degrade code path.

const noNetworkFetch = () =>
  Promise.reject(new Error('network disabled in test environment'));

if (typeof globalThis.fetch === 'undefined' || (globalThis as any).__mockFetch__) {
  // already replaced
} else {
  (globalThis as any).__mockFetch__ = true;
}

// Always install the rejection stub (overrides any real fetch in node env).
(globalThis as any).fetch = noNetworkFetch;

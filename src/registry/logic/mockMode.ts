// src/registry/logic/mockMode.ts
// Central gate for the "DISABLE_MOCK_DATA" global switch.
//
// When this is ON, the pipeline must NOT fabricate any data it does not have a
// real live source for. The default app ships with ZERO live sources configured
// (every analyst declares only `mock:`/seeded feeds), so turning this on means
// a run produces NO seeded numbers — only an honest "mock disabled, no live
// source" state. This is the user's explicit request: they do not want to be
// able to confuse fabricated ("purely imagination") data with real data.
//
// The single chokepoint is `seededRandom` in shared.ts — every seeded number
// (declarative features, fn-handler fallbacks, options bundles) funnels through
// it. When disabled it returns 0 for every draw, which makes every consumer
// collapse to its `?? 0` fallback and emit an empty/honest output.

import config from '../../config';

/** True when the DISABLE_MOCK_DATA env var is set (any non-empty value). */
export const MOCK_DISABLED: boolean = !!(
  process.env.DISABLE_MOCK_DATA && process.env.DISABLE_MOCK_DATA.length > 0
);

/** Honor an explicit runtime override too (so tests/config can flip it). */
let override: boolean | null = null;

export function setMockDisabled(v: boolean | null): void {
  override = v;
}

export function isMockDisabled(): boolean {
  if (override !== null) return override;
  return MOCK_DISABLED;
}

// Touch config so the import is meaningful and the env is read through the
// canonical config loader (dotenv already loaded by config.ts).
void config;

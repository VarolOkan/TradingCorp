// src/tests/netTestEnv.ts
// Shared helper for tests that REQUIRE outbound internet (live API probes).
//
// These tests are ENABLED BY DEFAULT. To skip them in environments without
// network access (offline CI, air-gapped hosts, sandboxes with egress blocked),
// set SKIP_NETWORK_TESTS=1 (or true / yes):
//
//   SKIP_NETWORK_TESTS=1 npm test
//
// The helpers mirror the jest `describe` / `it` signatures but, when the env
// var is set, silently downgrade to skipped tests (jest reports them as
// "skipped", not failed) so the rest of the suite still runs green.

const RAW = (process.env.SKIP_NETWORK_TESTS ?? '').trim().toLowerCase();
export const SKIP_NETWORK = RAW === '1' || RAW === 'true' || RAW === 'yes';

type DescribeFn = (name: string, fn: () => void) => void;
type ItFn = (name: string, fn?: any, timeout?: number) => void;

/** `describe` that skips its body when SKIP_NETWORK_TESTS is set. */
export const describeNet: DescribeFn = (name, fn) =>
  SKIP_NETWORK ? describe.skip(name, fn) : describe(name, fn);

/** `it` that skips when SKIP_NETWORK_TESTS is set. */
export const itNet: ItFn = (name, fn, timeout) =>
  SKIP_NETWORK ? it.skip(name, fn as any, timeout) : it(name, fn, timeout);

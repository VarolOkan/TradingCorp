// src/server/dataDir.ts
// Central resolution for the on-disk `.data` directory so it can be relocated
// via a single env var (DATA_DIR). This matters because multiple server
// instances sharing one cwd were stepping on each other's `llm-config.json`
// / `flavors.json` / `registry.db` (the cause of the recurring "model changed
// again" corruption). Pointing each instance at its own DATA_DIR isolates them.
//
// Precedence for a given store:
//   1. A store-specific override env (e.g. LLM_JSON_PATH, FLAVOR_STORE_PATH,
//      REGISTRY_STORE_DIR, LLM_SQLITE_PATH) — preserved for backwards compat.
//   2. DATA_DIR + the store's file name.
//   3. process.cwd()/.data + the store's file name (historical default).

import path from 'path';

/** The resolved `.data` directory (honors DATA_DIR). */
export function dataDir(): string {
  return process.env.DATA_DIR || path.join(process.cwd(), '.data');
}

/** A file path inside the resolved `.data` directory. */
export function dataFilePath(name: string): string {
  return path.join(dataDir(), name);
}

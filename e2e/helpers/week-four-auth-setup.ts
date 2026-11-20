import {execFileSync} from "node:child_process";
import path from "node:path";
import assert from "node:assert/strict";
import {E2E_DATA_DIR, assertE2EDataDirIsIsolated} from "./data-dir";
import {E2E_PORT} from "./e2e-target";

export default async function setup() {
  assertE2EDataDirIsIsolated();
  execFileSync(process.execPath, [path.resolve("node_modules/tsx/dist/cli.mjs"), "scripts/seed-demo.ts", "--force"], {
    env: {...process.env, PERSISTENCE_PROVIDER: "json", DATABASE_URL: "", LEADGEN_DATA_DIR: E2E_DATA_DIR},
    stdio: "pipe", windowsHide: true,
  });
  const response = await fetch(`http://localhost:${E2E_PORT}/api/health`, {signal: AbortSignal.timeout(60_000)});
  const health = await response.json();
  assert.equal(health.persistenceProvider, "json");
  assert.equal(health.authMode, "production");
  // Protected /api/state must NOT be pre-warmed with a demo cookie: 401 here
  // is correct. The tests sign in through the actual password form instead.
}

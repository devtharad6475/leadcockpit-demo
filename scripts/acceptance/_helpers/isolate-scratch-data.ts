/**
 * isolate-scratch-data.ts — preload for scripts/acceptance/*.
 *
 * Same hoisting constraint as the probe and golden helpers: src/lib/db.ts reads
 * LEADGEN_DATA_DIR into a module-level const at import time, so the variable has
 * to be set by a `--import` preload rather than inside main().
 *
 * Differs from scripts/probes/_helpers/isolate-copy-demo-data.ts in one way that
 * matters for what this harness is trying to prove: it starts EMPTY. The
 * ten-company acceptance run must build each company from nothing — workspace,
 * business profile, knowledge — because the CEO's bar is "import ten different
 * companies' data and talk to the system as that customer". Starting from the
 * Balaji demo seed would let a persona's answer be right for the wrong reason
 * (the model reading zari-lace context that the persona never supplied).
 *
 * .env is loaded here because tsx does not do it, and the run needs
 * PLATFORM_DEEPSEEK_API_KEY to reach the real model. The key is never printed.
 */
import fsSync from "node:fs";
import os from "node:os";
import pathMod from "node:path";

try { process.loadEnvFile(pathMod.resolve(process.cwd(), ".env")); } catch { /* no .env, fine */ }

// Never Postgres: this harness creates and destroys ten workspaces, and the
// ship database is not a scratchpad (F-P0-5, 2026-08-05).
process.env.PERSISTENCE_PROVIDER = "json";

const isolatedDir = pathMod.join(os.tmpdir(), "leadgen-acceptance-data", `run-${process.pid}-${Date.now()}`);
fsSync.mkdirSync(isolatedDir, { recursive: true });

process.env.LEADGEN_DATA_DIR = isolatedDir;
process.env.ACCEPTANCE_ISOLATED_DIR = isolatedDir;

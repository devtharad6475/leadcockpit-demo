/**
 * force-json-provider.ts — preload module that pins the test process to the
 * JSON persistence provider BEFORE any service module is imported.
 *
 * WHY (Stage 6 / 2026-07-31): the service-layer functions a logic golden
 * exercises (SignupService, PlatformAdminService, FeatureFlagService, …) import
 * the MODULE-LEVEL `repositories` singleton from `@/repositories` (index.ts
 * line 20: `export const repositories = createRepositories();`). That singleton
 * reads `process.env.PERSISTENCE_PROVIDER` ONCE at module-load. ES module
 * imports are HOISTED — a top-level `process.env.PERSISTENCE_PROVIDER = "json"`
 * line inside a golden runs AFTER its imports have already latched the
 * provider from `.env`. So when `.env` = prisma, the singleton is Prisma even
 * though the golden wanted JSON → split-brain ("Admin not found" / FK errors).
 *
 * THE FIX: Node's `--import` (or tsx's preload) runs THIS file BEFORE the
 * golden's module graph is evaluated. Setting the env here guarantees the
 * singleton resolves to JSON. Logic goldens opt in by being run with
 *   `tsx --import ./scripts/golden/_helpers/force-json-provider.ts <golden>`
 * (see package.json + run-all-goldens.ts). Prisma goldens do NOT opt in.
 *
 * Idempotent + safe: only sets the var if not already pinned to "prisma" by a
 * PRISMA_GOLDEN that explicitly wants Postgres.
 */
// UNCONDITIONAL: this preload ONLY loads for logic goldens (the runner uses a
// plain `tsx` run — no preload — for Prisma goldens). So if we reach this file
// we MUST be JSON, regardless of what `.env` says. The earlier guard
// `if (process.env.PERSISTENCE_PROVIDER !== "prisma")` was BACKWARDS: when the
// shell had loaded `.env` (PERSISTENCE_PROVIDER=prisma), the guard SKIPPED the
// pin and let logic goldens fall through to Prisma → "Admin not found" / FK
// errors in 8 logic goldens. That made the whole suite pass-or-fail depending
// on how the operator's shell was set up — a flaky, lying suite. Forcing JSON
// here makes logic goldens deterministic and independent of `.env`, exactly as
// the runner's contract promises (run-all-goldens.ts: "must run on a
// deterministic JSON substrate — independent of .env"). Test-honesty fix 2026-07-31.
// N-AI-2 fallout (2026-08-20): platform AI keys are neutralised before ANY
// import, so `.env` (loaded by @prisma/client) cannot turn a logic golden into
// a live, billable API call. See _helpers/no-platform-ai-keys.ts.
import "./no-platform-ai-keys";

process.env.PERSISTENCE_PROVIDER = "json";

// ─── F-P0-5 fix (Stage 6 / 2026-07-31): isolated test data file ─────────────
// Redirect ALL JSON-data reads/writes to a process-unique temp directory. This
// closes two problems at once:
//   1. DEMO-FILE POLLUTION (F-P0-5): logic goldens write isolated test rows
//      (workspaces, users, leads). Before this, they wrote to the SHARED demo
//      `app-data.json`, leaving 300+ junk rows after a suite run. Now each test
//      process gets its OWN file, so the demo file is never touched.
//   2. CROSS-PROCESS EPERM RENAME RACE: the suite runner spawns each golden as
//      a separate process; when several hit the same `app-data.json` the atomic
//      rename (tmp → final) can collide with EPERM on Windows. Separate files
//      per process eliminate the collision entirely.
// Synchronous (no top-level await) so the preload is a plain module.
import pathMod from "node:path";
// N-DATA-2: the scratch root used to be os.tmpdir()/leadgen-golden-data, which
// nothing ever cleaned and which had grown to 8,206 directories. It now lives
// inside the project, so the mess is ours to sweep -- see golden-scratch.ts for
// why cleanup happens at the START of the next run rather than at the end of
// this one, and why the old OS-temp directories are deliberately left alone.
import { ensureScratchRoot } from "./golden-scratch";
const tempRoot = ensureScratchRoot();
process.env.LEADGEN_DATA_DIR = pathMod.join(tempRoot, `run-${process.pid}-${Date.now()}`);

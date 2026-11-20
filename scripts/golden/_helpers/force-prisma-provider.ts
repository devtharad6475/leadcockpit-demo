/**
 * force-prisma-provider.ts — preload module that pins the test process to the
 * PRISMA persistence provider BEFORE any service module is imported.
 *
 * WHY (2026-08-17, CEO-loop session 2): the mirror image of the bug
 * `force-json-provider.ts` already documents for logic goldens.
 *
 * A PRISMA_GOLDEN calls `createRepositories("prisma")` explicitly for its own
 * bundle, but the SERVICE functions it exercises (suspendWorkspace,
 * resumeWorkspace, changePlatformTicketStatus, …) import the module-level
 * `repositories` singleton from `@/repositories`, which latches
 * `process.env.PERSISTENCE_PROVIDER` ONCE at module-load. The suite runner and
 * the `golden:*-prisma` npm scripts both ran these goldens with a plain `tsx`
 * call that simply INHERITS `.env` — on the assumption that `.env` says
 * `PERSISTENCE_PROVIDER="prisma"`.
 *
 * When `.env` says `json` (which is exactly what the 2026-08-13 UI audit left
 * it set to, and what any operator running the app in demo mode will have),
 * the golden's own bundle writes to Postgres while the services it calls read
 * and write JSON. The result is a split brain: the golden seeds a platform
 * admin into Postgres, `suspendWorkspace` looks for it in the JSON file, and
 * the run fails with "Admin not found." — a failure that looks like a product
 * bug in the Postgres field-clearing logic but is purely an ambient-environment
 * artifact. (Verified 2026-08-17: identical golden, same code, 2 failed with
 * `.env` = json → 3 passed with PERSISTENCE_PROVIDER=prisma.)
 *
 * The reverse case is worse: if a future defect existed only on the Prisma
 * path, this same split could let the golden PASS while never exercising the
 * substrate it claims to test.
 *
 * THE FIX: Node's `--import` runs this file before the golden's module graph is
 * evaluated, so the singleton resolves to Prisma no matter what `.env` says —
 * making PRISMA goldens as deterministic and env-independent as logic goldens
 * already are.
 *
 * DATABASE_URL is still read from `.env` (the golden genuinely needs a real
 * Postgres); only the PROVIDER SELECTION is pinned here.
 */

// N-AI-2 fallout (2026-08-20): platform AI keys are neutralised before ANY
// import, so `.env` (loaded by @prisma/client) cannot turn a logic golden into
// a live, billable API call. See _helpers/no-platform-ai-keys.ts.
import "./no-platform-ai-keys";
process.env.PERSISTENCE_PROVIDER = "prisma";

// ─── N-DATA-2 (2026-08-26): ISOLATE THE JSON DATA DIRECTORY TOO ─────────────
//
// Pinning the provider was only half the guarantee. This preload deliberately
// left LEADGEN_DATA_DIR alone, on the reasoning that a PRISMA_GOLDEN talks to
// Postgres and has no business in the JSON file. Measured on 2026-08-26, that
// reasoning was wrong in practice: the live demo store
// `.leadgen-data/app-data.json` had accumulated 15 scratch workspaces and 88
// rows of test residue, named after the Prisma goldens that produced them
// (`ws_golden_svm_prisma_*`, `ws_golden_fieldclear_*`, `ws_golden_parity_*`).
//
// It was not a cosmetic mess. Three of those leftover users carried
// `@test.app` addresses — a REGISTERED, deliverable domain — and a send test
// reads that exact file, so `golden-unroutable-contacts` went red on a real
// safety defect that only existed because of the leak.
//
// The fix is the same one `isolate-json-data.ts` already documents, and for
// the same reason it must be a preload: `src/lib/db.ts` freezes its data
// directory into a module-level `const` the first time it is imported, and ES
// module imports are hoisted above the golden's own `main()`.
//
// This is a safety net, not a behaviour change. A golden that genuinely talks
// to Postgres never notices it. A golden that quietly falls back to JSON now
// writes to a throwaway directory instead of the operator's real data, and
// `golden-unroutable-contacts` CASE 9 fails loudly if anything ever lands in
// the live store again.
import pathMod from "node:path";
// N-DATA-2: the scratch root used to be os.tmpdir()/leadgen-golden-data, which
// nothing ever cleaned and which had grown to 8,206 directories. It now lives
// inside the project, so the mess is ours to sweep -- see golden-scratch.ts for
// why cleanup happens at the START of the next run rather than at the end of
// this one, and why the old OS-temp directories are deliberately left alone.
import { ensureScratchRoot } from "./golden-scratch";
const tempRoot = ensureScratchRoot();
process.env.LEADGEN_DATA_DIR = pathMod.join(tempRoot, `prisma-golden-${process.pid}-${Date.now()}`);

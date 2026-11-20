/**
 * provider.ts — the SINGLE chokepoint for how a golden test chooses its
 * persistence provider (Stage 6 / 2026-07-31).
 *
 * WHY THIS EXISTS (build-right Phase 3d "One gate for cross-cutting rules"):
 *   Before this file, 29 logic goldens called `createRepositories()` with NO
 *   argument. That call defaults to `getPersistenceProvider()`, which reads
 *   `.env`. When the operator flipped `.env` to `PERSISTENCE_PROVIDER="prisma"`
 *   (Stage 6 / WP6-A), those 29 logic goldens silently started running against
 *   real Postgres and broke for the WRONG REASON — they wrote isolated test
 *   rows into Neon whose workspaceIds don't exist there, hitting foreign-key
 *   violations. The business logic they were testing was correct; the test was
 *   failing because it had accidentally become a persistence test.
 *
 *   The build-right rule (Phase 3): EACH TEST TESTS ONE THING. A logic golden
 *   (scoring, dedup rules, SLA math, RBAC maps, knowledge rules) must test the
 *   LOGIC on a deterministic, isolated substrate — never affected by the
 *   database. The Postgres proof lives in the SEPARATE dedicated persistence
 *   goldens (golden:prisma-commercial-parity, golden:webhook-dedup-prisma,
 *   golden:prisma-stage5-mappers, the prisma smokes).
 *
 *   So: logic goldens MUST use `createJsonRepos()` (below), which pins "json"
 *   explicitly — independent of `.env`. The provider decision now lives in ONE
 *   place (this file), not 29 scattered calls. A future agent who writes a new
 *   logic golden imports this helper instead of the bare factory.
 *
 * RULES:
 *   - `createJsonRepos()`    → use for LOGIC goldens (the default for 99% of
 *                              cases). Fast, isolated, deterministic.
 *   - `createPrismaRepos()`  → use ONLY for persistence goldens that PROVE the
 *                              Prisma runtime against real Postgres. These must
 *                              seed their own parent rows (workspace etc.) and
 *                              clean up (Gate #8). See golden-webhook-dedup-
 *                              prisma.ts for the proven seed/cleanup pattern.
 *
 * NOTE: this is a double-underscore-prefixed _helpers directory so the suite
 * runner (scripts/run-all-goldens.ts, which runs every .ts file in scripts/
 * golden/) doesn't mistake it for a golden. It is a shared utility, not a test.
 */
import { createRepositories } from "@/repositories";
import type { RepositoryBundle } from "@/repositories";

/**
 * Create a JSON-backed repository bundle for a LOGIC golden. Deterministic +
 * isolated from the database + independent of `.env` (always JSON, even if the
 * operator has flipped `.env` to prisma). Use this in every business-logic
 * golden.
 *
 * IMPORTANT — the process-level provider pin lives in the SUITE RUNNER
 * (scripts/run-all-goldens.ts), NOT here. Why: many services (SignupService,
 * PlatformAdminService, FeatureFlagService, …) import the MODULE-LEVEL
 * `repositories` singleton (`@/repositories` index.ts line 20:
 * `export const repositories = createRepositories();`), which reads
 * `process.env.PERSISTENCE_PROVIDER` ONCE at module-load time. ES module
 * imports are HOISTED, so a golden that does
 *   `import { signup } from "@/services/SignupService";`  ← evaluates singleton
 *   `import { createJsonRepos } from "./_helpers/provider";`
 * resolves the singleton BEFORE any code in this helper runs — meaning an env
 * set here would be too late (the singleton already latched prisma). The only
 * reliable place to pin the provider for the whole process is the spawning
 * parent (the runner), which sets `PERSISTENCE_PROVIDER=json` for every logic
 * golden. A golden that needs prisma opts in via the `PRISMA_GOLDEN` marker.
 */
export function createJsonRepos(): RepositoryBundle {
  return createRepositories("json");
}

/**
 * Create a Prisma-backed repository bundle for a PERSISTENCE golden that proves
 * the Postgres runtime. Caller is responsible for seeding parent rows (the FK
 * constraints are real) and cleaning up its own rows (build-right Gate #8).
 */
export function createPrismaRepos(): RepositoryBundle {
  return createRepositories("prisma");
}

/**
 * Create a bundle that follows whatever the PROCESS is on — no pin at all.
 *
 * WHEN TO USE THIS INSTEAD OF createJsonRepos (2026-08-25, A-7 / N-TEST-9)
 * -----------------------------------------------------------------------
 * Use it when the services under test take NO repository argument. SignupService
 * and FeatureFlagService are the two: every one of their functions reaches for
 * the module-level `repositories` singleton and there is no way to hand them a
 * different bundle. For a golden testing those, a pinned JSON bundle is not
 * isolation — it is a LIE. The golden seeds an operator admin into JSON, the
 * service looks for it in whatever `.env` said, and on the Postgres pass every
 * case dies with "Admin not found." while claiming to be an assertion failure.
 *
 * So the golden's own writes must land wherever the code under test will look.
 * That is this function. On the normal suite run the runner has already pinned
 * PERSISTENCE_PROVIDER=json for logic goldens, so this behaves exactly like
 * createJsonRepos. Under the A-7 Postgres pass it follows the harness onto a
 * private template clone, and the golden genuinely runs on the substrate we
 * ship on — which is the whole point of A-7.
 *
 * THIS IS A WORKAROUND FOR A PRODUCT GAP, NOT THE END STATE. The right fix is
 * for those services to accept a `RepositoryBundle` like every other service
 * does, so a caller can put them in a transaction or a test double. Recorded as
 * N-DATA-17 on the board. Do NOT reach for this helper just because a golden is
 * failing — first check whether the service can be handed a bundle. If it can,
 * hand it one; the pinned JSON bundle is still correct for those.
 */
export function createAmbientRepos(): RepositoryBundle {
  return createRepositories();
}

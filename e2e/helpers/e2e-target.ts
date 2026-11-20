/**
 * e2e-target.ts — which substrate this Playwright invocation is testing.
 *
 * WHY ONE RUN CANNOT COVER BOTH (2026-08-19, CEO-loop session 7).
 *
 * The suite needs two different servers:
 *
 *   json   — the disposable substrate, pointed at a throwaway data directory.
 *            Everything except the prod-prisma smoke. The mutating specs
 *            (full-button-coverage, the nine depth-* specs) rely on
 *            `restoreDemoData()` copying a JSON file back between tests, which
 *            only isolates anything if the server is actually reading that file.
 *   prisma — the real database, for `prod-prisma-smoke.spec.ts`, whose entire
 *            purpose is proving that real Postgres rows reach the screen. It
 *            asserts only; it never writes.
 *
 * The obvious implementation — two `webServer` entries on two ports — does not
 * work. Next 16 refuses outright:
 *
 *     ⨯ Another next dev server is already running.
 *
 * It is one dev server per project directory, whatever port you ask for. So the
 * choice moves up a level: one server per INVOCATION, selected here.
 *
 *   npm run test:e2e          → json server, every spec but the smoke
 *   npm run test:e2e:prisma   → prisma server, the smoke only
 *
 * Getting this wrong is not a broken test, it is data loss: the mutating specs
 * against a prisma server write to the ship database with their isolation
 * silently doing nothing. e2e/helpers/global-setup.ts therefore verifies the
 * running server's provider against this value before a single test runs.
 */
export type E2ETarget = "json" | "prisma";

export const E2E_TARGET: E2ETarget = process.env.E2E_TARGET === "prisma" ? "prisma" : "json";

/**
 * Both targets use the same port — they never run at the same time (see above).
 *
 * 2026-08-31 (N-TEST-16) — the port was hardcoded to 3000, and this machine
 * runs an UNRELATED project's app there. `reuseExistingServer: !CI` in
 * playwright.config.ts means Playwright then quietly adopts that stranger's
 * server as the system under test. global-setup's provider probe does stop the
 * run, so nothing false goes green — but the suite becomes unrunnable for as
 * long as any other app holds the port, and the failure names a provider
 * mismatch rather than the actual cause.
 *
 * Reading an override from the environment costs nothing and makes the suite
 * runnable next to whatever else is on the machine:
 *     E2E_PORT=3210 npx playwright test
 * The default is unchanged, so every existing command behaves exactly as before.
 */
export const E2E_PORT = Number(process.env.E2E_PORT) || 3000;

export const E2E_BASE_URL = `http://localhost:${E2E_PORT}`;

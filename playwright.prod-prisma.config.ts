/**
 * playwright.prod-prisma.config.ts — L-2/L-4 (2026-08-04).
 *
 * A SEPARATE Playwright config for the prod-prisma smoke test. Inherits the
 * base config's projects/devices/retry settings, but:
 *   1. Points baseURL at port 3001 (NOT 3000, which the operator's separate
 *      "Green ERP" deployment occupies on this machine).
 *   2. DISABLES the webServer block (the prod-prisma server must be started
 *      manually first: `PORT=3001 PERSISTENCE_PROVIDER=prisma npm run dev`).
 *      Reason: the main config's webServer boots with `AUTH_MODE=demo` + no
 *      PERSISTENCE_PROVIDER (JSON mode). This config MUST run against prisma.
 *   3. DISABLES the globalSetup (which re-seeds the JSON demo file — would
 *      pollute Neon if it ran here; the prisma seed is separate + opt-in).
 *
 * Run: PORT=3001 npm run dev  (in one terminal — boots prod-prisma on 3001)
 *      npm run seed:demo:prisma  (once — seeds workspace_demo in Neon)
 *      npx playwright test --config=playwright.prod-prisma.config.ts prod-prisma-smoke
 */
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "prod-prisma-smoke.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  // NO webServer — the prod-prisma server is started manually on 3001.
  // NO globalSetup — it re-seeds the JSON file; we seed Neon separately.
  use: {
    baseURL: process.env.PROD_PRISMA_BASE_URL || "http://localhost:3001",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
});

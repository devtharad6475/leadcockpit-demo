import { defineConfig, devices } from "@playwright/test";
import { E2E_DATA_DIR } from "./e2e/helpers/data-dir";
import { E2E_TARGET, E2E_PORT, E2E_BASE_URL } from "./e2e/helpers/e2e-target";

/**
 * NO PAID CALLS FROM THE TEST SERVER (2026-09-24).
 *
 * The test server read `.env`, which holds the real platform keys, so every
 * `npm run test:e2e` made billed DeepSeek calls (three ICP generations in
 * depth-profile-icp-campaign alone, per run), could make billed SerpApi
 * searches, and held the live e-mail and WhatsApp send tokens. The specs assert contracts that hold on the free mock path too.
 *
 * Blank values are enough: Next's env loader never overwrites a variable that
 * already exists, even an empty one, and every key reader in the product
 * treats blank as absent. Set E2E_REAL_AI=1 for a deliberate, paid run.
 * Pinned by scripts/golden/golden-e2e-makes-no-paid-calls.ts.
 */
export const PAID_KEY_ENV_NAMES = [
  "PLATFORM_DEEPSEEK_API_KEY", "DEEPSEEK_API_KEY",
  "PLATFORM_OPENAI_API_KEY", "OPENAI_API_KEY",
  "PLATFORM_ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY",
  "PLATFORM_GEMINI_API_KEY", "GEMINI_API_KEY",
  "PLATFORM_KIMI_API_KEY", "KIMI_API_KEY",
  "PLATFORM_MINIMAX_API_KEY", "MINIMAX_API_KEY",
  "PLATFORM_SERPAPI_API_KEY", "SERPAPI_API_KEY",
  "TRANSCRIPTION_OPENAI_API_KEY",
  // Anything that can reach a real person. A test must never be able to send:
  // transactional e-mail and the WhatsApp Cloud send tokens. (Webhook secrets
  // stay — the signature specs need them, and they send nothing.)
  "RESEND_API_KEY",
  "WHATSAPP_CLOUD_ACCESS_TOKEN", "WHATSAPP_TOKEN", "META_SYSTEM_TOKEN",
] as const;
const NO_PAID_CALLS_ENV: Record<string, string> =
  process.env.E2E_REAL_AI === "1" ? {} : Object.fromEntries(PAID_KEY_ENV_NAMES.map((name) => [name, ""]));

/** Disposable JSON substrate — everything except the prod-prisma smoke. */
const SHARED_SERVER_ENV = {
  ...NO_PAID_CALLS_ENV,
  // AUTH_MODE=demo keeps the login screen showing the one-click demo entry so
  // tests don't need credentials.
  AUTH_MODE: "demo",
  // 2026-07-29 (UI sweep test-isolation, Gate #8): the full-ui-sweep-v2 spec
  // visits 26 tabs x ~5 fetches each in seconds — legitimately more traffic
  // than a real user. The WP5.4 edge rate limiter (300/min per IP, proven by
  // golden:wp5-edge-rate-limit) correctly blocks that. To keep the sweep from
  // tripping its own protection (which would surface as cascading 429s + the
  // Next.js dev overlay), raise the per-IP cap to a test-only value. The
  // production default (300) is still pinned by the golden; this env only
  // affects the playwright test server.
  EDGE_RATE_LIMIT_PER_IP: "100000",
  EDGE_RATE_LIMIT_PER_WORKSPACE: "100000",
  // 2026-09-08 — the APP-level preset table needs the same treatment, for the
  // same reason. On the Postgres target `readAppData()` no longer reads a file:
  // it asks the server for `GET /api/data/export`, once per assertion. That
  // action is capped at 50 per 24 HOURS, sized for a shared deployment where a
  // human clicks Export a few times a week. A single suite run makes hundreds
  // of those calls, so the run dies partway through with HTTP 429 — measured
  // 2026-09-08: 31 of 254 tests lost, and the 24h window meant the next run
  // that day started already exhausted.
  //
  // RATE_LIMIT_SINGLE_USER is the dial the product already ships for exactly
  // this shape of problem (memoryBackend.ts): every non-auth preset becomes
  // 10,000/minute, the brute-force guards (login, signup, password reset) keep
  // their real values, and the limiter stays wired so a runaway still stops.
  // Test server only — the shipped preset table is still pinned by the goldens,
  // which run with this variable unset.
  RATE_LIMIT_SINGLE_USER: "1",
  PORT: String(E2E_PORT),
  // 2026-09-05 (session 52) — hide Next's dev-tools badge for test runs. It
  // renders bottom-left, on top of this app's last sidebar group, and its portal
  // eats the click. See next.config.ts for the fifteen-minute hang it caused.
  LEADGEN_HIDE_DEV_INDICATOR: "1",
};

/**
 * ONE SERVER PER INVOCATION, PINNED TO ONE PROVIDER (2026-08-19, session 7).
 *
 * There used to be one server whose provider came from `.env`. `.env` now says
 * `PERSISTENCE_PROVIDER=prisma`, because that is what the product ships on — so
 * `npm run test:e2e` booted a PRISMA server and pointed the whole suite at it.
 *
 * That is not a slower version of the same run. The suite's isolation mechanism
 * is `restoreDemoData()`, which copies a JSON file back over `app-data.json`
 * between mutating tests; against a Prisma server nothing reads that file, so
 * the isolation silently becomes a no-op and the mutating specs create, edit and
 * delete rows in the ship database with nothing restoring anything.
 *
 * Both targets listen on 3000 and never run together — Next 16 allows only one
 * dev server per project directory. See e2e/helpers/e2e-target.ts.
 */
const SERVER_ENV =
  E2E_TARGET === "prisma"
    ? {
        ...SHARED_SERVER_ENV,
        PERSISTENCE_PROVIDER: "prisma",
        // DATABASE_URL deliberately NOT set — it comes from .env, so this server
        // reads exactly the database the operator configured, which is the only
        // thing worth smoke-testing.
        //
        // 2026-09-08 — EXCEPT under E2E_PRISMA_FULL, which runs the MUTATING
        // specs against Postgres to close the blind spot this file documents at
        // length. Those specs must never touch the operator's database, so that
        // mode requires E2E_PG_URL naming a disposable one; the run refuses to
        // start without it rather than silently falling back to .env.
        ...(process.env.E2E_PRISMA_FULL === "1"
          ? {
              DATABASE_URL: (() => {
                const url = process.env.E2E_PG_URL;
                if (!url) {
                  throw new Error(
                    "E2E_PRISMA_FULL=1 needs E2E_PG_URL pointing at a DISPOSABLE Postgres database. " +
                      "Without it the mutating specs would run against the database in .env.",
                  );
                }
                return url;
              })(),
            }
          : {}),
      }
    : {
        ...SHARED_SERVER_ENV,
        // Pin it. Inheriting the provider from .env is what pointed the whole
        // mutating suite at the ship database.
        PERSISTENCE_PROVIDER: "json",
        // The suite seeds and restores a throwaway JSON substrate on every run.
        // Point the server at the SAME directory, or it reads
        // .leadgen-data/app-data.json — the real demo data set. See
        // e2e/helpers/data-dir.ts for what that used to cost.
        LEADGEN_DATA_DIR: E2E_DATA_DIR,
      };

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false, // JSON demo store has a global mutation queue — serial is safer
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1, // same reason as fullyParallel
  reporter: process.env.CI ? "github" : "list",
  // 2026-08-19 — was 30_000, and that was most of the reason the suite looked
  // broken. A Turbopack dev server compiles each route on first request, so the
  // first test to reach a screen pays 15-25s of compile before it can click
  // anything; the 30s budget was gone before the assertion ran and the failure
  // read as a product bug. globalSetup now pre-warms `/`, and the budget is
  // large enough that a timeout here means something is actually stuck.
  timeout: 90_000,
  expect: { timeout: 5_000 },
  // 2026-07-29 (full-button-coverage spec, Gate #8 isolation): seed a fresh,
  // known-good demo workspace AND snapshot it before the suite runs. The
  // full-button-coverage spec restores this snapshot before each mutating
  // test so every test starts from identical clean state. The JSON layer
  // reads app-data.json from disk every request (no cache), so restoring the
  // file is sufficient — no server restart needed.
  globalSetup: require.resolve("./e2e/helpers/global-setup.ts"),
  /**
   * TWO SERVERS, ON PURPOSE (2026-08-19, CEO-loop session 7).
   *
   * There used to be one, and `.env` decides its persistence provider. `.env`
   * now says `PERSISTENCE_PROVIDER=prisma`, because that is what the product
   * ships on — so `npm run test:e2e` booted a PRISMA server and pointed the
   * whole suite at it.
   *
   * That is not a slower version of the same test run. It is a different and
   * much worse one:
   *
   *   - The suite's isolation mechanism is `restoreDemoData()`, which copies a
   *     JSON file back over `app-data.json` between mutating tests. Against a
   *     Prisma server that file is not read by anything. The isolation silently
   *     becomes a no-op.
   *   - The mutating specs (full-button-coverage and the nine depth-* specs)
   *     then create, edit and delete rows in the SHIP DATABASE — the one
   *     holding the migrated demo data set — with nothing restoring anything
   *     between tests.
   *
   * So the split is by what each spec is actually about:
   *
   *   :3000  JSON provider, pointed at the suite's throwaway data directory.
   *          Everything except the prod-prisma smoke. Restorable, disposable.
   *   :3100  Prisma provider, real database, READ-ONLY assertions.
   *          `prod-prisma-smoke.spec.ts` only — its entire purpose is to prove
   *          that real Postgres rows reach the screen, which needs a real
   *          Prisma server. It never writes.
   *
   * Next reads PORT from the environment, and @next/env does not overwrite a
   * variable that is already set, so the `env` blocks below win over `.env`.
   */
  use: {
    baseURL: E2E_BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: E2E_TARGET === "prisma" ? "prisma-smoke" : "chromium",
      // The smoke needs a real Prisma server; every other spec needs a
      // disposable one. Selecting by target makes it impossible to run the
      // smoke against JSON and get a green "real Postgres data renders" that
      // proved nothing — or, far worse, to run the mutating specs against the
      // real database.
      //
      // 2026-09-05 (session 52): the pattern now covers EVERY prod-prisma spec,
      // not the one that existed when it was written. A second read-only spec
      // (prod-prisma-every-screen) was added, and a literal filename here would
      // have silently run it under the JSON target — proving nothing about
      // Postgres while looking like it did — and never run it under the prisma
      // one. Name the family, not the file.
      //
      // 2026-09-08 — a third mode. E2E_PRISMA_FULL runs everything EXCEPT the
      // prod-prisma family against Postgres: those two specs assert the
      // operator's real data, which the disposable fixture database does not
      // have, so including them would fail for a data reason and say nothing.
      ...(E2E_TARGET === "prisma"
        ? process.env.E2E_PRISMA_FULL === "1"
          ? { testIgnore: /prod-prisma-.*\.spec\.ts/ }
          : { testMatch: /prod-prisma-.*\.spec\.ts/ }
        : { testIgnore: /prod-prisma-.*\.spec\.ts/ }),
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "npm run dev",
    url: E2E_BASE_URL,
    timeout: 240_000, // first Next.js compile is slow; give it room
    reuseExistingServer: !process.env.CI,
    env: SERVER_ENV,
  },
});

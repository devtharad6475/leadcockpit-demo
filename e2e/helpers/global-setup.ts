/**
 * Playwright globalSetup — runs ONCE before the whole suite (after the
 * webServer config is resolved but the config is evaluated first).
 *
 * Responsibilities (build-right Gate #8 — Test Isolation):
 *   1. Re-seed a fresh, known-good demo workspace into the SUITE'S OWN data
 *      directory (see e2e/helpers/data-dir.ts).
 *   2. Snapshot the seeded file → app-data.snapshot.spec.json, in that same
 *      directory.
 *
 * The full-button-coverage spec then restores this snapshot before each
 * mutating test. The JSON layer reads app-data.json from disk every request
 * (verified in src/lib/db.ts — no in-memory cache), so restoring the file is
 * sufficient; no server restart needed.
 *
 * This globalSetup runs for ALL specs in e2e/, not just the coverage spec.
 * Re-seeding is cheap (~200ms) and harmless for read-only specs.
 *
 * 2026-08-19 — it was NOT harmless before today. It seeded over
 * `.leadgen-data/app-data.json`, the real demo data set and the migration's
 * source of record, on every single run. `LEADGEN_DATA_DIR` below is what
 * redirects the seeder's write; the same variable is set on the dev server in
 * playwright.config.ts so the server reads what the seeder wrote.
 */
import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { snapshotDemoData, restoreDemoData } from "./demo-data-snapshot";
import { E2E_DATA_DIR, assertE2EDataDirIsIsolated } from "./data-dir";
import { E2E_TARGET, E2E_PORT } from "./e2e-target";

/**
 * Confirm each server is running the provider its project assumes.
 *
 * `reuseExistingServer` is true locally, which means Playwright will happily
 * adopt whatever is already listening on the port — including a developer's own
 * `npm run dev`, which reads `.env` and is therefore a PRISMA server. If that
 * happens on :3000, the mutating specs run against the ship database with their
 * JSON-file isolation quietly doing nothing. That is the failure this refuses.
 *
 * /api/health is public and reports the provider, so no login is needed.
 */
async function assertProvider(port: number, expected: "json" | "prisma") {
  const url = `http://localhost:${port}/api/health`;

  // 2026-08-19 — this used to be a single un-guarded `await resp.json()`, and
  // the whole suite died on:
  //
  //     SyntaxError: Unexpected token '<', "<!DOCTYPE "... is not valid JSON
  //
  // Two lines of output, no test run, nothing naming the port or the route.
  // Playwright waits for the dev server's URL to answer, not for its API routes
  // to be COMPILED — Turbopack compiles /api/health on first request — so the
  // first hit can come back as an HTML error page while the route is still
  // building. That is a server that is not ready yet, not a misconfigured one,
  // so it is worth retrying; what is NOT worth doing is reporting it as a JSON
  // parse error and leaving whoever reads the log to guess.
  let lastProblem = "";
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const resp = await fetch(url).catch((e) => {
      lastProblem = `request failed: ${String(e)}`;
      return null;
    });
    if (resp) {
      const text = await resp.text();
      let body: { persistenceProvider?: string } | null = null;
      try {
        body = JSON.parse(text) as { persistenceProvider?: string };
      } catch {
        // Keep the beginning of what actually came back — an HTML error page
        // says something very different from an empty body or a proxy notice.
        lastProblem = `HTTP ${resp.status} but the body is not JSON: ${text.slice(0, 120).replace(/\s+/g, " ")}`;
      }
      if (body) {
        if (body.persistenceProvider === expected) {
          console.log(`[globalSetup] :${port} \u2192 ${expected} \u2713`);
          return;
        }
        // A live, correct answer naming the wrong provider is not a timing
        // problem and never becomes one. Fail immediately.
        throw new Error(
          `Server on :${port} reports PERSISTENCE_PROVIDER="${body.persistenceProvider}", ` +
            `but this run's target is "${expected}". Almost certainly a dev server you ` +
            `started yourself was adopted via reuseExistingServer. Stop it and re-run \u2014 ` +
            (expected === "json"
              ? "the mutating specs would otherwise write to the real database."
              : "the prod-prisma smoke would otherwise prove nothing."),
        );
      }
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(
    `Gave up waiting for ${url} to report a persistence provider (90s). Last problem: ${lastProblem}`,
  );
}

/**
 * Pay the first-compile cost here instead of charging it to whichever test
 * happens to run first.
 *
 * The dev server compiles a route the first time it is requested, which takes
 * 15-25s for the app shell. Under the old 30s per-test budget that compile ate
 * the whole budget and the first test in the run failed at the first click —
 * looking exactly like a broken button rather than a cold cache. Warming the
 * route here makes the first test cost the same as the hundredth.
 */
async function warmUp(port: number) {
  const t0 = Date.now();
  const resp = await fetch(`http://localhost:${port}/`).catch(() => null);
  const ms = Date.now() - t0;
  if (!resp || !resp.ok) {
    console.log(`[globalSetup] warm-up request did not succeed (${ms}ms) — continuing anyway`);
    return;
  }
  await resp.text();
  console.log(`[globalSetup] warmed / in ${ms}ms`);
}

/**
 * Prove the server can actually SERVE the seeded data before any test runs.
 *
 * 2026-08-19 (N-TEST-6). `reuseExistingServer` is true locally, so Playwright
 * adopts whatever is listening on :3000 - including a dev server left wedged by
 * an earlier interrupted run. One did exactly that: /api/health still answered
 * (its route was already compiled) while /api/state returned HTTP 500,
 * "Jest worker encountered 2 child process exceptions, exceeding retry limit".
 * The suite started anyway, and 66 tests failed on a mix of navigation timeouts
 * and "Dev server did not quiesce" - not one of them naming a dead server.
 *
 * assertProvider() cannot catch this: it only asks /api/health. This asks the
 * route every test depends on, and fails the RUN rather than every test in it.
 */
async function assertStateServable(port: number) {
  const url = `http://localhost:${port}/api/state`;
  let lastProblem = "no request completed";
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const resp = await fetch(url, { headers: { Cookie: "lc_demo=1" } }).catch((e) => {
      lastProblem = `request failed: ${String(e)}`;
      return null;
    });
    if (resp) {
      const text = await resp.text();
      if (!resp.ok) {
        lastProblem = `HTTP ${resp.status}: ${text.slice(0, 200).replace(/\s+/g, " ")}`;
      } else {
        let body: { totalLeads?: number } | null = null;
        try {
          body = JSON.parse(text) as { totalLeads?: number };
        } catch {
          lastProblem = `HTTP 200 but the body is not JSON: ${text.slice(0, 120).replace(/\s+/g, " ")}`;
        }
        if (body) {
          if (typeof body.totalLeads === "number" && body.totalLeads > 0) {
            console.log(`[globalSetup] :${port} /api/state serves ${body.totalLeads} leads ✓`);
            return;
          }
          lastProblem =
            `HTTP 200 but totalLeads=${JSON.stringify(body.totalLeads)} - the server is not reading ` +
            "the directory this setup just seeded";
        }
      }
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(
    `The server on :${port} cannot serve /api/state (60s). Last problem: ${lastProblem}
` +
      "If that is an HTTP 500, a dev server from an earlier run was adopted via " +
      `reuseExistingServer and is wedged - kill whatever is listening on :${port} and re-run.`,
  );
}

export default async function globalSetup() {
  assertE2EDataDirIsIsolated();
  await assertProvider(E2E_PORT, E2E_TARGET);
  await warmUp(E2E_PORT);

  if (E2E_TARGET === "prisma") {
    if (process.env.E2E_PRISMA_FULL === "1") {
      // The mutating specs are about to run against Postgres. Put the fixture
      // database back to baseline first, so the run starts from the same state
      // the JSON suite starts from, and prove the server can serve it before a
      // single test runs — an empty or unreachable fixture database otherwise
      // fails 200 tests one assertion at a time with nothing naming the cause.
      console.log("[globalSetup] prisma FULL target — restoring Postgres fixture to baseline…");
      restoreDemoData();
      await assertStateServable(E2E_PORT);
      console.log("[globalSetup] ready for suite (Postgres).");
      return;
    }
    // Nothing to seed: the prod-prisma smoke reads the real database and asserts
    // what is already there. Re-seeding the JSON fixture here would be harmless
    // but misleading — it would look like this run had a fixture.
    console.log("[globalSetup] prisma target — no JSON fixture needed." + "\n");
    return;
  }

  mkdirSync(E2E_DATA_DIR, { recursive: true });
  console.log(`\n[globalSetup] re-seeding fresh demo workspace → ${E2E_DATA_DIR}`);
  execSync("npm run seed:demo -- --force", {
    stdio: "inherit",
    env: { ...process.env, LEADGEN_DATA_DIR: E2E_DATA_DIR },
  });
  console.log("[globalSetup] snapshotting seeded data…");
  snapshotDemoData();
  await assertStateServable(E2E_PORT);
  console.log("[globalSetup] ready for suite.\n");
}

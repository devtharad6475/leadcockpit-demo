/**
 * e2e-pg-fixture.mjs — build the disposable Postgres database the mutating
 * e2e suite runs against (2026-09-08).
 *
 * WHY THIS EXISTS
 * ---------------
 * playwright.config.ts and e2e/helpers/e2e-target.ts both explain, at length,
 * that the mutating specs must never run against the operator's database: their
 * isolation is "copy a JSON file back between tests", which does nothing to a
 * database. That reasoning is right, and the cost of it is a blind spot — the
 * behaviour of 187 buttons was only ever proven on the JSON substrate, while
 * production runs on Postgres. Every Postgres-only defect this repo has found
 * was found by hand, after shipping.
 *
 * This closes it without weakening the rule. The suite still never touches the
 * operator's database; it gets its OWN database, built here, thrown away and
 * rebuilt whenever you like.
 *
 * WHAT IT DOES
 *   1. Creates (or recreates) a separate database in the local Postgres
 *      container. The operator's database is never opened.
 *   2. Applies the real migrations, so the schema is the shipped schema.
 *   3. Seeds the JSON demo dataset into the suite's throwaway data directory and
 *      migrates it in through the real repositories — so the fixture holds the
 *      SAME dataset the JSON suite seeds. That is what makes a difference in
 *      result mean a difference in SUBSTRATE rather than a difference in data.
 *   4. Dumps the result. e2e/helpers/demo-data-snapshot.ts restores that dump
 *      before each mutating test, which is the database equivalent of copying
 *      the JSON file back.
 *
 * Run:  node scripts/e2e-pg-fixture.mjs
 * Then: npm run test:e2e:prisma-full
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const REPO = process.cwd();
const CONTAINER = process.env.E2E_PG_CONTAINER || "leadgen-pg";
const PG_USER = process.env.E2E_PG_USER || "leadgen";
const PG_DB = process.env.E2E_PG_DB || "leadgen_e2e";
const DUMP = process.env.E2E_PG_DUMP || "/tmp/e2e-pg-baseline.dump";
const DATA_DIR = path.join(REPO, ".leadgen-data-e2e");
const URL_FILE = path.join(REPO, ".env.e2e-pg");

function run(cmd, args, env) {
  return execFileSync(cmd, args, {
    stdio: "inherit",
    env: { ...process.env, ...env },
    // Windows: npx/npm are .cmd shims and Node refuses to spawn them directly.
    shell: process.platform === "win32",
  });
}

/** Run a command, returning its combined output, without throwing on exit code. */
function captureRun(cmd, args, env) {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
      shell: process.platform === "win32",
    });
  } catch (e) {
    return `${e.stdout || ""}${e.stderr || ""}`;
  }
}

function docker(args, opts = {}) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    // MSYS path conversion rewrites /tmp into a Windows path INSIDE the
    // container argument, which is how this first failed: pg_dump reported it
    // could not open "C:/Users/.../tmp/e2e-pg-baseline.dump".
    env: { ...process.env, MSYS_NO_PATHCONV: "1" },
    ...opts,
  });
}

/**
 * The fixture URL is the operator's URL with ONLY the database name changed.
 *
 * Deriving it rather than asking for a second connection string means there is
 * no separate password to store, print, or leak — and no way for the two to
 * drift apart and have the fixture quietly built somewhere else.
 */
function fixtureUrl() {
  const envPath = path.join(REPO, ".env");
  if (!existsSync(envPath)) throw new Error(".env not found — DATABASE_URL is read from it.");
  const match = /^DATABASE_URL=(.*)$/m.exec(readFileSync(envPath, "utf8"));
  if (!match) throw new Error("DATABASE_URL is not set in .env");
  const url = match[1].trim().replace(/^"|"$/g, "");
  const swapped = url.replace(/\/[^/?]+(\?|$)/, `/${PG_DB}$1`);
  if (!swapped.includes(`/${PG_DB}`)) {
    throw new Error("Could not substitute the database name into DATABASE_URL.");
  }
  if (swapped === url) {
    throw new Error(
      `DATABASE_URL already names ${PG_DB}. Refusing to build the fixture in the operator's own database.`,
    );
  }
  return swapped;
}

const url = fixtureUrl();

console.log(`[fixture] recreating ${PG_DB} in container ${CONTAINER}…`);
docker(["exec", CONTAINER, "psql", "-U", PG_USER, "-d", "postgres", "-c", `DROP DATABASE IF EXISTS ${PG_DB};`]);
docker(["exec", CONTAINER, "psql", "-U", PG_USER, "-d", "postgres", "-c", `CREATE DATABASE ${PG_DB} OWNER ${PG_USER};`]);

console.log("[fixture] applying migrations…");
run("npx", ["prisma", "migrate", "deploy"], { DATABASE_URL: url });

console.log("[fixture] seeding the JSON demo dataset…");
run("npm", ["run", "seed:demo", "--", "--force"], { LEADGEN_DATA_DIR: DATA_DIR });

console.log("[fixture] migrating that dataset into Postgres through the real repositories…");
/**
 * The migrator re-plans after writing and exits non-zero unless the second plan
 * is empty. Two rows never satisfy that: whatsAppAgentSettings carries
 * `autoSendToggle` and `autonomyKillSwitch`, which Postgres has and the JSON
 * store has no field for, so they re-plan as "overwrite" forever. That is a
 * clean load, not a failed one.
 *
 * Ignoring the exit code outright would also hide a genuinely failed write, so
 * the output is read instead: no write errors and nothing left to CREATE means
 * every row arrived. Anything else still fails the build.
 */
const migration = captureRun("npx", ["tsx", "scripts/migrate-json-to-postgres.ts", "--write"], {
  LEADGEN_DATA_DIR: DATA_DIR,
  PERSISTENCE_PROVIDER: "prisma",
  DATABASE_URL: url,
});
const wroteEverything =
  /write errors:\s+0/.test(migration) && /rows still to create:\s+0/.test(migration);
if (!wroteEverything) {
  console.error(migration.slice(-3000));
  throw new Error("[fixture] the migration did not write every row — see the plan above.");
}
const leftover = /rows still to overwrite:\s+(\d+)/.exec(migration);
if (leftover && leftover[1] !== "0") {
  console.log(`[fixture] note: ${leftover[1]} row(s) hold Postgres-only fields the JSON store cannot express — expected.`);
}

console.log(`[fixture] dumping baseline → ${DUMP} (inside the container)…`);
docker(["exec", CONTAINER, "pg_dump", "-U", PG_USER, "-d", PG_DB, "-Fc", "-f", DUMP]);

// Written for the test run to read. Gitignored: it carries the same password as
// .env, and the whole point of deriving it was not to have a second copy of
// that in the repository.
writeFileSync(URL_FILE, `DATABASE_URL=${url}\n`, "utf8");

const counts = docker([
  "exec", CONTAINER, "psql", "-U", PG_USER, "-d", PG_DB, "-t", "-c",
  "SELECT 'leads=' || (SELECT count(*) FROM leads) || ' replies=' || (SELECT count(*) FROM replies) || ' tickets=' || (SELECT count(*) FROM tickets);",
]);
console.log(`[fixture] ready: ${counts.trim()}`);
console.log(`[fixture] run the suite with: npm run test:e2e:prisma-full`);

/**
 * Demo-data snapshot/restore helper for Playwright tests (build-right Gate #8).
 *
 * The JSON persistence layer reads `<data dir>/app-data.json` from DISK on
 * every API request (no in-memory cache — verified in `src/lib/db.ts:172`).
 * So restoring the file on disk between tests gives each test a clean,
 * identical starting state without restarting the dev server.
 *
 * Usage:
 *   - `snapshotDemoData()` once in globalSetup (after the dev server is up +
 *     demo data is seeded) → saves a pristine copy.
 *   - `restoreDemoData()` in `beforeEach` of any mutating test → wipes any
 *     mutations the previous test made. The next API request sees fresh bytes.
 *
 * Also clears any stale `.leadgen-data/app-data.lock` left by a crashed
 * mutation (db.ts:239-256 auto-releases after 15s, but we clear it explicitly
 * to avoid an 8s stall on the next test).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { E2E_DATA_DIR } from "./data-dir";
import { E2E_BASE_URL, E2E_TARGET } from "./e2e-target";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";

// 2026-08-19: was `<repo>/.leadgen-data` — the product's real demo data set,
// which this helper's own `restoreDemoData()` overwrites before every mutating
// test. It now points at the suite's throwaway directory, the same one
// globalSetup seeds and the same one the dev server is told to read.
const DATA_DIR = E2E_DATA_DIR;
const DATA_FILE = path.join(DATA_DIR, "app-data.json");
const LOCK_DIR = path.join(DATA_DIR, "app-data.lock");
export const SNAPSHOT_FILE = path.join(DATA_DIR, "app-data.snapshot.spec.json");

/** Save a pristine copy of the current demo data. Call ONCE before tests. */
export function snapshotDemoData(): void {
  if (!fs.existsSync(DATA_FILE)) {
    throw new Error(
      `Cannot snapshot: ${DATA_FILE} does not exist. Run \`npm run seed:demo --force\` first.`,
    );
  }
  fs.copyFileSync(DATA_FILE, SNAPSHOT_FILE);
  // Sanity: the snapshot must be a valid non-empty JSON object.
  const raw = fs.readFileSync(SNAPSHOT_FILE, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.workspaces)) {
    throw new Error("Snapshot failed validation: not a valid AppData object.");
  }
  console.log(`[snapshot] saved pristine demo data → ${SNAPSHOT_FILE} (${(raw.length / 1024).toFixed(1)} KB)`);
}

/**
 * Restore the pristine Postgres fixture (E2E_PRISMA_FULL mode).
 *
 * The JSON path below restores by copying a file back. Against a database that
 * does nothing at all, which is why the mutating specs were never allowed to
 * run on Postgres — and why every Postgres-only defect this repo has found was
 * found by hand. `pg_restore --clean` is the database equivalent: it drops what
 * the last test made and puts the baseline back.
 *
 * The dump is taken once, by scripts/e2e-pg-fixture.mjs, from a database loaded
 * with the SAME demo dataset the JSON suite seeds — so a spec asserting demo
 * content asserts the same content on both substrates, and a difference in
 * result is a difference in the SUBSTRATE, which is the entire point.
 */
function restorePrismaFixture(): void {
  const container = process.env.E2E_PG_CONTAINER || "leadgen-pg";
  const db = process.env.E2E_PG_DB || "leadgen_e2e";
  const user = process.env.E2E_PG_USER || "leadgen";
  const dump = process.env.E2E_PG_DUMP || "/tmp/e2e-pg-baseline.dump";
  try {
    execSync(
      `docker exec ${container} pg_restore -U ${user} -d ${db} --clean --if-exists --no-owner ${dump}`,
      { stdio: "pipe" },
    );
  } catch (e) {
    // pg_restore exits non-zero on benign "does not exist, skipping" notices
    // when a table the dump drops was already absent. A restore that actually
    // failed shows up immediately as the next test's assertions reading the
    // previous test's rows, and waitForServerQuiescent below catches an empty
    // database outright — so a hard throw here would fail runs that are fine.
    const msg = String((e as { stderr?: Buffer }).stderr || e);
    if (!/does not exist|errors ignored on restore/i.test(msg)) {
      throw new Error(`Postgres fixture restore failed:
${msg.slice(0, 800)}`);
    }
  }
}

/** Restore the pristine snapshot. Call before each mutating test. */
export function restoreDemoData(): void {
  if (E2E_TARGET === "prisma") {
    restorePrismaFixture();
    return;
  }
  if (!fs.existsSync(SNAPSHOT_FILE)) {
    throw new Error(
      `Cannot restore: ${SNAPSHOT_FILE} does not exist. Was snapshotDemoData() called?`,
    );
  }
  // Do not truncate a file that background API reads may have open. Prepare
  // the complete fixture beside it, then replace it in one filesystem action.
  // This is test-only data; the product JSON and database are never restored.
  const replacement = path.join(DATA_DIR, `app-data.restore-${randomUUID()}.tmp`);
  try {
    fs.copyFileSync(SNAPSHOT_FILE, replacement);
    const deadline = Date.now() + 1500;
    for (;;) {
      try { fs.renameSync(replacement, DATA_FILE); break; }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (!["EPERM", "EACCES", "EBUSY"].includes(code || "") || Date.now() >= deadline) throw error;
        // Windows may briefly hold the destination during a background read.
        // Keep the complete replacement; never fall back to a partial copy.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
  } finally {
    if (fs.existsSync(replacement)) fs.unlinkSync(replacement);
  }
  // Clear any stale lock dir from a crashed mutation.
  if (fs.existsSync(LOCK_DIR)) {
    try {
      fs.rmSync(LOCK_DIR, { recursive: true, force: true });
    } catch {
      // Best-effort; db.ts will auto-release after 15s anyway.
    }
  }
}

/** Wait until the dev server serves the restored data AND the business
 * profile is present (proves the full restore took effect, not a half-written
 * file mid-mutation). This eliminates the transient "Business profile
 * required" / "Profile required" errors that appear if a test fires an
 * endpoint while the restore is still being read. */
export async function waitForServerQuiescent(
  baseURL = E2E_BASE_URL,
  timeoutMs = 15000,
): Promise<void> {
  const start = Date.now();
  // 2026-08-19 (N-TEST-6) — this used to record ONLY the exception from a
  // failed fetch, so the two ways this actually fails in practice both threw
  // `Last error: ` with nothing after it:
  //
  //   - the server answered, but with HTTP 500 (a wedged dev server adopted
  //     via reuseExistingServer — "Jest worker encountered 2 child process
  //     exceptions" — cost a whole 66-test run before anyone knew why);
  //   - the server answered 200 but reported totalLeads: 0 (a restore that did
  //     not land, or a seed that wrote somewhere else).
  //
  // Those need completely different fixes and the message named neither.
  let lastProblem = "no request completed";
  while (Date.now() - start < timeoutMs) {
    try {
      // The /api/state summary must load AND report a non-zero lead count
      // (proves workspace_demo's full data, including the profile, is back).
      const resp = await fetch(`${baseURL}/api/state`, {
        headers: { Cookie: "lc_demo=1" },
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        lastProblem =
          `HTTP ${resp.status} from ${baseURL}/api/state: ${text.slice(0, 200).replace(/\s+/g, " ")}`;
      } else {
        const body = await resp.json();
        if (body && typeof body.totalLeads === "number" && body.totalLeads > 0) {
          return; // restored data is fully visible to the server
        }
        lastProblem =
          `HTTP 200 but totalLeads=${JSON.stringify(body?.totalLeads)} — the server is not reading ` +
          `the file this helper restores (${DATA_FILE})`;
      }
    } catch (e) {
      lastProblem = `request failed: ${String(e)}`;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Dev server did not quiesce within ${timeoutMs}ms. Last problem: ${lastProblem}`);
}

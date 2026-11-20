/**
 * data-dir.ts — where the Playwright suite's JSON substrate lives.
 *
 * THE BUG THIS FIXES (2026-08-19, CEO-loop session 7).
 *
 * `globalSetup` runs `npm run seed:demo -- --force` before EVERY Playwright
 * run, and `seed:demo` REPLACES the whole file it writes to. That file was
 * `.leadgen-data/app-data.json` — which is not a test fixture. It is the
 * product's demo data set: one invented company, 15 leads, 523 knowledge
 * answers produced by a real DeepSeek extraction over 18 source documents, and
 * the source of record the JSON→Postgres migration reads.
 *
 * So running a single e2e spec — even a read-only one, even `--grep` on one
 * test — would have destroyed the data set the migration had just been proven
 * against. Nothing warned; the seeder's own backup lands in
 * `.leadgen-data/backups/` under a timestamp nobody looks at.
 *
 * The two roles were sharing one path: a scratch fixture that is meant to be
 * overwritten on every run, and the real data set that must never be. Splitting
 * the path is the whole fix — the suite gets its own directory, and the seeder,
 * the snapshot helper, and the dev server the suite boots all point at it.
 *
 * Deliberately a CONSTANT and not `process.env.LEADGEN_DATA_DIR`. Three
 * separate processes have to agree on this path (the Playwright runner, the
 * `seed:demo` child process, and the Next dev server), and an env var read in
 * three places is three chances for one of them to fall back to the default and
 * quietly clobber the real file again. The env var is how we TELL the other two
 * processes; this file is what it is set from.
 */
import * as path from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

/** Repo root — this file is `<root>/e2e/helpers/data-dir.ts`. */
export const REPO_ROOT = path.resolve(__dirname, "..", "..");

/** The real demo/product data set. The suite must never write here. */
export const PRODUCT_DATA_DIR = path.join(REPO_ROOT, ".leadgen-data");

/** The suite's own throwaway JSON substrate. Safe to seed over on every run. */
// Windows source-tree watchers can keep the JSON destination locked even in a
// production-server test. Every fixture consumer uses this checkout-stable path;
// the actual product data stays where it is, and no existing data is moved.
const checkoutKey = createHash("sha256").update(process.platform === "win32" ? REPO_ROOT.toLowerCase() : REPO_ROOT).digest("hex").slice(0, 16);
export const E2E_DATA_DIR = path.join(tmpdir(), "leadcockpit-e2e", checkoutKey);

/**
 * The JSON file the SUITE's server reads and writes.
 *
 * Exported because nine `depth-*` specs assert persistence by reading the file
 * straight off disk, and every one of them had `path.join(REPO_ROOT,
 * ".leadgen-data", "app-data.json")` hard-coded. Once the paths were split
 * (see above) those specs were reading the PRODUCT file while the server wrote
 * to the suite's file, so a PUT that worked perfectly read back as "did not
 * persist" — 44 red tests, none of them a product bug. One constant, imported.
 */
export const E2E_DATA_FILE = path.join(E2E_DATA_DIR, "app-data.json");

/**
 * Fail loudly if the two ever collapse back into one path. This is the guard on
 * the fix itself: someone "simplifying" E2E_DATA_DIR back to `.leadgen-data`
 * would otherwise reintroduce the exact data loss, silently.
 */
export function assertE2EDataDirIsIsolated(candidate = E2E_DATA_DIR): void {
  const normalise = (value: string) => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  const contains = (parent: string, child: string) => {
    const relative = path.relative(normalise(parent), normalise(child));
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
  };
  if (contains(PRODUCT_DATA_DIR, candidate) || contains(candidate, PRODUCT_DATA_DIR) || contains(REPO_ROOT, candidate)) {
    throw new Error("E2E fixture must be outside the watched checkout and must not contain or overlap product data. Refusing to re-seed.");
  }
}

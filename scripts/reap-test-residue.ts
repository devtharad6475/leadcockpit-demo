/**
 * reap-test-residue.ts — remove test-run leftovers from the live JSON demo
 * store, `.leadgen-data/app-data.json`.
 *
 * ─── THE PROBLEM THIS EXISTS FOR (N-DATA-2, measured 2026-08-26) ───────────
 *
 * The demo store held 16 workspaces. ONE of them was the demo company. The
 * other 15 were scratch workspaces left behind by golden runs — names like
 * "SVM Prisma 1787726368489_394049" and "Golden Dedup Prisma …" — plus 65
 * rows scoped to them, 2 platform admins, 4 platform audit entries, 5 platform
 * tickets and 24 ticket events. An operator opening the app in demo mode would
 * have seen the test suite's rubbish sitting in their own workspace list.
 *
 * It also caused a REAL safety failure, which is how it was found:
 * `golden-unroutable-contacts` went red because three of those leftover users
 * carried `@test.app` addresses — a domain that is registered and therefore
 * DELIVERABLE. A send test reads this exact file. The residue was one wrong
 * click away from mailing a stranger.
 *
 * ─── WHY THE LEAK HAPPENS ──────────────────────────────────────────────────
 *
 * `run-all-goldens.ts` isolates a logic golden's data directory
 * (force-json-provider.ts) and a hybrid golden's (isolate-json-data.ts), but a
 * PRISMA_GOLDEN runs under force-prisma-provider.ts, which pins the PROVIDER
 * and deliberately does not touch LEADGEN_DATA_DIR — it is supposed to be
 * talking to Postgres. Any code path inside such a golden that still resolves
 * to the JSON substrate therefore writes to the operator's real file.
 *
 * Isolating those goldens is the upstream fix and is tracked separately. This
 * script is the mop, and the new CASE in `golden-unroutable-contacts` is the
 * alarm that stops the mess accumulating silently again.
 *
 * ─── WHY AN ALLOWLIST AND NOT A LIST OF TEST PREFIXES ──────────────────────
 *
 * The obvious implementation reaps ids starting `ws_golden_`. The scripts in
 * this repo already generate FORTY distinct workspace-id prefixes, including a
 * bare `ws_${…}`, and the next golden somebody writes will invent the
 * forty-first. A blocklist covers the leaks that existed the day it was
 * written — the same trap `golden-unroutable-contacts` documents for its seed
 * file, which named `scripts/seed-demo.ts` literally and so never noticed
 * `scripts/seed-demo-prisma.ts`.
 *
 * So this reaps by exclusion: keep the demo workspace, keep anything named in
 * `.leadgen-data/keep-workspaces.json`, remove the rest. A novel prefix is
 * covered on the day it is invented rather than the day somebody remembers
 * this file exists.
 *
 * ─── SAFETY ────────────────────────────────────────────────────────────────
 *
 * Dry run by default. `--apply` writes, and only after taking a timestamped
 * backup beside the store. It never touches anything outside `.leadgen-data/`.
 *
 * Run:  npx tsx scripts/reap-test-residue.ts            (report only)
 *       npx tsx scripts/reap-test-residue.ts --apply    (write)
 */
import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import path from "node:path";
import { defaultWorkspaceId } from "../src/lib/db";

const ROOT = process.cwd();
const STORE = path.join(ROOT, ".leadgen-data", "app-data.json");
const KEEP_FILE = path.join(ROOT, ".leadgen-data", "keep-workspaces.json");
const APPLY = process.argv.includes("--apply");

if (!existsSync(STORE)) {
  console.error(`no store at ${STORE} — run \`npm run seed:demo -- --force\` first`);
  process.exit(1);
}

const raw = readFileSync(STORE, "utf8");
const data: Record<string, unknown> = JSON.parse(raw);

const keep = new Set<string>([defaultWorkspaceId]);
if (existsSync(KEEP_FILE)) {
  for (const id of JSON.parse(readFileSync(KEEP_FILE, "utf8")) as string[]) keep.add(id);
}

/**
 * Ids of the workspaces being reaped. Rows are matched against this set rather
 * than re-tested against the allowlist, so a row pointing at a workspace that
 * no longer exists at all is also swept — an orphan is residue too.
 */
const workspaces = (data.workspaces as Array<{ id: string; name?: string }> | undefined) ?? [];
const doomed = new Set(workspaces.filter((w) => !keep.has(w.id)).map((w) => w.id));

/**
 * A workspace-scoped row whose workspaceId is neither kept nor a known doomed
 * workspace is an orphan: the workspace it belonged to is already gone. Sweep
 * it on the same pass, otherwise re-running this script never converges.
 */
const isResidueScope = (id: unknown): boolean => typeof id === "string" && !keep.has(id);

/**
 * Platform-level rows carry no workspaceId. Goldens mint their admins with a
 * `${Date.now()}_${random}` run id, which is what this shape matches. The
 * demo seeder creates NO platform admins at all (verified: `grep -n
 * platformAdmin scripts/seed-demo*.ts` returns nothing), so any admin in a
 * freshly seeded store arrived from a test run.
 */
const TEST_ADMIN_ID = /^admin_\d{13}_\d+$/;

const removed: Record<string, number> = {};
const note = (key: string, n: number) => { if (n > 0) removed[key] = (removed[key] ?? 0) + n; };

const doomedAdmins = new Set<string>();
for (const a of (data.platformAdmins as Array<{ id: string }> | undefined) ?? []) {
  if (TEST_ADMIN_ID.test(a.id)) doomedAdmins.add(a.id);
}

for (const [key, value] of Object.entries(data)) {
  if (!Array.isArray(value)) continue;
  const before = value.length;

  const kept = value.filter((row) => {
    if (!row || typeof row !== "object") return true;
    const r = row as Record<string, unknown>;

    if (key === "workspaces") return keep.has(String(r.id));
    if ("workspaceId" in r) return !isResidueScope(r.workspaceId);

    // The two tables key the admin differently and the dry run caught it:
    // a credential row has its OWN uuid `id` (platform_admin_cred_<uuid>)
    // alongside the `adminId` foreign key, so `id ?? adminId` read the uuid,
    // matched nothing, and would have left both credentials behind while
    // deleting the admins they belong to. Name the field per table.
    if (key === "platformAdmins") return !doomedAdmins.has(String(r.id));
    if (key === "platformAdminCredentials") return !doomedAdmins.has(String(r.adminId));
    if (key === "platformAuditLogs") {
      if (doomedAdmins.has(String(r.adminId))) return false;
      const meta = r.metadata as Record<string, unknown> | undefined;
      return !(meta && isResidueScope(meta.workspaceId));
    }
    // platformSupportHours and platformTicketSlaSettings are deliberately NOT
    // reaped. Both are single rows with id "default" holding ordinary global
    // configuration (09:00-18:00, four SLA windows) — no test identity, no
    // tenant data. The service creates them lazily on first write, so a test
    // run is what put them here, but the values are the same ones a first real
    // operator would produce. Removing them would buy nothing and briefly show
    // blank SLA settings on screen.
    return true;
  });

  note(key, before - kept.length);
  if (kept.length !== before) (data as Record<string, unknown>)[key] = kept;
}

const total = Object.values(removed).reduce((a, b) => a + b, 0);

console.log(`store:      ${STORE}`);
console.log(`keeping:    ${[...keep].join(", ")}`);
console.log(`reaping:    ${doomed.size} workspace(s), ${doomedAdmins.size} platform admin(s)`);
console.log("");
if (total === 0) {
  console.log("nothing to reap — the store holds no test residue.");
  process.exit(0);
}
for (const [key, n] of Object.entries(removed).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${key.padEnd(30)} ${String(n).padStart(4)} row(s)`);
}
console.log(`  ${"TOTAL".padEnd(30)} ${String(total).padStart(4)} row(s)`);
console.log("");

if (!APPLY) {
  console.log("dry run — nothing written. Re-run with --apply to remove these rows.");
  process.exit(0);
}

const backup = `${STORE}.bak-reap-${Date.now()}`;
copyFileSync(STORE, backup);
writeFileSync(STORE, `${JSON.stringify(data, null, 2)}\n`, "utf8");
console.log(`backup:  ${backup}`);
console.log(`written: ${total} row(s) removed`);

/**
 * Remove golden-test residue from the POSTGRES store.
 *
 * ── WHY THIS EXISTS (N-DATA-2, second substrate) ────────────────────────────
 * `scripts/reap-test-residue.ts` cleans the JSON store. It found 88 stray rows
 * and 15 scratch workspaces there. The same measurement against Postgres --
 * the substrate production actually runs on -- found the problem roughly
 * twenty-five times larger:
 *
 *     workspaces                    364   (1 real: workspace_demo)
 *     users                         252   (12 real)
 *     leads                         215   (45 real)
 *     platform_admins               307   (0 real)
 *     platform_admin_credentials    307   (0 real)
 *     platform_audit_logs           405
 *     impersonation_sessions         45
 *
 * 305 of those workspaces were created in a single day. 297 of the 307
 * platform-administrator accounts carried an `@test.app` address -- a
 * REGISTERED domain with live MX records, so those are not inert strings.
 * Every one of the 307 was a full-power platform account with a stored
 * credential, and not one of them was real: the seven that looked plausible
 * (`admin@leadcockpit.app`) turned out to be `admin+goldena@`,
 * `admin+goldenb@` ... created by a golden at 08:07 one morning.
 *
 * ── WHAT IT KEEPS, AND WHY IT IS AN ALLOWLIST ───────────────────────────────
 * Same rule as the JSON reaper, for the same reason. This repo's scripts
 * already generate forty distinct workspace-id prefixes, one of them a bare
 * `ws_${Date.now()}`. A blocklist of known-bad prefixes covers exactly the
 * leaks that existed the day it was written; an allowlist of known-good ids
 * covers the forty-first prefix on the day somebody invents it.
 *
 * The keep set is `defaultWorkspaceId` plus anything listed in
 * `.leadgen-data/keep-workspaces.json` -- deliberately THE SAME FILE the JSON
 * reaper reads, so "which workspaces are real" is stated once rather than
 * twice and cannot drift between the two substrates.
 *
 * Two global-config tables are deliberately NOT touched:
 * `platform_support_hours` and `platform_ticket_sla_settings`. Both hold a
 * single row keyed `default` carrying ordinary configuration (office hours,
 * four SLA windows). No test identity, no tenant data, nothing to reap.
 *
 * ── SAFETY ──────────────────────────────────────────────────────────────────
 * Dry run by default; `--apply` writes. Unlike the JSON reaper it cannot copy
 * the store to a `.bak` file itself, so `--apply` REFUSES to run unless a
 * recent `pg-full.bak-*.sql` dump exists under `.leadgen-data/`. Take one with:
 *
 *     docker exec leadgen-pg pg_dump -U leadgen -d leadgen \
 *       > ".leadgen-data/pg-full.bak-$(date +%s).sql"
 *
 * Deletes run inside ONE transaction. 107 of this schema's foreign keys are
 * ON DELETE CASCADE, so removing a workspace removes everything hanging off
 * it; the tables that carry no `workspace_id` at all are named explicitly
 * below rather than left to luck.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { prisma } from "../src/lib/prisma";
import { defaultWorkspaceId } from "../src/lib/db";

const ROOT = process.cwd();
const KEEP_FILE = path.join(ROOT, ".leadgen-data", "keep-workspaces.json");
// N-TEST-13: lead ids inside the demo workspace that are real and must survive.
const KEEP_DEMO_LEADS_FILE = path.join(ROOT, ".leadgen-data", "keep-demo-leads.json");
const BACKUP_DIR = path.join(ROOT, ".leadgen-data");
const APPLY = process.argv.includes("--apply");
const BACKUP_MAX_AGE_MS = 6 * 60 * 60 * 1000;

function keepSet(): string[] {
  const keep = new Set<string>([defaultWorkspaceId]);
  if (existsSync(KEEP_FILE)) {
    for (const id of JSON.parse(readFileSync(KEEP_FILE, "utf8")) as string[]) keep.add(id);
  }
  return [...keep];
}

/**
 * N-TEST-13 (2026-08-27): lead ids to spare inside the demo workspace.
 *
 * The workspace-level sweep above cannot see this debris — the demo workspace is
 * on the keep list, correctly, so everything inside it was exempt. 30 golden
 * fixture leads accumulated there unnoticed. The rule is the same one the
 * matching golden asserts: a lead in the demo workspace comes from the demo
 * seed, or it is residue.
 */
function keepDemoLeadIds(): string[] {
  if (!existsSync(KEEP_DEMO_LEADS_FILE)) return [];
  return JSON.parse(readFileSync(KEEP_DEMO_LEADS_FILE, "utf8")) as string[];
}

/** Newest `pg-full.bak-*.sql` under .leadgen-data, or undefined. */
function recentBackup(): { file: string; ageMs: number } | undefined {
  let best: { file: string; ageMs: number } | undefined;
  for (const name of readdirSync(BACKUP_DIR)) {
    if (!/^pg-full\.bak-\d+\.sql$/.test(name)) continue;
    const full = path.join(BACKUP_DIR, name);
    const ageMs = Date.now() - statSync(full).mtimeMs;
    if (!best || ageMs < best.ageMs) best = { file: full, ageMs };
  }
  return best;
}

async function main() {
  const keep = keepSet();
  const keepDemoLeads = keepDemoLeadIds();
  console.log("");
  console.log(`database:  ${process.env.DATABASE_URL ? "(from DATABASE_URL, not printed)" : "(unset)"}`);
  console.log(`keeping:   ${keep.join(", ")}`);
  console.log("");

  const counts = {
    workspaces: await prisma.$queryRaw<{ n: bigint }[]>`select count(*) n from workspaces where id <> all(${keep})`,
    platformAdmins: await prisma.$queryRaw<{ n: bigint }[]>`select count(*) n from platform_admins`,
    platformAuditLogs: await prisma.$queryRaw<{ n: bigint }[]>`select count(*) n from platform_audit_logs`,
    impersonationSessions: await prisma.$queryRaw<{ n: bigint }[]>`select count(*) n from impersonation_sessions`,
    demoLeadDebris: await prisma.$queryRaw<{ n: bigint }[]>`select count(*) n from leads where workspace_id = ${defaultWorkspaceId} and coalesce(source, '') <> 'demo_seed' and id <> all(${keepDemoLeads})`,
  };

  const rows: [string, number][] = [
    ["workspaces (cascades to 79 scoped tables)", Number(counts.workspaces[0].n)],
    ["platform_admins (cascades to credentials)", Number(counts.platformAdmins[0].n)],
    ["platform_audit_logs", Number(counts.platformAuditLogs[0].n)],
    ["impersonation_sessions", Number(counts.impersonationSessions[0].n)],
    ["leads inside the demo workspace not from the seed", Number(counts.demoLeadDebris[0].n)],
  ];
  const total = rows.reduce((a, [, n]) => a + n, 0);
  for (const [label, n] of rows) console.log(`  ${label.padEnd(44)} ${String(n).padStart(5)}`);
  console.log(`  ${"TOTAL (before cascades)".padEnd(44)} ${String(total).padStart(5)}`);
  console.log("");

  if (total === 0) {
    console.log("nothing to reap — the database holds no test residue.");
    return;
  }
  if (!APPLY) {
    console.log("dry run — nothing deleted. Re-run with --apply to remove these rows.");
    return;
  }

  const backup = recentBackup();
  if (!backup || backup.ageMs > BACKUP_MAX_AGE_MS) {
    console.error("");
    console.error("REFUSING TO APPLY — no recent database dump under .leadgen-data/.");
    console.error("This tool deletes through 107 cascading foreign keys and cannot undo itself.");
    console.error("Take one first:");
    console.error('  docker exec leadgen-pg pg_dump -U leadgen -d leadgen > ".leadgen-data/pg-full.bak-$(date +%s).sql"');
    process.exitCode = 2;
    return;
  }
  console.log(`backup:    ${path.basename(backup.file)} (${Math.round(backup.ageMs / 60000)} min old)`);

  await prisma.$transaction([
    prisma.$executeRaw`delete from workspaces where id <> all(${keep})`,
    prisma.$executeRaw`delete from platform_admins`,
    prisma.$executeRaw`delete from platform_audit_logs`,
    prisma.$executeRaw`delete from impersonation_sessions`,
    prisma.$executeRaw`delete from leads where workspace_id = ${defaultWorkspaceId} and coalesce(source, '') <> 'demo_seed' and id <> all(${keepDemoLeads})`,
  ]);
  console.log(`deleted:   ${total} row(s) plus everything cascading from them`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

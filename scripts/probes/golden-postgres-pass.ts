/**
 * golden-postgres-pass.ts — audit A-7: run the goldens that actually touch
 * storage against the substrate we actually ship on.
 *
 * THE PROBLEM. 182 goldens are green. 173 of them run on the JSON substrate.
 * Production runs Postgres. The suite's own banner has said so honestly for
 * weeks — "the JSON results transfer to production only while
 * golden-substrate-parity.ts stays green" — but that golden covers a fixed list
 * of operations, not the whole suite. Everything outside that list is a rule
 * proven on a substrate no customer will ever run.
 *
 * WHAT THIS IS NOT. It is not "run all 182 twice". Most of the suite never
 * reaches a database at all: it computes on an AppData object it built itself,
 * and a Postgres pass would prove nothing while costing a minute each. The
 * suite runner now MEASURES which goldens reach storage (see the census note in
 * run-all-goldens.ts) and writes the answer to _helpers/substrate-census.json.
 * This harness takes exactly that set — the ones whose evidence is "data-dir" —
 * and runs them again on Postgres.
 *
 * ISOLATION, AND WHY IT IS A TEMPLATE DATABASE. Each golden needs a database
 * that starts clean, or they overwrite each other's fixtures and the reds are
 * meaningless. Two obvious options are both wrong:
 *   - one shared schema for all of them: cross-contamination, exactly the bug
 *     that JSON isolation (F-P0-5) was introduced to fix;
 *   - `prisma migrate deploy` per golden: 30-odd migrations, dozens of seconds
 *     each, times 76.
 * Postgres has a third option. Migrate ONE template database once, then
 * `CREATE DATABASE x TEMPLATE ...` per golden, which is a file copy at the
 * storage layer and takes well under a second. Clean database per golden, one
 * migration run for the whole harness.
 *
 * WHAT IT DELETES, PRECISELY. It drops ONLY databases it created itself in this
 * run, whose names begin with the run prefix below, inside this project's own
 * Postgres container. It never touches `leadgen`, and it never touches anything
 * outside the project. The template database is created once and left in place
 * for the next run — dropping and re-migrating it every time would put back the
 * cost that the template exists to remove.
 *
 * EXPECT RED. A golden written against JSON may fail on Postgres for reasons
 * that are not bugs — it may rely on a fixture the JSON seed has and a fresh
 * Postgres does not. Those failures are the point: each one is either a real
 * substrate gap or a test that was never honest about what it needed. Sorting
 * them is the work this harness exists to make possible; it does not pretend to
 * do that sorting itself.
 *
 * Run: npx tsx scripts/probes/golden-postgres-pass.ts [--limit N] [--only <substr>]
 */
import { readFileSync, existsSync, statSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { Client } from "pg";

const CENSUS = path.resolve(process.cwd(), "scripts/golden/_helpers/substrate-census.json");
const TEMPLATE_DB = "leadgen_golden_template";
/** Every database this run creates carries this prefix; nothing else is dropped. */
const RUN_PREFIX = `golden_pass_${process.pid}_`;
const PRISMA_PRELOAD = "./scripts/golden/_helpers/force-prisma-provider.ts";
const PER_GOLDEN_TIMEOUT_MS = Number(process.env.PG_PASS_TIMEOUT_MS || 180_000);
/**
 * Where a golden's JSON writes go IF it falls back. Two reasons this is set:
 * a fallback must not be allowed to scribble on the shared demo file (that is
 * the F-P0-5 pollution bug), and the directory only comes into existence when
 * src/lib/db.ts actually reads or writes — so its presence afterwards is direct
 * evidence of which substrate the golden really used. Under the system temp
 * root, outside the project, and only ever created by the child.
 */
const FALLBACK_ROOT = path.join(os.tmpdir(), "leadgen-a7-pass");
/**
 * Every failure's FULL output, one file per golden, outside the project. The
 * console line is a one-line diagnosis; triage needs the stack. Without this the
 * harness reported 23 failures that all looked identical, because the console
 * line was the last two lines of a Prisma error — which are the same two lines
 * for every Prisma error ever thrown.
 */
const FAILURE_LOG_DIR = path.join(os.tmpdir(), "leadgen-a7-failures");

const args = process.argv.slice(2);
const limit = Number(args[args.indexOf("--limit") + 1]) || 0;
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : "";

/**
 * Read DATABASE_URL from .env as TEXT rather than loading it, so this process's
 * env — inherited by every child — is not changed as a side effect of reading a
 * config file. Same reason the suite runner does it this way.
 */
function databaseUrl(): string {
  const raw = readFileSync(path.resolve(process.cwd(), ".env"), "utf8");
  const line = raw.split(/\r?\n/).find((l) => /^\s*DATABASE_URL\s*=/.test(l));
  if (!line) throw new Error("DATABASE_URL is not set in .env");
  return line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "");
}

/**
 * Every variable in `.env`, parsed as TEXT, for use as the BASE of a child's
 * environment.
 *
 * WHY THIS EXISTS (A-7, 2026-08-26 — a harness gap that silently changed what
 * every golden in this pass was testing)
 * ---------------------------------------------------------------------------
 * Nothing in a golden loads `.env`. It arrives as a SIDE EFFECT: almost every
 * golden imports `@/repositories`, which imports `@prisma/client`, and Prisma
 * loads `.env` on import. That is how `AUTH_SESSION_SECRET`, `ENCRYPTION_KEY`
 * and the WhatsApp variables reach a golden under the ordinary suite.
 *
 * Prisma skips that load when `DATABASE_URL` is ALREADY set in the environment
 * — which is exactly what this harness does to point each golden at its own
 * cloned database. So every child of this probe has been running with an
 * entirely empty `.env`, and nobody noticed until two goldens that assert
 * production auth failed with:
 *
 *     AUTH_SESSION_SECRET must be set to a random value of at least 32 characters
 *
 * That was never a product bug and never a golden bug. It was this file
 * quietly removing 18 variables from the environment under test, which makes
 * the Postgres pass a comparison between two different systems rather than two
 * substrates. A harness that changes more than the one thing it claims to
 * change cannot be used as evidence.
 *
 * PRECEDENCE. Same rule dotenv uses, so a child sees what it would have seen:
 * a variable already in the real environment WINS over the file, and this
 * harness's own three overrides win over both.
 *
 * SAFETY. The values are never printed and never reach a command line — they
 * go into the child's env object only. `.env` carries a database password and
 * live API keys.
 */
function envFileVars(): Record<string, string> {
  const raw = readFileSync(path.resolve(process.cwd(), ".env"), "utf8");
  const vars: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!match) continue; // comment, blank, or a continuation we do not support
    vars[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
  }
  return vars;
}

/** The same server, a different database. Never logged — it carries a password. */
function urlForDatabase(base: string, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

/** host:port only. Safe to print; the rest of the URL is not. */
function whereIsIt(base: string): string {
  const url = new URL(base);
  return `${url.hostname}:${url.port || 5432}`;
}

/**
 * WHY A FAILURE NEEDS A CATEGORY, NOT A TAIL.
 *
 * The first version of this harness reported the last two lines of the child's
 * output. For a Prisma error those two lines are `clientVersion: '7.8.0'` and
 * `}` — identical for a missing foreign key, a unique violation and a null
 * constraint alike. Twenty-three distinct failures rendered as one, and the
 * triage that followed had to re-run each golden by hand to learn anything.
 *
 * So the harness reads the output for the sentence that actually names the
 * problem, in priority order, and stamps a category on it. The categories are
 * chosen to split the pile the way the FIX splits it:
 *
 *   FIXTURE   the golden referenced a row that does not exist in a clean
 *             database. JSON has no foreign keys, so the golden never had to be
 *             honest about what it needed. Fix = give it the fixture.
 *   CONFLICT  a unique constraint. Usually the golden assumes it is the only
 *             thing in the database, or re-seeds an id it already used.
 *   SCHEMA    a column or table Prisma does not have. That is a real gap
 *             between the two substrates and is a product bug, not test debt.
 *   ASSERTION the golden ran fine and disagreed with the product. THIS is the
 *             valuable pile — a rule that holds on JSON and breaks on Postgres.
 *   TIMEOUT   suspicion, never a verdict (N-TEST-2).
 *   SKIP      printed SKIP and exited non-zero — its own category, never a pass.
 *
 * Nothing here decides anything. It sorts, and it names the file holding the
 * full stack so the sorting can be checked rather than believed.
 */
type Diagnosis = { category: string; reason: string };

function diagnose(raw: string, timedOut: boolean): Diagnosis {
  const text = raw || "";
  if (timedOut) return { category: "TIMEOUT", reason: `no output for ${PER_GOLDEN_TIMEOUT_MS / 1000}s` };

  const fk = text.match(/Foreign key constraint violated on the constraint: `([^`]+)`/);
  if (fk) return { category: "FIXTURE", reason: `foreign key ${fk[1]} — it referenced a row a clean database does not have` };

  const missing = text.match(/An operation failed because it depends on one or more records that were required but not found[.:]?\s*([^\n]*)/);
  if (missing) return { category: "FIXTURE", reason: `required record not found${missing[1] ? ` — ${missing[1].trim().slice(0, 90)}` : ""}` };

  const uniq = text.match(/Unique constraint failed on the (?:fields|constraint): ?\(?([^)\n]+)\)?/);
  if (uniq) return { category: "CONFLICT", reason: `unique constraint on ${uniq[1].trim()}` };

  const nullish = text.match(/Null constraint violation on the (?:fields|constraint): ?\(?([^)\n]+)\)?/);
  if (nullish) return { category: "SCHEMA", reason: `null constraint on ${nullish[1].trim()}` };

  const unknownArg = text.match(/Unknown (?:argument|field) `([^`]+)`/);
  if (unknownArg) return { category: "SCHEMA", reason: `Prisma has no \`${unknownArg[1]}\` — the two substrates disagree on the shape` };

  const relation = text.match(/The (?:column|table) `([^`]+)` does not exist/);
  if (relation) return { category: "SCHEMA", reason: `${relation[1]} does not exist in the Prisma schema` };

  // The golden's own verdict lines. These are the interesting failures: the
  // golden ran, reached the product, and disagreed with it.
  const verdicts = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /(^|\s)(CASE .* FAIL|FAIL —|FAILED|❌)/.test(l) && !/CASES? PASS/.test(l));
  if (verdicts.length) {
    return {
      category: "ASSERTION",
      reason: `${verdicts.length} assertion(s) failed; first: ${verdicts[0].replace(/❌/g, "").trim().slice(0, 120)}`,
    };
  }

  if (/^\s*SKIP:/m.test(text)) {
    const skip = text.match(/^\s*(SKIP:[^\n]*)/m);
    return { category: "SKIP", reason: (skip?.[1] || "SKIP").slice(0, 120) };
  }

  const prismaCode = text.match(/code: '(P\d+)'/);
  const thrown = text.split("\n").map((l) => l.trim()).find((l) => /^(Error|TypeError|ReferenceError|SyntaxError|AssertionError):/.test(l));
  if (thrown) return { category: prismaCode ? "SCHEMA" : "CRASH", reason: thrown.slice(0, 140) };
  if (prismaCode) return { category: "SCHEMA", reason: `Prisma ${prismaCode[1]} with no message this harness recognises` };

  const tail = text.split("\n").map((l) => l.trim()).filter(Boolean).slice(-2).join(" | ");
  return { category: "UNKNOWN", reason: tail.slice(0, 160) || "no output at all" };
}

async function adminQuery(base: string, sql: string): Promise<void> {
  // Admin statements cannot run against the database being copied, so they run
  // against `leadgen` itself, which is never a template and never dropped here.
  const client = new Client({ connectionString: base });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

/**
 * PROOF OF USE. A golden that silently fell back to the JSON substrate would
 * print PASS just as loudly as one that ran on Postgres — and that failure mode
 * is the entire reason this audit exists. So every clone is interrogated before
 * it is dropped.
 *
 * A freshly created database gets its own row in pg_stat_database with every
 * counter at zero, and nothing but the golden's own child process ever connects
 * to it (this harness's admin statements run against `leadgen`). So
 * xact_commit + xact_rollback == 0 means, with no interpretation required, that
 * nothing ever opened a transaction there: the child did not use Postgres.
 * The row disappears when the database is dropped, so this must be read first.
 */
type PgActivity = { xacts: number; fetched: number; written: number };

async function pgActivity(base: string, name: string): Promise<PgActivity> {
  const client = new Client({ connectionString: base });
  await client.connect();
  try {
    const result = await client.query(
      `select xact_commit + xact_rollback as xacts,
              tup_returned + tup_fetched as fetched,
              tup_inserted + tup_updated + tup_deleted as written
         from pg_stat_database where datname = $1`,
      [name],
    );
    const row = result.rows[0] as { xacts: string; fetched: string; written: string } | undefined;
    if (!row) return { xacts: 0, fetched: 0, written: 0 };
    return { xacts: Number(row.xacts), fetched: Number(row.fetched), written: Number(row.written) };
  } finally {
    await client.end();
  }
}

/**
 * The other half of the same suspicion: a child that fell back to JSON does not
 * merely fail to touch Postgres, it touches the shared JSON file instead. This
 * fingerprints that file once before the run and once after; a change means some
 * child wrote to the substrate we are trying to prove we are not using.
 */
function sharedJsonFingerprint(): string {
  const file = path.resolve(process.cwd(), ".leadgen-data/app-data.json");
  try {
    const stat = statSync(file);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return "absent";
  }
}

async function databaseExists(base: string, name: string): Promise<boolean> {
  const client = new Client({ connectionString: base });
  await client.connect();
  try {
    const result = await client.query("select 1 from pg_database where datname = $1", [name]);
    return result.rowCount === 1;
  } finally {
    await client.end();
  }
}

async function main() {
  if (!existsSync(CENSUS)) {
    console.error("No substrate census. Run the full golden suite first: npx tsx scripts/run-all-goldens.ts");
    process.exit(2);
  }
  const census = JSON.parse(readFileSync(CENSUS, "utf8")) as {
    goldens: { rel: string; evidence: string; substrate: string }[];
  };
  let targets = census.goldens.filter((g) => g.evidence === "data-dir").map((g) => g.rel);
  if (only) targets = targets.filter((rel) => rel.includes(only));
  if (limit) targets = targets.slice(0, limit);

  const base = databaseUrl();
  console.log("AUDIT A-7 — Postgres pass over the goldens that actually touch storage");
  console.log(`  server:    ${whereIsIt(base)}`);
  console.log(`  targets:   ${targets.length} golden(s) (census evidence "data-dir")`);
  console.log(`  isolation: one database per golden, cloned from ${TEMPLATE_DB}`);
  console.log("");

  // Template, created once and RE-MIGRATED every run.
  //
  // It used to be reused as-is when it already existed, which is a trap: change
  // the Prisma schema, run this pass, and every golden gets cloned from a
  // database with yesterday's columns. The failure that produces looks like a
  // product bug and is not one. `migrate deploy` is idempotent and takes about
  // two seconds against an up-to-date database — once per run, not per golden —
  // so the cheap thing and the correct thing are the same thing here.
  const templateExisted = await databaseExists(base, TEMPLATE_DB);
  if (templateExisted) {
    console.log(`template ${TEMPLATE_DB} exists — re-applying migrations to it`);
  } else {
    console.log(`template ${TEMPLATE_DB} does not exist — creating and migrating it`);
    await adminQuery(base, `CREATE DATABASE "${TEMPLATE_DB}"`);
  }
  {
    const migrated = spawnSync("npx", ["prisma", "migrate", "deploy"], {
      cwd: process.cwd(),
      encoding: "utf8",
      shell: true,
      env: { ...envFileVars(), ...process.env, DATABASE_URL: urlForDatabase(base, TEMPLATE_DB) },
      timeout: 300_000,
    });
    if (migrated.status !== 0) {
      console.error(`migrate deploy failed on the template:\n${(migrated.stderr || migrated.stdout || "").slice(-2000)}`);
      process.exit(2);
    }
    console.log(templateExisted ? "template up to date" : "template migrated");
  }
  console.log("");

  const passed: string[] = [];
  const failed: { rel: string; category: string; reason: string; logFile: string }[] = [];
  // Only a FULL run may clear the log directory. A filtered run (--only /
  // --limit) regenerates one or two files, and wiping the rest would delete
  // the evidence from the full run it is following up on — which is exactly
  // what happened the first time this was used for triage.
  if (!only && !limit) rmSync(FAILURE_LOG_DIR, { recursive: true, force: true });
  mkdirSync(FAILURE_LOG_DIR, { recursive: true });
  /** PASSED, but never opened a transaction on its own database. Proves nothing. */
  const unproven: { rel: string; activity: PgActivity; fellBackToJson: boolean }[] = [];
  const readOnly: string[] = [];
  const jsonBefore = sharedJsonFingerprint();

  for (const [index, rel] of targets.entries()) {
    const db = `${RUN_PREFIX}${index}`;
    const label = rel.replace("scripts/golden/", "").padEnd(52);
    try {
      await adminQuery(base, `CREATE DATABASE "${db}" TEMPLATE "${TEMPLATE_DB}"`);
    } catch (error) {
      failed.push({ rel, category: "HARNESS", reason: `could not clone the template: ${(error as Error).message}`, logFile: "" });
      console.log(`  ERROR ${label} could not create its database`);
      continue;
    }
    let didPass = false;
    const fallbackDir = path.join(FALLBACK_ROOT, `${RUN_PREFIX}${index}`);
    try {
      execSync(`npx tsx --import ${PRISMA_PRELOAD} ${rel}`, {
        cwd: process.cwd(),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: PER_GOLDEN_TIMEOUT_MS,
        env: {
          // `.env` FIRST, then the real environment, then this harness's own
          // three overrides. See envFileVars() for why the file has to be here
          // at all: setting DATABASE_URL stops Prisma loading it, which used to
          // strip 18 variables from every golden in this pass.
          ...envFileVars(),
          ...process.env,
          PERSISTENCE_PROVIDER: "prisma",
          DATABASE_URL: urlForDatabase(base, db),
          LEADGEN_DATA_DIR: fallbackDir,
        },
      });
      passed.push(rel);
      didPass = true;
      console.log(`  PASS  ${label}`);
    } catch (error) {
      const shape = error as { stderr?: string; stdout?: string; message?: string; signal?: string; code?: number };
      const raw = `${shape.stdout || ""}\n${shape.stderr || ""}\n${shape.message || ""}`;
      const timedOut = shape.signal === "SIGTERM" || /ETIMEDOUT|timed out/i.test(shape.message || "");
      const { category, reason } = diagnose(raw, timedOut);
      // The full stack goes to a file, outside the project, named after the
      // golden. The console gets one line. Triage reads the file.
      const logFile = path.join(FAILURE_LOG_DIR, `${path.basename(rel, ".ts")}.log`);
      try {
        writeFileSync(logFile, raw, "utf8");
      } catch {
        /* a missing log must not turn a diagnosed failure into a crash */
      }
      failed.push({ rel, category, reason, logFile });
      console.log(`  FAIL  ${label} [${category}] ${reason}`);
    } finally {
      // Interrogate BEFORE the drop — dropping the database deletes its stats row.
      let activity: PgActivity = { xacts: 0, fetched: 0, written: 0 };
      try {
        activity = await pgActivity(base, db);
      } catch (error) {
        console.log(`  (could not read activity for ${db}: ${(error as Error).message})`);
      }
      const fellBackToJson = existsSync(fallbackDir);
      if (didPass) {
        if (activity.xacts === 0) {
          unproven.push({ rel, activity, fellBackToJson });
          console.log(
            `        ^ UNPROVEN: passed without ever opening a transaction on its database` +
              (fellBackToJson ? " — it used the JSON substrate instead" : ""),
          );
        } else if (activity.written === 0) {
          readOnly.push(rel);
        }
      }
      // Drops ONLY a database this run created, by name, in this project's own
      // container. Force-disconnect first: a golden that leaves a connection
      // open would otherwise block the drop and leak the database.
      try {
        await adminQuery(base, `DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
      } catch (error) {
        console.log(`  (could not drop ${db}: ${(error as Error).message} — drop it by hand)`);
      }
    }
  }

  const jsonAfter = sharedJsonFingerprint();

  console.log("");
  console.log(`=== A-7 POSTGRES PASS: ${passed.length} PASS / ${failed.length} FAIL (of ${targets.length}) ===`);
  console.log(`    of the passes: ${passed.length - unproven.length - readOnly.length} wrote to Postgres, ${readOnly.length} read only, ${unproven.length} never connected`);
  if (jsonBefore !== jsonAfter) {
    console.log("");
    console.log("!!! The shared JSON file .leadgen-data/app-data.json CHANGED during this run.");
    console.log("    Something fell back to the JSON substrate instead of using its database.");
  }
  if (failed.length) {
    console.log("");
    console.log("Failures — each is either a real substrate gap or a test that was never");
    console.log("honest about the fixtures it needs. Both are findings; neither is noise.");
    // Grouped by what the FIX would be, not alphabetically. A pile of twenty
    // failures sorted into four causes is triage; the same twenty in file order
    // is a to-do list that gets worked in the wrong order.
    const order = ["ASSERTION", "SCHEMA", "FIXTURE", "CONFLICT", "CRASH", "TIMEOUT", "SKIP", "HARNESS", "UNKNOWN"];
    const groups = new Map<string, typeof failed>();
    for (const entry of failed) {
      if (!groups.has(entry.category)) groups.set(entry.category, []);
      groups.get(entry.category)!.push(entry);
    }
    const meaning: Record<string, string> = {
      ASSERTION: "the golden ran and DISAGREED with the product on Postgres — the valuable pile, look here first",
      SCHEMA: "the two substrates disagree on the shape of the data — a product gap, not test debt",
      FIXTURE: "the golden referenced a row a clean database does not have — give it the fixture, never loosen the assertion",
      CONFLICT: "a unique constraint — the golden assumes it is alone in the database",
      CRASH: "the golden threw before it could assert anything",
      TIMEOUT: "a suspicion, not a verdict — re-run before believing it",
      SKIP: "printed SKIP and still exited non-zero — its own category, never a pass",
      HARNESS: "this harness failed, not the golden",
      UNKNOWN: "diagnose() did not recognise the output — read the log and teach it",
    };
    for (const category of order) {
      const entries = groups.get(category);
      if (!entries?.length) continue;
      console.log("");
      console.log(`  ${category} (${entries.length}) — ${meaning[category]}`);
      for (const entry of entries) {
        console.log(`    - ${entry.rel.replace("scripts/golden/", "")}: ${entry.reason}`);
      }
    }
    console.log("");
    console.log(`  full output for every failure: ${FAILURE_LOG_DIR}`);
  }
  if (unproven.length) {
    console.log("");
    console.log("Passed without proof — each of these ran green while its database sat");
    console.log("untouched, so it tested something, but not Postgres. Treat as a failure of");
    console.log("the harness's premise until each one is explained:");
    for (const entry of unproven) {
      console.log(
        `  - ${entry.rel.replace("scripts/golden/", "")}${entry.fellBackToJson ? "  (wrote JSON instead)" : "  (touched no storage at all)"}`,
      );
    }
  }
  // Never exit 0 on failures, and never exit 0 on unearned green either: a
  // harness that reports red and exits green is the reason nobody trusts
  // harnesses, and a pass that proves nothing is the quieter version of that.
  process.exit(failed.length || unproven.length || jsonBefore !== jsonAfter ? 1 : 0);
}

main().catch((error) => {
  console.error("A-7 PASS CRASHED:", error);
  process.exit(2);
});

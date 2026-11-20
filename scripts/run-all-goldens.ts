/**
 * run-all-goldens.ts — run every golden in scripts/golden/ + report pass/fail.
 * One-shot helper for batch verification.
 */
import { readdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import path from "node:path";
import { SCRATCH_ROOT, sweepScratchRoot } from "./golden/_helpers/golden-scratch";

const dir = path.resolve(process.cwd(), "scripts/golden");
// golden-demo-data-integrity is a PRE-DEMO GATE, not a regression-suite member.
// Its job: verify the demo file is demo-ready (single workspace_demo, coherent
// seed content) RIGHT BEFORE a demo. Running it inside the suite is dishonest
// because OTHER goldens in the suite legitimately pollute the shared demo file
// (Stage 5 finding F-P0-5 — the polluting goldens don't clean up; that's queued
// Batch 3 work). So this golden would always fail mid-suite for a reason that
// is NOT a regression. It is invoked STANDALONE as the last step before a demo:
//   npm run seed:demo -- --force && npm run golden:demo-data-integrity
// (and also by full-ui-sweep-v2 which boots a freshly-seeded server). Excluding
// it here keeps the suite honest about what it measures (per-golden correctness)
// vs. what the pre-demo gate measures (demo-file readiness).
// 2026-08-04 (L-2/L-4 cleanup): golden-docker-compose requires a working
// Docker daemon + does a ~170s image build. Under the parallel suite load it
// contends for resources + intermittently times out, producing a flaky red
// that isn't a regression (it passes 11/11 standalone). Like the pre-demo
// gate above, it's a DEPLOYMENT-READINESS check, not a regression-suite
// member. Run it standalone: `npm run golden:docker-compose`.
const SUITE_EXCLUDE = new Set(["golden-demo-data-integrity.ts", "golden-docker-compose.ts"]);
// SUITE_ONLY (2026-08-18, added while proving N-TEST-3) — substring filter on
// the golden filename, for exercising the RUNNER rather than the goldens. The
// suite takes ~10 minutes, which is the right cost for a regression check and
// the wrong cost for "does the new skip-reporting branch actually fire". It is
// a debugging aid only: it never runs in CI, and a filtered run prints a banner
// saying so, because a partial suite that looks like a full one is precisely
// the class of dishonest reporting N-TEST-3 was about.
//   SUITE_ONLY=dnc npx tsx scripts/run-all-goldens.ts
const SUITE_ONLY = process.env.SUITE_ONLY?.trim();
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".ts") && f !== "run-all-goldens.ts" && !SUITE_EXCLUDE.has(f))
  .filter((f) => !SUITE_ONLY || f.includes(SUITE_ONLY))
  .sort();
if (SUITE_ONLY) {
  console.log(`!! SUITE_ONLY=${SUITE_ONLY} — running ${files.length} of the suite. THIS IS NOT A FULL RUN.`);
  console.log("!! Nothing from a filtered run may be quoted as a suite result.");
  if (files.length === 0) {
    console.error(`No golden filename contains ${JSON.stringify(SUITE_ONLY)}.`);
    process.exit(1);
  }
}

// ─── Provider pinning (Stage 6 / 2026-07-31) ──────────────────────────────
// A LOGIC golden tests business logic (scoring, dedup rules, SLA math, RBAC
// maps) and must run on a deterministic JSON substrate — independent of `.env`.
// A PERSISTENCE golden proves the Prisma/Postgres runtime and needs `.env`'s
// DATABASE_URL. The two are distinguished by an OPT-IN marker: a persistence
// golden contains the literal `// PRISMA_GOLDEN` comment in its source. Every
// other golden is treated as a logic golden.
//
// HOW: logic goldens are run with `tsx --import ./scripts/golden/_helpers/
// force-json-provider.ts <golden>`. The preload sets PERSISTENCE_PROVIDER=json
// BEFORE the golden's module graph evaluates, so the service-layer
// `repositories` singleton (read once at module-load) also resolves to JSON.
// This MUST happen before module-load because ES imports are hoisted — a
// top-level env-set inside the golden is too late. The standalone `golden:*`
// npm scripts use the same `--import` flag, so a single golden run identically
// whether invoked via the runner or via `npm run golden:<name>`.
const PRELOAD = "./scripts/golden/_helpers/force-json-provider.ts";
function isPrismaGolden(rel: string): boolean {
  try {
    const src = readFileSync(path.resolve(process.cwd(), rel), "utf8");
    return src.includes("// PRISMA_GOLDEN");
  } catch {
    return false;
  }
}
// 2026-08-05 (audit F-1 follow-up) — a third category: a golden that manages
// BOTH substrates itself in one process (golden-substrate-parity.ts). It must
// NOT get force-json-provider's PERSISTENCE_PROVIDER=json pin (that would
// fight its own explicit createRepositories("prisma") call for the Prisma
// half), but it DOES need JSON-side data isolation so it never touches the
// shared demo file — that's a real bug this file shipped with once (see its
// own header for the postmortem). isolate-json-data.ts provides isolation
// without the provider pin.
// 2026-08-17 (CEO-loop session 2): PRISMA goldens get their own preload that
// pins PERSISTENCE_PROVIDER=prisma, so the substrate under test is decided by
// the test, not by whatever `.env` happens to say. See the helper's header.
const PRISMA_PRELOAD = "./scripts/golden/_helpers/force-prisma-provider.ts";
const HYBRID_PRELOAD = "./scripts/golden/_helpers/isolate-json-data.ts";
function isHybridGolden(rel: string): boolean {
  try {
    const src = readFileSync(path.resolve(process.cwd(), rel), "utf8");
    return src.includes("// HYBRID_GOLDEN");
  } catch {
    return false;
  }
}

let pass = 0;
let fail = 0;
const failed: string[] = [];
/**
 * N-TEST-3 (2026-08-18, CEO-loop session 6) — a golden that DECLINED to run was
 * indistinguishable from one that passed.
 *
 * `golden-prisma-commercial-parity.ts` is env-gated: when it does not like
 * DATABASE_URL it prints `SKIP: …` and exits 0. This runner decided pass/fail
 * purely on the exit code, with the child's stdout thrown away
 * (`stdio: ["ignore", "ignore", "pipe"]`), so a golden that never touched a
 * database was counted in the same number as one that did — and then reported
 * in the "on Postgres" half of the substrate banner, which is the one line in
 * this output whose entire job is to stop that exact misreading.
 *
 * A test that opts out silently is worse than a missing test: a missing test is
 * a visible hole, while this one shows up as evidence. So the child's stdout is
 * now captured and a declared SKIP is reported in its own category — not a
 * pass, not a failure, and subtracted from the Postgres count.
 */
const skipped: { rel: string; why: string }[] = [];
/** First `SKIP:` line a golden printed, if it declined to run. */
function declaredSkip(stdout: string | undefined): string | undefined {
  const line = (stdout || "").split("\n").find((l) => l.trim().startsWith("SKIP:"));
  return line ? line.trim().replace(/^SKIP:\s*/, "") : undefined;
}
/** Goldens that timed out once and then passed on a serial retry (N-TEST-2). */
const recovered: string[] = [];

/**
 * N-TEST-2 (2026-08-17, CEO-loop session 3) — tell a TIMEOUT apart from a
 * FAILURE, and retry the timeout once before believing it.
 *
 * Two suite runs launched while a production build and a dev server were also
 * running each reported exactly one failure — `golden-rate-limit` in one,
 * `golden-agent-context` in the other — both `spawnSync ... ETIMEDOUT`, and
 * both passed cleanly (7/7 and 4/4) when re-run on their own. A DIFFERENT
 * golden failing each time is the signature of machine contention, not of a
 * regression.
 *
 * That matters more than it sounds: a red suite that is actually green is the
 * fastest way to teach everyone — human or model — to stop reading red. So a
 * timeout is no longer counted as a failure on the first sighting. It is
 * retried once, serially, with double the budget; only if the retry ALSO fails
 * does it count, and the summary says plainly which kind of failure it was.
 *
 * A real hang still fails, it just costs one extra run to confirm.
 */
// Overridable so the retry path itself can be exercised cheaply (set it low
// enough that everything times out) instead of only ever being observed by
// accident on a loaded machine.
const GOLDEN_TIMEOUT_MS = Number(process.env.GOLDEN_TIMEOUT_MS || 180_000);
/**
 * The one line a human needs from a failed golden.
 *
 * This used to be "the last two non-empty lines", and the last two lines of a
 * thrown Error are always the bottom of its stack trace — Node internals. A
 * real failure therefore reported:
 *
 *     ❌ golden-lead-create-field-fidelity.ts —
 *        at Module._load (node:internal/modules/cjs/loader:1300:12) | ...
 *
 * while the sentence that said what was actually wrong ("could not locate
 * normalizeLead() ... this golden's source parse needs updating") sat four lines
 * above and never reached the summary. Every golden in this suite states its
 * failure on a line of its own; this finds that line and falls back to the old
 * behaviour only when there isn't one.
 */
function failureLine(source: string): string {
  const lines = source.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const spoken = lines.find((l) => /GOLDEN FAILED|ASSERTION FAILED|CASE [A-Z0-9]+:|^Error:/.test(l));
  if (spoken) return spoken.slice(0, 400);
  return lines.slice(-2).join(" | ").slice(0, 400);
}

function isTimeout(e: unknown): boolean {
  const err = e as { signal?: string; code?: string; message?: string };
  // execSync surfaces a timeout as signal SIGTERM (Windows: ETIMEDOUT in the
  // message). Match both rather than trusting one platform's shape.
  return err.signal === "SIGTERM" || err.code === "ETIMEDOUT" || /ETIMEDOUT/.test(err.message || "");
}

// ─── Database reachability gate (2026-08-18, CEO-loop session 5 / N-DX-2) ──
// A Postgres golden run against a database that is switched off does not fail
// honestly. `golden-prisma-field-clearing` printed, verbatim:
//
//   ❌ golden-prisma-field-clearing FAILED — the split-brain field-clearing
//      bug is NOT fixed in Postgres.
//
// It is fixed. Nothing was listening on the port. That red accuses a shipped
// fix of having regressed, which is the single most expensive kind of wrong a
// test suite can be: it sends somebody to re-open working code.
//
// Text-scraping the child output cannot fix this — the goldens catch the
// connection error themselves and print their own verdict, so `ECONNREFUSED`
// never reaches the runner for some of them. So the check happens ONCE, UP
// FRONT, at the only level where the answer is unambiguous: can anything be
// reached at the host and port in DATABASE_URL at all.
//
// WHAT THIS DELIBERATELY DOES NOT DO: it does not turn a red into a green.
// Unreachable goldens are reported as NOT RUN, listed by name, and the suite
// still exits non-zero. "Did not run" is not "passed", and a suite that
// quietly downgraded a database outage to a pass would be worse than the
// misleading red it replaces.
//
// It also cannot mask a real defect: reachability is checked BEFORE anything
// runs, so if the database is up, every Postgres golden executes exactly as it
// did before and a genuine failure is still a failure.
function databaseHostPort(): { host: string; port: number } | undefined {
  // Read .env as TEXT rather than loading it. Loading would put DATABASE_URL
  // into this process's env, which every child then inherits — a change to
  // what the goldens run with, made as a side effect of a diagnostic.
  try {
    const raw = readFileSync(path.resolve(process.cwd(), ".env"), "utf8");
    const line = raw.split(/\r?\n/).find((l) => /^\s*DATABASE_URL\s*=/.test(l));
    if (!line) return undefined;
    const value = line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "");
    const url = new URL(value);
    return { host: url.hostname, port: Number(url.port || 5432) };
  } catch {
    return undefined;
  }
}

/**
 * True only when a TCP connection is refused, times out, or the host does not
 * resolve. A successful connect does NOT prove the credentials or the schema
 * are right — it only rules out "nothing is there", which is the one case that
 * produces the lying red above.
 *
 * Runs as an argv-passed child (`spawnSync`, no shell) so the connection string
 * is never interpolated into a command line — it carries a password.
 */
function databaseUnreachable(target: { host: string; port: number }): boolean {
  const probe =
    "const net=require('net');" +
    "const s=net.connect({host:process.argv[1],port:Number(process.argv[2])});" +
    "s.setTimeout(5000);" +
    "s.on('connect',()=>{s.destroy();process.exit(0);});" +
    "s.on('error',()=>process.exit(1));" +
    "s.on('timeout',()=>{s.destroy();process.exit(1);});";
  const r = spawnSync(process.execPath, ["-e", probe, target.host, String(target.port)], {
    stdio: "ignore", timeout: 10000,
  });
  return r.status !== 0;
}

// Postgres-touching = PRISMA_GOLDEN *and* HYBRID_GOLDEN. A hybrid golden runs
// one pass on each substrate, so a dead database kills it exactly as surely as
// it kills a pure Prisma golden — `golden-substrate-parity` was one of the four
// reds that prompted this gate.
const postgresGoldens = files.filter((f) => {
  const rel = `scripts/golden/${f}`;
  return isPrismaGolden(rel) || isHybridGolden(rel);
});
const dbTarget = postgresGoldens.length ? databaseHostPort() : undefined;
// Host and port only — never the connection string; it contains a password.
const dbDown = dbTarget ? databaseUnreachable(dbTarget) : false;
const notRun: string[] = [];
if (dbDown && dbTarget) {
  console.log("");
  console.log(`🔌 DATABASE UNREACHABLE at ${dbTarget.host}:${dbTarget.port} — nothing is listening there.`);
  console.log(`   Skipping the ${postgresGoldens.length} Postgres golden(s). They are reported as NOT RUN, not as passed.`);
  console.log("   Start it (`docker start leadgen-pg`) or point DATABASE_URL at a database that is running.");
  console.log("");
}

// ─── Substrate coverage census (audit A-7, 2026-08-25, CEO-loop session 20) ──
// THE PROBLEM. The banner further down reports the substrate split honestly —
// 173 on JSON, 9 on Postgres — but it reports the split of what the runner
// CHOSE, not of what the goldens actually DO. Production runs Postgres. A rule
// proven only on JSON is evidence about production only as far as
// golden-substrate-parity.ts carries it, and that golden covers a fixed list of
// operations, not the whole suite. So the real question is not "how many run on
// JSON" — it is "how many goldens that ACTUALLY TOUCH A DATABASE are never
// tried against the one we ship".
//
// Nobody can answer that by reading the files. A static grep for "repositories"
// says 117 of 184, and that number is wrong in both directions: some goldens
// import a service that never reaches storage, and golden-campaign-analytics-
// scoping imports the whole API route (which imports the repositories) while
// building its AppData by hand, so it touches no substrate at all.
//
// SO MEASURE IT, DO NOT DECLARE IT. force-json-provider.ts gives every logic
// golden its own data directory under the system temp root, and src/lib/db.ts
// creates that directory only when something actually reads or writes — a read
// of a missing file seeds and writes it. So the directory exists if and only if
// the golden reached persistence. The runner watches for it around each child.
//
// WHY THIS AND NOT INSTRUMENTATION: patching readData/mutateData would mean
// test-only code inside a production module, and ESM exports cannot be
// monkey-patched from the preload. This costs one readdir per golden, needs no
// production change, and cannot drift out of date because it is measured on
// every run rather than written down once.
//
// WHY IT ONLY REPORTS. It does not fail the suite yet. Turning it red today
// would make every run red for a known, already-recorded reason, and a suite
// that is red for a reason everybody knows about is a suite people stop
// reading — the exact failure N-TEST-2 and N-TEST-3 exist to prevent. It goes
// red when the Postgres coverage it is measuring actually exists.
// N-DATA-2: the scratch root now lives inside the project (see
// scripts/golden/_helpers/golden-scratch.ts). Imported rather than rebuilt
// here, because the runner reading a DIFFERENT directory than the preloads
// write to would silently report every JSON golden as "touched no substrate"
// -- a number that still reads like a measurement while measuring nothing.
const CENSUS_ROOT = SCRATCH_ROOT;

// Sweep before the first golden starts, never after the last one finishes:
// the census evidence IS the leftover directory, so cleaning up at the end of
// a run would destroy the thing the run is measuring. An hour of grace means
// a suite running in another terminal keeps its evidence.
{
  const { removed, kept } = sweepScratchRoot();
  if (removed > 0) console.log(`  \u{1f9f9} swept ${removed} stale scratch dir(s) from .golden-scratch (kept ${kept}).`);
}
const CENSUS_PATH = path.resolve(process.cwd(), "scripts/golden/_helpers/substrate-census.json");
/** Directory names under CENSUS_ROOT: `run-<pid>-<ms>`, written by the preload. */
function censusDirsSince(startedAt: number): string[] {
  try {
    return readdirSync(CENSUS_ROOT).filter((name) => {
      const stamp = Number(name.split("-")[2]);
      return Number.isFinite(stamp) && stamp >= startedAt;
    });
  } catch {
    return [];
  }
}
/** True if this golden left a data directory behind, i.e. it reached storage. */
function touchedPersistence(startedAt: number, before: Set<string>): boolean {
  return censusDirsSince(startedAt).some((name) => !before.has(name));
}
//
// WHAT THIS CANNOT SEE, SAID OUT LOUD. The data-directory trick only works for
// goldens that run under force-json-provider, because only that preload points
// LEADGEN_DATA_DIR at the watched temp root. A PRISMA_GOLDEN or HYBRID_GOLDEN
// gets no such directory, so the watcher observes nothing — and the first
// version of this census duly recorded all nine of them as "touched no
// substrate at all", which is plainly false: reaching Postgres is their entire
// job. That is the exact failure this file argues against everywhere else, a
// number that reads as a measurement while measuring something adjacent. So the
// evidence is now NAMED rather than reduced to a boolean: "data-dir" is
// observed, "declared-postgres" is true by declaration and unmeasurable here,
// and "none-observed" is the only one that means what it says.
type CensusEvidence = "data-dir" | "declared-postgres" | "none-observed";
const census: { rel: string; touched: boolean; evidence: CensusEvidence; substrate: "json" | "prisma" | "hybrid" }[] = [];
/**
 * Run one golden and record whether it reached storage while doing so.
 *
 * Every path that spawns a golden goes through here — including the N-TEST-2
 * retry — so a golden that only touches the database on its second attempt is
 * still counted. `touched` is OR-ed across attempts for the same reason.
 */
function runGolden(rel: string, cmd: string, childEnv: NodeJS.ProcessEnv, timeout: number): string {
  const startedAt = Date.now();
  const before = new Set(censusDirsSince(startedAt - 60_000));
  try {
    return execSync(cmd, { cwd: process.cwd(), encoding: "utf8", env: childEnv, stdio: ["ignore", "pipe", "pipe"], timeout });
  } finally {
    const substrate = isPrismaGolden(rel) ? "prisma" : isHybridGolden(rel) ? "hybrid" : "json";
    const observed = touchedPersistence(startedAt, before);
    const evidence: CensusEvidence =
      substrate !== "json" ? "declared-postgres" : observed ? "data-dir" : "none-observed";
    const touched = substrate !== "json" || observed;
    const existing = census.find((c) => c.rel === rel);
    if (existing) {
      // OR-ed across attempts: a golden that only reached storage on its retry
      // still reached storage.
      if (touched && !existing.touched) { existing.touched = true; existing.evidence = evidence; }
    } else census.push({ rel, touched, evidence, substrate });
  }
}


for (const f of files) {
  const rel = `scripts/golden/${f}`;
  const prisma = isPrismaGolden(rel);
  const hybrid = !prisma && isHybridGolden(rel);
  if (dbDown && (prisma || hybrid)) {
    notRun.push(rel);
    console.log(`  🔌 ${rel} — NOT RUN (database unreachable). This is not a pass.`);
    continue;
  }
  // Logic goldens: --import the JSON preload (pins provider + isolates data).
  // Prisma goldens: plain run (inherit .env, need DATABASE_URL).
  // Hybrid goldens: isolate JSON data WITHOUT pinning the provider.
  const cmd = prisma
    ? `npx tsx --import ${PRISMA_PRELOAD} ${rel}`
    : hybrid ? `npx tsx --import ${HYBRID_PRELOAD} ${rel}` : `npx tsx --import ${PRELOAD} ${rel}`;
  // 2026-08-04 root-fix: pass an EXPLICIT env to the child. The `--import`
  // preload sets PERSISTENCE_PROVIDER=json, but under `execSync` the child
  // inherits the parent's env FIRST — and when the parent loaded `.env`
  // (PERSISTENCE_PROVIDER="prisma"), whatever reads `.env` earliest in the
  // child's module graph can latch Prisma before the preload runs (the
  // golden-audit-fixes-aug04 FK-violation failure under `golden:all`).
  // Setting it in the child env guarantees JSON for logic goldens BEFORE any
  // module loads. Prisma goldens keep prisma (inherited). Belt + suspenders
  // alongside the preload — neither alone was reliable under child spawn.
  // Hybrid goldens keep the inherited env too (like Prisma goldens) — they
  // pick their own provider per pass via an explicit createRepositories(x)
  // argument, so pinning PERSISTENCE_PROVIDER here would fight that.
  // 2026-08-17 (CEO-loop session 2): Prisma goldens no longer merely INHERIT
  // `.env`. The old comment above assumed `.env` says PERSISTENCE_PROVIDER=
  // "prisma"; when it says "json" (demo mode, and what the 2026-08-13 UI audit
  // left behind) a PRISMA_GOLDEN's own `createRepositories("prisma")` bundle
  // wrote to Postgres while the SERVICES it calls read the JSON singleton →
  // "Admin not found." Pinning it here (belt) alongside force-prisma-provider
  // (suspenders) makes the Postgres substrate a property of the TEST, not of
  // the operator's shell — the same guarantee logic goldens already have.
  const childEnv = hybrid
    ? process.env
    : { ...process.env, PERSISTENCE_PROVIDER: prisma ? "prisma" : "json" };
  try {
    // A golden FAILS iff it exits non-zero (every golden calls process.exit(1)
    // on failure). execSync throws on non-zero exit. So success = no throw.
    // This is more honest than text-scraping the output (goldens use varied
    // success phrasing: "ALL GREEN", "PASS", "N passed, 0 failed", etc.).
    // 180s timeout — covers golden-test-isolation which spawns 4 child tsx
    // processes (signup-invite + platform-admin-ops × 2 runs each); cold
    // module loading on Windows pushes it past the original 120s. Other
    // goldens finish in <15s so this only affects the spawn-heavy one.
    const out = runGolden(rel, cmd, childEnv, GOLDEN_TIMEOUT_MS);
    const why = declaredSkip(out);
    if (why) {
      skipped.push({ rel, why });
      console.log(`  SKIPPED ${rel} — it exited 0 without testing anything: ${why}`);
      continue;
    }
    pass++;
  } catch (e) {
    // N-TEST-2: a timeout is a suspicion, not a verdict. Retry it once with a
    // doubled budget before counting it — see the note above isTimeout().
    if (isTimeout(e)) {
      console.log(`  ⏳ ${rel} — timed out after ${GOLDEN_TIMEOUT_MS / 1000}s; retrying once (machine may be busy)`);
      try {
        const rout = runGolden(rel, cmd, childEnv, GOLDEN_TIMEOUT_MS * 2);
        const rwhy = declaredSkip(rout);
        if (rwhy) {
          skipped.push({ rel, why: rwhy });
          console.log(`  SKIPPED ${rel} — it exited 0 on retry without testing anything: ${rwhy}`);
          continue;
        }
        pass++;
        recovered.push(rel);
        console.log(`  ✅ ${rel} — passed on retry (the first timeout was contention, not a defect)`);
        continue;
      } catch (retryErr) {
        fail++;
        failed.push(rel);
        const rerr = retryErr as { stderr?: string; stdout?: string; message?: string };
        const kind = isTimeout(retryErr) ? "TIMED OUT TWICE (real hang, or the budget is genuinely too small)" : "failed on retry";
        const rdetail = failureLine(rerr.stderr || rerr.stdout || rerr.message || "");
        console.log(`  ❌ ${rel} — ${kind} — ${rdetail}`);
        continue;
      }
    }
    fail++;
    failed.push(rel);
    const err = e as { stderr?: string; stdout?: string; message?: string };
    const detail = failureLine(err.stderr || err.stdout || err.message || "");
    console.log(`  ❌ ${rel} — ${detail}`);
  }
}

console.log("");
console.log(
  `=== GOLDEN SUITE: ${pass} PASS / ${fail} FAIL` +
  (skipped.length ? ` / ${skipped.length} SKIPPED` : "") +
  (notRun.length ? ` / ${notRun.length} NOT RUN` : "") +
  ` (of ${files.length}) ===`,
);
if (recovered.length) {
  // Never let a retry hide behind a green number: say what needed one.
  console.log(`    (${recovered.length} passed only after a retry — first run timed out: ${recovered.join(", ")})`);
}

// ─── Substrate honesty banner (2026-08-05, audit finding F-1) ──────────────
// The count above is easy to misread as "the product is proven". It is not:
// almost every golden in this suite runs on the JSON substrate, while
// PRODUCTION runs Prisma. Print the split explicitly so nobody — human or
// model — mistakes a green suite for a proven production runtime.
//
// The bridge between the two is `golden-substrate-parity.ts`: it drives BOTH
// repository implementations through one operation script and diffs the
// results. While THAT golden is green, a rule proven on JSON is also true on
// Prisma for the operations it covers, and the JSON-heavy split below is
// sound. If it ever goes red, the rest of this suite stops being evidence
// about production until the divergence is closed.
// N-TEST-3, second half: this line used to count PRISMA_GOLDEN only. A HYBRID
// golden runs one pass on EACH substrate — the db-down gate above already
// treats it as Postgres-touching, and counting it as "on JSON" here contradicts
// that thirty lines later. And a golden that skipped itself touched neither, so
// it is subtracted rather than quietly inflating the Postgres half.
const prismaCount = files.filter((f) => isPrismaGolden(`scripts/golden/${f}`)).length;
const hybridCount = files.filter((f) => !isPrismaGolden(`scripts/golden/${f}`) && isHybridGolden(`scripts/golden/${f}`)).length;
const skippedPostgres = skipped.filter(
  (s) => isPrismaGolden(s.rel) || isHybridGolden(s.rel),
).length;
const postgresRan = prismaCount + hybridCount - skippedPostgres;
// Both halves subtract their own skips. Caught by the N-TEST-3 negative
// control, which showed `0 PASS / 1 SKIPPED` above a split line still claiming
// "1 on JSON" — the Postgres half had been taught to subtract and the JSON half
// had not, so the same output disagreed with itself two lines apart.
const skippedJson = skipped.length - skippedPostgres;
const jsonRan = files.length - prismaCount - hybridCount - skippedJson;
console.log(
  `    substrate split: ${jsonRan} on JSON · ` +
  `${postgresRan} touched Postgres (${prismaCount} Prisma` +
  `${hybridCount ? ` + ${hybridCount} hybrid, which runs BOTH substrates` : ""}` +
  `${skippedPostgres ? `, minus ${skippedPostgres} that skipped itself` : ""})`,
);
console.log("    the JSON results transfer to production only while");
console.log("    golden-substrate-parity.ts stays green (audit F-1).");

// ─── What the split above does NOT tell you (audit A-7) ────────────────────
// Measured, not declared — see the note above CENSUS_ROOT. A golden that never
// reached storage is substrate-independent BY CONSTRUCTION: it computes on data
// it built itself, and running it against Postgres would prove nothing and cost
// a minute. A golden that DID reach storage, and only ever reaches the JSON one,
// is a gap: it is evidence about a substrate we do not sell.
const reachedStorage = census.filter((c) => c.touched);
const jsonOnlyGap = census.filter((c) => c.evidence === "data-dir");
const pureLogic = census.filter((c) => c.evidence === "none-observed");
if (census.length) {
  console.log("");
  console.log(
    `    substrate COVERAGE (measured this run): ${reachedStorage.length} of ${census.length} goldens actually reached storage.`,
  );
  console.log(
    `    ${pureLogic.length} touched no substrate at all — those are pure logic and need no Postgres pass.`,
  );
  if (jsonOnlyGap.length) {
    console.log(
      `    ⚠️  ${jsonOnlyGap.length} reached storage on JSON ONLY. Production is Postgres. That is audit A-7's real number.`,
    );
    console.log(`    Full list written to ${CENSUS_PATH}`);
  }
}
// Written on every FULL run, so it can never become a stale hand-maintained
// list. It is generated data: regenerate it, do not edit it.
//
// Deliberately NOT written on a SUITE_ONLY run: a filtered run would replace the
// coverage map of 184 goldens with the two it happened to run, and the file gives
// no hint that it is partial. That is the same dishonest-partial-report class as
// N-TEST-3, one file further downstream.
//
// Deliberately NO timestamp inside it either. It is committed, and a generated
// date would make every suite run produce a dirty file whose diff says nothing.
// With the content deterministic, a diff appears only when the coverage actually
// CHANGED — a golden started or stopped touching storage — which is the one thing
// anybody would want to be told about.
if (SUITE_ONLY) {
  console.log(`    (census not written — a filtered run must not overwrite the full coverage map)`);
} else try {
  writeFileSync(
    CENSUS_PATH,
    JSON.stringify(
      {
        generatedBy: "scripts/run-all-goldens.ts",
        note:
          "Generated on every full suite run. Do not edit by hand. `evidence` says HOW we know: " +
          "\"data-dir\" = observed reaching storage, because the golden created its own JSON data directory; " +
          "\"declared-postgres\" = a PRISMA_GOLDEN or HYBRID_GOLDEN, which reaches a database by definition and " +
          "is not measurable by that trick; \"none-observed\" = reached no substrate, so it is pure logic and " +
          "needs no Postgres pass. Audit A-7's scope is exactly the \"data-dir\" set.",
        totals: {
          goldens: census.length,
          reachedStorage: reachedStorage.length,
          pureLogic: pureLogic.length,
          jsonOnlyAndReachedStorage: jsonOnlyGap.length,
          alreadyOnPostgres: census.length - pureLogic.length - jsonOnlyGap.length,
        },
        goldens: census.slice().sort((a, b) => a.rel.localeCompare(b.rel)),
      },
      null,
      2,
    ) + String.fromCharCode(10),
    "utf8",
  );
} catch (e) {
  console.log(`    (could not write the substrate census: ${(e as Error).message})`);
}

// N-TEST-6 (2026-08-20, CEO-loop session 11) — say out loud that the suite is
// not the whole set of goldens. `(of N)` counts only what the runner chose to
// run, so "165 of 165" reads as "every golden in the repo is green" when two
// were removed from the denominator before counting began. Both exclusions are
// legitimate and reasoned above — but the reader of the output cannot see that
// reasoning, and a denominator that silently shrinks is the same class of
// dishonest reporting as the SKIP branch N-TEST-3 fixed. Naming them, with the
// command that runs each one, keeps the number honest and makes the standalone
// gate discoverable instead of folklore.
if (!SUITE_ONLY && SUITE_EXCLUDE.size) {
  const HOW_TO_RUN: Record<string, string> = {
    "golden-demo-data-integrity.ts": "npm run seed:demo -- --force && npm run golden:demo-data-integrity",
    "golden-docker-compose.ts": "npm run golden:docker-compose",
  };
  console.log("");
  console.log(`EXCLUDED FROM THIS SUITE — ${SUITE_EXCLUDE.size} golden(s) exist that the count above does NOT include:`);
  for (const f of [...SUITE_EXCLUDE].sort()) {
    console.log(`  - ${f} — run standalone: ${HOW_TO_RUN[f] || `npx tsx scripts/golden/${f}`}`);
  }
  console.log("  They are deployment/demo readiness gates, not regression members (see the note at");
  console.log("  the top of this file). Green above does not say anything about them either way.");
}

if (notRun.length) {
  console.log("");
  console.log(`NOT RUN — the database was unreachable, so these could not be attempted:`);
  for (const f of notRun) console.log(`  - ${f}`);
  console.log("  These are NOT failures and they are NOT passes. Nothing is known about them.");
}

if (skipped.length) {
  console.log("");
  console.log("SKIPPED — these exited 0 without testing anything. Nothing is proven by them:");
  for (const s of skipped) console.log(`  - ${s.rel}: ${s.why}`);
  console.log("  Counted separately on purpose. A golden that declines to run and is filed");
  console.log("  under PASS is worse than no golden at all — it reads as evidence.");
}

if (fail > 0) {
  console.log("FAILED:");
  for (const f of failed) console.log(`  - ${f}`);
  process.exit(1);
}
if (notRun.length) {
  // Deliberately non-zero. Every JSON golden passing while the Postgres half of
  // the suite never ran is not a green suite, and must not be reported as one.
  console.log(`ALL ${pass} GOLDENS THAT RAN ARE GREEN — but ${notRun.length} never ran. Not a green suite.`);
  process.exit(2);
}
if (skipped.length) {
  // Exit 0: a declared skip is a known, printed gap, not a failure — failing the
  // suite for it would just get the runner ignored. But the headline must not
  // claim more than happened.
  console.log(`${pass} GOLDENS GREEN — and ${skipped.length} skipped themselves. Not "all green".`);
  process.exit(0);
}
console.log("ALL GOLDENS GREEN ✅");
process.exit(0);

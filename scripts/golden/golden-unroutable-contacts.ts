/**
 * Golden test — Unroutable demo contacts (2026-08-17) — finding N-SAFETY-1.
 *
 * WHY THIS EXISTS
 * ---------------
 * This product sends real WhatsApp messages (src/services/WhatsAppCredentialService.ts
 * posts to https://graph.facebook.com/v20.0/). Gate G7 exists specifically to prove
 * a real outbound send works. That means the demo/seed data is one button-press away
 * from being dialled for real.
 *
 * The seed data used to contain numbers like `+971 50 111 0001` — a structurally
 * VALID Dubai mobile. Nothing in the code would have stopped a send test from
 * messaging whoever owns that number. "Looks fake" is not a safety property.
 *
 * THE RULE THIS PINS: fake contact data must be UNROUTABLE BY CONSTRUCTION —
 * impossible to deliver to, not merely unlikely to belong to someone.
 *
 *   Phones: `+91 00000 000NN`. An Indian mobile number's subscriber part always
 *           begins 6-9, never 0, so this range can never be assigned to anyone.
 *   Email/web: the RFC 2606 reserved `example.com` / `.example` TLD, which ICANN
 *           guarantees will never be delegated, so it can never resolve.
 *
 * WHAT IT SCANS
 *   - .leadgen-data/app-data.json  — the live demo store (all string values).
 *     This is the file the dev server actually serves, so it is the file a send
 *     test would actually read. It catches leaks written at RUNTIME, not just
 *     ones committed to source — the first run of this golden caught exactly
 *     that: an e2e spec had persisted `+919876543210` into the WhatsApp agent's
 *     escalation contact, which is the one number the agent actively dials.
 *   - src/lib/db.ts, scripts/seed-demo*.ts (BY GLOB — see seederFiles()),
 *     e2e/ *.spec.ts — the sources that WRITE contact data. Comment lines are
 *     skipped: a comment quoting a retired number (as seed-demo.ts does, to
 *     explain why it was retired) is documentation, not data, and must stay
 *     readable.
 *
 * WHAT IT DELIBERATELY DOES **NOT** FLAG (N-SAFETY-2, 2026-08-17)
 *   A full-repo sweep finds routable-shaped numbers in 22 files. 21 of them are
 *   goldens and smoke scripts where the number is a TEST INPUT, not a seeded
 *   contact — and `golden-find-lead-by-phone.ts:112` asserts that
 *   `+919876543210` / `+91 98765 43210` / `+91-98765-43210` all normalise to one
 *   value, i.e. the realistic Indian-mobile SHAPE is the thing under test.
 *   Renumbering those would be churn with real breakage risk, and a golden that
 *   flags 21 innocents is a golden somebody relaxes. The residual risk is real
 *   but lives elsewhere: prisma goldens leak `sp-*-prisma-ws` scratch
 *   workspaces into the live database (12 workspaces, 11 of them scratch, as of
 *   2026-08-17), and those carry leads with those numbers. The fix for that is
 *   reaping the scratch workspaces (queued under N-DATA-2), not renumbering
 *   test fixtures — remove the residue rather than disguise it.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *   It does not scan scripts/probes/_receipts/ or scripts/ui-screenshots/. Those
 *   are frozen historical evidence of past runs. Rewriting them would be
 *   falsifying a record, and nothing reads them to send a message.
 *
 * Run: npx tsx scripts/golden/golden-unroutable-contacts.ts
 */
export {};

// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { defaultWorkspaceId as DEMO_WORKSPACE_ID } from "../../src/lib/db";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

let passed = 0;
let failed = 0;
let skipped = 0;
const cases: Array<{ name: string; fn: () => void | Promise<void> }> = [];
function test(name: string, fn: () => void | Promise<void>) {
  cases.push({ name, fn });
}

/**
 * A case that needs something this machine may not have (CASE 10 needs the dev
 * Postgres running). It reports SKIPPED and is counted separately — never as a
 * pass. A developer without Docker should not get a red suite, and should also
 * never be told that a check ran when it did not.
 */
class Unavailable extends Error {}

const ROOT = process.cwd();

/** Anything shaped like an international phone number. */
const PHONE_SHAPE = /\+\d[\d\s\-()]{7,17}\d/g;

/**
 * The ONLY assignable-proof phone range this repo may use.
 * digits-only form: 91 + 00000 + 000NN → /^9100000\d{5}$/
 * (+910000000010 → "9100000"+"00010"; +910000009999 → "9100000"+"09999")
 */
const UNROUTABLE_PHONE = /^9100000\d{5}$/;

/** RFC 2606 reserved namespaces — guaranteed never delegated. */
function isReservedHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return (
    h === "example.com" ||
    h === "example.net" ||
    h === "example.org" ||
    h.endsWith(".example.com") ||
    h.endsWith(".example") ||
    h === "localhost" ||
    h.endsWith(".localhost") ||
    // internal placeholder namespace: `.demo` is not a delegated TLD
    h.endsWith(".demo") ||
    // bare IPs / ports used by local tooling are not deliverable addresses
    /^\d+\.\d+\.\d+\.\d+$/.test(h)
  );
}

function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

/** Collect every routable-looking phone in `text`, with line numbers. */
function findRoutablePhones(text: string, skipComments: boolean): string[] {
  const hits: string[] = [];
  text.split("\n").forEach((line, i) => {
    if (skipComments && isCommentLine(line)) return;
    for (const m of line.matchAll(PHONE_SHAPE)) {
      const digits = m[0].replace(/\D/g, "");
      if (!UNROUTABLE_PHONE.test(digits)) hits.push(`line ${i + 1}: ${m[0]}`);
    }
  });
  return hits;
}

function specFiles(): string[] {
  const dir = path.join(ROOT, "e2e");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".spec.ts"))
    .map((f) => path.join(dir, f));
}

/**
 * N-SAFETY-2 (2026-08-17): every demo seeder, found by GLOB rather than by name.
 *
 * The first version of this golden named its seed file literally — `scripts/
 * seed-demo.ts` — and so covered exactly the writers that existed the day it was
 * written. It therefore missed `scripts/seed-demo-prisma.ts`, which writes the
 * same kind of contact data into POSTGRES: the substrate decision D3 says we
 * ship on, aimed at Neon by its own header. The rule ended up enforced on the
 * substrate we don't ship and unenforced on the one we do.
 *
 * A glob fixes the class, not the instance: seeder #3 is covered the day it is
 * created rather than the day somebody remembers this file exists.
 */
function seederFiles(): string[] {
  const dir = path.join(ROOT, "scripts");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^seed-demo.*\.ts$/.test(f))
    .map((f) => path.join(dir, f));
}

/** Collect every deliverable email domain in `text`, skipping comment lines. */
function findDeliverableEmailDomains(text: string): string[] {
  const hits: string[] = [];
  text.split("\n").forEach((line, i) => {
    if (isCommentLine(line)) return;
    for (const m of line.matchAll(/[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g)) {
      if (!isReservedHost(m[1])) hits.push(`line ${i + 1}: ${m[0]}`);
    }
  });
  return hits;
}

// ─── CASES ───────────────────────────────────────────────────────────────────

test("CASE 1 — every phone in the live demo store is unroutable by construction", () => {
  const file = path.join(ROOT, ".leadgen-data", "app-data.json");
  assert(existsSync(file), "missing .leadgen-data/app-data.json — run `npm run seed:demo -- --force`");
  const raw = readFileSync(file, "utf8");
  const bad = [...new Set([...raw.matchAll(PHONE_SHAPE)].map((m) => m[0]))].filter(
    (p) => !UNROUTABLE_PHONE.test(p.replace(/\D/g, "")),
  );
  assert(
    bad.length === 0,
    `the demo store holds ${bad.length} phone number(s) that could reach a real person: ${bad.join(", ")}. ` +
      `A send test reads THIS file. Replace them with +91 00000 000NN (see N-SAFETY-1).`,
  );
});

test("CASE 2 — every email domain in the live demo store is RFC 2606 reserved", () => {
  const raw = readFileSync(path.join(ROOT, ".leadgen-data", "app-data.json"), "utf8");
  const domains = [
    ...new Set([...raw.matchAll(/[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g)].map((m) => m[1])),
  ];
  const bad = domains.filter((d) => !isReservedHost(d));
  assert(
    bad.length === 0,
    `the demo store holds ${bad.length} deliverable email domain(s): ${bad.join(", ")}. ` +
      `Use example.com or a *.example domain so mail can never be delivered (N-SAFETY-1).`,
  );
});

test("CASE 3 — every http(s) host in the live demo store is RFC 2606 reserved", () => {
  const raw = readFileSync(path.join(ROOT, ".leadgen-data", "app-data.json"), "utf8");
  const hosts = [...new Set([...raw.matchAll(/https?:\/\/([A-Za-z0-9.-]+)/g)].map((m) => m[1]))];
  const bad = hosts.filter((h) => !isReservedHost(h));
  assert(
    bad.length === 0,
    `the demo store points at ${bad.length} real host(s): ${bad.join(", ")}. ` +
      `A crawl/enrich run would hit somebody's real server. Use *.example (N-SAFETY-1).`,
  );
});

test("CASE 4 — src/lib/db.ts (the fresh-install defaults) holds no routable phone", () => {
  const file = path.join(ROOT, "src", "lib", "db.ts");
  const hits = findRoutablePhones(readFileSync(file, "utf8"), true);
  assert(
    hits.length === 0,
    `src/lib/db.ts seeds a routable phone into every fresh install: ${hits.join(" | ")} (N-SAFETY-1)`,
  );
});

test("CASE 5 — no demo seeder (scripts/seed-demo*.ts) writes a routable phone", () => {
  const seeders = seederFiles();
  assert(seeders.length >= 2, `expected at least the JSON and Prisma seeders, found ${seeders.length}`);
  const offenders: string[] = [];
  for (const file of seeders) {
    const hits = findRoutablePhones(readFileSync(file, "utf8"), true);
    if (hits.length) offenders.push(`${path.relative(ROOT, file)} → ${hits.join(" | ")}`);
  }
  assert(
    offenders.length === 0,
    `a demo seeder writes a routable phone into its substrate: ${offenders.join(" ;; ")}. ` +
      `This covers BOTH substrates on purpose — seed-demo.ts writes JSON, seed-demo-prisma.ts ` +
      `writes the Postgres we ship on (N-SAFETY-1 / N-SAFETY-2).`,
  );
});

test("CASE 7 — no demo seeder writes a deliverable email domain", () => {
  const offenders: string[] = [];
  for (const file of seederFiles()) {
    const hits = findDeliverableEmailDomains(readFileSync(file, "utf8"));
    if (hits.length) offenders.push(`${path.relative(ROOT, file)} → ${hits.join(" | ")}`);
  }
  assert(
    offenders.length === 0,
    `a demo seeder writes an email at a REGISTRABLE domain: ${offenders.join(" ;; ")}. ` +
      `The Prisma seeder shipped with priya@aarnabridal.in — '.in' is a live TLD and ` +
      `aarnabridal.in can be bought by anyone. Use example.com or a *.example host (N-SAFETY-2).`,
  );
});

/**
 * N-SAFETY-3 (2026-08-18): goldens that write to a REAL database, found by the
 * opt-in marker they already carry rather than by name.
 *
 * When N-SAFETY-2 was closed I deliberately decided NOT to renumber the ~21
 * goldens holding realistic phone numbers, because in those files the number is
 * a pure test INPUT against an isolated JSON store — and one of them
 * (`golden-find-lead-by-phone.ts`) asserts that the realistic Indian-mobile
 * shape normalises correctly, i.e. the shape is the thing under test. That
 * reasoning was right for those files and WRONG for this handful, and I missed
 * the distinction: a golden carrying `PRISMA_GOLDEN` or `HYBRID_GOLDEN` writes
 * through the real repositories into the database D3 says we ship on. For the
 * length of every run, its "test input" is live contact data in the real DB.
 *
 * Two were found this way: `golden-substrate-parity.ts` (+91 98765 43210,
 * +919812345678, +919900112233) and `golden-webhook-dedup-prisma.ts`
 * (+919999000111). Both renumbered to the unroutable range.
 *
 * Marker-based discovery is the point: a golden gets covered on the day someone
 * marks it as database-writing, not on the day someone remembers this file.
 */
function realDatabaseGoldens(): string[] {
  const dir = path.join(ROOT, "scripts", "golden");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    // This file must not scan itself. It selects files by searching for the
    // marker names, so it necessarily CONTAINS those names, and it quotes
    // example numbers in its own failure messages — it flagged itself on the
    // first run for exactly that reason. A scanner that scans itself reports
    // its own vocabulary as a defect.
    .filter((f) => f !== path.basename(__filename))
    .map((f) => path.join(dir, f))
    .filter((file) => /PRISMA_GOLDEN|HYBRID_GOLDEN/.test(readFileSync(file, "utf8")));
}

test("CASE 8 — no database-writing golden holds a routable phone", () => {
  const files = realDatabaseGoldens();
  assert(files.length >= 2, `expected at least 2 goldens marked as database-writing, found ${files.length}`);
  const offenders: string[] = [];
  for (const file of files) {
    const hits = findRoutablePhones(readFileSync(file, "utf8"), true);
    if (hits.length) offenders.push(`${path.relative(ROOT, file)} → ${hits.join(" | ")}`);
  }
  assert(
    offenders.length === 0,
    `a golden that writes to the REAL database holds a routable phone: ${offenders.join(" ;; ")}. ` +
      `Unlike the JSON-pinned goldens, these persist their fixtures into the Postgres we ship on ` +
      `for the duration of every run, so the number must be unroutable by construction (N-SAFETY-3).`,
  );
});

test("CASE 6 — no e2e spec writes a routable phone into real app data", () => {
  const offenders: string[] = [];
  for (const file of specFiles()) {
    const hits = findRoutablePhones(readFileSync(file, "utf8"), true);
    if (hits.length) offenders.push(`${path.relative(ROOT, file)} → ${hits.join(" | ")}`);
  }
  assert(
    offenders.length === 0,
    `e2e specs POST contact data through the real API, so their values persist into the demo store ` +
      `and outlive the test run. Routable phone(s) found: ${offenders.join(" ;; ")} (N-SAFETY-1)`,
  );
});

test("CASE 9 — the live demo store holds no workspace the demo seeder did not create", () => {
  const raw = readFileSync(path.join(ROOT, ".leadgen-data", "app-data.json"), "utf8");
  const data = JSON.parse(raw) as Record<string, unknown>;

  const keepFile = path.join(ROOT, ".leadgen-data", "keep-workspaces.json");
  const keep = new Set<string>([DEMO_WORKSPACE_ID]);
  if (existsSync(keepFile)) {
    for (const id of JSON.parse(readFileSync(keepFile, "utf8")) as string[]) keep.add(id);
  }

  const workspaces = (data.workspaces as Array<{ id: string; name?: string }> | undefined) ?? [];
  const strays = workspaces.filter((w) => !keep.has(w.id));

  let scopedRows = 0;
  for (const value of Object.values(data)) {
    if (!Array.isArray(value)) continue;
    for (const row of value) {
      if (!row || typeof row !== "object") continue;
      const ws = (row as Record<string, unknown>).workspaceId;
      if (typeof ws === "string" && !keep.has(ws)) scopedRows++;
    }
  }

  assert(
    strays.length === 0 && scopedRows === 0,
    `the demo store holds ${strays.length} workspace(s) the seeder never created and ${scopedRows} row(s) ` +
      `scoped to them: ${strays.slice(0, 5).map((w) => `${w.id} (${w.name ?? "?"})`).join(", ")}` +
      `${strays.length > 5 ? `, +${strays.length - 5} more` : ""}. ` +
      `Run \`npx tsx scripts/reap-test-residue.ts --apply\` (N-DATA-2). ` +
      `If one of these is a workspace you created on purpose, list its id in ` +
      `.leadgen-data/keep-workspaces.json instead of relaxing this case.`,
  );
});

/**
 * CASE 10 — the same rule as CASE 9, against the substrate we actually ship on.
 *
 * WHY CASE 9 WAS NOT ENOUGH (N-DATA-2, second substrate, 2026-08-26).
 * CASE 9 watches `.leadgen-data/app-data.json` and, once the leak upstream of
 * it was closed, went quiet and stayed quiet. Meanwhile the dev Postgres —
 * the substrate production runs on, and the one the operator's app reads in
 * the shipping configuration — had accumulated **364 workspaces of which one
 * was real, 307 platform-administrator accounts of which none were, 405
 * platform audit logs and 45 impersonation sessions**. Roughly 25 times the
 * mess CASE 9 was built to catch, sitting in the more important store, with
 * no alarm pointed at it. An alarm on the substrate nobody ships is a smoke
 * detector in the garage.
 *
 * WHY IT READS `.env` AS TEXT INSTEAD OF `process.env.DATABASE_URL`.
 * This is the whole load-bearing decision in the case, so it is worth stating
 * plainly. Preloads and harnesses in this repo legitimately redirect a child
 * at a different database — `force-prisma-provider.ts` does it, and the queued
 * per-golden clone isolation will do it to every Prisma golden. An alarm that
 * read the environment would, on the day that lands, silently start inspecting
 * an empty throwaway clone and pass forever while the real database rotted.
 * That failure would be invisible, because a green case and a case watching
 * nothing look identical. Reading the file makes the alarm point at the
 * operator's database by construction, and no preload can move it.
 *
 * WHY PLATFORM ADMINS GET THEIR OWN ALLOWLIST.
 * The 79 tenant-scoped tables are covered by the workspace allowlist: a row is
 * residue if its workspace is. The six platform-tier tables carry no
 * `workspace_id` at all, which is exactly why nothing ever cleaned them and why
 * 307 of them piled up. They need their own statement of what is real, and it
 * has to be an allowlist for the same reason the workspace one is (L40): a
 * pattern-match on today's test emails covers today's fixtures and nothing
 * else. `.leadgen-data/keep-platform-admins.json` is that statement. It is
 * absent today, which asserts — correctly — that no real platform
 * administrator exists yet. When one is created, its address goes in the file.
 */
type PgResidue = { strayWorkspaces: string[]; scopedRows: number; admins: string[]; auditLogs: number; impersonations: number; demoLeadDebris: string[] };

/** DATABASE_URL from `.env`, as TEXT. Never printed — it carries a password. */
function devDatabaseUrl(): string {
  const envFile = path.join(ROOT, ".env");
  if (!existsSync(envFile)) throw new Unavailable("no .env file");
  const line = readFileSync(envFile, "utf8").split(/\r?\n/).find((l) => /^\s*DATABASE_URL\s*=/.test(l));
  if (!line) throw new Unavailable("DATABASE_URL is not set in .env");
  return line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "");
}

async function readPgResidue(keep: Set<string>, keptAdmins: Set<string>): Promise<PgResidue> {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: devDatabaseUrl(), connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
  } catch (e) {
    throw new Unavailable(`cannot reach the dev database (${(e as Error).message.slice(0, 60)})`);
  }
  try {
    const keepList = [...keep];
    const strays = await client.query<{ id: string; name: string | null }>(
      "select id, name from workspaces where id <> all($1) order by id limit 6",
      [keepList],
    );
    // Every table that carries a workspace_id, asked one at a time.
    //
    // The tempting version of this is a single query that builds each count with
    // `format(...)` and sums them. It was written that way first and it failed
    // with `invalid byte sequence for encoding "UTF8": 0x00` — quoting an array
    // parameter into generated SQL inside query_to_xml does not survive the
    // round trip. Eighty small parameterized counts are slower by a few
    // milliseconds and are obvious to read, and an alarm nobody can read is an
    // alarm somebody eventually relaxes.
    //
    // The table names come from the catalogue, never from a caller; the guard
    // below rejects any identifier that could break out of the quoting anyway.
    //
    // HONESTY ABOUT WHAT THIS COUNTER IS: today all 79 scoped tables carry a
    // foreign key on workspace_id, so a scoped row whose workspace is missing
    // cannot be created, and the stray-workspace check above catches everything
    // this counter would. It could not be proven able to fail on its own for
    // exactly that reason. It is here for the first scoped table somebody adds
    // WITHOUT that foreign key — at which point it becomes the only guard.
    const tables = await client.query<{ table_name: string }>(
      `select table_name from information_schema.columns
        where table_schema = 'public' and column_name = 'workspace_id' order by table_name`,
    );
    let scopedRows = 0;
    for (const { table_name: name } of tables.rows) {
      if (!/^[a-z_][a-z0-9_]*$/.test(name)) continue;
      const one = await client.query<{ n: string }>(
        `select count(*)::text n from public."${name}" where workspace_id <> all($1)`,
        [keepList],
      );
      scopedRows += Number(one.rows[0].n);
    }
    const admins = await client.query<{ email: string }>(
      "select email from platform_admins where email <> all($1) order by email limit 6",
      [[...keptAdmins]],
    );
    // N-TEST-13 (2026-08-27): everything above only looks at workspaces nobody
    // KEPT. The demo workspace is on the keep list — correctly, it is the demo —
    // so debris INSIDE it was invisible to this alarm, and 30 golden fixture
    // leads sat in it for a day without a single check going red. An alarm that
    // watches only the rooms nobody lives in is not an alarm.
    //
    // The rule: every lead in the shipped demo workspace comes from the demo
    // seed. Deliberately keyed on `source`, not on a hand-written list of
    // fixture company names — a hand-written list goes stale silently, which is
    // the failure mode this project has already paid for once.
    const demoLeadKeepFile = path.join(ROOT, ".leadgen-data", "keep-demo-leads.json");
    const keptLeadIds: string[] = existsSync(demoLeadKeepFile)
      ? (JSON.parse(readFileSync(demoLeadKeepFile, "utf8")) as string[])
      : [];
    const demoDebris = await client.query<{ id: string; company_name: string | null; source: string | null }>(
      `select id, company_name, source from leads
        where workspace_id = $1 and coalesce(source, '') <> 'demo_seed' and id <> all($2)
        order by created_at limit 6`,
      [DEMO_WORKSPACE_ID, keptLeadIds],
    );
    const audit = await client.query<{ n: string }>("select count(*)::text n from platform_audit_logs");
    const imp = await client.query<{ n: string }>("select count(*)::text n from impersonation_sessions");
    return {
      strayWorkspaces: strays.rows.map((r) => `${r.id} (${r.name ?? "?"})`),
      scopedRows,
      admins: admins.rows.map((r) => r.email),
      auditLogs: Number(audit.rows[0].n),
      impersonations: Number(imp.rows[0].n),
      demoLeadDebris: demoDebris.rows.map((r) => `${r.company_name ?? "(no name)"} [${r.source ?? "no source"}]`),
    };
  } finally {
    await client.end();
  }
}

test("CASE 10 — the live Postgres holds no workspace and no platform admin nobody created on purpose", async () => {
  const keep = new Set<string>([DEMO_WORKSPACE_ID]);
  const keepFile = path.join(ROOT, ".leadgen-data", "keep-workspaces.json");
  if (existsSync(keepFile)) {
    for (const id of JSON.parse(readFileSync(keepFile, "utf8")) as string[]) keep.add(id);
  }
  const keptAdmins = new Set<string>();
  const adminFile = path.join(ROOT, ".leadgen-data", "keep-platform-admins.json");
  if (existsSync(adminFile)) {
    for (const email of JSON.parse(readFileSync(adminFile, "utf8")) as string[]) keptAdmins.add(email);
  }
  // No sentinel for the empty case: `x <> all('{}')` is true for every row, so
  // an empty allowlist flags every platform admin. That is the correct reading
  // — today there is no real one — not an edge case to special-case away.
  // Checked against the database rather than assumed, because "ALL over an
  // empty array" is exactly the kind of SQL trivia that is easy to get backwards.
  const residue = await readPgResidue(keep, keptAdmins);

  const complaints: string[] = [];
  if (residue.strayWorkspaces.length) complaints.push(`${residue.strayWorkspaces.length}+ stray workspace(s): ${residue.strayWorkspaces.join(", ")}`);
  if (residue.scopedRows) complaints.push(`${residue.scopedRows} row(s) scoped to a workspace nobody kept`);
  if (residue.admins.length) complaints.push(`${residue.admins.length}+ platform admin(s) not on the keep list: ${residue.admins.join(", ")}`);
  if (residue.auditLogs) complaints.push(`${residue.auditLogs} platform audit log(s)`);
  if (residue.impersonations) complaints.push(`${residue.impersonations} impersonation session(s)`);
  if (residue.demoLeadDebris.length) complaints.push(`${residue.demoLeadDebris.length}+ lead(s) inside the demo workspace that the demo seed did not create: ${residue.demoLeadDebris.join(", ")}`);

  assert(
    complaints.length === 0,
    `the dev database holds test residue — ${complaints.join("; ")}. ` +
      `Run \`npx tsx scripts/reap-pg-residue.ts\` to see it and \`--apply\` to remove it (N-DATA-2). ` +
      `If one of these is real, list its workspace id in .leadgen-data/keep-workspaces.json, its ` +
      `email in .leadgen-data/keep-platform-admins.json, or its lead id in ` +
      `.leadgen-data/keep-demo-leads.json — do not relax this case. ` +
      `A platform admin is a full-power account on the substrate we ship on; 307 of them accumulated ` +
      `unnoticed once already, and 297 carried a domain that really accepts mail.`,
  );
});

// ─── RUN ─────────────────────────────────────────────────────────────────────

// Wrapped in a function rather than run at the top level: CASE 10 awaits a
// database round-trip, and tsx transpiles this file to CJS, where a top-level
// await is a build error rather than a runtime one.
async function run(): Promise<void> {
  for (const c of cases) {
    try {
      await c.fn();
      passed++;
      console.log(`  ✅ ${c.name}`);
    } catch (e) {
      if (e instanceof Unavailable) {
        skipped++;
        console.log(`  ⏭️  ${c.name}`);
        console.log(`     SKIPPED — ${e.message}. This case did NOT run; it is not a pass.`);
        continue;
      }
      failed++;
      console.error(`  ❌ ${c.name}`);
      console.error(`     ${(e as Error).message}`);
    }
  }
  console.log("");
  console.log(
    `unroutable-contacts: ${passed} passed, ${failed} failed${skipped ? `, ${skipped} SKIPPED (not run)` : ""} — ${failed === 0 ? "ALL GREEN ✅" : "FAIL ❌"}`,
  );
  if (failed > 0) {
    console.log("");
    console.log("RECOVERY: replace the offending value with +91 00000 000NN (phones) or a *.example host,");
    console.log("then re-run. Do NOT relax this golden — 'looks fake' is not the same as 'cannot be delivered'.");
    process.exit(1);
  }
}

run().catch((e) => {
  console.error(`unroutable-contacts CRASHED: ${(e as Error).message}`);
  process.exit(1);
});

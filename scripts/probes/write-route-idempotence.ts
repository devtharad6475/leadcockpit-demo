/**
 * write-route-idempotence.ts — the second-press sweep (2026-09-05, session 52).
 *
 * WHY THIS EXISTS
 * ---------------
 * Three real defects were found in one afternoon and all three were the same
 * shape: pressing the button twice did not equal pressing it once, and nothing
 * checked. Knowledge sync left a second complete copy of the search index
 * behind. Product research appended a second full set of products. The webhook
 * dedup cap trimmed nothing. Every one of them returned HTTP 200 both times, so
 * no status-code sweep could ever have found them — the wrongness is only
 * visible in what the database holds afterwards.
 *
 * So this sweep does not look at status codes. For each route it counts every
 * table in the database, calls the route, counts again, calls it a SECOND time,
 * and counts again. A route that is meant to save, sync, replace or regenerate
 * something should leave the same number of rows the second time. Any table
 * that grows on the second press is reported.
 *
 * IT REPORTS, IT DOES NOT JUDGE. Some growth is correct — an audit log records
 * that the button was pressed, and it is supposed to have two entries after two
 * presses. The output separates those (an expected-append list, stated per
 * route and defended in one line) from everything else, which needs a human
 * look. A sweep that guessed would either hide a real duplication or cry wolf
 * until it was ignored.
 *
 * IT RUNS AGAINST POSTGRES ON PURPOSE. The browser suite runs against the JSON
 * file substrate, where removal works. Every defect above existed only on
 * Postgres. A sweep pointed at JSON would have passed on all three.
 *
 * WHAT IT WRITES. Real rows, in the demo workspace, on the real local database
 * — that is the point. Re-seed afterwards with `npx tsx scripts/seed-demo.ts`
 * if the demo data matters for what you are doing next.
 */
import { readFileSync } from "node:fs";

const BASE_URL = process.env.SWEEP_BASE_URL || "http://127.0.0.1:3010";

/** Tables that legitimately gain a row every time a button is pressed. */
const APPEND_BY_DESIGN = new Set([
  "audit_logs",        // records that the action happened — two presses, two entries
  "event_logs",        // same, on the event bus
  "agent_runs",        // one run row per invocation, by design
  "job_runs",          // same
  "knowledge_base_query_logs", // one row per search performed
]);

type Route = {
  path: string;
  body: Record<string, unknown>;
  /** One line saying what the second press is expected to do. */
  expectation: string;
  /** Tables this specific route is allowed to grow on a second press, and why. */
  allowedGrowth?: Record<string, string>;
};

/**
 * The routes swept. Chosen by one rule: a second press should not create a
 * second copy of anything. Deliberately excluded, with reasons, because an
 * unexplained gap in a sweep is worse than a smaller sweep:
 *
 *   - anything under auth/ or admin/auth/ — signing in is not something this
 *     process does.
 *   - routes that create a NEW thing each time by design (orders, quotes,
 *     tickets, invites, leads/manual, whatsapp-templates). Two presses are
 *     meant to make two things; there is nothing to detect.
 *   - product-research/generate and documents/process — a live billed model
 *     call each, 80-120s. product-research is pinned instead by
 *     golden-mutateall-removal-parity CASE C, which proves the same property
 *     with no model call.
 *   - inbound/whatsapp-webhook — its whole job is to be called twice and do
 *     nothing the second time, which is what dedup is; it has its own goldens.
 *   - leads/discover and crawl/start — they reach the live internet.
 */
const ROUTES: Route[] = [
  {
    path: "knowledge/sync",
    body: {},
    expectation: "compiles approved answers into the searchable document — a re-sync REPLACES it",
  },
  {
    path: "knowledge/sync-business-profile",
    body: {},
    expectation: "pushes the business profile into the answer framework — re-running updates the same answers",
  },
  {
    path: "knowledge/structured-settings/sync",
    body: {},
    expectation: "pushes saved settings into the answer framework — re-running updates the same answers",
  },
  {
    path: "agent-autonomous/settings",
    body: { autoReplyEnabled: false },
    expectation: "saves one settings row per workspace",
  },
  {
    path: "lead-review/settings",
    body: { autoApproveThreshold: 80 },
    expectation: "saves one settings row per workspace",
  },
  {
    path: "tickets/sla-settings",
    body: { firstResponseMinutes: 60 },
    expectation: "saves one settings row per workspace",
  },
  {
    path: "workspace/insights",
    body: { note: "second-press sweep note" },
    expectation: "records an operator note — a second press is a second note, so only the note table may grow",
    allowedGrowth: { workspace_insights: "one note per press is the whole point of the endpoint" },
  },
  {
    path: "crawl/consent",
    body: { websiteUrl: "https://example.com", consentGiven: true },
    expectation: "records consent for one domain",
    allowedGrowth: {
      website_crawl_consents:
        "append-only ON PURPOSE. The row is the legal artifact proving permission to crawl was given, so each " +
        "answer is its own dated record and getLatestForUrl reads the newest. Collapsing them would destroy the " +
        "history that makes the record worth keeping, and revoking works by appending a consentGiven=false row.",
    },
  },
  {
    path: "knowledge/question-answers/approve-safe",
    body: {},
    expectation: "approves the answers that are safe to approve — the second run has nothing left to do",
  },
  {
    path: "settings/pending-drafts",
    // A sourceGroupKey on purpose: it is what the upsert matches on, so an
    // empty body would test the one path that CANNOT dedup and prove nothing.
    body: {
      kind: "structured",
      sourceGroupKey: "sweep_second_press",
      sourceTitle: "second-press sweep",
      sourceTopic: "sweep",
      sourceAnswer: "written by scripts/probes/write-route-idempotence.ts",
    },
    expectation: "saving the same draft twice updates the one draft, it does not make a second",
  },
  {
    path: "extraction-runs/cancel-active",
    body: {},
    expectation: "cancels whatever extraction is running — with nothing running it should do nothing at all",
  },
  {
    path: "settings/products/draft",
    body: { notes: "We sell rice in 25kg bags to wholesalers." },
    expectation: "turns notes into a draft to show the operator — it decides, it does not save",
  },
  {
    path: "settings/draft-from-answer",
    body: { domainKey: "products_services", relatedQuestionKeys: [], answer: "We sell rice in 25kg bags." },
    expectation: "turns one answer into a draft to show the operator — it decides, it does not save",
  },
];

type Counts = Map<string, number>;

async function tableCounts(): Promise<Counts> {
  const { prisma } = await import("@/lib/prisma");
  const tables: { table_name: string }[] = await prisma.$queryRawUnsafe(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name",
  );
  const names = tables.map((row) => row.table_name).filter((name) => name !== "_prisma_migrations");
  const union = names.map((name) => `SELECT '${name}' AS t, count(*)::int AS n FROM "${name}"`).join(" UNION ALL ");
  const rows: { t: string; n: number }[] = await prisma.$queryRawUnsafe(union);
  return new Map(rows.map((row) => [row.t, Number(row.n)]));
}

function diff(before: Counts, after: Counts): Map<string, number> {
  const out = new Map<string, number>();
  for (const [table, count] of after) {
    const grew = count - (before.get(table) ?? 0);
    if (grew !== 0) out.set(table, grew);
  }
  return out;
}

function describe(delta: Map<string, number>): string {
  if (!delta.size) return "nothing changed";
  return [...delta.entries()].map(([table, n]) => `${table} ${n > 0 ? "+" : ""}${n}`).join(", ");
}

async function main() {
  console.log("");
  console.log("=== WRITE-ROUTE IDEMPOTENCE SWEEP (against the real Postgres database) ===");
  console.log("");

  const provider = (readFileSync(".env", "utf8").match(/^PERSISTENCE_PROVIDER=(.*)$/m) || [])[1];
  const health = await fetch(`${BASE_URL}/api/health`).then((response) => response.json()).catch(() => null) as
    | { persistenceProvider?: string }
    | null;
  if (!health) {
    console.log(`  No server answering on ${BASE_URL}. Start it first — this sweep is about what a RUNNING app writes.`);
    process.exit(1);
  }
  if (health.persistenceProvider !== "prisma") {
    console.log(`  The server on ${BASE_URL} is running on "${health.persistenceProvider}", not Postgres.`);
    console.log("  That is the substrate this sweep exists to test. Refusing to run and report a green that proved nothing.");
    process.exit(1);
  }
  console.log(`  server: ${BASE_URL} · provider: ${health.persistenceProvider} (.env says ${provider})`);
  console.log("");

  const suspects: string[] = [];

  for (const route of ROUTES) {
    const before = await tableCounts();
    const first = await fetch(`${BASE_URL}/api/${route.path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(route.body),
    });
    const afterFirst = await tableCounts();
    const second = await fetch(`${BASE_URL}/api/${route.path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(route.body),
    });
    const afterSecond = await tableCounts();

    const delta1 = diff(before, afterFirst);
    const delta2 = diff(afterFirst, afterSecond);

    if (!first.ok || !second.ok) {
      console.log(`  SKIP  ${route.path} — HTTP ${first.status} then ${second.status}; nothing to compare`);
      continue;
    }

    const unexplained = [...delta2.entries()].filter(
      ([table, n]) => n > 0 && !APPEND_BY_DESIGN.has(table) && !(route.allowedGrowth || {})[table],
    );

    if (unexplained.length) {
      suspects.push(`${route.path}: ${unexplained.map(([table, n]) => `${table} +${n}`).join(", ")}`);
      console.log(`  GREW  ${route.path}`);
      console.log(`        ${route.expectation}`);
      console.log(`        first press:  ${describe(delta1)}`);
      console.log(`        SECOND press: ${describe(delta2)}`);
      console.log(`        unexplained:  ${unexplained.map(([table, n]) => `${table} +${n}`).join(", ")}`);
    } else {
      console.log(`  OK    ${route.path} — second press added nothing but bookkeeping (${describe(delta2) || "nothing"})`);
    }
  }

  console.log("");
  if (suspects.length) {
    console.log(`  ${suspects.length} route(s) grew on a second press and need a look:`);
    for (const line of suspects) console.log(`    - ${line}`);
  } else {
    console.log("  No route grew a data table on a second press.");
  }
  console.log("");

  const { prisma } = await import("@/lib/prisma");
  await prisma.$disconnect().catch(() => {});
  process.exit(suspects.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

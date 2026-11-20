/**
 * golden-missing-entity-is-404.ts — a row you cannot have is REFUSED, not empty.
 *
 * ── THE DEFECT (found 2026-08-26 by walking the product as two customers) ────
 * Signed in as tenant A, asking for tenant B's lead by id returned:
 *
 *     HTTP 200   null
 *
 * Nothing leaked. The query was correctly workspace-scoped, so it simply found
 * nothing, and the walk checked the body for tenant B's fields and found none.
 * What was wrong is the ANSWER. "Here you go, it is nothing" is a different
 * statement from "that does not exist", and the caller cannot tell an empty
 * record from a refused one. A tenant boundary that declines to say it declined
 * is a boundary you cannot audit, cannot alarm on, and cannot show a customer.
 *
 * ── HOW IT WAS BUILT, WHICH IS THE INTERESTING PART ─────────────────────────
 * Two correct decisions composed into a wrong one:
 *
 *   1. Every repository `getById` resolves to `undefined` when the row is not
 *      there. Reasonable.
 *   2. `json()` in the route file coerces `undefined` to `null` on purpose, so
 *      the serializer cannot throw. That coercion was added to stop a REAL 500
 *      (the 2026-07-27 sla-settings P0) and it did its job.
 *
 * Together they turn "not found" into "found, and empty". Note the direction:
 * the safety net converted a LOUD failure into a QUIET success. That is the
 * expensive kind of hiding, and it is why this went unnoticed through a
 * dedicated 101-route tenant sweep -- that sweep is a LEAK probe, and scored
 * `200` carrying no foreign id as a pass, with a comment saying so. It was
 * right about leaks and silent about answers.
 *
 * ── WHAT IS ASSERTED ────────────────────────────────────────────────────────
 * Behaviour of the helper the fix introduced:
 *   1. undefined  → 404 with a NOT_FOUND code (the repositories' actual miss value)
 *   2. null       → 404 as well (services return null rather than undefined)
 *   3. a real row → 200 carrying that row unchanged
 *   4. falsy-but-real values (0, "", false) are ROWS, not misses
 *
 * And the routes that must use it, asserted from source. Each source case first
 * proves its target EXISTS and then proves the property, so a route that gets
 * renamed or deleted turns this red instead of passing against nothing:
 *   5. no GET serves one entity by id through bare `json(await ...getById(...))`
 *   6. every sub-resource list under a parent id checks the parent first
 *
 * Run: npx tsx scripts/golden/golden-missing-entity-is-404.ts
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { jsonOne } from "@/lib/api-response";

const ROUTE_PATH = join(process.cwd(), "src", "app", "api", "[[...path]]", "route.ts");
const ROUTE = readFileSync(ROUTE_PATH, "utf8");

let passed = 0;
let failed = 0;
const cases: Array<{ name: string; fn: () => Promise<void> | void }> = [];
function test(name: string, fn: () => Promise<void> | void) {
  cases.push({ name, fn });
}

async function bodyOf(res: Response): Promise<unknown> {
  return JSON.parse(await res.text());
}

// ─── CASE 1 — undefined is what a repository actually returns on a miss ──────
test("CASE 1 — undefined becomes 404, not 200 null", async () => {
  const res = jsonOne(undefined, "Lead");
  assert.strictEqual(
    res.status,
    404,
    "THE DEFECT. Every repos.*.getById resolves to `undefined` when the row is absent " +
      "or belongs to another tenant. If that comes back 200 the caller is told the record " +
      "exists and is empty, which is not true.",
  );
  const body = (await bodyOf(res)) as { success?: boolean; error?: { code?: string; message?: string } };
  assert.strictEqual(body.success, false, "a refusal must not be shaped like a success");
  assert.strictEqual(body.error?.code, "NOT_FOUND", `expected a NOT_FOUND code, got ${body.error?.code}`);
  assert.match(
    String(body.error?.message),
    /Lead not found/,
    "the message must name what was not found, so an operator reading a log knows which lookup failed",
  );
});

// ─── CASE 2 — services hand back null rather than undefined ─────────────────
test("CASE 2 — null becomes 404 too", async () => {
  const res = jsonOne(null, "Document");
  assert.strictEqual(
    res.status,
    404,
    "the service layer (getKnowledgeDocument, getKnowledgeExtractionRun) returns null on a miss " +
      "while the repositories return undefined. Handling only one of the two leaves half the " +
      "routes still answering 200.",
  );
});

// ─── CASE 3 — a real row still comes back whole ─────────────────────────────
test("CASE 3 — a row the caller may have is returned unchanged, with 200", async () => {
  const lead = { id: "lead_1", companyName: "Acme Pipes", workspaceId: "ws_a" };
  const res = jsonOne(lead, "Lead");
  assert.strictEqual(res.status, 200, "the ordinary path must not have been broken by the fix");
  assert.deepStrictEqual(
    await bodyOf(res),
    lead,
    "the row must arrive intact — no envelope, no reshaping. Every existing caller reads it directly.",
  );
});

// ─── CASE 4 — falsy is not the same as absent ───────────────────────────────
test("CASE 4 — 0, empty string and false are rows, not misses", async () => {
  for (const value of [0, "", false] as const) {
    const res = jsonOne(value, "Thing");
    assert.strictEqual(
      res.status,
      200,
      `jsonOne(${JSON.stringify(value)}) must be 200. Writing this check as \`if (!value)\` ` +
        "would turn a legitimate zero — a count, a price, a disabled flag — into a 404. " +
        "That is the classic version of this bug, introduced while fixing this bug.",
    );
    assert.strictEqual(await bodyOf(res), value, "the falsy value itself must be returned");
  }
});

// ─── CASE 5 — no single-entity GET may go through bare json() ───────────────
test("CASE 5 — every one-row-by-id GET uses jsonOne, none use bare json", () => {
  const used = ROUTE.match(/return jsonOne\(await [^)]*?\.(getById|getLeadById)\(/g) ?? [];
  assert.ok(
    used.length >= 6,
    `TARGET CHECK: expected to find at least 6 single-entity GETs routed through jsonOne, found ` +
      `${used.length}. If the routes moved or were renamed this test is no longer looking at ` +
      `anything, and a silent pass would be worse than a failure.`,
  );

  const offenders = (ROUTE.match(/return json\(await repos\.[A-Za-z]+\.(getById|getLeadById)\([^)]*\)\)/g) ?? []);
  assert.deepStrictEqual(
    offenders,
    [],
    "REGRESSION GUARD. These serve exactly one row addressed by an id in the URL, so a miss is a " +
      "404, not a 200. Use jsonOne(...). Offending lines:\n  " + offenders.join("\n  "),
  );
});

// ─── CASE 6 — a list under a parent id checks the parent ────────────────────
test("CASE 6 — sub-resource lists refuse an unreachable parent instead of returning []", () => {
  // Each entry: the route's match() line, and the guard that must sit inside it.
  const guarded: Array<[string, string]> = [
    ['["crawl", ":jobId", "pages"]', "websiteCrawlJob.getById"],
    ['["outreach", ":leadId"]', "lead.getLeadById"],
    ['["extraction-runs", ":id", "batches"]', "getKnowledgeExtractionRun"],
    ['["tickets", ":id", "events"]', "ticket.getById"],
    ['["leads", ":id", "conversation-summary"]', "lead.getLeadById"],
    ['["leads", ":id", "reengagement-nudge"]', "lead.getLeadById"],
    ['["copilot", "conversations", ":id", "messages"]', "ownerCopilotConversation.getById"],
  ];

  for (const [pattern, guard] of guarded) {
    const at = ROUTE.indexOf(`match(path, ${pattern})`);
    assert.notStrictEqual(
      at,
      -1,
      `TARGET CHECK: route ${pattern} is gone. Either it was removed (then drop it from this ` +
        `list deliberately) or renamed (then this test has been watching nothing).`,
    );
    // Scan the whole handler body, not a fixed number of characters. The first
    // draft used `at + 900` and reported the copilot route as unguarded when the
    // guard was simply 1.1k characters down -- that route answers two patterns
    // from one `if`, so its body is long. A window that is too short does not
    // fail safe, it fails LOUD and wastes the reader's trust; the handler ends at
    // the next top-level `if (`, so say that instead of guessing a length.
    const end = ROUTE.indexOf("\n  if (", at + 1);
    assert.notStrictEqual(end, -1, `TARGET CHECK: cannot find the end of the ${pattern} handler`);
    const window = ROUTE.slice(at, end);
    assert.ok(
      window.includes(guard),
      `${pattern} builds a list scoped to a parent id supplied by the caller. Without a ` +
        `${guard}(...) check it answers 200 [] for a parent belonging to another customer — ` +
        `"this has no rows" where the truth is "this is not yours".`,
    );
    assert.ok(
      window.includes("notFoundResponse"),
      `${pattern} looks up the parent but does not refuse when it is missing. Looking and then ` +
        `ignoring the answer is the same 200 with extra steps.`,
    );
  }
});

// ─── RUN ────────────────────────────────────────────────────────────────────
async function main() {
  for (const c of cases) {
    try {
      await c.fn();
      passed++;
      console.log(`  ✅ ${c.name}`);
    } catch (e) {
      failed++;
      console.error(`  ❌ ${c.name}`);
      console.error(`     ${(e as Error).message}`);
    }
  }
  console.log(`\nmissing-entity-is-404: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

void main();

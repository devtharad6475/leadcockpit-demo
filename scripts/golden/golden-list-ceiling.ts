/**
 * Golden test — LIST CEILING + TRUNCATION HONESTY (2026-08-05, audit F-8).
 *
 * ─── WHY THIS EXISTS ───────────────────────────────────────────────────────
 *
 * `LeadListPagination.ts` (Session 7, P-3) added a page ceiling to
 * `GET /api/leads` — but ONLY on the opt-in `?limit`/`?offset` path. The
 * dashboard never opts in, so the code path carrying all the real traffic
 * stayed uncapped, as did every other list endpoint (`/api/replies`,
 * `/api/messages`, `/api/auto-reply-logs`, `/api/tickets`, `/api/orders`,
 * `/api/quotes`).
 *
 * `src/services/ListPagination.ts` now caps the bare path too. This golden
 * pins the two properties that matter:
 *
 *   1. THE CEILING HOLDS. No list response can exceed BARE_LIST_CEILING rows,
 *      whatever the caller passes.
 *   2. TRUNCATION IS NEVER SILENT. When rows are dropped, the true total is
 *      still reported, so the UI can say "showing 2,000 of 9,000" instead of
 *      rendering a confidently wrong count from a shortened array.
 *
 * Property 2 is the one worth protecting. A slow page is a nuisance; a
 * dashboard that quietly reports 2,000 leads when the workspace has 9,000 is a
 * business decision made on a false number.
 *
 * ─── HAND-COMPUTED EXPECTATIONS ────────────────────────────────────────────
 *
 *   DEFAULT_PAGE_SIZE  = 500
 *   MAX_PAGE_SIZE      = 1000
 *   BARE_LIST_CEILING  = 2000
 *
 *   paginate(9000 rows)                → items 500,  total 9000, hasMore true
 *   paginate(9000, limit=50)           → items 50,   offset 0,   hasMore true
 *   paginate(9000, limit=50, off=8990) → items 10,   hasMore false (8990+10=9000)
 *   paginate(9000, limit=99999)        → items 1000  (clamped to MAX_PAGE_SIZE)
 *   paginate(9000, limit=-5)           → items 500   (invalid → default)
 *   paginate(9000, offset=-5)          → offset 0    (invalid → 0)
 *   paginate(9000, offset=99999)       → items 0,    hasMore false (past the end)
 *   paginate(10 rows)                  → items 10,   total 10,   hasMore false
 *
 *   capBareList(1999 rows)             → 1999 rows, truncated FALSE
 *   capBareList(2000 rows)             → 2000 rows, truncated FALSE (boundary)
 *   capBareList(2001 rows)             → 2000 rows, truncated TRUE, total 2001
 *
 * Run: npm run golden:list-ceiling
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import {
  paginate,
  capBareList,
  paginationHeaders,
  safeLimit,
  safeOffset,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  BARE_LIST_CEILING,
} from "@/services/ListPagination";

type Case = { name: string; fn: () => void };
const cases: Case[] = [];
function test(name: string, fn: () => void) { cases.push({ name, fn }); }

/** A workspace that has outgrown every default. */
const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `row-${i}` }));
const BIG = rows(9000);

test("CASE A — constants are the documented values", () => {
  assert.strictEqual(DEFAULT_PAGE_SIZE, 500, "default page size");
  assert.strictEqual(MAX_PAGE_SIZE, 1000, "max page size");
  assert.strictEqual(BARE_LIST_CEILING, 2000, "bare list ceiling");
  assert.ok(BARE_LIST_CEILING >= MAX_PAGE_SIZE, "the bare ceiling must not be tighter than an explicit page");
});

test("CASE B — default page: 500 of 9000, hasMore", () => {
  const page = paginate(BIG);
  assert.strictEqual(page.items.length, 500, "500 items");
  assert.strictEqual(page.total, 9000, "total reports the FULL count, not the page size");
  assert.strictEqual(page.offset, 0, "offset 0");
  assert.strictEqual(page.hasMore, true, "hasMore");
});

test("CASE C — explicit limit + offset slice correctly", () => {
  const page = paginate(BIG, 50, 0);
  assert.strictEqual(page.items.length, 50);
  assert.strictEqual(page.items[0].id, "row-0", "first row of page 1");
  const page2 = paginate(BIG, 50, 50);
  assert.strictEqual(page2.items[0].id, "row-50", "first row of page 2");
  // 8990 + 10 = 9000 exactly, so no more pages.
  const last = paginate(BIG, 50, 8990);
  assert.strictEqual(last.items.length, 10, "final partial page has 10 rows");
  assert.strictEqual(last.hasMore, false, "no more after the final row");
});

test("CASE D — limit is CLAMPED; no caller can request an unbounded page", () => {
  assert.strictEqual(paginate(BIG, 99999).items.length, MAX_PAGE_SIZE, "99999 clamps to MAX_PAGE_SIZE");
  assert.strictEqual(paginate(BIG, Number.MAX_SAFE_INTEGER).items.length, MAX_PAGE_SIZE, "MAX_SAFE_INTEGER clamps");
  assert.strictEqual(paginate(BIG, Infinity).items.length, DEFAULT_PAGE_SIZE, "Infinity is not finite → default");
  assert.strictEqual(paginate(BIG, NaN).items.length, DEFAULT_PAGE_SIZE, "NaN → default");
  assert.strictEqual(paginate(BIG, -5).items.length, DEFAULT_PAGE_SIZE, "negative → default");
  assert.strictEqual(paginate(BIG, 0).items.length, DEFAULT_PAGE_SIZE, "zero → default");
});

test("CASE E — offset is clamped and reading past the end is empty, not an error", () => {
  assert.strictEqual(safeOffset(-5), 0, "negative offset → 0");
  assert.strictEqual(safeOffset(NaN), 0, "NaN offset → 0");
  assert.strictEqual(safeOffset(undefined), 0, "missing offset → 0");
  assert.strictEqual(safeLimit(undefined), DEFAULT_PAGE_SIZE, "missing limit → default");
  const past = paginate(BIG, 50, 99999);
  assert.strictEqual(past.items.length, 0, "reading past the end yields no rows");
  assert.strictEqual(past.hasMore, false, "and no more pages");
  assert.strictEqual(past.total, 9000, "but STILL reports the true total");
});

test("CASE F — a small workspace is completely unaffected", () => {
  const small = rows(10);
  const page = paginate(small);
  assert.strictEqual(page.items.length, 10, "all 10 rows");
  assert.strictEqual(page.hasMore, false, "no paging needed");
  const capped = capBareList(small);
  assert.strictEqual(capped.items.length, 10, "bare list returns everything");
  assert.strictEqual(capped.truncated, false, "and is not marked truncated");
});

test("CASE G — the bare-list ceiling holds exactly at the boundary", () => {
  const under = capBareList(rows(BARE_LIST_CEILING - 1));
  assert.strictEqual(under.items.length, BARE_LIST_CEILING - 1, "1999 rows pass through");
  assert.strictEqual(under.truncated, false, "1999 is not truncated");

  const exact = capBareList(rows(BARE_LIST_CEILING));
  assert.strictEqual(exact.items.length, BARE_LIST_CEILING, "2000 rows pass through");
  assert.strictEqual(exact.truncated, false, "exactly at the ceiling is NOT truncation (off-by-one guard)");

  const over = capBareList(rows(BARE_LIST_CEILING + 1));
  assert.strictEqual(over.items.length, BARE_LIST_CEILING, "2001 rows are capped to 2000");
  assert.strictEqual(over.truncated, true, "2001 IS truncated");
  assert.strictEqual(over.total, BARE_LIST_CEILING + 1, "and the TRUE total survives the cap");
});

test("CASE H — truncation is never silent (the property that matters)", () => {
  // The whole point: after capping, the caller can still tell the user the
  // truth. If this assertion ever fails, a dashboard somewhere starts printing
  // a wrong number with no warning.
  const capped = capBareList(BIG);
  assert.strictEqual(capped.items.length, BARE_LIST_CEILING, "capped to the ceiling");
  assert.strictEqual(capped.total, 9000, "TRUE total preserved");
  assert.notStrictEqual(capped.items.length, capped.total, "returned count differs from the total");

  const headers = paginationHeaders(capped);
  assert.strictEqual(headers["X-Total-Count"], "9000", "X-Total-Count reports reality");
  assert.strictEqual(headers["X-Returned-Count"], "2000", "X-Returned-Count reports what was sent");
  assert.strictEqual(headers["X-Truncated"], "true", "X-Truncated marks the response");

  // ...and an untruncated response must NOT carry the flag, or the UI would
  // show a scary banner on every normal load.
  const clean = paginationHeaders(capBareList(rows(5)));
  assert.strictEqual(clean["X-Truncated"], undefined, "no X-Truncated on a complete response");
  assert.strictEqual(clean["X-Total-Count"], "5", "total still reported on a complete response");
});

test("CASE I — paginate never mutates the caller's array", () => {
  const original = rows(100);
  const copy = [...original];
  paginate(original, 10, 10);
  capBareList(original, 5);
  assert.deepStrictEqual(original, copy, "the source array is untouched");
});

// --- RUNNER ----------------------------------------------------------------
let passed = 0;
let failed = 0;
for (const c of cases) {
  try {
    c.fn();
    passed++;
    console.log(`  ✅ ${c.name}`);
  } catch (e) {
    failed++;
    console.error(`  ❌ ${c.name}`);
    console.error(`     ${(e as Error).message}`);
  }
}
console.log("");
console.log(`list-ceiling: ${passed} passed, ${failed} failed — ${failed === 0 ? "ALL GREEN ✅" : "FAIL ❌"}`);
if (failed > 0) process.exit(1);

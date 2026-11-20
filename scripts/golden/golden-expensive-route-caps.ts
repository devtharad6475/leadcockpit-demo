/**
 * golden-expensive-route-caps.ts — every expensive route is rate-capped (NEW, S6 S-3).
 *
 * WHY THIS TEST EXISTS:
 *   Audit S6 S-3 found 13 expensive LLM/extraction/crawl routes with NO
 *   spending cap — a rogue or compromised account could burn the AI budget.
 *   Each was wired to checkRateLimit. This golden greps the route file to
 *   PROVE every expensive route still has a cap, so a future agent can't
 *   silently remove one (e.g. "while refactoring").
 *
 * HAND-COMPUTED CONTRACT (anti-cheat):
 *   For each expensive route pattern, the route handler block MUST contain a
 *   checkRateLimit call before its heavy work. We assert that the line range
 *   from the route's `match(...)` to the next `match(...` contains the
 *   substring "checkRateLimit". If a cap is removed, the substring search fails.
 *
 * REAL PIPELINE: reads the actual route.ts source (no mocks). If a future
 * agent deletes a checkRateLimit call, this fails instantly.
 *
 * Run: `npm run golden:expensive-route-caps`
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

const ROUTE_FILE = path.join(process.cwd(), "src/app/api/[[...path]]/route.ts");
const src = fs.readFileSync(ROUTE_FILE, "utf8");
const lines = src.split("\n");

type Case = { name: string; fn: () => Promise<void> };
const cases: Case[] = [];
function test(name: string, fn: () => Promise<void>) { cases.push({ name, fn }); }

// The 13 expensive routes that S6 S-3 wired. Each entry is a substring of the
// match() line; we find its line, then scan forward until the next match() and
// assert checkRateLimit appears in that block.
const EXPENSIVE_ROUTES = [
  'match(path, ["onboarding", "extract-company-knowledge"])',
  'match(path, ["crawl", ":jobId", "extract"])',
  'match(path, ["leads", "enrich-approved"])',
  'match(path, ["leads", ":id", "enrich"])',
  'match(path, ["analytics", "campaign", ":campaignId", "generate-learning"])',
  'match(path, ["whatsapp-agent", "dry-run"])',
  'match(path, ["leads", ":id", "generate-policy"])',
  'match(path, ["documents", ":id", "extract-questions"])',
  'match(path, ["extraction-runs", ":id", "retry-failed"])',
  'match(path, ["documents", "apply"])',
  'match(path, ["knowledge", "search"])',
  'match(path, ["knowledge", "sync"])',   // the full-sync form (not the questionKey/answer single-entry form)
  'match(path, ["knowledge", "documents"])', // POST create + auto-chunk
];

function blockHasRateLimit(routePattern: string, occurrence: "first" | "last" = "first"): boolean {
  // Find the start line of the route's handler block. Some patterns appear
  // twice (e.g. ["knowledge", "documents"] is both a GET list and a POST
  // create); "last" picks the POST create (the expensive one).
  let startIdx = -1;
  if (occurrence === "first") {
    startIdx = lines.findIndex((l) => l.includes(routePattern));
  } else {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].includes(routePattern)) { startIdx = i; break; }
    }
  }
  if (startIdx === -1) return false;
  // Scan forward until the next `if (match(path,` or end of handler.
  for (let i = startIdx; i < lines.length && i < startIdx + 40; i++) {
    if (i > startIdx && /if \(match\(path,/.test(lines[i])) break; // next route
    if (lines[i].includes("checkRateLimit")) return true;
  }
  return false;
}

test("CASE A — every expensive route has a checkRateLimit guard in its block", async () => {
  const missing: string[] = [];
  // Some patterns appear more than once: the FIRST occurrence is a cheap form
  // (GET list / single-entry upsert) and the LAST is the expensive one
  // (POST create / full re-sync). Use "last" for those.
  const LAST_OCCURRENCE = new Set([
    'match(path, ["knowledge", "documents"])', // GET list (cheap) vs POST create (expensive)
    'match(path, ["knowledge", "sync"])',       // single-entry upsert (cheap) vs full re-sync (expensive)
  ]);
  for (const route of EXPENSIVE_ROUTES) {
    const occurrence = LAST_OCCURRENCE.has(route) ? "last" : "first";
    if (!blockHasRateLimit(route, occurrence)) missing.push(route);
  }
  assert.strictEqual(missing.length, 0, `These expensive routes lost their rate cap:\n  ${missing.join("\n  ")}`);
  console.log(`  All ${EXPENSIVE_ROUTES.length} expensive routes are rate-capped.`);
});

test("CASE B — the new presets exist in the defaults map", async () => {
  const memFile = path.join(process.cwd(), "src/services/rate-limit/memoryBackend.ts");
  const mem = fs.readFileSync(memFile, "utf8");
  for (const preset of ["knowledge_sync", "lead_enrichment", "campaign_learning", "policy_pdf"]) {
    assert.ok(mem.includes(`${preset}:`), `preset "${preset}" must exist in the defaults map`);
  }
  console.log("  All 4 new presets (knowledge_sync, lead_enrichment, campaign_learning, policy_pdf) present.");
});

test("CASE C — count of checkRateLimit calls in route.ts is >= 25 (was 12 before S-3)", async () => {
  const count = (src.match(/checkRateLimit\(/g) || []).length;
  // Before S-3: 12 calls. After wiring 13 routes: ~25. Assert >= 25 so a
  // future mass-deletion is caught.
  assert.ok(count >= 25, `expected >= 25 checkRateLimit calls after S-3 wiring, got ${count}`);
  console.log(`  ${count} checkRateLimit calls present (was 12 pre-S-3).`);
});

// --- RUNNER ---------------------------------------------------------------------
(async () => {
  let passed = 0;
  let failed = 0;
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
  console.log("");
  console.log(`expensive-route-caps: ${passed} passed, ${failed} failed — ${failed === 0 ? "ALL GREEN ✅" : "FAIL ❌"}`);
  if (failed > 0) process.exit(1);
})();

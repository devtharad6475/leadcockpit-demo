/**
 * golden-whatsapp-window.ts — pins CP-24 (the 24-hour customer-service window).
 *
 * CONTRACTS (hand-computed):
 *   W1: isWithin24hWindow(now) → open, ~24h remaining.
 *   W2: isWithin24hWindow(25h ago) → closed.
 *   W3: isWithin24hWindow(undefined) → closed (never messaged).
 *   W4: isWithin24hWindow(invalid string) → closed (defensive).
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import { isWithin24hWindow } from "@/lib/whatsapp-window";
import assert from "node:assert";

type Case = { name: string; fn: () => Promise<void> };
const cases: Case[] = [];
function test(name: string, fn: Case["fn"]) { cases.push({ name, fn }); }

test("W1 — window OPEN when last inbound was just now", async () => {
  const status = isWithin24hWindow(new Date().toISOString());
  assert.ok(status.open, "window must be open for a message received now");
  assert.ok(status.hoursRemaining !== undefined && status.hoursRemaining <= 24, "hoursRemaining must be <= 24");
  assert.ok(status.hoursRemaining! >= 23, "hoursRemaining must be ~24 for just-now");
});

test("W2 — window CLOSED when last inbound was 25 hours ago", async () => {
  const twentyFiveHoursAgo = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  const status = isWithin24hWindow(twentyFiveHoursAgo);
  assert.ok(!status.open, "window must be closed after 25h");
  assert.strictEqual(status.hoursRemaining, 0, "hoursRemaining must be 0 when closed");
  assert.ok(/closed/i.test(status.label), "label must say 'closed'");
});

test("W3 — window CLOSED when customer never messaged (undefined)", async () => {
  const status = isWithin24hWindow(undefined);
  assert.ok(!status.open, "window must be closed when lastInboundAt is undefined");
  assert.ok(/hasn.t messaged/i.test(status.label), "label must explain 'never messaged'");
});

test("W4 — window CLOSED on invalid timestamp (defensive)", async () => {
  const status = isWithin24hWindow("not-a-date");
  assert.ok(!status.open, "window must be closed on invalid input");
  assert.ok(/invalid/i.test(status.label), "label must say 'invalid'");
});

(async () => {
  let passed = 0, failed = 0;
  for (const c of cases) {
    try { await c.fn(); passed++; console.log(`  ✅ ${c.name}`); }
    catch (err) { failed++; console.error(`  ❌ ${c.name}: ${(err as Error).message}`); }
  }
  console.log(`\nwhatsapp-window: ${passed} passed, ${failed} failed — ${failed === 0 ? "ALL GREEN ✅" : "FAILED ❌"}`);
  process.exit(failed > 0 ? 1 : 0);
})();

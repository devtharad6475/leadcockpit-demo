/**
 * golden-safe-audit.ts — safeAudit best-effort contract (NEW, S6 W-2).
 *
 * WHY THIS TEST EXISTS:
 *   Audit S6 W-2: ~16 logAuditEvent callsites were unwrapped — if the auditLog
 *   repo threw, the audit event was silently dropped AND the rejection became
 *   an unhandled promise rejection (or crashed the user flow). safeAudit is
 *   the chokepoint that wraps the write so the primary action always proceeds
 *   and the failure is logged (never silent). This golden pins that contract.
 *
 * HAND-COMPUTED CONTRACT (anti-cheat):
 *   CASE A — happy path: safeAudit writes the entry; the audit log has it.
 *   CASE B — repo throws: safeAudit DOES NOT throw; the caller continues; the
 *     entry is absent but the failure was logged to console.error (the test
 *     spies on console.error to prove the failure is visible, not silent).
 *   CASE C — static: route.ts no longer contains `new AuditLogService().logAuditEvent`
 *     (all 16 sites migrated to safeAudit).
 *
 * Run: `npm run golden:safe-audit`
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { safeAudit } from "@/lib/safe-audit";
import { createJsonRepos } from "./_helpers/provider";

type Case = { name: string; fn: () => Promise<void> };
const cases: Case[] = [];
function test(name: string, fn: () => Promise<void>) { cases.push({ name, fn }); }

function caseWorkspace(slug: string): string {
  return `ws_golden_safeaudit_${slug}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

test("CASE A — happy path: safeAudit writes the entry", async () => {
  const repos = createJsonRepos();
  const WS = caseWorkspace("A");
  // Must NOT throw.
  await safeAudit(repos, { workspaceId: WS, userId: "user_owner", action: "test.action", entityType: "test", entityId: "x" });
  // The entry is in the audit log. logAuditEvent stores action as eventType.
  const data = await repos.readAll!();
  const found = (data.auditLogs || []).some((l) => l.workspaceId === WS && l.eventType === "test.action");
  assert.ok(found, "safeAudit wrote the entry on the happy path");
});

test("CASE B — repo throws: safeAudit DOES NOT throw + the failure is logged (not silent)", async () => {
  // Use a stub repos whose auditLog.create THROWS — this deterministically
  // exercises the failure path. The contract: safeAudit swallows it (the
  // caller's primary action continues) AND logs the failure to console.error
  // (No-Silent-Failures rule).
  const throwingRepos = {
    auditLog: {
      create: async () => { throw new Error("simulated Postgres transient error"); },
    },
  } as unknown as Parameters<typeof safeAudit>[0];
  const WS = caseWorkspace("B");
  // Spy on console.error to prove the failure is surfaced.
  const errors: string[] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
  try {
    // Must NOT throw — this is the load-bearing W-2 assertion.
    await safeAudit(throwingRepos, { workspaceId: WS, userId: "x", action: "test.throw", entityType: "t", entityId: "y" });
  } catch (e) {
    assert.fail(`safeAudit MUST NOT throw on a repo failure (W-2 contract), but it threw: ${(e as Error).message}`);
  } finally {
    console.error = origError;
  }
  // The failure was logged (visible, not silent).
  assert.ok(errors.some((e) => /safeAudit.*FAILED/i.test(e) || /simulated Postgres/i.test(e)), `console.error logged the audit-write failure (not silent). Got: ${errors.join(" | ")}`);
});

test("CASE C — static: route.ts no longer uses the unwrapped pattern", async () => {
  const src = fs.readFileSync(path.join(process.cwd(), "src/app/api/[[...path]]/route.ts"), "utf8");
  // The old unwrapped pattern must be GONE (all migrated to safeAudit).
  assert.ok(!/new AuditLogService\(\)\.logAuditEvent/.test(src), "no unwrapped `new AuditLogService().logAuditEvent` remains in route.ts");
  // And safeAudit is now used (count >= 10 — there were ~16 sites).
  const count = (src.match(/safeAudit\(/g) || []).length;
  assert.ok(count >= 10, `expected >= 10 safeAudit calls in route.ts (was ~16 sites), got ${count}`);
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
  console.log(`safe-audit: ${passed} passed, ${failed} failed — ${failed === 0 ? "ALL GREEN ✅" : "FAIL ❌"}`);
  if (failed > 0) process.exit(1);
})();

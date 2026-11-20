/**
 * golden-platform-admin-get-rbac.ts — pins the /admin/* GET route RBAC chokepoint
 * (Stage 5 / WP3 re-audit, F-P1-5).
 *
 * WHAT THIS PROVES
 *   The GET-side route gate under /admin/* is NOT a single flat "any admin"
 *   gate. Per docs/LOGIC.md (2026-07-28 "PlatformAdmin roles"):
 *
 *     "support_agent (a future support hire) — LIMITED: can ONLY see + reply
 *      to platform tickets. Cannot suspend workspaces, manage billing, config
 *      flags, manage users, or impersonate."
 *
 *   Before this fix, EVERY /admin/* GET endpoint let `support_agent` in — so a
 *   future support hire could read EVERY workspace's users, every platform
 *   audit log, every feature-flag state, and the system health surface. That
 *   is a privilege-escalation backdoor: the UI hides the buttons, but the API
 *   is the law (build-right Angle Bank A1 "Backdoor Check"). The fix extracts
 *   the required-role-per-path into one chokepoint (`requiredAdminRoleForGetPath`)
 *   so the rule lives in ONE place and can be tested.
 *
 * HAND-COMPUTED CONTRACT (anti-cheat — these are the RULES, not the code):
 *
 *   CASE A — support_agent CAN read its own ticket inbox (the support-scope):
 *     /admin/platform-tickets               → support_agent (allowed)
 *     /admin/platform-tickets/list          → support_agent (allowed)
 *     /admin/platform-tickets/:id           → support_agent (allowed)
 *     /admin/platform-tickets/:id/events    → support_agent (allowed)
 *     /admin/platform-tickets/sla-settings  → support_agent (allowed)
 *     /admin/platform-tickets/support-hours → support_agent (allowed)
 *     /admin/me                             → support_agent (any admin can read self)
 *     /admin/auth/status                    → PUBLIC (no role required; handled before the gate)
 *
 *   CASE B — support_agent CANNOT read operator surfaces (the backdoor list):
 *     /admin/workspaces                     → operator (NOT support_agent)
 *     /admin/workspaces/list                → operator
 *     /admin/workspaces/:id                 → operator (exposes every tenant's users)
 *     /admin/workspaces/:id/users           → operator
 *     /admin/audit-logs                     → operator (every platform action)
 *     /admin/feature-flags                  → operator
 *     /admin/health                         → operator (system internals)
 *     /admin/impersonation/active           → operator (impersonation is operator-only)
 *
 *   CASE C — operator CAN read everything support_agent can read (flat ladder):
 *     every support_agent-allowed path also returns true for operator.
 *
 * REAL PIPELINE: imports the REAL chokepoint (`requiredAdminRoleForGetPath`).
 * If a future agent widens /admin/workspaces back to "support_agent", CASE B
 * fails instantly.
 *
 * Run: npx tsx scripts/golden/golden-platform-admin-get-rbac.ts
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { requiredAdminRoleForGetPath, type PlatformAdminRole } from "@/lib/platform-admin-rbac";

type Case = { name: string; fn: () => Promise<void> };
const cases: Case[] = [];
function test(name: string, fn: Case["fn"]) { cases.push({ name, fn }); }

const ALLOWED_FOR_SUPPORT: string[][] = [
  ["admin", "platform-tickets"],
  ["admin", "platform-tickets", "list"],
  ["admin", "platform-tickets", "TICKET_1"],
  ["admin", "platform-tickets", "TICKET_1", "events"],
  ["admin", "platform-tickets", "sla-settings"],
  ["admin", "platform-tickets", "support-hours"],
  ["admin", "me"],
];

const OPERATOR_ONLY: string[][] = [
  ["admin", "workspaces"],
  ["admin", "workspaces", "list"],
  ["admin", "workspaces", "ws_123"],
  ["admin", "workspaces", "ws_123", "users"],
  ["admin", "audit-logs"],
  ["admin", "feature-flags"],
  ["admin", "health"],
  ["admin", "impersonation", "active"],
];

/** Does `role` satisfy the required role for this path? (flat ladder: operator ≥ support_agent.) */
function canRead(path: string[], role: PlatformAdminRole): boolean {
  const required = requiredAdminRoleForGetPath(path);
  if (required === "support_agent") return role === "support_agent" || role === "operator";
  return role === "operator";
}

// ─── CASE A: support_agent CAN read its ticket inbox + self ─────────────────
test("CASE A — support_agent CAN read platform-tickets + self (the support scope)", async () => {
  for (const p of ALLOWED_FOR_SUPPORT) {
    const required = requiredAdminRoleForGetPath(p);
    assert.strictEqual(
      required,
      "support_agent",
      `path ${p.join("/")} must require support_agent (the lowest role), got ${required}`,
    );
    assert.strictEqual(canRead(p, "support_agent"), true, `support_agent must be able to read ${p.join("/")}`);
  }
  // /admin/auth/status is PUBLIC — the chokepoint returns null (no role needed).
  assert.strictEqual(requiredAdminRoleForGetPath(["admin", "auth", "status"]), null, "/admin/auth/status is public");
});

// ─── CASE B: support_agent CANNOT read operator surfaces (the backdoor) ─────
test("CASE B — support_agent CANNOT read workspaces/users/audit-logs/flags/health/impersonation", async () => {
  for (const p of OPERATOR_ONLY) {
    const required = requiredAdminRoleForGetPath(p);
    assert.strictEqual(
      required,
      "operator",
      `path ${p.join("/")} must require operator (NOT support_agent), got ${required} — this is the F-P1-5 backdoor`,
    );
    assert.strictEqual(canRead(p, "support_agent"), false, `support_agent must NOT be able to read ${p.join("/")}`);
  }
});

// ─── CASE C: operator can read everything support_agent can (flat ladder) ───
test("CASE C — operator can read every support_agent-allowed path too", async () => {
  for (const p of ALLOWED_FOR_SUPPORT) {
    assert.strictEqual(canRead(p, "operator"), true, `operator must also be able to read ${p.join("/")}`);
  }
  for (const p of OPERATOR_ONLY) {
    assert.strictEqual(canRead(p, "operator"), true, `operator must be able to read ${p.join("/")}`);
  }
});

// ─── CASE D: unknown /admin/* path defaults to operator (fail-closed) ───────
test("CASE D — an unmapped /admin/* GET path defaults to operator (fail-closed)", async () => {
  const required = requiredAdminRoleForGetPath(["admin", "some-future-route"]);
  assert.strictEqual(required, "operator", "unmapped /admin/* GET path must default to operator (fail-closed, not open)");
});

// ─── Runner ─────────────────────────────────────────────────────────────────
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
  console.log(`\n=== Result: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.error("❌ golden-platform-admin-get-rbac FAILED — F-P1-5 not closed.");
    process.exit(1);
  }
  console.log("✅ golden-platform-admin-get-rbac ALL GREEN ✅");
  process.exit(0);
})();

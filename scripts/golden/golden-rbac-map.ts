/**
 * golden-rbac-map.ts — RBAC role-map contract pin (NEW, 2026-07-27 S6 S-1/S-2).
 *
 * WHY THIS TEST EXISTS:
 *   The role map (which role can mutate which route) lived un-exported inside
 *   the 3000-line catch-all route, so it had no test. Audit S6 S-1/S-2 found
 *   the send/approve family (`auto-reply-logs`, `messages`) defaulted to
 *   sales_member, contradicting the documented owner-only policy — any junior
 *   salesperson could fire customer WhatsApp messages. The map was extracted
 *   to src/lib/rbac-map.ts (one chokepoint) and tightened. This golden pins
 *   the contract so a future agent can't silently widen it again.
 *
 * HAND-COMPUTED CONTRACT (anti-cheat — these are the RULES, not the code):
 *
 *   CASE A — customer-facing SEND/APPROVE family is OWNER-only:
 *     auto-reply-logs/:id/approve  → owner   (dispatches a real WhatsApp send)
 *     messages/:id/approve         → owner   (manual-send approval step)
 *     price-change/send            → owner   (broadcast to customers)
 *   CASE B — destructive/workspace-wide cascades are OWNER-only:
 *     erasure/*                    → owner   (hard-delete all customer data)
 *     workspaces (create)          → owner   (new tenant)
 *   CASE C — AI/credential/integration config is OWNER-only:
 *     ai/*, agent-autonomous/*, integrations/* → owner
 *   CASE D — workspace-wide operational config is ADMIN+ (admin OR owner):
 *     workspace, consent, onboarding, business-profile, crawl, media,
 *     outreach, lead-review, settings, whatsapp-agent → admin
 *   CASE E — day-to-day CRM records stay at SALES_MEMBER (operator decision):
 *     tickets, orders, quotes, leads, replies → sales_member
 *   CASE F — role ladder is a strict total order: viewer < sales_member < admin < owner
 *   CASE G — roleCanMutate: an admin CAN mutate an admin-required route; a
 *     sales_member CANNOT mutate an admin-required route; a viewer can NEVER mutate.
 *
 * REAL PIPELINE: imports the REAL rbac-map (no mocks). If a future agent
 * removes "auto-reply-logs" from OWNER_ONLY_PREFIXES, CASE A fails instantly.
 *
 * Run: `npm run golden:rbac-map`
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import {
  requiredRoleForPath,
  roleCanMutate,
  ROLE_RANK,
  OWNER_ONLY_PREFIXES,
  ADMIN_REQUIRED_PREFIXES,
  SALES_MEMBER_PREFIXES,
  UNGATED_PREFIXES,
  TOUR_VISIBLE_DESPITE_ADMIN_WRITE,
  isTabHiddenForTour,
  type MinRole,
} from "@/lib/rbac-map";

type Case = { name: string; fn: () => Promise<void> };
const cases: Case[] = [];
function test(name: string, fn: () => Promise<void>) { cases.push({ name, fn }); }

const V = (p: string[]) => requiredRoleForPath(p, "POST");

test("CASE A — customer-facing SEND/APPROVE family is OWNER-only", async () => {
  // THE load-bearing S-1/S-2 assertions. Before the fix these returned sales_member.
  assert.strictEqual(V(["auto-reply-logs", "x", "approve"]), "owner", "approve-and-send is owner-only per policy");
  assert.strictEqual(V(["messages", "x", "approve"]), "owner", "manual-send approval is owner-only");
  assert.strictEqual(V(["price-change", "send"]), "owner", "price-change broadcast is owner-only");
  // F-RBAC-1 (2026-08-04 build-right audit): templates are sent OUTSIDE the 24h
  // window (cold customer outreach) — the route comment says "owner confirms Meta
  // approved it." Before the fix this fell through to sales_member (a sales_member
  // could create/submit/approve templates). Same threat model as auto-reply-logs.
  assert.strictEqual(V(["whatsapp-templates"]), "owner", "template create is owner-only (customer-facing send family)");
  assert.strictEqual(V(["whatsapp-templates", "x", "submit"]), "owner", "template submit-to-Meta is owner-only");
  assert.strictEqual(V(["whatsapp-templates", "x", "approve"]), "owner", "template approve is owner-only");
});

test("CASE B — destructive/workspace-wide cascades are OWNER-only", async () => {
  assert.strictEqual(V(["erasure", "lead", "x"]), "owner", "erasure cascade is owner-only");
  assert.strictEqual(V(["erasure"]), "owner", "erasure preview root is owner-only");
  assert.strictEqual(V(["workspaces"]), "owner", "workspace (tenant) creation is owner-only");
});

test("CASE C — AI/credential/integration config is OWNER-only", async () => {
  assert.strictEqual(V(["ai", "settings"]), "owner", "AI settings owner-only");
  assert.strictEqual(V(["agent-autonomous", "settings"]), "owner", "agent autonomy owner-only");
  assert.strictEqual(V(["integrations", "whatsapp"]), "owner", "integrations owner-only");
});

test("CASE D — workspace-wide operational config is ADMIN+ (admin or owner)", async () => {
  for (const prefix of ["workspace", "consent", "onboarding", "business-profile", "crawl", "media", "outreach", "lead-review", "settings", "whatsapp-agent"]) {
    assert.strictEqual(V([prefix]), "admin", `${prefix} requires admin+`);
  }
});

test("CASE E — day-to-day CRM records stay at SALES_MEMBER (operator decision)", async () => {
  // Per DECISIONS.md 2026-07-21: "all staff" for operational records.
  assert.strictEqual(V(["tickets"]), "sales_member", "tickets default to sales_member");
  assert.strictEqual(V(["orders"]), "sales_member", "orders default to sales_member");
  assert.strictEqual(V(["quotes"]), "sales_member", "quotes default to sales_member");
  assert.strictEqual(V(["leads"]), "sales_member", "leads default to sales_member");
  assert.strictEqual(V(["replies"]), "sales_member", "replies default to sales_member");
});

test("CASE F — role ladder is a strict total order", async () => {
  assert.ok(ROLE_RANK.viewer < ROLE_RANK.sales_member, "viewer < sales_member");
  assert.ok(ROLE_RANK.sales_member < ROLE_RANK.admin, "sales_member < admin");
  assert.ok(ROLE_RANK.admin < ROLE_RANK.owner, "admin < owner");
});

test("CASE G — roleCanMutate respects the ladder", async () => {
  // A sales_member cannot approve-and-send (owner-only route).
  assert.strictEqual(roleCanMutate("sales_member", ["auto-reply-logs", "x", "approve"], "POST"), false, "sales_member CANNOT approve-and-send");
  // An owner can.
  assert.strictEqual(roleCanMutate("owner", ["auto-reply-logs", "x", "approve"], "POST"), true, "owner CAN approve-and-send");
  // An admin can mutate an admin-required route; a sales_member cannot.
  assert.strictEqual(roleCanMutate("admin", ["workspace", "insights"], "POST"), true, "admin CAN post an insight");
  assert.strictEqual(roleCanMutate("sales_member", ["workspace", "insights"], "POST"), false, "sales_member CANNOT post an insight");
  // A viewer can NEVER mutate anything.
  assert.strictEqual(roleCanMutate("viewer", ["tickets"], "POST"), false, "viewer cannot even create a ticket");
  assert.strictEqual(roleCanMutate("viewer", ["orders"], "POST"), false, "viewer cannot create an order");
});

test("CASE H — the prefix sets are non-empty and disjoint (no route in both sets)", async () => {
  assert.ok(OWNER_ONLY_PREFIXES.size >= 6, "owner set has the expected entries");
  assert.ok(ADMIN_REQUIRED_PREFIXES.size >= 8, "admin set has the expected entries");
  for (const p of OWNER_ONLY_PREFIXES) {
    assert.ok(!ADMIN_REQUIRED_PREFIXES.has(p), `"${p}" must not be in BOTH sets (ambiguous)`);
  }
});

// ─── 2026-08-05 (audit finding F-6) — DEFAULT-DENY ──────────────────────────
//
// HAND-COMPUTED CONTRACT for these cases:
//
//   CASE I — an UNRECOGNISED prefix requires "owner", not "sales_member".
//     Before F-6, requiredRoleForPath ended in `return "sales_member"`, so any
//     route prefix added to route.ts in future was member-mutable until
//     somebody remembered to restrict it here. The failure was silent and in
//     the unsafe direction. These assertions are the whole point of the fix:
//     if a future edit reinstates a permissive fall-through, CASE I goes red.
//
//   CASE J — the five prefixes F-6 classified resolve to admin.
//   CASE K — genuinely public prefixes stay ungated; `admin` does NOT.
//   CASE L — the four role sets are mutually disjoint.
//   CASE M — tightening WRITE permissions did not hide demo tabs from the tour.

test("CASE I — an unclassified route prefix DENIES by default (owner)", async () => {
  // Prefixes that do not exist anywhere in the app. Each must land on owner.
  for (const unknown of ["totally-new-feature", "reports", "billing", "webhooks-v2", "zzz"]) {
    assert.strictEqual(
      requiredRoleForPath([unknown], "POST"), "owner",
      `unknown prefix "${unknown}" must default to owner (default-deny), not fall through to sales_member`,
    );
    assert.strictEqual(
      roleCanMutate("sales_member", [unknown], "POST"), false,
      `a sales_member must NOT be able to mutate the unclassified prefix "${unknown}"`,
    );
    assert.strictEqual(
      roleCanMutate("admin", [unknown], "POST"), false,
      `an admin must NOT be able to mutate the unclassified prefix "${unknown}"`,
    );
  }
  // An empty path is not a real mutation and must not be permissive either.
  assert.strictEqual(requiredRoleForPath([], "POST"), "owner", "empty path defaults to owner");
});

test("CASE J — the five F-6 prefixes are ADMIN, not member", async () => {
  // These reached sales_member only via the old fall-through, never by decision.
  for (const prefix of ["knowledge", "documents", "icp", "extraction-runs", "invites"]) {
    assert.strictEqual(requiredRoleForPath([prefix], "POST"), "admin", `"${prefix}" must require admin`);
    assert.strictEqual(roleCanMutate("sales_member", [prefix], "POST"), false, `sales_member cannot write "${prefix}"`);
    assert.strictEqual(roleCanMutate("admin", [prefix], "POST"), true, `admin CAN write "${prefix}"`);
  }
});

test("CASE K — public prefixes stay ungated; the operator console does not", async () => {
  // Login/signup/reset must work with no session; the webhook authenticates by
  // HMAC signature rather than by a user role.
  for (const prefix of ["auth", "inbound"]) {
    assert.strictEqual(requiredRoleForPath([prefix], "POST"), "viewer", `"${prefix}" must stay ungated`);
  }
  // `admin` is the SaaS-operator console. It has its own auth AND returns
  // before this gate — but if that ordering ever changed, "ungated" would be
  // the worst possible fallback. It must land on default-deny.
  assert.ok(!UNGATED_PREFIXES.has("admin"), "the operator console must NOT be in the ungated set");
  assert.strictEqual(requiredRoleForPath(["admin"], "POST"), "owner", "admin console falls to default-deny");
});

test("CASE L — the four role sets are mutually disjoint", async () => {
  const sets: Array<[string, ReadonlySet<string>]> = [
    ["OWNER_ONLY", OWNER_ONLY_PREFIXES],
    ["ADMIN_REQUIRED", ADMIN_REQUIRED_PREFIXES],
    ["SALES_MEMBER", SALES_MEMBER_PREFIXES],
    ["UNGATED", UNGATED_PREFIXES],
  ];
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      const [nameA, setA] = sets[i];
      const [nameB, setB] = sets[j];
      for (const prefix of setA) {
        assert.ok(!setB.has(prefix), `"${prefix}" is in BOTH ${nameA} and ${nameB} — ambiguous`);
      }
    }
  }
  assert.ok(SALES_MEMBER_PREFIXES.size >= 8, "sales_member set has the expected entries");
});

test("CASE M — tightening writes did not hide demo tabs from the public tour", async () => {
  // Regression guard. TOUR_HIDDEN_TAB_PREFIXES is DERIVED from the mutation
  // sets, so moving a prefix into ADMIN_REQUIRED silently hides its tab. When
  // F-6 classified knowledge/documents/icp as admin-write, that would have
  // deleted the Knowledge Base, Documents and Ideal Customers tabs from the
  // public demo — a product regression caused purely by a permissions change.
  for (const prefix of TOUR_VISIBLE_DESPITE_ADMIN_WRITE) {
    assert.strictEqual(
      isTabHiddenForTour(prefix), false,
      `"${prefix}" requires admin to WRITE but must remain VISIBLE to a read-only tour viewer`,
    );
    // ...and it must still be write-protected. Visible is not the same as open.
    assert.strictEqual(
      roleCanMutate("viewer", [prefix], "POST"), false,
      `"${prefix}" must stay read-only for a tour viewer`,
    );
  }
  // The genuinely operational ones stay hidden.
  for (const prefix of ["integrations", "ai", "settings", "extraction-runs", "invites"]) {
    assert.strictEqual(isTabHiddenForTour(prefix), true, `"${prefix}" must stay hidden from the tour`);
  }
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
  console.log(`rbac-map: ${passed} passed, ${failed} failed — ${failed === 0 ? "ALL GREEN ✅" : "FAIL ❌"}`);
  if (failed > 0) process.exit(1);
})();

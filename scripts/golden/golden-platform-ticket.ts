/**
 * golden-platform-ticket.ts — pins PlatformTicketService lifecycle (WP3).
 *
 * WHAT THIS PROVES (Stage 5 / WP3, docs/LOGIC.md 2026-07-28)
 *   The platform-ticket model: a workspace user reports a problem to the SaaS
 *   operator. Separate from the Stage 2 customer Ticket. Every LOGIC rule is
 *   asserted at the math layer here; the HTTP layer is pinned by
 *   `smoke:stage5-platform-ticket` + a Playwright Golden Thread test.
 *
 * THE CONTRACTS (hand-computed BEFORE writing assertions):
 *
 *   CASE A — owner creates a bug ticket → succeeds; ticketNumber=(global max+1),
 *            globally unique; status=open; category=bug; a "created" event
 *            appended with actorType=user + actorUserId=creator. The number is
 *            a GLOBAL monotonic counter (not always 1 — depends on prior state),
 *            so we assert it equals (max-before-create)+1 and is unique.
 *
 *   CASE B — sales_member tries to create → throws AuthorizationError (RBAC:
 *            owner/admin only). A sales_member must NOT reach the operator inbox.
 *
 *   CASE C — blocked user (isBlockedFromSupport=true) tries to create → throws
 *            AuthorizationError. Existing open tickets are NOT auto-closed
 *            (verified in CASE I).
 *
 *   CASE D — unknown category ("feature_request") → throws (closed list of 6).
 *
 *   CASE E — isolation: workspace X user cannot see workspace Y's ticket via
 *            listForUser. Cross-workspace read blocked at the repo layer.
 *
 *   CASE F — sales_member in workspace X cannot see the owner's ticket in X via
 *            listForUser (the route enforces this; the repo returns ALL the
 *            workspace's tickets so the route must filter — verified by
 *            asserting the repo returns it but a higher-level check would gate).
 *            Here we assert the inverse: listForUser returns the workspace's
 *            tickets scoped to that workspace (no leak from another workspace).
 *
 *   CASE G — operator comment sets firstResponseAt; user comment on a ticket
 *            resolved WITHIN the 7-day window reopens it (status→reopened,
 *            resolvedAt cleared); user comment AFTER 7 days is rejected.
 *
 *   CASE H — computeLivePlatformBreach: now>slaDueAt + status=open → breached=true;
 *            status=resolved → breached=false even if now is past dueAt (the
 *            SLA clock stops on resolve). The sacred Stage 2 rule, mirrored.
 *
 *   CASE I — flagAsSpam hides the ticket from the DEFAULT operator list
 *            (listForOperator with no includeSpamFlagged) but the record
 *            persists (getForOperator still returns it). blockUser sets
 *            isBlockedFromSupport=true; a NEW ticket by that user is rejected
 *            (CASE C path), but the user's EXISTING open ticket is unaffected.
 *
 *   CASE J — no-auto-outreach invariant: createPlatformTicket + addComment
 *            write ZERO sends. Static check: neither function imports or calls
 *            any WhatsApp/email provider. (The full grep pin lives in
 *            golden:no-auto-outreach; this case asserts the service files
 *            contain no allowRealSend / provider-send call.)
 *
 * REAL PIPELINE: imports the real PlatformTicketService + real JSON repos. Each
 * case uses a unique workspace + ticket id namespace (Ironclad Gate #8) so
 * state never leaks between cases or between runs.
 *
 * SLA HAND-COMPUTATION (CASE A):
 *   urgent = 240 minutes (4 hours). Created Mon 2026-07-13 10:00 IST inside
 *   support hours (09:00-18:00 Mon-Sat). Business-hours clock accumulates 240
 *   minutes → dueAt = Mon 2026-07-13 14:00 IST (4 business hours later, still
 *   inside the same business-hours window). We assert dueAt is within 1 minute
 *   of 14:00 IST (the engine walks in 1-minute granularity).
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import { createAmbientRepos } from "./_helpers/provider";
import { ensureWorkspace } from "./_helpers/fixtures";
import type { RepositoryBundle } from "@/repositories/interfaces";
import {
  addPlatformTicketComment,
  blockPlatformUser,
  changePlatformTicketStatus,
  computeLivePlatformBreach,
  createPlatformTicket,
  flagPlatformTicketAsSpam,
  isValidPlatformTicketCategory,
  PLATFORM_TICKET_CATEGORIES,
} from "@/services/PlatformTicketService";
import assert from "node:assert";

type Case = { name: string; fn: () => Promise<void> };
const cases: Case[] = [];
function test(name: string, fn: Case["fn"]) { cases.push({ name, fn }); }

function caseWs(caseId: string) { return `ws_pt_golden_${caseId}`; }
function caseUser(caseId: string, role: string) { return `user_pt_${caseId}_${role}`; }

/**
 * Ironclad Gate #8 (Test Isolation): GLOBAL cleanup at the start of every run.
 * Wipes ALL test-prefix workspaces so the golden is deterministic regardless
 * of leftover state from prior runs OR from smoke-stage5-platform-ticket
 * (which uses `smoke5_*` prefixes). Without this, the global ticketNumber
 * counter accumulates across runs + the CASE A `beforeMax` snapshot drifts.
 *
 * 2026-07-29 (WP5): added after the smoke runs during WP5 verification pushed
 * the global ticketNumber counter up + broke CASE A's beforeMax+1 assertion.
 * This is the root-cause fix (Gate #8) — the per-case clearCase was not enough
 * because ticketNumber is a GLOBAL counter shared across all test workspaces.
 */
async function clearAllTestWorkspaces() {
  // A-7 (2026-08-26): under the Postgres pass this golden owns a private
  // database that is created from a clean template and dropped afterwards,
  // so there is no leftover state to wipe and nothing shares the counter.
  // Reaching into the JSON file from a Postgres run would clean the wrong
  // substrate and prove nothing.
  if (process.env.PERSISTENCE_PROVIDER === "prisma") return;
  const { mutateData } = await import("@/lib/db");
  await mutateData((data) => {
    // Match BOTH the golden prefix (ws_pt_golden_*) AND the smoke prefix
    // (ws_smoke5_* — note the `ws_` prefix; the smoke script names workspaces
    // `ws_${runId}` where runId starts with `smoke5_`).
    const isTestWs = (wsId: unknown): boolean =>
      typeof wsId === "string" && (wsId.startsWith("ws_pt_golden_") || wsId.startsWith("ws_smoke5_"));
    const testTicketIds = (data.platformTickets || []).filter((t) => isTestWs(t.workspaceId)).map((t) => t.id);
    data.platformTickets = (data.platformTickets || []).filter((t) => !isTestWs(t.workspaceId));
    data.platformTicketEvents = (data.platformTicketEvents || []).filter((e) => !testTicketIds.includes(e.ticketId));
    data.platformUserBlocks = (data.platformUserBlocks || []).filter((b) => !isTestWs(b.workspaceId));
    data.users = (data.users || []).filter((u) => !isTestWs(u.workspaceId) && !(typeof u.id === "string" && u.id.startsWith("user_pt_")));
    return undefined;
  });
}


/**
 * The two operator ids this file hands to the platform services.
 *
 * A-7 (2026-08-26): every privileged action here writes a platform audit log
 * keyed by the acting admin. `admin_test` and `admin_op` were invented strings
 * that matched no row, and Postgres refuses the audit write with
 * platform_audit_logs_admin_id_fkey. JSON accepted them, which meant the
 * audit trail these cases assert on was being written against an operator who
 * does not exist - exactly the state the constraint is there to prevent.
 *
 * The password hash is filler of the right length and is never used: nothing
 * in this golden signs in.
 */
const TICKET_ADMINS = ["admin_test", "admin_op"];

async function ensureTicketAdmins(repos: RepositoryBundle) {
  for (const id of TICKET_ADMINS) {
    if (await repos.platformAdmin.findById(id)) continue;
    await repos.platformAdmin.createWithCredential({
      admin: { id, email: `${id}@platform.example`, name: id, role: "operator", status: "active" },
      credential: { adminId: id, email: `${id}@platform.example`, passwordHash: "x".repeat(60) },
    });
  }
}

/** Ironclad Gate #8: each case clears its own workspace's tickets + events. */
async function clearCase(caseId: string) {
  const ws = caseWs(caseId);
  // A-7 (2026-08-26): every case invents its own tenant id, and until now
  // nothing ever created it. JSON did not care; Postgres refuses the ticket
  // with platform_tickets_workspace_id_fkey. This runs at the top of every
  // case, so it is the one place that makes all of them real.
  const fixtureRepos = createAmbientRepos();
  await ensureWorkspace(fixtureRepos, ws, `platform ticket golden ${caseId}`);
  await ensureTicketAdmins(fixtureRepos);
  if (process.env.PERSISTENCE_PROVIDER === "prisma") return;
  const { mutateData } = await import("@/lib/db");
  await mutateData((data) => {
    const ticketIds = (data.platformTickets || []).filter((t) => t.workspaceId === ws).map((t) => t.id);
    data.platformTickets = (data.platformTickets || []).filter((t) => t.workspaceId !== ws);
    data.platformTicketEvents = (data.platformTicketEvents || []).filter((e) => !ticketIds.includes(e.ticketId));
    data.platformUserBlocks = (data.platformUserBlocks || []).filter((b) => b.workspaceId !== ws);
    // Stage 5 re-audit F-P1-10 ripple: also clear seeded users for this case
    // (blockPlatformUser now requires the User row to exist + match workspaceId).
    data.users = (data.users || []).filter((u) => !(u.id.startsWith(`user_pt_${caseId}_`) && u.workspaceId === ws));
    return undefined;
  });
}

/**
 * Stage 5 re-audit F-P1-10 ripple (2026-07-28): blockPlatformUser now verifies
 * the (userId, workspaceId) membership before upserting. Cases that block a
 * user MUST seed a real User row first (the realistic scenario — you can only
 * block a user who exists + belongs to the workspace).
 */
async function seedUser(caseId: string, role: string) {
  const repos = createAmbientRepos();
  const ws = caseWs(caseId);
  const user = caseUser(caseId, role);
  await repos.user.create({
    id: user, workspaceId: ws, name: `Test ${role}`, email: `pt_${caseId}_${role}@test.example`,
    role: role as "owner", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  return user;
}

// --- CASE A: owner creates a bug ticket --------------------------------------
test("CASE A — owner creates a bug ticket (ticketNumber=max+1, status=open, created event)", async () => {
  const caseId = "A";
  await clearCase(caseId);
  const repos: RepositoryBundle = createAmbientRepos();
  const ws = caseWs(caseId);
  const user = caseUser(caseId, "owner");
  // Fixed clock: Mon 2026-07-13 04:30 UTC = 10:00 IST (IST = UTC+5:30).
  const now = new Date("2026-07-13T04:30:00.000Z");

  // Ironclad Gate #8: ticketNumber is a GLOBAL monotonic counter (shared
  // across the whole demo store, like a real support desk ticket sequence),
  // so it is NOT always 1 — it depends on how many tickets already exist.
  // The honest contract is: the new number is exactly (current max + 1),
  // proving the atomic allocation works against whatever state preceded it.
  // Capture the max BEFORE create, then assert the new number is max+1 and
  // is globally unique (no other ticket shares it).
  const beforeMax = (await repos.platformTicket.listForOperator())
    .reduce((acc, t) => Math.max(acc, Number(t.ticketNumber || 0)), 0);

  const ticket = await createPlatformTicket({
    workspaceId: ws,
    raisedByUserId: user,
    creatorRole: "owner",
    subject: "App crashed on lead import",
    description: "Uploaded a 50-row CSV and the screen went white.",
    category: "bug",
    priority: "urgent",
    now,
  });

  assert.strictEqual(ticket.ticketNumber, beforeMax + 1, `ticketNumber must be (global max ${beforeMax})+1`);
  // Globally unique: no other ticket shares this number.
  const allTickets = await repos.platformTicket.listForOperator();
  const dupes = allTickets.filter((t) => t.ticketNumber === ticket.ticketNumber);
  assert.strictEqual(dupes.length, 1, "ticketNumber must be globally unique");
  assert.strictEqual(ticket.status, "open");
  assert.strictEqual(ticket.category, "bug");
  assert.strictEqual(ticket.priority, "urgent");
  assert.strictEqual(ticket.workspaceId, ws);
  assert.strictEqual(ticket.raisedByUserId, user);
  assert.strictEqual(ticket.isSpamFlagged, false);

  // SLA dueAt: urgent=240min, created 10:00 IST inside business hours → 14:00 IST.
  // 14:00 IST = 08:30 UTC. Allow 1-minute tolerance for the engine's granularity.
  const dueAt = new Date(ticket.slaDueAt);
  const expectedDue = new Date("2026-07-13T08:30:00.000Z");
  const driftMin = Math.abs(dueAt.getTime() - expectedDue.getTime()) / 60000;
  assert.ok(driftMin <= 1, `urgent SLA dueAt drift too large: expected ~08:30Z (14:00 IST), got ${dueAt.toISOString()} (${driftMin}min)`);

  const events = await repos.platformTicketEvent.listByTicket(ticket.id);
  assert.ok(events.length >= 1, "a 'created' event must be appended");
  const created = events.find((e) => e.eventType === "created");
  assert.ok(created, "created event exists");
  assert.strictEqual(created!.actorType, "user");
  assert.strictEqual(created!.actorUserId, user);
});

// --- CASE B: sales_member cannot create --------------------------------------
test("CASE B — sales_member create → AuthorizationError (RBAC: owner/admin only)", async () => {
  const { AuthorizationError } = await import("@/lib/auth-service");
  const caseId = "B";
  await clearCase(caseId);
  const ws = caseWs(caseId);
  const user = caseUser(caseId, "sales_member");
  await assert.rejects(
    () => createPlatformTicket({
      workspaceId: ws,
      raisedByUserId: user,
      creatorRole: "sales_member",
      subject: "I have a question",
      description: "...",
      category: "how_to",
      priority: "medium",
    }),
    (err: unknown) => {
      assert.ok(err instanceof AuthorizationError);
      assert.strictEqual(err.statusCode, 403);
      assert.strictEqual(err.message, "Only workspace owners and admins can open support tickets.");
      return true;
    },
    "sales_member must be blocked from opening platform tickets",
  );
});

// --- CASE C: blocked user cannot create --------------------------------------
test("CASE C — blocked user create → AuthorizationError", async () => {
  const { AuthorizationError } = await import("@/lib/auth-service");
  const caseId = "C";
  await clearCase(caseId);
  const repos = createAmbientRepos();
  const ws = caseWs(caseId);
  // Stage 5 re-audit F-P1-10 ripple: seed a real User row (blockPlatformUser
  // now verifies membership before upserting the block).
  const user = await seedUser(caseId, "owner");
  // Block the user first (operator action).
  await blockPlatformUser({ userId: user, workspaceId: ws, adminId: "admin_test", isBlockedFromSupport: true, reason: "abuse" });
  assert.ok(await repos.platformUserBlock.isBlocked(user), "isBlocked must report true after block");
  await assert.rejects(
    () => createPlatformTicket({
      workspaceId: ws,
      raisedByUserId: user,
      creatorRole: "owner",
      subject: "...",
      description: "...",
      category: "bug",
      priority: "low",
    }),
    (err: unknown) => {
      assert.ok(err instanceof AuthorizationError);
      assert.strictEqual(err.statusCode, 403);
      assert.strictEqual(err.message, "Your account is restricted from opening support tickets. Email support@leadcockpit.app.");
      return true;
    },
    "a blocked user must not open a new ticket",
  );
});

// --- CASE D: unknown category rejected ---------------------------------------
test("CASE D — unknown category ('feature_request') → throws (closed list of 6)", async () => {
  const caseId = "D";
  await clearCase(caseId);
  const ws = caseWs(caseId);
  const user = caseUser(caseId, "owner");
  await assert.rejects(
    // Cast to bypass TS — simulates a raw client sending an unknown string.
    () => createPlatformTicket({
      workspaceId: ws,
      raisedByUserId: user,
      creatorRole: "owner",
      subject: "x", description: "y",
      category: "feature_request" as never,
      priority: "low",
    }),
    /unknown platform-ticket category/i,
  );
  // Also pin the closed-list helper directly.
  assert.strictEqual(isValidPlatformTicketCategory("feature_request"), false);
  assert.strictEqual(PLATFORM_TICKET_CATEGORIES.length, 6);
  for (const c of ["bug", "account", "billing", "how_to", "data_request", "other"]) {
    assert.ok(isValidPlatformTicketCategory(c), `category ${c} must be valid`);
  }
});

// --- CASE E: workspace isolation (user X cannot see workspace Y's ticket) ----
test("CASE E — isolation: listForUser(wsX) never returns wsY's ticket", async () => {
  const caseIdA = "E_A";
  const caseIdB = "E_B";
  await clearCase(caseIdA);
  await clearCase(caseIdB);
  const repos = createAmbientRepos();
  const wsX = caseWs(caseIdA);
  const wsY = caseWs(caseIdB);
  const t1 = await createPlatformTicket({ workspaceId: wsX, raisedByUserId: caseUser(caseIdA, "owner"), creatorRole: "owner", subject: "in X", description: "d", category: "bug", priority: "low" });
  await createPlatformTicket({ workspaceId: wsY, raisedByUserId: caseUser(caseIdB, "owner"), creatorRole: "owner", subject: "in Y", description: "d", category: "bug", priority: "low" });

  const visibleToX = await repos.platformTicket.listForUser(wsX);
  assert.strictEqual(visibleToX.length, 1, "wsX sees only its own ticket");
  assert.strictEqual(visibleToX[0].id, t1.id);
  assert.strictEqual(visibleToX.every((t) => t.workspaceId === wsX), true, "no leak from wsY");

  // getForUser is workspace-scoped too.
  const crossRead = await repos.platformTicket.getForUser(wsX, t1.id);
  assert.ok(crossRead, "wsX can read its own ticket");
  const crossReadWrong = await repos.platformTicket.getForUser(wsY, t1.id);
  assert.strictEqual(crossReadWrong, undefined, "wsY cannot read wsX's ticket by guessing the id");
});

// --- CASE F: listForUser is workspace-scoped (parallel-pattern check) --------
test("CASE F — listForUser returns only the caller's workspace tickets (no cross-ws leak at scale)", async () => {
  const caseId = "F";
  await clearCase(caseId);
  const repos = createAmbientRepos();
  const ws = caseWs(caseId);
  // Create 3 tickets in ws, 2 in a sibling ws (using CASE E_B's ws cleared above).
  await clearCase("F_sibling");
  const wsSib = caseWs("F_sibling");
  for (let i = 0; i < 3; i++) {
    await createPlatformTicket({ workspaceId: ws, raisedByUserId: caseUser(caseId, "owner"), creatorRole: "owner", subject: `t${i}`, description: "d", category: "bug", priority: "low" });
  }
  for (let i = 0; i < 2; i++) {
    await createPlatformTicket({ workspaceId: wsSib, raisedByUserId: caseUser("F_sibling", "owner"), creatorRole: "owner", subject: `s${i}`, description: "d", category: "bug", priority: "low" });
  }
  const mine = await repos.platformTicket.listForUser(ws);
  assert.strictEqual(mine.length, 3);
  assert.strictEqual(mine.every((t) => t.workspaceId === ws), true);
});

// --- CASE G: operator firstResponse + 7-day reopen window --------------------
test("CASE G — operator comment sets firstResponseAt; user comment reopens within 7d, rejected after", async () => {
  const caseId = "G";
  await clearCase(caseId);
  const repos = createAmbientRepos();
  const ws = caseWs(caseId);
  const user = caseUser(caseId, "owner");
  const startedAt = new Date("2026-07-13T04:30:00.000Z"); // Mon 10:00 IST
  const ticket = await createPlatformTicket({ workspaceId: ws, raisedByUserId: user, creatorRole: "owner", subject: "g", description: "d", category: "bug", priority: "high", now: startedAt });
  assert.strictEqual(ticket.firstResponseAt, undefined, "no first response yet");

  // Operator replies 1 hour later → firstResponseAt set.
  const opReplyAt = new Date("2026-07-13T05:30:00.000Z");
  const r1 = await addPlatformTicketComment({ ticketId: ticket.id, actorType: "operator", actorAdminId: "admin_op", note: "Looking into this.", now: opReplyAt });
  assert.ok(r1.ticket.firstResponseAt, "firstResponseAt set after first operator comment");

  // Operator resolves.
  const resolvedAt = new Date("2026-07-13T07:00:00.000Z");
  await changePlatformTicketStatus({ ticketId: ticket.id, toStatus: "resolved", actorType: "operator", actorAdminId: "admin_op", now: resolvedAt });

  // User replies 3 days later (within 7-day window) → reopens.
  const userReplyWithin = new Date("2026-07-16T07:00:00.000Z"); // +3 days
  const r2 = await addPlatformTicketComment({ ticketId: ticket.id, actorType: "user", actorUserId: user, note: "It happened again!", now: userReplyWithin });
  assert.strictEqual(r2.reopened, true, "user comment within 7d must reopen");
  assert.strictEqual(r2.ticket.status, "reopened");

  // Resolve again, then try to reopen 10 days later → rejected.
  await changePlatformTicketStatus({ ticketId: ticket.id, toStatus: "resolved", actorType: "operator", actorAdminId: "admin_op", now: new Date("2026-07-16T08:00:00.000Z") });
  const tooLate = new Date("2026-07-26T08:00:00.000Z"); // +10 days from the second resolve
  await assert.rejects(
    () => addPlatformTicketComment({ ticketId: ticket.id, actorType: "user", actorUserId: user, note: "again", now: tooLate }),
    /can no longer be reopened/i,
    "user comment after the 7-day window must be rejected (open a new ticket)",
  );

  // (cleanup sibling events so they don't leak) — also verify the thread has multiple events
  const events = await repos.platformTicketEvent.listByTicket(ticket.id);
  assert.ok(events.filter((e) => e.eventType === "commented").length >= 2, "both comments are in the thread");
  assert.ok(events.some((e) => e.eventType === "reopened"), "a reopened event was appended");
});

// --- CASE H: computeLivePlatformBreach ---------------------------------------
test("CASE H — computeLivePlatformBreach: open+past-due=breached; resolved=never", async () => {
  const caseId = "H";
  await clearCase(caseId);
  const ws = caseWs(caseId);
  const user = caseUser(caseId, "owner");
  const ticket = await createPlatformTicket({ workspaceId: ws, raisedByUserId: user, creatorRole: "owner", subject: "h", description: "d", category: "bug", priority: "urgent", now: new Date("2026-07-13T04:30:00.000Z") });

  // now > dueAt (urgent dueAt ≈ 08:30Z). Use 10:00Z the next day.
  const after = new Date("2026-07-14T10:00:00.000Z");
  assert.strictEqual(computeLivePlatformBreach(ticket, after), true, "open ticket past dueAt is breached");

  // Resolved → never breached even past dueAt.
  const resolved = await changePlatformTicketStatus({ ticketId: ticket.id, toStatus: "resolved", actorType: "operator", actorAdminId: "admin_op", now: after });
  assert.strictEqual(computeLivePlatformBreach(resolved, after), false, "resolved ticket is never breached (clock stopped)");
});

// --- CASE I: spam flag hides from default list; block doesn't close existing -
test("CASE I — flagAsSpam hides from default operator list (record persists); block leaves existing open", async () => {
  const caseId = "I";
  await clearCase(caseId);
  const repos = createAmbientRepos();
  const ws = caseWs(caseId);
  // Stage 5 re-audit F-P1-10 ripple: seed a real User row (blockPlatformUser
  // now verifies membership before upserting the block).
  const user = await seedUser(caseId, "owner");
  const t1 = await createPlatformTicket({ workspaceId: ws, raisedByUserId: user, creatorRole: "owner", subject: "i", description: "d", category: "other", priority: "low" });
  // Second ticket by the same user (to verify block doesn't auto-close it).
  const t2 = await createPlatformTicket({ workspaceId: ws, raisedByUserId: user, creatorRole: "owner", subject: "i2", description: "d", category: "other", priority: "low" });

  // Flag t1 as spam.
  await flagPlatformTicketAsSpam({ ticketId: t1.id, adminId: "admin_op", reason: "nonsense" });
  const defaultList = await repos.platformTicket.listForOperator({});
  assert.strictEqual(defaultList.find((t) => t.id === t1.id), undefined, "flagged ticket hidden from default operator list");
  const withSpam = await repos.platformTicket.listForOperator({ includeSpamFlagged: true });
  assert.ok(withSpam.find((t) => t.id === t1.id), "flagged ticket still retrievable when explicitly requested");
  const persisted = await repos.platformTicket.getForOperator(t1.id);
  assert.ok(persisted && persisted.isSpamFlagged, "record persists with the flag");

  // Block the user. Existing open ticket (t2) is NOT auto-closed.
  await blockPlatformUser({ userId: user, workspaceId: ws, adminId: "admin_op", isBlockedFromSupport: true, reason: "spam" });
  const t2after = await repos.platformTicket.getForOperator(t2.id);
  assert.ok(t2after && t2after.status !== "closed" && t2after.status !== "resolved", "existing open ticket is NOT auto-closed by the block");
});

// --- CASE J: no-auto-outreach invariant (static) -----------------------------
test("CASE J — service files introduce ZERO auto-send paths (sacred rule)", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const files = [
    "src/services/PlatformTicketService.ts",
    "src/services/PlatformAdminAuthService.ts",
  ];
  for (const rel of files) {
    const full = path.resolve(process.cwd(), rel);
    const src = fs.readFileSync(full, "utf8");
    assert.ok(!/allowRealSend\s*:\s*true/.test(src), `${rel} must not set allowRealSend:true`);
    assert.ok(!/sendTextMessage|sendWhatsApp|sendEmail/i.test(src), `${rel} must not call any send provider (no auto-outreach)`);
  }
});

// --- RUNNER -------------------------------------------------------------------
(async () => {
  // Ironclad Gate #8: wipe ALL test-prefix workspaces before any case runs.
  // Makes the golden deterministic regardless of prior runs / smoke runs.
  await clearAllTestWorkspaces();
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
  console.log(`platform-ticket: ${passed} passed, ${failed} failed — ${failed === 0 ? "ALL GREEN ✅" : "FAIL ❌"}`);
  if (failed > 0) process.exit(1);
})();

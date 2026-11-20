/**
 * Golden test — Prisma "undefined-to-clear" field clearing (Stage 6 / 2026-07-31).
 *
 * // PRISMA_GOLDEN — opt-in marker read by scripts/run-all-goldens.ts: this is a
 * PERSISTENCE golden that needs `.env`'s DATABASE_URL (real Postgres). The suite
 * runner does NOT force JSON for it (unlike logic goldens).
 *
 * WHY THIS TEST EXISTS (the split-brain bug the Postgres flip exposed):
 *   Prisma treats `{ field: undefined }` in an `.update()` as "don't touch this
 *   field", whereas the JSON runtime (Object.assign) treats it as "clear it".
 *   So a service that passes `suspendedAt: undefined` to CLEAR a field works in
 *   JSON/demo mode but silently does NOTHING in Postgres — the field keeps its
 *   old value. Two production-critical paths hit this:
 *
 *   1. resumeWorkspace (the kill-switch RESTORE) passes
 *      `{ status: "active", suspendedAt: undefined, suspendedByAdminId: undefined }`.
 *      In Postgres the status flips but suspendedAt/suspendedByAdminId STAY SET
 *      → a resumed workspace still looks half-suspended → the kill-switch does
 *      not cleanly clear. (WorkspacePrismaRepository.update passed `data`
 *      straight through to Prisma with no undefined→null mapping.)
 *
 *   2. PlatformTicket reopen passes
 *      `{ status: "reopened", resolvedAt: undefined, closedAt: undefined }`.
 *      In Postgres the status flips but resolvedAt/closedAt STAY SET → a
 *      reopened ticket still carries a resolution timestamp → the breach/SLA
 *      math and the reopen-window anchor are wrong.
 *      (PlatformTicketPrismaRepository.updateForOperator had an
 *      `if (data.X !== undefined)` guard that silently DROPPED the clear
 *      intent — so the field was never added to the update payload.)
 *
 *   Both bugs were INVISIBLE in JSON/demo mode (the whole suite was green) and
 *   only surfaced when the operator flipped `.env` to prisma (Stage 6 / WP6-A).
 *
 * HAND-COMPUTED CONTRACT (anti-cheat):
 *   CASE A — resumeWorkspace on REAL NEON: suspend a workspace (status→suspended,
 *     suspendedAt set, suspendedByAdminId set), then resume it. Assert the
 *     READ-BACK row has status="active" AND suspendedAt === null AND
 *     suspendedByAdminId === null. A fresh repo bundle confirms it PERSISTED.
 *   CASE B — ticket reopen on REAL NEON: create a ticket, resolve it
 *     (resolvedAt set), then reopen it via a user comment within the window.
 *     Assert the READ-BACK row has status="reopened" AND resolvedAt === null AND
 *     closedAt === null. A fresh repo bundle confirms it PERSISTED.
 *
 * ISOLATION (Gate #8): each run uses a RUN-tagged workspace + ticket and
 * cascade-deletes the workspace at the end (the FK cascade wipes child rows).
 *
 * Env-gated: requires DATABASE_URL (real Neon). Same pattern as the other
 * prisma:* goldens. Run: `npm run golden:prisma-field-clearing`
 */
import assert from "node:assert";
import { createRepositories, type RepositoryBundle } from "@/repositories";
import { prisma } from "@/lib/prisma";
import { suspendWorkspace, resumeWorkspace } from "@/services/PlatformAdminService";

const RUN = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const WS = `ws_golden_fieldclear_${RUN}`;

type Case = { name: string; fn: () => Promise<void> };
const cases: Case[] = [];
function test(name: string, fn: Case["fn"]) { cases.push({ name, fn }); }

async function ensureWorkspace(repos: RepositoryBundle) {
  // A platform admin (operator) is required by suspendWorkspace/resumeWorkspace.
  // Idempotent: both CASE A and CASE B call this on a shared adminId/workspace.
  const adminId = `admin_${RUN}`;
  const existingAdmin = await repos.platformAdmin.findById(adminId);
  if (!existingAdmin) {
    await repos.platformAdmin.createWithCredential({
      admin: { id: adminId, email: `fc+${RUN}@test.example`, name: "FC Op", role: "operator", status: "active" },
      credential: { adminId, email: `fc+${RUN}@test.example`, passwordHash: "x".repeat(60) },
    });
  }
  const existingWs = await repos.workspace.getById(WS);
  if (!existingWs) {
    await repos.workspace.create({
      id: WS,
      name: `Golden FieldClear ${RUN}`,
      status: "active",
      autonomyKillSwitch: false,
      autoSendToggle: false,
    });
  }
  return adminId;
}

async function cleanup() {
  // Gate #8: cascade-delete the workspace (wipes child rows via FK).
  //
  // N-DATA-2 (2026-08-26): deleting the workspace is NOT enough, and believing
  // it was is how 307 platform-administrator accounts accumulated in the dev
  // database unnoticed. Everything scoped to a workspace goes with it — 107 of
  // this schema's foreign keys cascade. The PLATFORM tier does not: an admin,
  // its credential and its audit logs carry no workspace_id at all, so nothing
  // links them to the workspace being removed and nothing ever swept them.
  // This golden alone left one admin and two audit logs behind on every run.
  //
  // Deletion is by THIS RUN's ids only (`RUN` is time + random), never by a
  // pattern like "everything that looks like a test admin" — a cleanup that
  // guesses at ownership is a cleanup that eventually deletes a real operator.
  const db = prisma as unknown as Record<string, { deleteMany: (a: unknown) => Promise<unknown> }>;
  const adminId = `admin_${RUN}`;
  try {
    await db.workspace.deleteMany({ where: { id: WS } });
    // Audit logs first: they reference the admin, and the admin is about to go.
    await db.platformAuditLog.deleteMany({ where: { adminId } });
    await db.platformAdmin.deleteMany({ where: { id: adminId } });
  } catch { /* best-effort; the database may be unreachable in some envs */ }
}

// ─── CASE A: resumeWorkspace clears suspendedAt + suspendedByAdminId ─────────
test("CASE A — resumeWorkspace on real Neon clears suspendedAt + suspendedByAdminId (status → active)", async () => {
  const repos = createRepositories("prisma");
  const adminId = await ensureWorkspace(repos);

  // Suspend → status suspended + stamps set.
  await suspendWorkspace({ adminId, workspaceId: WS, reason: "test suspend" });
  const suspended = await repos.workspace.getById(WS);
  assert.ok(suspended, "workspace must exist");
  assert.strictEqual(suspended!.status, "suspended", "suspend must set status");
  assert.ok(suspended!.suspendedAt, "suspend must stamp suspendedAt");
  assert.strictEqual(suspended!.suspendedByAdminId, adminId, "suspend must stamp suspendedByAdminId");

  // Resume → status active AND stamps CLEARED (the bug: Prisma ignored undefined).
  await resumeWorkspace({ adminId, workspaceId: WS });
  const resumed = await repos.workspace.getById(WS);
  assert.ok(resumed, "workspace must exist after resume");
  assert.strictEqual(resumed!.status, "active", "resume must set status active");
  assert.strictEqual(resumed!.suspendedAt, null, "resume must CLEAR suspendedAt (was ignored by Prisma undefined)");
  assert.strictEqual(resumed!.suspendedByAdminId, null, "resume must CLEAR suspendedByAdminId");

  // Persistence proof: a FRESH repo bundle reads the same cleared state.
  const fresh = createRepositories("prisma");
  const reread = await fresh.workspace.getById(WS);
  assert.strictEqual(reread!.suspendedAt, null, "suspendedAt must be null via a fresh repo bundle (persisted, not memory)");
  assert.strictEqual(reread!.suspendedByAdminId, null, "suspendedByAdminId must be null via a fresh repo bundle");
});

// ─── CASE B: ticket reopen clears resolvedAt + closedAt ─────────────────────
test("CASE B — ticket reopen on real Neon clears resolvedAt + closedAt (status → reopened)", async () => {
  const repos = createRepositories("prisma");
  const adminId = await ensureWorkspace(repos);
  // A platform ticket needs a raising user in the workspace.
  const userId = `user_${RUN}`;
  await repos.user.create({
    id: userId, workspaceId: WS, name: "TC User", email: `tcu+${RUN}@test.example`, role: "owner",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });

  // Create a ticket.
  const { createPlatformTicket, changePlatformTicketStatus, addPlatformTicketComment } = await import("@/services/PlatformTicketService");
  const startedAt = new Date("2026-07-13T04:30:00.000Z");
  const ticket = await createPlatformTicket({
    workspaceId: WS, raisedByUserId: userId, creatorRole: "owner",
    subject: "reopen-clear-test", description: "d", category: "bug", priority: "high", now: startedAt,
  });

  // Operator first-response + resolve → resolvedAt set.
  await addPlatformTicketComment({ ticketId: ticket.id, actorType: "operator", actorAdminId: adminId, note: "fixing", now: new Date("2026-07-13T05:30:00.000Z") });
  await changePlatformTicketStatus({ ticketId: ticket.id, toStatus: "resolved", actorType: "operator", actorAdminId: adminId, now: new Date("2026-07-13T07:00:00.000Z") });
  const resolved = await repos.platformTicket.getForOperator(ticket.id);
  assert.ok(resolved!.resolvedAt, "resolve must stamp resolvedAt");
  assert.strictEqual(resolved!.status, "resolved");

  // User reopens within the 7-day window → status reopened AND resolvedAt CLEARED.
  const reopen = await addPlatformTicketComment({
    ticketId: ticket.id, actorType: "user", actorUserId: userId, note: "happened again",
    now: new Date("2026-07-16T07:00:00.000Z"), // +3 days, within window
  });
  assert.strictEqual(reopen.reopened, true, "must reopen within the 7d window");
  assert.strictEqual(reopen.ticket.status, "reopened");

  // THE LOAD-BEARING ASSERTION (the bug): resolvedAt must be CLEARED in Postgres.
  // The domain mapper (mapPlatformTicket) represents "cleared" as `undefined`
  // (a null DB column → undefined), so "cleared" = null OR undefined (NOT the
  // old timestamp). The pre-fix bug kept the OLD resolvedAt value here.
  const reopened = await repos.platformTicket.getForOperator(ticket.id);
  assert.strictEqual(reopened!.status, "reopened");
  assert.ok(reopened!.resolvedAt == null, "reopen must CLEAR resolvedAt in Postgres (was silently kept at its old timestamp by the updateForOperator guard)");
  assert.ok(reopened!.closedAt == null, "reopen must CLEAR closedAt in Postgres");

  // Persistence proof: a FRESH repo bundle reads the same cleared state.
  const fresh = createRepositories("prisma");
  const reread = await fresh.platformTicket.getForOperator(ticket.id);
  assert.ok(reread!.resolvedAt == null, "resolvedAt must be cleared via a fresh repo bundle (persisted, not memory)");
});

// ─── CASE C: WORKSPACE ticket reopen clears resolvedAt (F-DATA-22 fix) ──────
// The Stage 6 fix (CASE B) covered the PLATFORM ticket (operator-facing). The
// 2026-08-05 audit (F-DATA-22) found the WORKSPACE ticket (customer-facing
// TicketService.changeTicketStatus) had the SAME divergence: it sets
// `patch.resolvedAt = undefined` on reopen, JSON repo clears it, but the Prisma
// Ticket repo passed `data` straight through → Prisma ignored the undefined →
// stale resolvedAt stayed on a reopened customer ticket. Fix:
// clearableTicketUpdate maps explicit-undefined resolvedAt/closedAt/
// firstRespondedAt → Prisma null. This case proves it on real Neon.
test("CASE C — WORKSPACE ticket reopen on real Neon clears resolvedAt (status → reopened)", async () => {
  const repos = createRepositories("prisma");
  await ensureWorkspace(repos);
  const { changeTicketStatus } = await import("@/services/TicketService");
  const startedAt = new Date("2026-08-01T04:30:00.000Z").toISOString();
  const dueAt = new Date("2026-08-08T04:30:00.000Z").toISOString();

  // Create a workspace ticket in resolved state (resolvedAt set).
  const ticketId = `tk_${RUN}_C`;
  await repos.ticket.create({
    id: ticketId, workspaceId: WS, ticketNumber: 999, leadId: undefined,
    sourceChannel: "manual", type: "general", priority: "medium", status: "resolved",
    subject: "F-DATA-22 workspace reopen", description: "d",
    sourceEntityType: "manual", slaStartedAt: startedAt, slaDueAt: dueAt,
    resolvedAt: "2026-08-01T10:00:00.000Z",
    createdAt: startedAt, updatedAt: startedAt,
  } as never);
  const before = await repos.ticket.getById(WS, ticketId);
  assert.ok(before!.resolvedAt, "setup: resolved ticket has resolvedAt set");

  // Reopen via the real service — builds patch { status:"reopened", resolvedAt: undefined }.
  await changeTicketStatus(WS, ticketId, "reopened",
    { userId: `owner_${RUN}`, actorType: "owner" }, repos);

  const after = await repos.ticket.getById(WS, ticketId);
  assert.strictEqual(after!.status, "reopened", "reopen must set status");
  // THE LOAD-BEARING ASSERTION: resolvedAt must be CLEARED in Postgres.
  // Pre-fix: Prisma's update({data:{resolvedAt: undefined}}) silently ignored
  // the key → the old "2026-08-01T10:00:00.000Z" stayed.
  assert.ok(after!.resolvedAt == null, `reopen must CLEAR workspace-ticket resolvedAt in Postgres (got ${JSON.stringify(after!.resolvedAt)})`);

  // Persistence proof: a FRESH repo bundle reads the same cleared state.
  const fresh = createRepositories("prisma");
  const reread = await fresh.ticket.getById(WS, ticketId);
  assert.ok(reread!.resolvedAt == null, "workspace-ticket resolvedAt must be cleared via a fresh repo bundle (persisted, not memory)");
});

// ─── Runner ─────────────────────────────────────────────────────────────────
(async () => {
  await cleanup();
  let passed = 0;
  let failed = 0;
  try {
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
  } finally {
    await cleanup();
  }
  console.log(`\n=== Result: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.error("❌ golden-prisma-field-clearing FAILED — the split-brain field-clearing bug is NOT fixed in Postgres.");
    process.exit(1);
  }
  console.log("✅ golden-prisma-field-clearing ALL GREEN ✅");
  process.exit(0);
})();

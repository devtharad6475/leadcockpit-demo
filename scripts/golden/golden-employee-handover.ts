/** Isolated service proof. No live database, email or model calls. */
import "./_helpers/isolate-standalone";
import assert from "node:assert/strict";
import { repositories, createRepositories } from "@/repositories";
import { changeTeamMemberRole, removeTeamMember } from "@/services/TeamService";
import { assignTicketToMember, changeTicketStatus, createTicketFromInbound } from "@/services/TicketService";
import { prisma } from "@/lib/prisma";
import type { TicketStatus, WorkspaceRole } from "@/lib/types";

async function seed(workspaceId: string, suffix: string, role: WorkspaceRole) {
  const id = `${workspaceId}-${suffix}`;
  const now = new Date().toISOString();
  await repositories.user.create({ id, workspaceId, email: `${id}@example.test`, name: suffix, role });
  await repositories.userCredential.create({ userId: id, workspaceId, email: `${id}@example.test`, passwordHash: "synthetic-not-used", sessionVersion: 1 });
  await repositories.workspaceMember.create({ id: `${id}-member`, workspaceId, userId: id,
    email: `${id}@example.test`, name: suffix, role, status: "active", createdAt: now, updatedAt: now });
  return { id, memberId: `${id}-member` };
}

async function company(workspaceId: string) {
  return { workspaceId, owner: await seed(workspaceId, "owner", "owner"), staff: await seed(workspaceId, "employee", "sales_member") };
}

async function ticket(workspaceId: string, assignedTo?: string, status: TicketStatus = "open") {
  const created = await createTicketFromInbound({ workspaceId, sourceChannel: "manual", type: "question", priority: "medium",
    subject: "Product enquiry", description: "Customer needs a specification." }, repositories);
  return repositories.ticket.update(workspaceId, created.id, { assignedTo, status });
}

async function main() {
  const blocked = await company("handover-blocked");
  for (const status of ["open", "in_progress", "waiting_customer", "reopened"] as const) await ticket(blocked.workspaceId, blocked.staff.id, status);
  const input = { workspaceId: blocked.workspaceId, actorUserId: blocked.owner.id, memberId: blocked.staff.memberId };
  const auditBefore = await repositories.auditLog.listByWorkspace(blocked.workspaceId);
  for (const action of [() => removeTeamMember(input), () => changeTeamMemberRole({ ...input, role: "viewer" })]) {
    await assert.rejects(action, error => error instanceof Error && "statusCode" in error && error.statusCode === 409 && /4 unfinished tickets.*Open Tickets and reassign/.test(error.message));
  }
  assert.equal((await repositories.workspaceMember.findForUser(blocked.workspaceId, blocked.staff.id))?.status, "active");
  assert.equal((await repositories.workspaceMember.findForUser(blocked.workspaceId, blocked.staff.id))?.role, "sales_member");
  assert.equal((await repositories.userCredential.findByUserId(blocked.staff.id))?.sessionVersion, 1);
  assert.deepEqual(await repositories.auditLog.listByWorkspace(blocked.workspaceId), auditBefore);
  console.log("PASS all unfinished states block departure/viewer access; membership, sessions and history unchanged");

  const handed = await company("handover-explicit");
  const caseRecord = await ticket(handed.workspaceId, handed.staff.id);
  await assignTicketToMember(handed.workspaceId, caseRecord.id, handed.owner.id, handed.owner.id, repositories);
  await changeTeamMemberRole({ workspaceId: handed.workspaceId, actorUserId: handed.owner.id, memberId: handed.staff.memberId, role: "viewer" });
  assert.equal((await repositories.ticket.getById(handed.workspaceId, caseRecord.id))?.assignedTo, handed.owner.id);
  assert.equal((await repositories.userCredential.findByUserId(handed.staff.id))?.sessionVersion, 2);
  assert.ok((await repositories.ticketEvent.listByTicket(handed.workspaceId, caseRecord.id)).some(event => event.eventType === "assigned" && /owner/.test(event.note || "")));
  console.log("PASS deliberate handover permits downgrade and keeps named responsibility/history");

  const finished = await company("handover-finished");
  const resolved = await ticket(finished.workspaceId, finished.staff.id, "resolved");
  await ticket(finished.workspaceId, finished.staff.id, "closed");
  await ticket("another-company", finished.staff.id, "open");
  await removeTeamMember({ workspaceId: finished.workspaceId, actorUserId: finished.owner.id, memberId: finished.staff.memberId });
  assert.equal((await repositories.workspaceMember.findForUser(finished.workspaceId, finished.staff.id))?.status, "disabled");
  assert.equal((await repositories.ticket.getById(finished.workspaceId, resolved.id))?.assignedTo, finished.staff.id);
  await assert.rejects(() => changeTicketStatus(finished.workspaceId, resolved.id, "reopened", { actorType: "owner", userId: finished.owner.id }, repositories), /Reassign this ticket/);
  assert.equal((await repositories.ticket.getById(finished.workspaceId, resolved.id))?.status, "resolved");
  await assignTicketToMember(finished.workspaceId, resolved.id, finished.owner.id, finished.owner.id, repositories);
  assert.equal((await changeTicketStatus(finished.workspaceId, resolved.id, "reopened", { actorType: "owner", userId: finished.owner.id }, repositories)).status, "reopened");
  console.log("PASS finished history preserved; foreign cases ignored; reopening needs a working handler");

  const rollback = await company("handover-rollback");
  const bump = repositories.userCredential.bumpSessionVersion;
  repositories.userCredential.bumpSessionVersion = async () => { throw new Error("simulated credential persistence failure"); };
  try {
    await assert.rejects(() => changeTeamMemberRole({ workspaceId: rollback.workspaceId, actorUserId: rollback.owner.id, memberId: rollback.staff.memberId, role: "viewer" }), /simulated credential/);
    await assert.rejects(() => removeTeamMember({ workspaceId: rollback.workspaceId, actorUserId: rollback.owner.id, memberId: rollback.staff.memberId }), /simulated credential/);
  } finally { repositories.userCredential.bumpSessionVersion = bump; }
  assert.equal((await repositories.workspaceMember.findForUser(rollback.workspaceId, rollback.staff.id))?.role, "sales_member");
  assert.equal((await repositories.workspaceMember.findForUser(rollback.workspaceId, rollback.staff.id))?.status, "active");
  assert.equal((await repositories.user.findById(rollback.staff.id))?.role, "sales_member");
  console.log("PASS failed session persistence rolls back removal and role/user changes");

  for (const assignFirst of [true, false]) {
    const race = await company(`handover-race-${assignFirst}`);
    const record = await ticket(race.workspaceId);
    const remove = () => removeTeamMember({ workspaceId: race.workspaceId, actorUserId: race.owner.id, memberId: race.staff.memberId });
    const assign = () => assignTicketToMember(race.workspaceId, record.id, race.staff.id, race.owner.id, repositories);
    const results = await Promise.allSettled(assignFirst ? [assign(), remove()] : [remove(), assign()]);
    assert.equal(results[0].status, "fulfilled");
    assert.equal(results[1].status, "rejected");
    const member = await repositories.workspaceMember.findForUser(race.workspaceId, race.staff.id);
    const assigned = (await repositories.ticket.getById(race.workspaceId, record.id))?.assignedTo;
    assert.ok(member?.status === "active" || assigned !== race.staff.id, "departure raced into an orphaned ticket");
  }
  console.log("PASS simultaneous assignment/departure both arrival orders produce no orphan");

  const note = await ticket(blocked.workspaceId);
  await assert.rejects(() => changeTicketStatus(blocked.workspaceId, note.id, "resolved", { actorType: "owner", note: "x".repeat(5_001) }, repositories), /5,000/);
  assert.equal((await repositories.ticket.getById(blocked.workspaceId, note.id))?.status, "open");
  console.log("PASS oversized outcome note rejected before case/history changes");

  // Contract proof only: verifies scoped SQL lock precedes the callback and
  // nested repository transaction reuses the same client. No PG connection.
  const originalTransaction = prisma.$transaction;
  const calls: string[] = [];
  const tx = { $executeRaw: async (_sql: TemplateStringsArray, key: unknown) => { calls.push(String(key)); return 1; } };
  prisma.$transaction = (async (work: (client: unknown) => Promise<unknown>) => work(tx)) as typeof prisma.$transaction;
  try {
    const pg = createRepositories("prisma");
    await pg.withWorkspaceTeamTransaction!("contract-company", async () => {
      calls.push("business-work");
      await pg.withTransaction!(async () => { calls.push("nested-work"); });
    });
    assert.deepEqual(calls, ["leadcockpit:team-ticket:contract-company", "business-work", "nested-work"]);
  } finally { prisma.$transaction = originalTransaction; }
  console.log("PASS Prisma company lock contract uses current transaction before business work (not live PG proof)");
  console.log("7 handover scenarios PASS");
}

main().catch(error => { console.error(error); process.exitCode = 1; });

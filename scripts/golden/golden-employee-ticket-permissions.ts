/** A read-only employee must never receive work they cannot complete.
 * Isolated JSON service proof: manual refusal preserves the case; round-robin
 * skips the viewer, only-viewer teams stay unassigned, viewer-targeted rules
 * stay unassigned instead of silently selecting a different employee.
 */
import "./_helpers/isolate-standalone";
import assert from "node:assert/strict";
import { repositories } from "@/repositories";
import { assignTicketToMember, createTicketFromInbound } from "@/services/TicketService";
import { defaultTicketSlaSettings } from "@/lib/ticket-sla";
import type { WorkspaceRole } from "@/lib/types";

async function team(workspaceId: string, roles: WorkspaceRole[]) {
  for (const [index, role] of roles.entries()) {
    const now = new Date().toISOString();
    await repositories.workspaceMember.create({
      id: `${workspaceId}-member-${index}`, workspaceId,
      userId: `${workspaceId}-user-${index}`, email: `${workspaceId}-${index}@example.test`,
      name: role, role, status: "active", createdAt: now, updatedAt: now,
    });
  }
}

async function ticket(workspaceId: string) {
  return createTicketFromInbound({ workspaceId, sourceChannel: "manual", type: "question",
    priority: "medium", subject: "Sample request follow-up", description: "Customer needs an answer." }, repositories);
}

async function main() {
  const manual = "employee-manual";
  await team(manual, ["viewer", "sales_member"]);
  const original = await ticket(manual);
  const eventsBefore = await repositories.ticketEvent.listByTicket(manual, original.id);
  await assert.rejects(() => assignTicketToMember(manual, original.id, `${manual}-user-0`, "owner", repositories), /permission to work tickets/);
  assert.equal((await repositories.ticket.getById(manual, original.id))?.assignedTo, undefined);
  assert.deepEqual(await repositories.ticketEvent.listByTicket(manual, original.id), eventsBefore);
  assert.equal((await assignTicketToMember(manual, original.id, `${manual}-user-1`, "owner", repositories)).assignedTo, `${manual}-user-1`);
  console.log("PASS manual: viewer refused without changing case/history; sales employee accepted");

  const rotating = "employee-rotating";
  await team(rotating, ["viewer", "sales_member", "admin"]);
  await repositories.ticketSlaSettings.upsertForWorkspace(rotating, { ...defaultTicketSlaSettings(rotating), assignmentMode: "round_robin", roundRobinPointer: 0 });
  // Two eligible workers => first gets worker 1, second worker 2, third worker 1.
  const assigned = [];
  for (let index = 0; index < 3; index++) assigned.push((await ticket(rotating)).assignedTo);
  assert.deepEqual(assigned, [`${rotating}-user-1`, `${rotating}-user-2`, `${rotating}-user-1`]);
  console.log("PASS rotation: sales employee, admin, sales employee; viewer skipped");

  const onlyViewer = "employee-viewer-only";
  await team(onlyViewer, ["viewer"]);
  await repositories.ticketSlaSettings.upsertForWorkspace(onlyViewer, { ...defaultTicketSlaSettings(onlyViewer), assignmentMode: "round_robin", roundRobinPointer: 0 });
  const unassigned = await ticket(onlyViewer);
  assert.equal(unassigned.assignedTo, undefined);
  assert.equal((await repositories.ticketSlaSettings.getByWorkspace(onlyViewer))?.roundRobinPointer, 0);
  assert.equal((await repositories.ticketEvent.listByTicket(onlyViewer, unassigned.id)).some(event => event.eventType === "assigned"), false);
  console.log("PASS only viewers: case stays unassigned; no false assignment or pointer advance");

  const ruled = "employee-rule";
  await team(ruled, ["viewer", "sales_member"]);
  await repositories.ticketSlaSettings.upsertForWorkspace(ruled, { ...defaultTicketSlaSettings(ruled), assignmentMode: "auto_rule",
    assignmentRules: [{ match: {}, assignToUserId: `${ruled}-user-0` }] });
  const ruleTicket = await ticket(ruled);
  assert.equal(ruleTicket.assignedTo, undefined);
  assert.equal((await repositories.ticketEvent.listByTicket(ruled, ruleTicket.id)).some(event => event.eventType === "assigned"), false);
  console.log("PASS rule targeting viewer: stays unassigned; no invented replacement");
  console.log("4 employee ticket permission scenarios PASS");
}

main().catch(error => { console.error(error); process.exitCode = 1; });

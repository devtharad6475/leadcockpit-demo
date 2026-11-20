/**
 * TeamService — remove a team member and change a member's role (S3,
 * docs/REVIEW-2026-09-27.md §4; rules in docs/LOGIC.md 2026-09-28).
 *
 * Before this, nobody could be taken off a team and access was decided by the
 * user record alone, so a person who left kept working access for as long as
 * their cookie lived. Now:
 *
 *   - Only an ACTIVE owner or admin of the company can change the team.
 *   - Nobody changes their own role or removes themselves here (so nobody can
 *     raise themselves, and nobody locks themselves out by accident).
 *   - An admin cannot remove an owner, change an owner's role, or make anyone
 *     an owner. Only an owner can make another owner.
 *   - The company always keeps at least one active owner.
 *   - Both changes take effect on the person's very next request: their
 *     sessionVersion is bumped (every cookie they hold stops working), and
 *     resolveCurrentUser reads the role from the membership row, not the user
 *     record.
 *   - Every change writes an audit row (who, whom, from what, to what).
 *
 * A removed person's membership row is kept with status "disabled" (their name
 * stays on records they touched). Inviting them again reuses that row — see
 * InviteService.
 */
import { AuthorizationError } from "@/lib/auth-service";
import { NeedsActionError } from "@/lib/user-errors";
import { oneAtATime } from "@/lib/one-at-a-time";
import { repositories } from "@/repositories";
import type { WorkspaceMember, WorkspaceRole } from "@/lib/types";

const ASSIGNABLE_ROLES: WorkspaceRole[] = ["owner", "admin", "sales_member", "viewer"];

const ROLE_WORDS: Record<WorkspaceRole, string> = {
  owner: "Owner",
  admin: "Admin",
  sales_member: "Sales Member",
  viewer: "Viewer",
};

async function activeMemberFor(workspaceId: string, userId: string): Promise<WorkspaceMember | undefined> {
  const member = await repositories.workspaceMember.findForUser(workspaceId, userId);
  return member && member.status === "active" ? member : undefined;
}

async function loadActorAndTarget(workspaceId: string, actorUserId: string, memberId: string) {
  const actor = await activeMemberFor(workspaceId, actorUserId);
  if (!actor || (actor.role !== "owner" && actor.role !== "admin")) {
    throw new AuthorizationError("Only an owner or admin can change the team.", 403);
  }
  const members = await repositories.workspaceMember.listByWorkspace(workspaceId);
  const target = members.find((m) => m.id === memberId);
  if (!target || target.status !== "active" || !target.userId) {
    throw new NeedsActionError("That person is not on your team any more. Refresh the page to see the current team.", 404);
  }
  if (target.userId === actorUserId) {
    throw new NeedsActionError("You can't change your own access. Ask another owner to do it.", 400);
  }
  if (actor.role === "admin" && target.role === "owner") {
    throw new AuthorizationError("Only an owner can change or remove another owner.", 403);
  }
  const activeOwners = members.filter((m) => m.status === "active" && m.role === "owner");
  return { actor, target, activeOwners };
}

export type TeamChangeResult = { memberId: string; userId: string; role: WorkspaceRole; status: WorkspaceMember["status"] };

/** Work must have a responsible person before their current handler loses access. */
async function requireTicketHandover(workspaceId: string, target: WorkspaceMember): Promise<void> {
  const unfinished = (await repositories.ticket.listOpenTickets(workspaceId))
    .filter((ticket) => ticket.assignedTo === target.userId);
  if (unfinished.length) {
    throw new NeedsActionError(
      `${target.name || target.email} still has ${unfinished.length} unfinished ticket${unfinished.length === 1 ? "" : "s"}. Open Tickets and reassign that work to an active team member before removing their access or making them a Viewer.`,
      409,
    );
  }
}

function teamTransaction<T>(workspaceId: string, work: () => Promise<T>): Promise<T> {
  if (repositories.withWorkspaceTeamTransaction) return repositories.withWorkspaceTeamTransaction(workspaceId, work);
  return repositories.withTransaction ? repositories.withTransaction(work) : work();
}

/** Take a person off the team. Their sessions end immediately. */
export async function removeTeamMember(input: { workspaceId: string; actorUserId: string; memberId: string }): Promise<TeamChangeResult> {
  return oneAtATime(`team:${input.workspaceId}`, () => teamTransaction(input.workspaceId, async () => {
    const { target, activeOwners } = await loadActorAndTarget(input.workspaceId, input.actorUserId, input.memberId);
    if (target.role === "owner" && activeOwners.length <= 1) {
      throw new NeedsActionError("This is the company's only owner. Make someone else an owner first.", 400);
    }
    const userId = target.userId as string;
    await requireTicketHandover(input.workspaceId, target);
    const updated = await repositories.workspaceMember.update(input.workspaceId, target.id, { status: "disabled" });
    await repositories.userCredential.bumpSessionVersion(userId);
    await repositories.auditLog.create({
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId,
      eventType: "team.member_removed",
      entityType: "workspace_member",
      entityId: target.id,
      payload: { userId, email: target.email, role: target.role },
    }).catch((e: unknown) => console.error("[audit] team.member_removed write failed:", e));
    return { memberId: updated.id, userId, role: updated.role, status: updated.status };
  }));
}

/** Change a person's role. Their sessions end so the new role applies at once. */
export async function changeTeamMemberRole(input: { workspaceId: string; actorUserId: string; memberId: string; role: WorkspaceRole }): Promise<TeamChangeResult> {
  if (!ASSIGNABLE_ROLES.includes(input.role)) {
    throw new NeedsActionError("Choose Owner, Admin, Sales Member or Viewer.", 400);
  }
  return oneAtATime(`team:${input.workspaceId}`, () => teamTransaction(input.workspaceId, async () => {
    const { actor, target, activeOwners } = await loadActorAndTarget(input.workspaceId, input.actorUserId, input.memberId);
    if (input.role === "owner" && actor.role !== "owner") {
      throw new AuthorizationError("Only an owner can make someone an owner.", 403);
    }
    if (target.role === input.role) {
      throw new NeedsActionError(`${target.name || target.email} is already ${ROLE_WORDS[input.role]}.`, 400);
    }
    if (target.role === "owner" && activeOwners.length <= 1) {
      throw new NeedsActionError("This is the company's only owner. Make someone else an owner first.", 400);
    }
    const userId = target.userId as string;
    if (input.role === "viewer") await requireTicketHandover(input.workspaceId, target);
    const previousRole = target.role;
    const updated = await repositories.workspaceMember.update(input.workspaceId, target.id, { role: input.role });
    // Keep the user record in step so nothing that still reads it shows the old role.
    await repositories.user.update(userId, { role: input.role });
    await repositories.userCredential.bumpSessionVersion(userId);
    await repositories.auditLog.create({
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId,
      eventType: "team.role_changed",
      entityType: "workspace_member",
      entityId: target.id,
      payload: { userId, email: target.email, fromRole: previousRole, toRole: input.role },
    }).catch((e: unknown) => console.error("[audit] team.role_changed write failed:", e));
    return { memberId: updated.id, userId, role: updated.role, status: updated.status };
  }));
}

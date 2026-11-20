/**
 * 2026-07-21 (Cluster B fix, session 17) — Mutation workspace resolution.
 *
 * Extracted from the POST/PUT handlers so the rule is testable in isolation
 * and lives in ONE place (skill Phase 3d Chokepoint Rule). The rule:
 *
 *   - Demo mode: body workspaceId is IGNORED. Always resolves to
 *     `defaultWorkspaceId` (the JSON demo runtime). This is intentional —
 *     demo bypasses auth so smokes + the JSON demo work without setup.
 *
 *   - Production mode: the resolved workspace comes from the SESSION user.
 *     If the request body's workspaceId is present and DIFFERS from the
 *     session user's workspace, the request is rejected with 403. This
 *     prevents the cross-tenant attack documented as P0 finding A1 in
 *     docs/AUDIT-FINDINGS-2026-07-21.md (body workspaceId="workspace_demo"
 *     from a user in ws_A → writes into ws_demo).
 *
 * The OLD behaviour compared the body against the `defaultWorkspaceId`
 * CONSTANT. That admitted the attack above the moment a second workspace
 * existed. This helper compares against the session-derived workspace.
 *
 * Pinned by scripts/golden/golden-workspace-scoping.ts.
 */
import { defaultWorkspaceId } from "@/lib/db";
import type { AuthMode } from "@/lib/auth";

export type ResolveOk = { ok: true; workspaceId: string };
export type ResolveBlocked = {
  ok: false;
  status: 403;
  code: "FORBIDDEN";
  message: string;
};

export type SessionUser = { workspaceId: string; userId: string } | null;

/**
 * Resolve the workspaceId for a mutation (POST/PUT/DELETE) and enforce the
 * cross-tenant block in production. Pure function — does not perform I/O.
 *
 * Caller responsibility: in production, the caller MUST pass the session
 * user resolved from the request (typically via resolveCurrentUser). In
 * demo, the caller passes null (the helper falls back to default).
 */
export async function resolveMutationWorkspace(input: {
  authMode: AuthMode;
  /** Unused by the helper itself; kept for symmetry with the call site. */
  request: unknown;
  bodyWorkspaceId: string | undefined;
  sessionUser: SessionUser;
}): Promise<ResolveOk | ResolveBlocked> {
  void input.request; // request is read by the caller to derive sessionUser.

  // Demo mode: bypass. The body's workspaceId is ignored entirely; demo
  // doesn't authenticate, so the body value carries no security meaning.
  if (input.authMode !== "production") {
    return { ok: true, workspaceId: defaultWorkspaceId };
  }

  // Production: resolve from session. Defensive fallback to default if the
  // session somehow has no workspace (shouldn't happen — the auth gate
  // rejects unauthenticated requests upstream — but fail-safe).
  const sessionWorkspaceId = input.sessionUser?.workspaceId || defaultWorkspaceId;

  // Cross-tenant block: if the body advertises a workspaceId, it MUST match
  // the session. This is the fix for finding A1.
  if (
    typeof input.bodyWorkspaceId === "string"
    && input.bodyWorkspaceId !== sessionWorkspaceId
  ) {
    return {
      ok: false,
      status: 403,
      code: "FORBIDDEN",
      message: "Workspace ID in request body does not match the authenticated workspace.",
    };
  }

  return { ok: true, workspaceId: sessionWorkspaceId };
}

/**
 * 2026-07-21 (Cluster B fix, session 17) — Resolve the actor identity for
 * an audit-log entry. In production, the actor is ALWAYS derived from the
 * session — the request body's actorUserId is IGNORED (it's user-controlled
 * and therefore forgeable). In demo, the body value is accepted (demo
 * bypasses auth so the body is the only signal).
 *
 * Without this, P0 finding A5 stands: a sales_member flipping the kill-
 * switch can stamp the audit entry as `actorUserId: "user_owner"`,
 * framing another user.
 *
 * Usage:
 *   const actor = await resolveActor(request, body?.actorUserId);
 *   await repos.auditLog.create({ ..., actorUserId: actor.userId });
 */
export async function resolveActor(
  request: { headers: { get(name: string): string | null } } | unknown,
  bodyActorUserId: string | undefined,
): Promise<{ userId: string; source: "session" | "body" | "fallback" }> {
  // Lazy import to avoid circular dependencies at module load.
  const { getAuthMode } = await import("@/lib/auth");
  if (getAuthMode() !== "production") {
    // Demo: body is the only signal.
    if (typeof bodyActorUserId === "string" && bodyActorUserId.trim()) {
      return { userId: bodyActorUserId, source: "body" };
    }
    return { userId: "demo_user", source: "fallback" };
  }
  // Production: derive from session.
  try {
    const { resolveCurrentUser } = await import("@/lib/auth-service");
    const user = await resolveCurrentUser(request as never);
    if (user) {
      return { userId: user.id, source: "session" };
    }
  } catch {
    // Fall through to fallback.
  }
  return { userId: "unknown", source: "fallback" };
}

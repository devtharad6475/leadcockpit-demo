import type { NextRequest } from "next/server";
import { defaultWorkspaceId } from "./db";

export type AuthMode = "demo" | "local" | "production";
export type WorkspaceRole = "owner" | "admin" | "sales_member" | "viewer";

export type RequestUser = {
  id: string;
  email?: string;
  name?: string;
  role: WorkspaceRole;
  workspaceId: string;
  // CP-20 (2026-08-02) — true when this user is an anonymous public-tour
  // visitor (viewer role on workspace_demo). Surfaced from the signed session
  // payload so the UI can render read-only tour chrome. The backend RBAC 403
  // is the real gate; this flag is informational for the UI.
  isTour?: boolean;
};

export function getAuthMode(): AuthMode {
  const value = process.env.AUTH_MODE;
  if (value === "production" || value === "local" || value === "demo") return value;
  return "demo";
}

export function getCurrentUserFromRequest(request: NextRequest): RequestUser {
  // Synchronous resolver used by legacy/non-async paths. In production the
  // real auth check is async (DB + cookie verification) and is performed by
  // resolveCurrentUser() in auth-service.ts at the route entry points.
  // This function is only safe to call in demo/local mode.
  void request;
  const mode = getAuthMode();
  if (mode === "production") {
    throw new Error("Production auth requires the async resolver (resolveCurrentUser).");
  }
  return { id: "user_owner", email: "owner@example.com", name: "Demo Owner", role: "owner", workspaceId: defaultWorkspaceId };
}

export function getDemoWorkspaceContext() {
  return { workspaceId: "workspace_demo", userId: "user_owner", mode: getAuthMode() };
}

export function getCurrentUser(request: NextRequest) {
  return getCurrentUserFromRequest(request);
}

export function requireUser(request: NextRequest) {
  return getCurrentUserFromRequest(request);
}

export function getCurrentWorkspace(request: NextRequest) {
  const user = getCurrentUserFromRequest(request);
  return { workspaceId: user.workspaceId, userId: user.id, role: user.role, mode: getAuthMode() };
}

export function requireWorkspaceAccess(request: NextRequest, workspaceId: string) {
  const user = requireUser(request);
  if (user.workspaceId !== workspaceId) throw new Error("Workspace access denied");
  return user;
}

export function requireRole(request: NextRequest, allowed: WorkspaceRole[]) {
  const user = requireUser(request);
  if (!allowed.includes(user.role)) throw new Error("Forbidden");
  return user;
}

export function productionAuthConfigured() {
  if (getAuthMode() !== "production") return true;
  // Phase 1.4 audit fix: this code uses the built-in email/password + signed-
  // session system (src/lib/session.ts). It is "configured" ONLY when
  // AUTH_SESSION_SECRET is set to a sufficiently long random value. The old
  // code OR-ed in legacy providers (NextAuth/Clerk) that this codebase does
  // not actually use — that was misleading. The real provider is the session
  // secret, period.
  // Note: we do NOT require a UserCredential to exist here, because the
  // bootstrap endpoint (which creates the first owner) must be reachable
  // before any credential exists. The "has a real user" check belongs in the
  // production-readiness gate, not here.
  const sessionSecret = process.env.AUTH_SESSION_SECRET;
  return Boolean(sessionSecret && sessionSecret.length >= 32);
}

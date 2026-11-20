/**
 * Stage 5 / WP3 (2026-07-28) — Platform admin authentication service.
 *
 * The operator (you) + future support hires authenticate here to reach the
 * `/admin/*` panel. This is INTENTIONALLY a separate auth system from the
 * workspace user auth (`src/lib/auth-service.ts`):
 *
 *   - Separate cookie (`lc_platform_admin`) — logging into /admin does NOT log
 *     you into any workspace, and vice-versa. Blast-radius containment: a
 *     leaked workspace cookie can't reach /admin.
 *   - Separate session payload (`adminId` + `role: PlatformAdminRole`, no
 *     workspaceId) — the admin panel is cross-workspace by design.
 *   - Separate secret (`PLATFORM_ADMIN_SESSION_SECRET`, falls back to
 *     `AUTH_SESSION_SECRET` so a single-operator setup needs one secret).
 *
 * Rules in docs/LOGIC.md 2026-07-28 (PlatformAdmin login / roles / bootstrap).
 *
 * Roles: `operator` (full power) + `support_agent` (limited to platform
 * tickets). Flat ladder — they're different scopes, not privilege ranks.
 *
 * Pinned by `golden:platform-admin-auth` (login round-trip, RBAC gate,
 * cross-session isolation, bootstrap idempotency).
 */
import { NeedsActionError } from "@/lib/user-errors";
import type { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import { getAuthMode } from "@/lib/auth";
import { uid, timestamp } from "@/lib/db";
import { hashPassword, verifyPassword } from "@/lib/password";
import { repositories } from "@/repositories";
import type { PlatformAdmin, PlatformAdminRole } from "@/lib/types";

export { AuthenticationError, AuthorizationError } from "@/lib/auth-service";

export const PLATFORM_ADMIN_COOKIE = "lc_platform_admin";
const ADMIN_SESSION_TTL_SECONDS = 60 * 60 * 8; // 8 hours (shorter than workspace: admin power = shorter window)
const ALGORITHM = "sha256";

/**
 * Admin session payload. Distinct from the workspace SessionPayload — no
 * workspaceId (admins are cross-workspace), carries adminId + role.
 */
export type PlatformAdminSession = {
  adminId: string;
  role: PlatformAdminRole;
  email: string;
  /**
   * 2026-09-28 (S4) — the credential's sessionVersion when this cookie was
   * issued. Signing out bumps it, so a copied admin cookie stops working.
   * Bound into the HMAC like every other field.
   */
  sessionVersion?: number;
  exp: number;
};

/**
 * Resolve the admin session signing secret. Production requires
 * PLATFORM_ADMIN_SESSION_SECRET (≥32 chars) OR falls back to
 * AUTH_SESSION_SECRET (so a single-operator setup with one secret works).
 * Demo/local uses a deterministic throwaway (these modes never gate on real
 * auth anyway).
 */
function getAdminSigningSecret(): string {
  const mode = getAuthMode();
  const envSecret = process.env.PLATFORM_ADMIN_SESSION_SECRET || process.env.AUTH_SESSION_SECRET;
  if (mode === "production") {
    if (!envSecret || envSecret.length < 32) {
      throw new Error("PLATFORM_ADMIN_SESSION_SECRET (or AUTH_SESSION_SECRET) must be set to ≥32 characters in production.");
    }
    return envSecret;
  }
  return envSecret || "dev-only-throwaway-platform-admin-secret-do-not-use-in-prod";
}

function b64encode(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}
function b64decode(input: string): string {
  return Buffer.from(input, "base64url").toString("utf8");
}
function sign(payload: string, secret: string): string {
  return createHmac(ALGORITHM, secret).update(payload).digest("base64url");
}

/** Create a signed admin session token from a payload. */
export function createAdminSessionToken(payload: Omit<PlatformAdminSession, "exp">): string {
  const secret = getAdminSigningSecret();
  const full: PlatformAdminSession = { ...payload, exp: Math.floor(Date.now() / 1000) + ADMIN_SESSION_TTL_SECONDS };
  const payloadB64 = b64encode(JSON.stringify(full));
  const signature = sign(payloadB64, secret);
  return `${payloadB64}.${signature}`;
}

/**
 * Verify an admin session token. Returns null on any tamper/expiry/shape
 * failure (never throws for bad tokens). Throws only for config errors
 * (missing production secret).
 */
export function verifyAdminSessionToken(token: string | undefined | null): PlatformAdminSession | null {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot >= token.length - 1) return null;
  const payloadB64 = token.slice(0, dot);
  const providedSig = token.slice(dot + 1);
  const secret = getAdminSigningSecret();
  const expectedSig = sign(payloadB64, secret);
  const a = Buffer.from(providedSig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let payload: PlatformAdminSession;
  try {
    payload = JSON.parse(b64decode(payloadB64)) as PlatformAdminSession;
  } catch {
    return null;
  }
  if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) return null;
  if (!payload.adminId || !payload.role || !payload.email) return null;
  return payload;
}

export function readAdminSessionFromRequest(request: NextRequest): PlatformAdminSession | null {
  return verifyAdminSessionToken(request.cookies.get(PLATFORM_ADMIN_COOKIE)?.value);
}

/** Set the admin session cookie on a response (HttpOnly + Secure in prod). */
export function setAdminSessionCookie(response: NextResponse, token: string): void {
  const mode = getAuthMode();
  response.cookies.set(PLATFORM_ADMIN_COOKIE, token, {
    httpOnly: true,
    secure: mode === "production",
    sameSite: "lax",
    path: "/",
    maxAge: ADMIN_SESSION_TTL_SECONDS,
  });
}

export function clearAdminSessionCookie(response: NextResponse): void {
  response.cookies.set(PLATFORM_ADMIN_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
}

// ─── Bootstrap (CLI: npm run bootstrap:admin) ────────────────────────────────

export type BootstrapAdminInput = {
  email: string;
  password: string;
  name?: string;
  role?: PlatformAdminRole;
};

/**
 * Create the first PlatformAdmin. Used by `scripts/bootstrap-admin.ts`.
 * Refuses if the email already exists. Atomic (admin + credential in one
 * transaction). Mirrors the proven `bootstrapOwner` pattern.
 */
export async function bootstrapPlatformAdmin(input: BootstrapAdminInput): Promise<PlatformAdmin> {
  const email = input.email.trim().toLowerCase();
  if (!email || !email.includes("@")) {
    throw new NeedsActionError("A valid admin email is required.", 400);
  }
  if (!input.password || input.password.length < 8) {
    throw new NeedsActionError("Admin password must be at least 8 characters.", 400);
  }
  const passwordHash = await hashPassword(input.password);
  const adminId = uid("platform_admin");
  const now = timestamp();
  const admin: Omit<PlatformAdmin, "createdAt" | "updatedAt"> = {
    id: adminId,
    email,
    name: input.name?.trim() || "Operator",
    role: input.role || "operator",
    status: "active",
    lastLoginAt: undefined,
  };
  const credential = {
    adminId,
    email,
    passwordHash,
  };
  void now;
  return repositories.platformAdmin.createWithCredential({ admin, credential });
}

// ─── Login ───────────────────────────────────────────────────────────────────

export type AdminLoginResult =
  | { ok: true; admin: PlatformAdmin; token: string }
  | { ok: false; reason: string };

/**
 * Verify an admin email/password and issue an admin session token.
 * Constant-time password compare (verifyPassword). Never reveals whether the
 * email or the password was wrong. Records a platform audit event for both
 * success and failure. Refuses suspended admins.
 */
export async function loginPlatformAdmin(email: string, password: string): Promise<AdminLoginResult> {
  if (!email || !password) return { ok: false, reason: "Email and password are required." };
  const found = await repositories.platformAdmin.findByEmail(email);
  // Dummy-hash to keep CPU cost consistent when the email is unknown.
  const dummyHash = "scrypt:32768:64:00000000000000000000000000000000:00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";
  const ok = found ? await verifyPassword(password, found.credential.passwordHash) : await verifyPassword(password, dummyHash);
  if (!found || !ok) {
    // Stage 5 re-audit fix (F-P3-2, 2026-07-28): write a platform audit row
    // for EVERY failed login, including when the email matches no admin. Pre-
    // fix the audit write was gated by `if (found)`, so enumeration attacks
    // (probing admin emails) left zero audit trail. Now unknown emails get a
    // sentinel adminId="unknown" row. Pinned by golden:stage5-batch4-
    // chokepoints CASE 11.
    const auditAdminId = found ? found.admin.id : "unknown";
    const auditMetadata = found
      ? { email, reason: "wrong_password" }
      : { email, reason: "unknown_email" };
    await repositories.platformAuditLog.create({
      adminId: auditAdminId,
      action: "admin_login_failed",
      metadata: auditMetadata,
    }).catch((e: unknown) => console.warn("[platform-admin-audit] failed login audit write failed:", e instanceof Error ? e.message : e));
    return { ok: false, reason: "Incorrect email or password." };
  }
  if (found.admin.status === "suspended") {
    await repositories.platformAuditLog.create({ adminId: found.admin.id, action: "admin_login_failed", metadata: { reason: "suspended" } }).catch((e: unknown) => console.warn("[platform-admin-audit] suspended audit write failed:", e instanceof Error ? e.message : e));
    return { ok: false, reason: "This admin account is suspended." };
  }
  await repositories.platformAdmin.touchLogin(found.admin.id);
  await repositories.platformAuditLog.create({ adminId: found.admin.id, action: "admin_login" }).catch((e: unknown) => console.warn("[platform-admin-audit] success audit write failed:", e instanceof Error ? e.message : e));
  const sessionVersion = found.credential.sessionVersion ?? (await repositories.platformAdmin.getSessionVersion(found.admin.id));
  const token = createAdminSessionToken({ adminId: found.admin.id, role: found.admin.role, email: found.admin.email, sessionVersion });
  return { ok: true, admin: found.admin, token };
}

// ─── Request-scoped admin resolution + RBAC gate ─────────────────────────────

export type RequestPlatformAdmin = {
  id: string;
  email: string;
  name: string;
  role: PlatformAdminRole;
};

/**
 * Resolve the current platform admin from the admin session cookie.
 *
 * Demo/local mode: returns null (there is NO demo admin — the admin panel is
 * production-only; demo mode is the workspace app, not the operator panel).
 * This is deliberate: the admin panel must not be reachable without real
 * admin auth, even in demo. Returns null instead of throwing so the caller
 * can decide the response shape (401 vs redirect).
 *
 * Production mode: reads the signed admin cookie, resolves against the
 * persisted admin record, re-checks status (a suspended admin's existing
 * session is invalidated on the next request). Returns null if any check
 * fails.
 */
export async function resolveCurrentPlatformAdmin(request: NextRequest): Promise<RequestPlatformAdmin | null> {
  // Demo mode: no admin panel access (production-only surface).
  if (getAuthMode() !== "production") {
    void request;
    return null;
  }
  const session = readAdminSessionFromRequest(request);
  if (!session) return null;
  const admin = await repositories.platformAdmin.findById(session.adminId);
  if (!admin) return null;
  if (admin.status === "suspended") return null;
  // 2026-09-28 (S4): a signed-out admin cookie is dead even if someone copied it.
  if ((session.sessionVersion ?? 1) !== (await repositories.platformAdmin.getSessionVersion(admin.id))) return null;
  return { id: admin.id, email: admin.email, name: admin.name, role: admin.role };
}

/**
 * Resolve the current admin AND confirm their role meets the minimum.
 * Throws AuthorizationError (403) if authenticated but role is wrong.
 * Throws AuthenticationError (401) if no valid admin session.
 *
 * Usage: `const admin = await requirePlatformAdmin(request, "operator");`
 * (`support_agent` calling an operator-only route → 403.)
 */
export async function requirePlatformAdmin(
  request: NextRequest,
  requiredRole: PlatformAdminRole,
): Promise<RequestPlatformAdmin> {
  // Import here to avoid a circular import at module load (auth-service imports
  // repositories; this file imports repositories + auth-mode only).
  const { AuthenticationError, AuthorizationError } = await import("@/lib/auth-service");
  const admin = await resolveCurrentPlatformAdmin(request);
  if (!admin) {
    throw new AuthenticationError("Platform admin authentication required.", 401);
  }
  // Flat ladder: only the exact-role check applies (support_agent cannot do
  // operator things; operator can do support_agent things trivially). The
  // caller passes the MINIMUM role the route needs.
  if (requiredRole === "operator" && admin.role !== "operator") {
    throw new AuthorizationError("This action requires the operator role.", 403);
  }
  // requiredRole === "support_agent" → any admin (operator or support_agent) passes.
  return admin;
}

/**
 * 2026-09-28 (S4) — sign the operator out for real: every admin cookie issued
 * before this moment stops working (the cookie is also cleared by the route).
 * Takes the raw cookie value; an invalid or expired one needs nothing ended.
 */
export async function signOutPlatformAdmin(token: string | undefined | null): Promise<boolean> {
  const session = verifyAdminSessionToken(token);
  if (!session) return false;
  const current = await repositories.platformAdmin.getSessionVersion(session.adminId);
  // Only a still-valid cookie may end the sessions (a stale copy cannot keep bumping).
  if ((session.sessionVersion ?? 1) !== current) return false;
  await repositories.platformAdmin.bumpSessionVersion(session.adminId);
  await repositories.platformAuditLog.create({ adminId: session.adminId, action: "admin_logout" }).catch((e: unknown) => console.warn("[platform-admin-audit] logout audit write failed:", e instanceof Error ? e.message : e));
  return true;
}

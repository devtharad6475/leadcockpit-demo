/**
 * Signed session cookies for production auth.
 *
 * Design goals:
 *  - Stateless: no session table to manage. The session payload (userId,
 *    workspaceId, role, exp) is stored in the cookie, signed with an
 *    HMAC-SHA256 secret so it cannot be tampered with.
 *  - No new dependencies: uses only Node core crypto + Next.js cookie APIs.
 *  - Tamper-evident: any change to the payload invalidates the signature.
 *  - Expiring: an `exp` timestamp is bound into the signed payload and
 *    enforced on read, so stolen cookies are useless after expiry.
 *
 * Security notes:
 *  - The signing secret MUST be set via AUTH_SESSION_SECRET in production.
 *    We refuse to issue or verify sessions if it is missing there.
 *  - Cookies are HttpOnly + Secure (in production) + SameSite=Lax.
 *    SameSite=Lax is sufficient for our CSRF model because every mutating
 *    request is also covered by the origin check (see csrf.ts).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { getAuthMode } from "./auth";
import type { WorkspaceRole } from "./types";

export const SESSION_COOKIE = "lc_session";
const SESSION_TTL_SECONDS = 60 * 60 * 12; // 12 hours
const ALGORITHM = "sha256";

export type SessionPayload = {
  userId: string;
  workspaceId: string;
  role: WorkspaceRole;
  // Stage 5 / WP1 (2026-07-28) — sessionVersion at issue time. Compared
  // against the credential's CURRENT sessionVersion on every authenticated
  // request; a mismatch (e.g. after a password reset bumped the version)
  // rejects the session. Bound into the HMAC signature (not a free field).
  sessionVersion?: number;
  // Expiry in seconds since epoch. Bound into the signature so it cannot
  // be extended by an attacker.
  exp: number;
  // CP-20 (2026-08-02) — Public read-only Tour flag. When true, this session
  // belongs to an anonymous visitor exploring the shared demo workspace as a
  // read-only `viewer`. Bound into the HMAC signature so it CANNOT be forged
  // (flipping it to false/true off-session invalidates the signature). The
  // backend still relies on the viewer-role RBAC 403 as the real gate; this
  // flag lets the UI render tour chrome + lets the status endpoint report it.
  isTour?: boolean;
};

export class SessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionError";
  }
}

/**
 * Resolve the session signing secret. In demo/local mode we use a fixed
 * throwaway value (these modes never gate on real auth anyway, so the secret
 * only needs to be stable within a process). In production the secret MUST be
 * provided via AUTH_SESSION_SECRET; we throw if it is missing.
 */
function getSigningSecret(): string {
  const mode = getAuthMode();
  const envSecret = process.env.AUTH_SESSION_SECRET;
  if (mode === "production") {
    if (!envSecret || envSecret.length < 32) {
      throw new SessionError("AUTH_SESSION_SECRET must be set to a random value of at least 32 characters in production.");
    }
    return envSecret;
  }
  // Demo/local: deterministic throwaway so dev restarts keep working.
  return envSecret || "dev-only-throwaway-session-secret-do-not-use-in-production";
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

/** Create a signed session token from a payload. */
export function createSessionToken(payload: Omit<SessionPayload, "exp">): string {
  const secret = getSigningSecret();
  const full: SessionPayload = {
    ...payload,
    // Stage 5 / WP1 — default sessionVersion to 1 if not provided (backward
    // compat with callers that predate the version check).
    sessionVersion: payload.sessionVersion ?? 1,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  };
  const payloadB64 = b64encode(JSON.stringify(full));
  const signature = sign(payloadB64, secret);
  return `${payloadB64}.${signature}`;
}

/**
 * Verify a session token and return its payload, or null if it is invalid,
 * tampered with, or expired. Never throws for bad tokens (returns null); only
 * throws for configuration errors (missing production secret).
 */
export function verifySessionToken(token: string | undefined | null): SessionPayload | null {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot >= token.length - 1) return null;
  const payloadB64 = token.slice(0, dot);
  const providedSig = token.slice(dot + 1);
  const secret = getSigningSecret();
  const expectedSig = sign(payloadB64, secret);
  // Constant-time compare to avoid timing leaks.
  const a = Buffer.from(providedSig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let payload: SessionPayload;
  try {
    payload = JSON.parse(b64decode(payloadB64)) as SessionPayload;
  } catch {
    return null;
  }
  if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) return null;
  if (!payload.userId || !payload.workspaceId || !payload.role) return null;
  return payload;
}

export function readSessionFromRequest(request: NextRequest): SessionPayload | null {
  return verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value);
}

/** Set the session cookie on a response. */
export function setSessionCookie(response: NextResponse, token: string): void {
  const mode = getAuthMode();
  response.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: mode === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

/** Clear the session cookie on a response. */
export function clearSessionCookie(response: NextResponse): void {
  response.cookies.set(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
}

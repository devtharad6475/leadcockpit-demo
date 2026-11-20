/**
 * Authentication service.
 *
 * Responsibilities:
 *  - Look up users + their stored credentials.
 *  - Verify email/password and issue a signed session.
 *  - Bootstrap the first owner account when none exists yet.
 *  - Expose the current user for the auth middleware.
 *
 * This service is auth-mode aware:
 *   - demo / local: returns a fixed demo owner (no session required). This
 *     keeps the existing JSON demo and smoke tests working unchanged.
 *   - production: requires a valid signed session cookie for every protected
 *     request; throws if the session is missing or invalid.
 */
import type { NextRequest } from "next/server";
import { getAuthMode, type RequestUser } from "./auth";
import { defaultWorkspaceId, timestamp, uid } from "./db";
import { hashPassword, verifyPassword } from "./password";
import { createSessionToken, readSessionFromRequest, verifySessionToken, type SessionPayload } from "./session";
import { repositories } from "@/repositories";
import type { User, UserCredential, WorkspaceRole } from "./types";

export class AuthenticationError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode = 401) {
    super(message);
    this.name = "AuthenticationError";
    this.statusCode = statusCode;
  }
}

/**
 * Authorization error — the user IS authenticated but lacks the role required
 * for the action. Distinct from AuthenticationError so the route layer can map
 * it to 403 (not 401).
 */
export class AuthorizationError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode = 403) {
    super(message);
    this.name = "AuthorizationError";
    this.statusCode = statusCode;
  }
}

/**
 * Role privilege ranking. Higher = more privileged. Used by requireRole to
 * decide whether the caller's role satisfies a route's minimum required role.
 *
 *   owner        — full control, including settings, integrations, credentials
 *   admin        — everything except destructive owner-only actions
 *   sales_member — day-to-day CRM work (leads, messages, replies, outreach)
 *   viewer       — read-only; cannot mutate any data
 *
 * This mirrors the WorkspaceRole union in types.ts. If a new role is added,
 * add it here with the right rank.
 */
const ROLE_RANK: Record<string, number> = {
  viewer: 10,
  sales_member: 20,
  admin: 30,
  owner: 40,
};

/**
 * Resolve the current user AND confirm their role meets the minimum required.
 *
 * Throws:
 *   - AuthenticationError (401) if no valid session in production mode.
 *   - AuthorizationError (403) if authenticated but role is too low.
 *
 * In demo/local mode this always passes (the demo owner has full access),
 * which keeps smoke tests and the JSON demo functional. RBAC only bites in
 * production mode, exactly like the rest of the auth gate.
 *
 * Usage in a handler:
 *   await requireRole(request, "admin");          // owner or admin
 *   await requireRole(request, "sales_member");   // any non-viewer
 */
export async function requireRole(request: NextRequest, requiredRole: "owner" | "admin" | "sales_member" | "viewer"): Promise<RequestUser> {
  const user = await resolveCurrentUser(request);
  const userRank = ROLE_RANK[user.role] ?? 0;
  const requiredRank = ROLE_RANK[requiredRole] ?? 0;
  if (userRank < requiredRank) {
    throw new AuthorizationError(`This action requires ${requiredRole} access or higher.`);
  }
  return user;
}

function toRequestUser(user: User): RequestUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    workspaceId: user.workspaceId,
  };
}

/**
 * Resolve the current request user.
 *
 * In demo/local mode this returns the fixed demo owner (existing behavior,
 * keeps smoke tests and the JSON demo fully functional).
 *
 * In production mode this reads the signed session cookie and resolves it
 * against the persisted user record. Throws AuthenticationError if the
 * session is missing, invalid, expired, or points at a user that no longer
 * exists.
 */
export async function resolveCurrentUser(request: NextRequest): Promise<RequestUser> {
  const mode = getAuthMode();
  if (mode !== "production") {
    return {
      id: "user_owner",
      email: "owner@example.com",
      name: "Demo Owner",
      role: "owner",
      workspaceId: defaultWorkspaceId,
    };
  }

  const session = readSessionFromRequest(request);
  if (!session) {
    throw new AuthenticationError("Authentication required.", 401);
  }
  return resolveSessionPayload(session);
}

/**
 * 2026-09-28 (S3/S9) — the ONE check every signed-in request goes through,
 * whichever door it came in by (API gate, /auth/me, /auth/status):
 *
 *   1. the user still exists in the session's company;
 *   2. the session's version matches the credential's current version
 *      (password reset, sign-out, removal and role change all bump it);
 *   3. the person still has an ACTIVE membership in that company, and their
 *      role is read from the membership row — not from the user record or
 *      the cookie. A removed member is out on their very next request.
 *      Tour sessions have no membership: they are always a viewer, and are
 *      refused once the tour company holds anything real (S2);
 *   4. the company is not suspended.
 */
async function resolveSessionPayload(session: SessionPayload): Promise<RequestUser> {
  // Stage A.2 (2026-07-26) — go through the auth repository (JSON or Prisma).
  const user = await repositories.auth.findUserById(session.workspaceId, session.userId);
  if (!user) {
    throw new AuthenticationError("Session user not found.", 401);
  }
  // Stage 5 / WP1 sessionVersion enforcement. Every token issued since WP1
  // carries a version (createSessionToken defaults it to 1), and a token lives
  // 12 hours, so there are no unversioned tokens left to grandfather.
  const cred = await repositories.userCredential.findByUserId(user.id);
  const currentVersion = cred?.sessionVersion ?? 1;
  // A token with no version is refused too (fail-closed): every token since
  // WP1 carries one, and the HMAC stops anyone adding or removing it.
  if (session.sessionVersion !== currentVersion) {
    throw new AuthenticationError("Your session has ended. Please sign in again.", 401);
  }
  let role: WorkspaceRole;
  if (session.isTour === true) {
    const verdict = await tourWorkspaceVerdict(user.workspaceId, user.id);
    if (!verdict.safe) throw new AuthenticationError(verdict.reason, 401);
    role = "viewer";
  } else {
    const member = await repositories.workspaceMember.findForUser(user.workspaceId, user.id);
    if (!member || member.status !== "active") {
      throw new AuthenticationError("You no longer have access to this company. Ask its owner if you need access again.", 401);
    }
    role = member.role;
  }
  // 2026-08-02 audit P0-1 — WP2 kill-switch on the real request path.
  const { isWorkspaceLoginAllowed } = await import("@/services/PlatformAdminService");
  if (!(await isWorkspaceLoginAllowed(user.workspaceId))) {
    throw new AuthenticationError("This workspace is suspended. Contact the operator.", 401);
  }
  return { ...toRequestUser(user), role, isTour: session.isTour === true };
}

/**
 * Returns true when at least one credential exists (i.e. the owner has been
 * bootstrapped). Used by the login UI to decide whether to show "set up
 * owner" vs "sign in".
 */
export async function hasAnyCredentials(): Promise<boolean> {
  return repositories.auth.hasAnyCredentials();
}

/**
 * 2026-09-28 (S8) — how many password checks every sign-in performs, at
 * least. Sign-in used to check one password per company the email belonged to
 * (and run one lookup per company in the system), so the time it took told a
 * stranger how many companies an email was in. Now every attempt does at least
 * this many checks — the real ones, padded with checks against a throwaway
 * hash — so 0, 1, 2 or 3 companies all take the same time.
 */
export const LOGIN_PASSWORD_CHECKS = 3;
const DUMMY_HASH = "scrypt:32768:64:00000000000000000000000000000000:00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";

export type LoginChoice = { workspaceId: string; name: string };
export type LoginResult =
  | { ok: true; user: RequestUser; token: string }
  | { ok: false; reason: string; choices?: LoginChoice[] };

/**
 * Verify an email/password pair and issue a session token. Constant-time
 * password comparison happens inside verifyPassword. We deliberately do not
 * reveal whether the email or the password was wrong.
 *
 * `options.chosenWorkspaceId` is the company the person picked on the sign-in
 * page after being asked which one (see below); only that company is checked.
 */
export async function loginWithPassword(workspaceId: string, email: string, password: string, options: { chosenWorkspaceId?: string } = {}): Promise<LoginResult> {
  if (!email || !password) return { ok: false, reason: "Email and password are required." };
  void workspaceId;
  // 2026-09-26 (break test): the sign-in page sends only email + password, so
  // every company holding this email is checked; the password decides which.
  // 2026-09-27 (CEO): the same password in several companies is asked which
  // company. 2026-09-28 (S8): ONE indexed lookup for the email (not one per
  // company), and a fixed floor of password checks (LOGIN_PASSWORD_CHECKS).
  const all = await repositories.auth.findCredentialsByEmail(email);
  const candidates = options.chosenWorkspaceId
    ? all.filter((item) => item.user.workspaceId === options.chosenWorkspaceId)
    : all;
  const verified: Array<{ user: User; credential: UserCredential }> = [];
  for (const candidate of candidates) {
    if (await verifyPassword(password, candidate.credential.passwordHash)) verified.push(candidate);
  }
  for (let i = candidates.length; i < LOGIN_PASSWORD_CHECKS; i++) await verifyPassword(password, DUMMY_HASH);
  // 2026-09-28 (S3): a person taken off a company's team cannot sign in to it.
  // Checked only AFTER the password matched, so it reveals nothing to a guesser.
  const matches: Array<{ user: User; credential: UserCredential }> = [];
  let removedOnly = false;
  for (const candidate of verified) {
    const member = await repositories.workspaceMember.findForUser(candidate.user.workspaceId, candidate.user.id);
    if (member && member.status === "active") matches.push({ user: { ...candidate.user, role: member.role }, credential: candidate.credential });
    else removedOnly = true;
  }
  if (!matches.length && removedOnly) {
    return { ok: false, reason: "You no longer have access to this company. Ask its owner if you need access again." };
  }
  if (matches.length > 1) {
    const workspaces = await repositories.workspace.listAll(true);
    const nameOf = (id: string) => workspaces.find((ws) => ws.id === id)?.name || "Your company";
    return {
      ok: false,
      reason: "This email is used in more than one company. Choose which one to sign in to.",
      choices: matches.map((match) => ({ workspaceId: match.user.workspaceId, name: nameOf(match.user.workspaceId) })),
    };
  }
  const found = matches[0];
  const ok = Boolean(found);
  if (!found || !ok) return { ok: false, reason: "Incorrect email or password." };

  // Stage 5 re-audit fix (F-P0-3, 2026-07-28) — WP2 kill-switch wiring. After
  // credential verification, check the workspace is not suspended. The kill-
  // switch helper existed but was never wired here; pre-fix a suspended
  // tenant's users could keep logging in. Pinned by
  // golden:platform-kill-switch-login-block CASE A. We use a dynamic import
  // to avoid a circular dependency (PlatformAdminService imports from auth-
  // service transitively via the repository layer).
  const { isWorkspaceLoginAllowed } = await import("@/services/PlatformAdminService");
  if (!(await isWorkspaceLoginAllowed(found.user.workspaceId))) {
    return { ok: false, reason: "This workspace is suspended. Contact the operator." };
  }

  const user = found.user;
  // Stage 5 / WP1 (2026-07-28) — bind the credential's sessionVersion into
  // the token so a later bump (password reset) invalidates this session.
  const token = createSessionToken({
    userId: user.id,
    workspaceId: user.workspaceId,
    role: user.role,
    sessionVersion: found.credential.sessionVersion ?? 1,
  });
  return { ok: true, user: toRequestUser(user), token };
}

/**
 * 2026-09-28 (S2) — which company a newly set-up owner lands in. It used to be
 * the demo company, which is also where the public tour looks — so the first
 * real owner's customers were one click from any visitor. Now a new owner gets
 * their own new company unless one is named explicitly.
 */
export function workspaceForNewOwner(requested?: string): string {
  const named = requested?.trim();
  return named ? named : uid("workspace");
}

/**
 * Bootstrap the first owner account. Only succeeds when no credentials exist
 * yet. This is the "set up owner" flow the login page uses on first run.
 */
export async function bootstrapOwner(input: {
  workspaceId?: string;
  email: string;
  password: string;
  name?: string;
}): Promise<RequestUser> {
  if (await hasAnyCredentials()) {
    throw new AuthenticationError("An owner account already exists. Sign in instead.", 409);
  }
  const email = input.email.trim().toLowerCase();
  if (!email || !email.includes("@")) {
    throw new AuthenticationError("A valid owner email is required.");
  }
  const passwordHash = await hashPassword(input.password);
  const workspaceId = workspaceForNewOwner(input.workspaceId);
  const userId = uid("user");
  const now = timestamp();
  const user: User = {
    id: userId,
    workspaceId,
    name: input.name?.trim() || "Owner",
    email,
    role: "owner",
    createdAt: now,
    updatedAt: now,
  };
  const credential: UserCredential = {
    id: uid("cred"),
    userId,
    workspaceId,
    email,
    passwordHash,
    sessionVersion: 1,
    createdAt: now,
    updatedAt: now,
  };
  const member = {
    id: uid("member"),
    workspaceId,
    userId,
    email,
    name: user.name,
    role: "owner" as const,
    status: "active" as const,
    createdAt: now,
    updatedAt: now,
  };
  // Stage A.2 (2026-07-26) — atomic create via the auth repository. The JSON
  // impl uses mutateData (one file lock, all 3 rows land together); the
  // Prisma impl uses $transaction. Same atomicity guarantee either way.
  await repositories.auth.createOwnerWithCredential({ workspaceId, user, credential, member });
  return toRequestUser(user);
}

/**
 * Verify a session token (from any source, not just a request) and return the
 * resolved user, or null. Used by /api/auth/me and /api/auth/status.
 *
 * 2026-09-28 (S9): this used to check only the signature and that the user
 * existed — so a suspended company, a reset password or a removed member still
 * showed as "signed in" on those two endpoints. It now runs the same check as
 * every other request (resolveSessionPayload).
 */
export async function resolveUserFromSession(token: string | undefined | null): Promise<RequestUser | null> {
  const payload = verifySessionToken(token);
  if (!payload) return null;
  try {
    return await resolveSessionPayload(payload);
  } catch (error) {
    if (error instanceof AuthenticationError) return null;
    throw error;
  }
}

/**
 * Stage 5 / WP1 (2026-07-28) — Verify a session token AND enforce every
 * session rule, throwing AuthenticationError when any fails. Same check as
 * resolveCurrentUser, without a Request object (used by goldens).
 */
export async function resolveUserFromSessionWithVersionCheck(token: string | undefined | null): Promise<RequestUser> {
  const payload = verifySessionToken(token);
  if (!payload) {
    throw new AuthenticationError("Invalid or expired session.", 401);
  }
  return resolveSessionPayload(payload);
}

/** Decode a session payload without DB lookup (for cookie issuance). */
export function issueSessionForUser(user: RequestUser, sessionVersion?: number): string {
  return createSessionToken({
    userId: user.id,
    workspaceId: user.workspaceId,
    role: user.role as WorkspaceRole,
    sessionVersion,
  });
}

/**
 * CP-20 (2026-08-02) — The id of the seeded read-only tour viewer on
 * workspace_demo. Seeded by `npm run seed:demo`. A real user row must exist
 * with this id (resolveCurrentUser does a findUserById), so the seed creates
 * both the user and a credential (sessionVersion 1).
 */
export const TOUR_USER_ID = "user_tour";

export type TourStartResult =
  | { ok: true; user: RequestUser; token: string }
  | { ok: false; reason: string; statusCode: number };

/**
 * CP-20 (2026-08-02) — Start a public read-only tour session.
 *
 * Mints a `viewer`-role session on `workspace_demo`, flagged `isTour: true`
 * (HMAC-bound). The existing RBAC gate then blocks every mutation with 403
 * (defense-in-depth: the UI also disables mutating buttons). Gated by the
 * `public_tour_enabled` operator kill-switch.
 *
 * Production-auth only: in demo/local the RBAC gate is a no-op, so a tour
 * session would be meaningless (it wouldn't actually be read-only). Callers
 * should reject tour-start in non-production modes.
 */
export async function startTourSession(): Promise<TourStartResult> {
  // CP-20d — operator kill-switch. Default ON; the operator can flip it off
  // from /admin Kill-switches to disable the tour instantly.
  const { isFeatureEnabled } = await import("@/services/FeatureFlagService");
  if (!(await isFeatureEnabled("public_tour_enabled"))) {
    return { ok: false, reason: "The public demo tour is currently disabled.", statusCode: 403 };
  }
  // CP-20a — load the seeded tour viewer. Must exist (seed:demo creates it).
  const user = await repositories.auth.findUserById(defaultWorkspaceId, TOUR_USER_ID);
  if (!user) {
    // The tour user hasn't been seeded. This is a deployment/seed defect, not
    // a user error — return a clear 503 so the operator notices.
    return { ok: false, reason: "Tour user is not configured. Run npm run seed:demo.", statusCode: 503 };
  }
  // CP-20a — viewer role, enforced at the backend by rbac-map/enforceAuthGate.
  if (user.role !== "viewer") {
    return { ok: false, reason: "Tour user is misconfigured (expected viewer role).", statusCode: 503 };
  }
  // 2026-09-28 (S2) — never show a visitor a company that is really in use.
  const verdict = await tourWorkspaceVerdict(user.workspaceId, user.id);
  if (!verdict.safe) return { ok: false, reason: verdict.reason, statusCode: 409 };
  // sessionVersion must match the credential's current version (the seed sets 1).
  const cred = await repositories.userCredential.findByUserId(user.id);
  const sessionVersion = cred?.sessionVersion ?? 1;
  const token = createSessionToken({
    userId: user.id,
    workspaceId: user.workspaceId,
    role: user.role,
    sessionVersion,
    isTour: true,
  });
  return { ok: true, user: { ...toRequestUser(user), isTour: true }, token };
}

/**
 * 2026-09-28 (S2) — may the public tour show this company? Only while it holds
 * nothing real. The tour is refused (and an open tour session ends) as soon as
 * the company has:
 *   - anyone other than the tour viewer who can sign in (a saved password), or
 *   - a pending invite (a real person about to join), or
 *   - a saved key or token (AI provider, WhatsApp, search, email).
 * The demo company's built-in sample owner has no password, so a freshly
 * seeded demo still tours.
 */
export const TOUR_REFUSED_MESSAGE = "The demo tour is closed because the demo company is being used by a real business. Nothing of theirs was shown. Please try again later or sign up for your own company.";

export async function tourWorkspaceVerdict(workspaceId: string, tourUserId: string): Promise<{ safe: true } | { safe: false; reason: string }> {
  const users = await repositories.user.listForWorkspace(workspaceId);
  for (const other of users) {
    if (other.id === tourUserId) continue;
    if (await repositories.userCredential.findByUserId(other.id)) return { safe: false, reason: TOUR_REFUSED_MESSAGE };
  }
  const members = await repositories.workspaceMember.listByWorkspace(workspaceId);
  // A pending invite means a real person is about to join. (Active rows are
  // covered by the password check above: the built-in sample owner has a
  // membership but no password, and must not close a fresh demo.)
  if (members.some((m) => m.userId !== tourUserId && m.status === "invited")) {
    return { safe: false, reason: TOUR_REFUSED_MESSAGE };
  }
  const saved = await repositories.llmProviderCredential.listByWorkspace(workspaceId);
  if (saved.some((c) => Boolean(c.encryptedApiKey))) return { safe: false, reason: TOUR_REFUSED_MESSAGE };
  return { safe: true };
}

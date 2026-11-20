/**
 * account-summary.ts — what the Settings screen says about this workspace.
 *
 * ── THE DEFECT THIS EXISTS FOR (2026-09-08) ─────────────────────────────────
 * Every row of the Settings → "Who you are and how this workspace is set up"
 * panel was a hardcoded string:
 *
 *   Current user          Demo Owner
 *   Sign-in               Demo mode — no password needed
 *   Production login      Not switched on yet
 *   Where data is stored  A file on this machine
 *
 * On the live deployment four of the five were false. The owner had signed in
 * with a real password, as themselves, on a workspace whose data is in Neon
 * Postgres. This is the one screen whose entire job is telling an owner how
 * their workspace is set up, and it was describing a different one — the
 * developer's laptop, months earlier.
 *
 * The facts were one fetch away the whole time: /api/auth/status carries the
 * signed-in user and the auth mode, /api/health carries the persistence
 * provider. So the panel asks, and when it cannot get an answer it says
 * "Checking…" rather than making one up. Confident wrongness is the bug; an
 * honest gap is not.
 *
 * Same family as the AI chip reading "AI running" beside a dead key, the lead
 * badge reading "Contact missing" beside a phone number, and the Dashboard
 * calling a draft campaign active: a screen asserting a state nobody checked.
 */

export type AccountSummaryInput = {
  /** From /api/auth/status. `undefined` means the call has not answered yet. */
  authMode?: string;
  user?: { name?: string; email?: string; role?: string };
  /** True once /api/auth/status has answered at all, however it answered. */
  loaded: boolean;
  /** From /api/health — "prisma" | "json" | "" while unknown. */
  persistenceProvider?: string;
  /** Workspace display name, already resolved by the caller. */
  workspaceName?: string;
  /** How the app spells a role for a person. */
  formatRole?: (role: string) => string;
};

/** Shown instead of a guess while an answer is still in flight or missing. */
export const UNKNOWN = "Checking…";

export function accountSummaryRows(input: AccountSummaryInput): Record<string, string> {
  const { authMode, user, loaded, persistenceProvider, workspaceName, formatRole } = input;
  const production = authMode === "production";

  const storage = persistenceProvider === "prisma"
    ? "A PostgreSQL database"
    : persistenceProvider === "json"
      ? "A file on the server"
      : UNKNOWN;

  return {
    "Current user": user?.name || user?.email || (loaded ? "Not signed in" : UNKNOWN),
    Workspace: workspaceName || "Demo workspace",
    Role: user?.role ? (formatRole ? formatRole(user.role) : user.role) : (loaded ? "Unknown" : UNKNOWN),
    "Sign-in": !loaded ? UNKNOWN : production ? "Email and password" : "Demo mode — no password needed",
    "Production login": !loaded ? UNKNOWN : production ? "On" : "Not switched on yet",
    "Where data is stored": storage,
  };
}

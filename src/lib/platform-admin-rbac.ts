/**
 * platform-admin-rbac.ts — the SINGLE chokepoint for /admin/* GET-route RBAC.
 *
 * WHY THIS EXISTS (Stage 5 re-audit, F-P1-5):
 *   Before this file, the GET-side gate in the catch-all route was a single
 *   `requirePlatformAdmin(request, "support_agent")` line at the top of
 *   `handlePlatformAdminGet`. That admitted a `support_agent` to EVERY /admin/*
 *   GET endpoint — including /admin/workspaces (every tenant's users),
 *   /admin/audit-logs (every platform action), /admin/feature-flags, and
 *   /admin/health. The UI hid the buttons, but the API was the law. This is a
 *   privilege-escalation backdoor: build-right Angle Bank A1 ("Backdoor
 *   Check").
 *
 *   The fix: per docs/LOGIC.md (2026-07-28 "PlatformAdmin roles"), a
 *   support_agent can ONLY see + reply to platform tickets. Everything else
 *   is operator-only. This function is the ONE place that rule lives, so a
 *   future agent can't silently widen it without also changing this file
 *   (which is pinned by golden:platform-admin-get-rbac).
 *
 * CONTRACT:
 *   - Returns `"support_agent"` for paths a support_agent may read (ticket
 *     inbox + self). The flat ladder means operator satisfies this too.
 *   - Returns `"operator"` for operator-only paths AND for any unmapped path
 *     (fail-closed — never open by accident).
 *   - Returns `null` for paths that are PUBLIC (no admin session required).
 *
 * NOTE: This is READ-only RBAC. The WRITE-side gates (POST/PUT/DELETE) live
 * inline in `handlePlatformAdminPost` and already enforce operator per route.
 * The PlatformAdminService methods (suspendWorkspace, setFeatureFlag,
 * startImpersonation, etc.) ALSO re-assert the role at the service layer
 * (defense-in-depth — pinned by golden:platform-admin-ops).
 */
import type { PlatformAdminRole } from "@/lib/types";

export type { PlatformAdminRole };

/** Match a path array against a route pattern with `:param` wildcards. */
function matchPath(path: string[], pattern: string[]): boolean {
  if (path.length !== pattern.length) return false;
  return pattern.every((seg, i) => seg.startsWith(":") || seg === path[i]);
}

/**
 * Returns the minimum PlatformAdminRole required to READ the given /admin/*
 * GET path, or `null` if the path is public (no admin session needed).
 *
 * The caller passes the result to `requirePlatformAdmin(request, role)` — or
 * skips the gate entirely when this returns `null`.
 */
export function requiredAdminRoleForGetPath(path: string[]): PlatformAdminRole | null {
  // PUBLIC — no admin session required (the login page reads this before auth).
  if (matchPath(path, ["admin", "auth", "status"])) return null;

  // support_agent-allowed (the support scope: ticket inbox + self).
  const supportScopes: string[][] = [
    ["admin", "platform-tickets"],
    ["admin", "platform-tickets", "list"],
    ["admin", "platform-tickets", ":id"],
    ["admin", "platform-tickets", ":id", "events"],
    ["admin", "platform-tickets", "sla-settings"],
    ["admin", "platform-tickets", "support-hours"],
    ["admin", "me"],
  ];
  if (supportScopes.some((p) => matchPath(path, p))) return "support_agent";

  // Everything else under /admin/* is operator-only (fail-closed for any
  // unmapped route). The operator-only list is intentionally NOT enumerated
  // here — the rule is "default to operator unless explicitly support-scoped",
  // which is the safer direction.
  return "operator";
}

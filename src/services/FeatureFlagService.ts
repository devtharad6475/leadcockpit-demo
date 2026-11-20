/**
 * Stage 5 / WP2 (2026-07-28) — Global feature-flag kill-switches.
 *
 * Per docs/LOGIC.md 2026-07-28: a SMALL FIXED set of GLOBAL on/off switches
 * the operator sets. NOT a generic toggle grid. The fixed keys are the only
 * accepted values (validated on write). Default for an unset flag is TRUE
 * (the system is "on"; the operator flips to false to kill a capability
 * platform-wide). Every toggle is audit-logged (config_changed).
 *
 * Rules enforced here (the chokepoint — no second copy):
 *   1. Only FIXED_FLAG_KEYS are accepted. Unknown key → throws.
 *   2. Only the operator role may toggle (RBAC checked by the caller via
 *      requirePlatformAdmin(request, "operator"); this service asserts the
 *      admin is an operator if an admin record is passed).
 *   3. Default = enabled (kill-switches start ON).
 *   4. Every toggle writes a config_changed audit row (before/after).
 *
 * Pinned by golden:platform-admin-ops CASE L + CASE M.
 */
import { NeedsActionError } from "@/lib/user-errors";
import { repositories } from "@/repositories";

/**
 * The fixed WP2 flag set. NO arbitrary keys. Adding a flag is a deliberate
 * decision (extend this set + add a LOGIC.md entry).
 *
 *   - new_signup_enabled   — gates the public signup page (WP1).
 *   - billing_enabled      — gates the billing UI (WP4).
 *   - whatsapp_send_enabled — gates live WhatsApp send (defensive; the
 *                             autonomyKillSwitch + owner approval still apply).
 *   - ai_usage_enabled     — gates new AI calls (emergency cost cap).
 *   - public_tour_enabled  — gates the public read-only "Explore the demo"
 *                            tour entry (CP-20, D-2026-08-02-l). The tour is
 *                            read-only (RBAC-enforced); this is the on/off
 *                            switch the operator can flip to disable it.
 */
export const FIXED_FLAG_KEYS = [
  "new_signup_enabled",
  "billing_enabled",
  "whatsapp_send_enabled",
  "ai_usage_enabled",
  "public_tour_enabled",
] as const;

export type FixedFlagKey = (typeof FIXED_FLAG_KEYS)[number];

const FIXED_KEY_SET: ReadonlySet<string> = new Set(FIXED_FLAG_KEYS);

/**
 * Read a flag. Returns true if the flag is unset (default = ON) or set to
 * true; returns false only when explicitly toggled off by an operator.
 *
 * This is the READ chokepoint: every "is X enabled?" question in the app
 * routes through here. No second copy of the default-true rule.
 */
export async function isFeatureEnabled(key: string): Promise<boolean> {
  const flag = await repositories.featureFlag.getByKey(key);
  // Unset flag → default true (system is "on"). Explicit false → false.
  return flag ? flag.enabled : true;
}

/**
 * Toggle a flag. Operator-only (the route enforces requirePlatformAdmin
 * "operator"; this service double-checks the role as defense-in-depth).
 * Writes a config_changed audit row with before/after. Throws on unknown
 * key or non-operator admin.
 */
export async function setFeatureFlag(input: {
  adminId: string;
  key: string;
  enabled: boolean;
}): Promise<{ key: string; before: boolean; after: boolean }> {
  if (!FIXED_KEY_SET.has(input.key)) {
    throw new NeedsActionError(
      `Unknown feature flag key "${input.key}". Accepted keys: ${FIXED_FLAG_KEYS.join(", ")}.`,
    );
  }
  // Defense-in-depth RBAC: the route already gates via
  // requirePlatformAdmin(request, "operator"); this service re-asserts it by
  // loading the admin + checking the role, so a caller that forgets the route
  // gate still can't toggle.
  const admin = await repositories.platformAdmin.findById(input.adminId);
  if (!admin) {
    const { AuthorizationError } = await import("@/lib/auth-service");
    throw new AuthorizationError("Admin not found.");
  }
  if (admin.status === "suspended") {
    const { AuthorizationError } = await import("@/lib/auth-service");
    throw new AuthorizationError("This admin account is suspended.");
  }
  if (admin.role !== "operator") {
    const { AuthorizationError } = await import("@/lib/auth-service");
    throw new AuthorizationError("Only the operator role may toggle feature flags.");
  }

  const before = await isFeatureEnabled(input.key);

  await repositories.featureFlag.upsert({
    key: input.key,
    enabled: input.enabled,
    lastToggledByAdminId: input.adminId,
  });

  await repositories.platformAuditLog.create({
    adminId: input.adminId,
    action: "config_changed",
    metadata: {
      kind: "feature_flag",
      key: input.key,
      before,
      after: input.enabled,
    },
  });

  return { key: input.key, before, after: input.enabled };
}

/** List all flags with their current state (operator flags screen). Unset
 *  flags are surfaced with their default (true) value so the operator sees
 *  the effective state of every kill-switch. */
export async function listAllFlags(): Promise<Array<{ key: string; enabled: boolean; lastToggledByAdminId?: string }>> {
  const set = await repositories.featureFlag.listAll();
  const setByKey = new Map(set.map((f) => [f.key, f]));
  return FIXED_FLAG_KEYS.map((key) => {
    const f = setByKey.get(key);
    return {
      key,
      // Unset → default true.
      enabled: f ? f.enabled : true,
      lastToggledByAdminId: f?.lastToggledByAdminId,
    };
  });
}

/**
 * Memory rate-limit backend (Stage C.1).
 *
 * This is the ORIGINAL in-process implementation, extracted verbatim from
 * src/services/RateLimitService.ts so the dispatcher can swap it for the
 * Redis backend without touching the math. The 17-preset defaults map lives
 * HERE as the single source of truth (the Redis backend imports it).
 *
 * Semantics: fixed-window counter, keyed `${workspaceId}:${userId|"workspace"}:${action}`.
 * When the current count >= limit, the request is denied with a `reason`.
 * When the window expires (resetAt <= now), the counter resets to 0.
 *
 * Known limitation (preserved, not silently "fixed"): the read-modify-write
 * (get → check → set) is NOT atomic under true concurrency in Node — two
 * requests that both pass the `>= limit` check before either increments can
 * both succeed. The Redis backend (RedisRateLimitBackend.ts) closes this with
 * server-side INCR. We keep the in-memory quirk here because changing it
 * would change the demo-mode behavior the 37 golden tests pin.
 *
 * 2026-07-27 Stage C.1.
 */
import { timestamp } from "@/lib/db";

type RateKey = string;
type RateRecord = { count: number; resetAt: number; updatedAt: string };

const memoryLimits = new Map<RateKey, RateRecord>();

/**
 * The 17-preset defaults map. Single source of truth — both backends import
 * this so the limit/window numbers cannot drift between them.
 */
export const defaults: Record<string, { limit: number; windowMs: number }> = {
  login: { limit: 5, windowMs: 10 * 60 * 1000 },
  document_extraction: { limit: 100, windowMs: 24 * 60 * 60 * 1000 },
  website_scan: { limit: 30, windowMs: 24 * 60 * 60 * 1000 },
  whatsapp_dry_run: { limit: 500, windowMs: 24 * 60 * 60 * 1000 },
  llm_test: { limit: 300, windowMs: 24 * 60 * 60 * 1000 },
  real_llm: { limit: 1000, windowMs: 24 * 60 * 60 * 1000 },
  inbound_webhook: { limit: 120, windowMs: 60 * 1000 },
  export: { limit: 50, windowMs: 24 * 60 * 60 * 1000 },
  lead_auto_approval: { limit: 100, windowMs: 24 * 60 * 60 * 1000 },
  message_generation: { limit: 500, windowMs: 24 * 60 * 60 * 1000 },
  // Session 4 audit: protect expensive/abuse-prone endpoints that were
  // previously unwired. Limits are generous for normal use but stop abuse.
  csv_upload: { limit: 30, windowMs: 60 * 60 * 1000 },        // 30 CSV imports/hour
  document_process: { limit: 60, windowMs: 60 * 60 * 1000 },   // 60 doc processes/hour
  crawl_start: { limit: 20, windowMs: 60 * 60 * 1000 },        // 20 crawls/hour
  whatsapp_webhook: { limit: 200, windowMs: 60 * 1000 },       // 200 webhooks/min
  // Phase 5.7: wire previously-dead presets and add limits for agent-backed
  // generation routes so a single workspace cannot exhaust LLM/crawl budget.
  icp_generate: { limit: 100, windowMs: 24 * 60 * 60 * 1000 },  // 100 ICP generations/day
  // N-FEAT-1 (2026-09-05) — product application research runs one model call
  // and writes five collections, so it gets the same shape of cap as ICP
  // generation. It is a setup action, not a per-lead one: 50/day is far more
  // than a real workspace needs and still stops a loop burning the budget.
  product_research: { limit: 50, windowMs: 24 * 60 * 60 * 1000 }, // 50 product-research runs/day
  reply_classify: { limit: 1000, windowMs: 24 * 60 * 60 * 1000 }, // 1000 reply classifications/day
  lead_scoring: { limit: 1000, windowMs: 24 * 60 * 60 * 1000 },   // 1000 lead scores/day
  // Audit 2026-07-27 S6 S-3: wire caps on the previously-uncapped expensive
  // routes so a rogue/compromised account cannot burn the LLM/crawl budget.
  knowledge_sync: { limit: 50, windowMs: 60 * 60 * 1000 },        // 50 KB syncs/hour
  lead_enrichment: { limit: 200, windowMs: 24 * 60 * 60 * 1000 }, // 200 enrichments/day
  campaign_learning: { limit: 100, windowMs: 24 * 60 * 60 * 1000 }, // 100 learning runs/day
  policy_pdf: { limit: 50, windowMs: 60 * 60 * 1000 },            // 50 PDF generations/hour
  // Stage 5 / WP3 (2026-07-28) — platform tickets + admin auth.
  platform_ticket_create: { limit: 20, windowMs: 60 * 60 * 1000 }, // 20 tickets/user/hour (flood guard)
  platform_admin_login: { limit: 10, windowMs: 10 * 60 * 1000 },   // 10 admin logins/10min (brute-force guard)
  // Stage 5 / WP2 (2026-07-28) — operator-issued password reset email.
  // Small cap (≤10/hour) so a bug or a compromised admin can't spam a user's
  // inbox. Pinned by golden:email-send CASE F.
  password_reset_email: { limit: 5, windowMs: 60 * 60 * 1000 },    // 5 reset emails/user/hour
  // Stage 5 re-audit F-P1-1 (2026-07-28) — public auth routes were UNCAPPED.
  // Each signup burns ~150ms CPU (scrypt N=2^15) + 4 DB writes + an outbound
  // email; an attacker could flood /auth/signup to burn the Resend quota +
  // amplify CPU. Pinned by golden:stage5-batch4-chokepoints CASE 1.
  signup: { limit: 5, windowMs: 60 * 60 * 1000 },                   // 5 signups/hour (per IP+email)
  invite_accept: { limit: 20, windowMs: 60 * 60 * 1000 },           // 20 invite-accepts/hour (per IP)
  resend_verification: { limit: 5, windowMs: 60 * 60 * 1000 },      // 5 resend-verification/hour (per user)
  // 2026-09-28: self-service "Forgot password?" (per IP+email, and per IP) and
  // "Change password" (per user — each try is a password check).
  forgot_password: { limit: 5, windowMs: 60 * 60 * 1000 },          // 5 reset requests/hour
  change_password: { limit: 5, windowMs: 10 * 60 * 1000 },          // 5 change attempts/10min
  // CP-20e (2026-08-02) — public tour session issuance. Each call mints a
  // signed cookie (cheap) but it's a fully-public unauthenticated endpoint,
  // so cap per IP to prevent a bot farm from minting unbounded sessions.
  // Pinned by golden:tour-session CASE T11.
  "tour-start": { limit: 10, windowMs: 60 * 60 * 1000 },            // 10 tour-starts/hour (per IP)
  // Stage 5 re-audit F-P3-3 (2026-07-28) — user-side ticket comment/status
  // routes were uncapped (asymmetry vs the capped create route). A stolen
  // cookie could append unlimited comments + ping the operator inbox.
  platform_ticket_comment: { limit: 30, windowMs: 60 * 60 * 1000 }, // 30 comments/user/hour
  platform_ticket_status: { limit: 30, windowMs: 60 * 60 * 1000 },  // 30 status moves/user/hour
};

export type RateLimitInput = {
  workspaceId: string;
  userId?: string;
  action: keyof typeof defaults | string;
  limit?: number;
  windowMs?: number;
};

export type RateLimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: string;
  reason?: string;
};

/**
 * Presets that stay at their normal values even in single-operator mode.
 *
 * These are not throughput caps — they are brute-force guards. `login` at
 * 5-per-10-minutes is what stops someone grinding passwords against the
 * deployment; raising it to 10,000/minute would hand an attacker roughly two
 * million attempts an hour. None of them can interrupt an operator's own work,
 * because nobody signs in ten thousand times a day, so exempting them costs
 * the single user nothing and keeps the guard real.
 */
const BRUTE_FORCE_GUARDS = new Set([
  "login",
  "signup",
  "platform_admin_login",
  "password_reset_email",
  "resend_verification",
  "forgot_password",
  "change_password",
]);

/**
 * Single-operator override (2026-09-07).
 *
 * The preset table is sized for a shared, multi-tenant deployment: caps like
 * `product_research` at 50/day or `crawl_start` at 20/hour exist so one
 * workspace cannot burn the whole LLM budget. On an instance with exactly one
 * human on it those are not a safety net, they are an interruption — and worse,
 * a 24-hour window means tripping one at 10am locks that feature until the next
 * morning.
 *
 * `RATE_LIMIT_SINGLE_USER=1` replaces every non-auth preset with a flat
 * N-per-minute allowance (default 10,000). Two deliberate parts:
 *
 *   - the LIMIT goes up, so normal work never trips it;
 *   - the WINDOW drops to 60s, so if something buggy ever does trip it, the
 *     lockout lasts a minute instead of a day.
 *
 * The rate limiter itself stays wired. This is a dial, not a bypass — the
 * counters still run, the admin snapshot still reports them, and flipping the
 * variable off restores the shared-deployment numbers with no code change.
 * Off by default, so the golden tests keep pinning the real preset table.
 */
function singleUserOverride(): { limit: number; windowMs: number } | null {
  if (process.env.RATE_LIMIT_SINGLE_USER !== "1") return null;
  const limit = Number(process.env.RATE_LIMIT_SINGLE_USER_PER_MINUTE) || 10_000;
  return { limit, windowMs: 60 * 1000 };
}

/** Resolve the effective limit + window for an action (preset or ad-hoc). */
export function resolvePreset(input: RateLimitInput): { limit: number; windowMs: number } {
  const preset = defaults[input.action] || { limit: input.limit || 1000, windowMs: input.windowMs || 24 * 60 * 60 * 1000 };
  // An explicit per-call limit/window still wins — a caller that asked for a
  // specific cap meant it, and the override is about the preset TABLE.
  const override = BRUTE_FORCE_GUARDS.has(String(input.action)) ? null : singleUserOverride();
  if (override) {
    return {
      limit: input.limit || override.limit,
      windowMs: input.windowMs || override.windowMs,
    };
  }
  return {
    limit: input.limit || preset.limit,
    windowMs: input.windowMs || preset.windowMs,
  };
}

/**
 * The words shown when a limit is hit.
 *
 * 2026-09-26 (break test): a person who typed a wrong password five times was
 * told "Daily limit reached. Try again later or increase your limit." — the
 * wait is minutes, not a day, and nobody can raise their own sign-in limit.
 * The sign-in / sign-up guards now say how long to wait. Other actions keep
 * their existing wording (AI usage limits are deferred).
 */
export function limitReachedReason(action: string, resetAtMs: number): string {
  if (!BRUTE_FORCE_GUARDS.has(action) && action !== "invite_accept") {
    return "Daily limit reached. Try again later or increase your limit.";
  }
  const minutes = Math.max(1, Math.ceil((resetAtMs - Date.now()) / 60000));
  const wait = minutes >= 60 ? `${Math.ceil(minutes / 60)} hour${Math.ceil(minutes / 60) === 1 ? "" : "s"}` : `${minutes} minute${minutes === 1 ? "" : "s"}`;
  return `Too many attempts. For your security, please wait ${wait} and try again.`;
}

/**
 * Check the rate limit against the in-memory map. Returns the SAME shape as
 * the Redis backend so the dispatcher's callers don't care which is active.
 */
export function checkRateLimitMemory(input: RateLimitInput): RateLimitResult {
  const { limit, windowMs } = resolvePreset(input);
  const key = `${input.workspaceId}:${input.userId || "workspace"}:${input.action}`;
  const now = Date.now();
  const existing = memoryLimits.get(key);
  const record = !existing || existing.resetAt <= now ? { count: 0, resetAt: now + windowMs, updatedAt: timestamp() } : existing;
  if (record.count >= limit) {
    return { allowed: false, limit, remaining: 0, resetAt: new Date(record.resetAt).toISOString(), reason: limitReachedReason(String(input.action), record.resetAt) };
  }
  record.count += 1;
  record.updatedAt = timestamp();
  memoryLimits.set(key, record);
  return { allowed: true, limit, remaining: Math.max(0, limit - record.count), resetAt: new Date(record.resetAt).toISOString() };
}

/** Snapshot of the in-memory limits (admin view; Redis backend has no equivalent). */
export function listRateLimitSnapshotMemory() {
  return Array.from(memoryLimits.entries()).map(([key, value]) => ({ key, ...value, resetAt: new Date(value.resetAt).toISOString() }));
}

/** Test seam: clear the in-memory map between golden-test cases. */
export function resetMemoryBackend() {
  memoryLimits.clear();
}

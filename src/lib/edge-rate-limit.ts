/**
 * Stage 5 / WP5 (2026-07-29) — Front-door (edge) rate limit.
 *
 * Per docs/LOGIC.md §WP5.4 + docs/DECISIONS.md D-2026-07-29-h:
 *   - Per IP:          300 requests/minute across ALL endpoints.
 *   - Per workspace:   600 requests/minute across all that workspace's users.
 *   - Block duration:  until the counting minute rolls over (N-SEC-1 amends
 *                      the original "5 minutes"; see EDGE_BLOCK_MS below).
 *   - Exempt paths:    /api/health, /api/health/deep,
 *                      /api/inbound/whatsapp-webhook, /api/admin/auth/status,
 *                      /api/auth/status (N-SEC-1).
 *   - IP extraction:   x-forwarded-for → x-real-ip → "unknown". Never throws.
 *
 * This is a SECOND layer on top of the 27 existing per-endpoint presets
 * (src/services/rate-limit/memoryBackend.ts `defaults`). The presets stop
 * per-action abuse (login brute-force, LLM budget burn); this guard stops
 * TOTAL-volume floods (DDoS, scripted scraping across endpoints).
 *
 * REUSES the existing rate-limit storage chokepoint (memory in demo, Redis
 * in prod) via the `action` field. The action keys are namespaced
 * (`__edge_ip:` / `__edge_ws:`) so they cannot collide with the 27 presets
 * and so the existing `listRateLimitSnapshot` admin view shows them
 * distinctly. Pinned by golden:wp5-edge-rate-limit.
 *
 * 2026-07-29 Stage 5 WP5.
 */

import { checkRateLimit, listRateLimitSnapshot } from "@/services/RateLimitService";
import { resetMemoryBackend } from "@/services/rate-limit/memoryBackend";

/**
 * The locked numbers from D-2026-07-29-h. Exported so the golden test can
 * pin the literal values (Golden Thread: golden ↔ LOGIC ↔ UI).
 *
 * Env overrides exist for production tuning WITHOUT changing the default
 * (operator can raise if a real customer legitimately exceeds the cap).
 */
export const EDGE_PER_IP_LIMIT: number =
  Number(process.env.EDGE_RATE_LIMIT_PER_IP) || 300;
export const EDGE_PER_WORKSPACE_LIMIT: number =
  Number(process.env.EDGE_RATE_LIMIT_PER_WORKSPACE) || 600;

/**
 * The COUNTING window: how long a request stays on the tally. 300 per MINUTE
 * per the decision.
 *
 * N-SEC-1 (2026-09-03) — THIS CONSTANT DID NOT EXIST, AND THAT WAS THE BUG.
 * `checkEdgeRateLimit` passed EDGE_BLOCK_MS (5 minutes) as the counting window,
 * so the guard enforced 300 per FIVE minutes — five times stricter than the
 * decision, this file's own header, the route's header and the golden all say.
 * Measured on the dev server before the fix: blocked at request 301 with
 * `retry-after: 290`, not ~50.
 *
 * The operator felt it as: ordinary clicking (one page load costs 16 requests,
 * opening Questions from AI costs 16 more) hit the ceiling inside a minute, and
 * the app then signed them out on every refresh.
 *
 * Why the golden did not catch it: CASE 6 pinned EDGE_BLOCK_MS and CASE 1
 * pinned the count of 300, but NOTHING pinned the period those 300 are counted
 * over. The golden was green and the product was wrong, because the golden
 * never asserted the thing that broke. CASE 7 now pins it.
 */
export const EDGE_WINDOW_MS: number = 60 * 1000; // 1 minute.

/**
 * How long a blocked caller stays blocked: until the counting window they
 * overflowed rolls over. Same value as EDGE_WINDOW_MS, and deliberately so.
 *
 * N-SEC-1 supersedes the "5 minute block" half of D-2026-07-29-h. The original
 * decision wanted 300/minute counted, with a 5-minute penalty on top. The code
 * never had a penalty mechanism — it only ever had one fixed-window counter,
 * and the 5 minutes got used as the counting window instead, which is how the
 * bug happened.
 *
 * Building a real penalty box would need a peek operation the storage
 * chokepoint does not have (reading a counter must not increment it), across
 * both the memory and Redis backends. That is new machinery in a security path,
 * and it buys less than it looks: the per-minute cap alone already stops a
 * flood dead (a real flood is millions per minute, not 301), the 27
 * per-endpoint presets still cap every expensive action individually, and the
 * penalty's only real effect is on the sustained rate a determined attacker
 * gets — 300/min instead of ~50/min. Set against that, a 5-minute penalty is
 * exactly what locked the operator out of their own product for five minutes at
 * a time. Simplicity in the chokepoint wins.
 */
export const EDGE_BLOCK_MS: number = EDGE_WINDOW_MS;

// Action keys are namespaced so they don't collide with the 27 presets and
// are visibly distinct in the admin snapshot.
const ACTION_IP = "__edge_ip";
const ACTION_WORKSPACE = "__edge_ws";

// The workspaceId field is REQUIRED by RateLimitInput even for the IP
// counter (which is global). Use a sentinel that can never be a real
// workspace id (real ones are cuid/uuid).
const GLOBAL_SCOPE = "__global";

export type EdgeRateLimitInput = {
  /** The client IP (from getClientIp). */
  ip: string;
  /** The workspace id if the request is authenticated to one (omitted for unauth routes). */
  workspaceId?: string;
};

/**
 * Test-only override. Production callers NEVER pass this — the wrapper uses
 * the locked EDGE_WINDOW_MS. Golden CASE 3 passes a short windowMs (50ms) so
 * it can sleep through the block honestly without faking the clock
 * (build-right Test-Honesty: real wall-clock > fake clock for behavior the
 * real clock already exercises).
 */
export type EdgeRateLimitOptions = {
  windowMs?: number;
};

export type EdgeRateLimitResult = {
  allowed: boolean;
  /** Which counter denied the request ("ip" | "workspace" | null). */
  blockedBy: "ip" | "workspace" | null;
  /** ISO timestamp when the block lifts (for Retry-After / UI). */
  resetAt: string;
  /** Human-readable reason mirrored from the underlying backend. */
  reason?: string;
};

/**
 * Check the front-door guard. Returns whether the request is allowed, and
 * if not, which counter denied it. The IP counter is ALWAYS checked (every
 * request has an IP, even "unknown"). The workspace counter is checked
 * only when a workspaceId is supplied (authenticated requests).
 *
 * Order: IP first (cheaper, broader), then workspace. Either denying is
 * enough to block.
 *
 * ASYNC because the underlying checkRateLimit dispatcher is async (the
 * Redis backend awaits INCR/EXPIRE; the memory backend is sync but wrapped
 * in Promise.resolve for a uniform return type). All callers MUST await —
 * TypeScript enforces this via the return type (same guard the dispatcher
 * uses). Pinned by golden:wp5-edge-rate-limit.
 *
 * @param options.windowMs — TEST ONLY. Production uses EDGE_WINDOW_MS. The
 *   golden passes a short window so it can sleep through the block honestly.
 */
export async function checkEdgeRateLimit(
  input: EdgeRateLimitInput,
  options: EdgeRateLimitOptions = {},
): Promise<EdgeRateLimitResult> {
  const windowMs = options.windowMs ?? EDGE_WINDOW_MS;
  const ip = input.ip || "unknown";

  // IP counter — global scope (one bucket per IP across all tenants).
  const ipResult = await checkRateLimit({
    workspaceId: GLOBAL_SCOPE,
    action: ACTION_IP,
    // Per-IP key: include the IP itself via the userId slot so each IP gets
    // its own bucket. The rate-limit key is `${workspaceId}:${userId}:${action}`
    // → `__global:<ip>:__edge_ip` — one counter per IP.
    userId: ip,
    limit: EDGE_PER_IP_LIMIT,
    windowMs,
  });
  if (!ipResult.allowed) {
    return {
      allowed: false,
      blockedBy: "ip",
      resetAt: ipResult.resetAt,
      reason: ipResult.reason || "IP rate limit exceeded.",
    };
  }

  // Workspace counter — only when the request is authenticated.
  if (input.workspaceId) {
    const wsResult = await checkRateLimit({
      workspaceId: input.workspaceId,
      action: ACTION_WORKSPACE,
      // Per-workspace key: omit userId so all of a workspace's users share
      // ONE bucket. The key is `<workspaceId>:workspace:__edge_ws`.
      limit: EDGE_PER_WORKSPACE_LIMIT,
      windowMs,
    });
    if (!wsResult.allowed) {
      return {
        allowed: false,
        blockedBy: "workspace",
        resetAt: wsResult.resetAt,
        reason: wsResult.reason || "Workspace rate limit exceeded.",
      };
    }
  }

  return { allowed: true, blockedBy: null, resetAt: new Date(Date.now() + windowMs).toISOString() };
}

/**
 * The exempt-path whitelist. These routes MUST bypass the front-door guard
 * because they are infrastructure (liveness probes) or have their own
 * rate-limit + signature verification (webhooks), or are the login probe
 * itself (must answer so the operator can log in to investigate a block).
 *
 * The path is the API path AFTER the /api prefix is stripped (so ["health"]
 * means /api/health). Match the catch-all route's `path` argument.
 */
const EXEMPT_PATHS: ReadonlyArray<readonly string[]> = [
  ["health"],                       // /api/health (liveness probe)
  ["health", "deep"],               // /api/health/deep (already owner-gated)
  ["inbound", "whatsapp-webhook"],  // webhook ingest (own RL + signature)
  ["admin", "auth", "status"],      // admin login probe (must answer)
  // N-SEC-1 (2026-09-03). The operator's own identity check. It was missing,
  // and its absence is what turned "the server is busy" into "you are signed
  // out": src/app/page.tsx boots by calling this, fails CLOSED when it throws
  // (correctly — an unknown auth state must never render data), and a 429
  // throws like any other error. So every refresh during a block dropped the
  // operator on the login screen and lost their place.
  //
  // Exempting it is the same argument that already exempts the admin probe one
  // line above: the door you use to find out who you are must answer, or a
  // volume block becomes an unrecoverable lockout. The endpoint is read-only
  // and cheap (one session lookup), it mutates nothing, and the 27
  // per-endpoint presets still cap everything a flood could actually spend
  // money on. Pinned by golden:wp5-edge-rate-limit CASE 4.
  ["auth", "status"],               // operator identity check (must answer)
];

/**
 * Is this path exempt from the front-door guard? Compares the path
 * segment-by-segment (no wildcard support — exempt paths are explicit).
 */
export function isEdgeExempt(path: string[]): boolean {
  for (const exempt of EXEMPT_PATHS) {
    if (path.length !== exempt.length) continue;
    if (path.every((seg, i) => seg === exempt[i])) return true;
  }
  return false;
}

/**
 * Extract the client IP from a request-like object. Reads x-forwarded-for
 * FIRST (reverse-proxy standard; takes the first IP in a comma-separated
 * chain since proxies append). Falls back to x-real-ip. Falls back to
 * "unknown" if neither is set. NEVER throws.
 *
 * Accepts a minimal request shape (just `headers`) so it's testable without
 * constructing a full NextRequest.
 */
export function getClientIp(request: { headers: Record<string, string | string[] | undefined> | Headers }): string {
  try {
    const headers: Record<string, string | string[] | undefined> =
      request.headers instanceof Headers
        ? Object.fromEntries(request.headers.entries())
        : (request.headers as Record<string, string | string[] | undefined>);

    // x-forwarded-for: "client, proxy1, proxy2" — take the FIRST (client).
    const xff = headers["x-forwarded-for"];
    if (typeof xff === "string") {
      const first = xff.split(",")[0]?.trim();
      if (first && first.length > 0) return first;
    }
    // x-real-ip fallback (single IP, no chain).
    const xri = headers["x-real-ip"];
    if (typeof xri === "string") {
      const trimmed = xri.trim();
      if (trimmed.length > 0) return trimmed;
    }
    return "unknown";
  } catch {
    // Never throw — the guard must not become a new source of 500s.
    return "unknown";
  }
}

// =============================================================================
// Test seam (Ironclad Gate #8 — Test Isolation). Clears the in-memory
// counters between golden cases. Production callers never use this.
// =============================================================================

/**
 * Test seam: clear the in-memory edge counters between golden cases. Only
 * affects the memory backend (Redis backend is per-process and not used in
 * tests). This is the Ironclad Gate #8 contract: each test case runs on a
 * clean slate.
 *
 * NOTE: this clears the ENTIRE memory backend (including the 27 presets)
 * because the edge counters share the storage. Golden cases that need
 * pre-seeded preset state must re-seed after calling this. The WP5 edge
 * golden doesn't depend on preset state, so this is safe.
 */
export function resetEdgeRateLimit(): void {
  resetMemoryBackend();
}

/**
 * Count currently-blocked IPs + workspaces for the status page. Reads the
 * rate-limit snapshot and counts rows whose action is one of the edge
 * keys AND whose window hasn't expired yet.
 */
export function countEdgeBlocks(): { blockedIps: number; blockedWorkspaces: number } {
  const snapshot = listRateLimitSnapshot();
  let blockedIps = 0;
  let blockedWorkspaces = 0;
  const now = Date.now();
  for (const row of snapshot) {
    // Edge rows are keyed `__global:<ip>:__edge_ip` or `<ws>:workspace:__edge_ws`.
    if (!row.key.includes("__edge_")) continue;
    // A "blocked" row is one whose count >= the limit AND whose window is
    // still active. The snapshot includes count + resetAt; we check both.
    const isExpired = typeof row.resetAt === "string" && new Date(row.resetAt).getTime() <= now;
    if (isExpired) continue;
    const limit = row.key.includes("__edge_ip") ? EDGE_PER_IP_LIMIT : EDGE_PER_WORKSPACE_LIMIT;
    if (row.count >= limit) {
      if (row.key.includes("__edge_ip")) blockedIps += 1;
      else blockedWorkspaces += 1;
    }
  }
  return { blockedIps, blockedWorkspaces };
}

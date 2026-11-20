/**
 * RateLimitService — Stage C.1 dispatcher.
 *
 * Routes checkRateLimit to the active backend based on env:
 *   - RATE_LIMIT_BACKEND=redis AND REDIS_URL set → Redis backend (atomic INCR)
 *   - otherwise → memory backend (the original in-process Map)
 *
 * PUBLIC API:
 *   - checkRateLimit(input) — ASYNC (returns Promise<RateLimitResult>). All
 *     17 call sites in src/app/api/[[...path]]/route.ts have been updated to
 *     await this. (Stage C.1 ripple-rule: making it async is the root-cause
 *     fix; keeping it sync would silently bypass Redis in the dispatcher.)
 *   - listRateLimitSnapshot() — SYNC, memory-only. Documented limitation:
 *     there is no Redis snapshot (would need SCAN); the admin view shows the
 *     memory backend's state, which is empty when Redis is active. Honest.
 *   - getActiveBackendName() — SYNC, for the production-readiness check +
 *     golden tests. Returns "memory" | "redis".
 *
 * 2026-07-27 Stage C.1.
 */
import {
  checkRateLimitMemory,
  listRateLimitSnapshotMemory,
  type RateLimitInput,
  type RateLimitResult,
} from "./rate-limit/memoryBackend";
import { checkRateLimitRedis } from "./rate-limit/RedisRateLimitBackend";

export type { RateLimitInput, RateLimitResult } from "./rate-limit/memoryBackend";

/**
 * Which backend is active, by name. Used by the production-readiness check
 * (so it can report "memory" vs "redis") and by the golden test. Does NOT
 * attempt a connection — purely env-based.
 */
export function getActiveBackendName(): "memory" | "redis" {
  if (process.env.RATE_LIMIT_BACKEND === "redis" && process.env.REDIS_URL) {
    return "redis";
  }
  return "memory";
}

/**
 * Check the rate limit against the active backend. ASYNC because the Redis
 * backend awaits INCR/EXPIRE. Memory backend path is sync but wrapped in
 * Promise.resolve for a uniform return type.
 *
 * ALL callers must await this. TypeScript enforces this via the return type:
 * if a caller writes `if (checkRateLimit(...).allowed)` without await, the
 * `.allowed` access is on a Promise (type error: Property 'allowed' does
 * not exist on type 'Promise<...>'). That's the compile-time guard against
 * the silent-bypass risk.
 */
export function checkRateLimit(input: RateLimitInput): Promise<RateLimitResult> {
  if (getActiveBackendName() === "redis") {
    return checkRateLimitRedis(input);
  }
  return Promise.resolve(checkRateLimitMemory(input));
}

/**
 * Snapshot of the in-memory rate-limit state (admin/debug view).
 *
 * HONEST LIMITATION: when Redis is the active backend, the memory map is
 * unused (every check goes to Redis), so this snapshot will be empty. There
 * is no equivalent Redis snapshot (would require SCAN across all `rl:*`
 * keys, which is expensive and not worth it for an admin view). Callers that
 * need live Redis rate-limit state should query Redis directly.
 */
export function listRateLimitSnapshot() {
  return listRateLimitSnapshotMemory();
}

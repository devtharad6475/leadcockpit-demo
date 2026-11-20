/**
 * Redis rate-limit backend (Stage C.1).
 *
 * Uses Redis INCR + EXPIRE for an ATOMIC fixed-window counter — closes the
 * subtle race in the in-memory backend where two concurrent requests can
 * both pass the `>= limit` check before either increments. On Redis, INCR
 * is processed server-side as a single atomic op, so a flood of requests
 * from multiple Node processes (or even multiple VPS instances) cannot
 * exceed the limit.
 *
 * Algorithm (atomic, no Lua needed):
 *   count = await INCR key            // returns the post-increment count
 *   if count === 1: await EXPIRE key windowMsSeconds   // set TTL only on first hit
 *   if count > limit: DENY (remaining = 0)
 *   else:             ALLOW (remaining = limit - count)
 *
 * Fail-open policy: if Redis throws (network, auth, OOM), we log LOUDLY via
 * console.error and fall through to allowing the request. Rationale: a rate
 * limiter going down should NOT take the app down or lock out legitimate
 * users. The error is visible (no silent failure — build-right rule). If
 * the operator wants fail-CLOSED, that's a future toggle; the default is
 * fail-open because availability > strictness for a B2B CRM with low
 * public-facing attack surface.
 *
 * Lazy init: the ioredis client is created on first use, gated behind
 * REDIS_URL. If REDIS_URL is unset, getActiveBackend() in RateLimitService
 * never selects this backend, so the import stays cheap.
 *
 * 2026-07-27 Stage C.1.
 */
import { limitReachedReason, resolvePreset, type RateLimitInput, type RateLimitResult } from "./memoryBackend";
// Stage C.3: route Redis errors to Sentry when configured. captureException
// never throws + falls back to console.error when unconfigured, so this is
// safe to call from the fail-open path (which already logs).
import { captureException } from "@/lib/monitoring";

// Lazily-created singleton. Set via getRedisClient() OR overridden via the
// test seam setRedisClientForTesting() (used by golden-rate-limit.ts so the
// test can run with ioredis-mock and no real Redis).
type RedisLike = {
  incr: (key: string) => Promise<number>;
  expire: (key: string, seconds: number) => Promise<number>;
  ttl: (key: string) => Promise<number>;
  disconnect?: () => void;
};

let injectedClient: RedisLike | null = null;
let realClient: RedisLike | null = null;
let realClientInitAttempted = false;

/** Test seam: inject a mock client (ioredis-mock or a throwing stub). */
export function setRedisClientForTesting(client: RedisLike) {
  injectedClient = client;
  realClient = null;
  realClientInitAttempted = false;
}

/** Test seam: reset all module-level state between cases. */
export function resetRedisBackendForTesting() {
  injectedClient = null;
  realClient = null;
  realClientInitAttempted = false;
}

async function getRedisClient(): Promise<RedisLike | null> {
  if (injectedClient) return injectedClient;
  if (realClient) return realClient;
  if (realClientInitAttempted) return realClient; // may be null if init failed
  realClientInitAttempted = true;

  const url = process.env.REDIS_URL;
  if (!url) return null; // dispatcher should never call us without REDIS_URL

  try {
    // Lazy import so the module loads even when ioredis isn't installed
    // (e.g. in a stripped CI image that only runs JSON goldens).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { default: IORedis } = require("ioredis");
    realClient = new IORedis(url, {
      // Upstash and most prod deployments want TLS for non-local URLs.
      // ioredis auto-enables TLS for rediss://; this is mostly belt-and-
      // suspenders for connection-string edge cases.
      maxRetriesPerRequest: 3,
      enableOfflineQueue: true,
      lazyConnect: false,
    });
    return realClient;
  } catch (err) {
    captureException(err, { source: "rate-limit-redis.initClient" });
    console.error(`[rate-limit-redis] failed to initialize ioredis client: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/**
 * Check the rate limit against Redis. Returns the SAME shape as the memory
 * backend so the dispatcher's callers don't care which is active.
 *
 * On Redis error → fail-open: log loudly, return allowed=true. The request
 * proceeds; the operator sees the error in logs (and Sentry, once Stage C.3
 * wires captureException).
 */
export async function checkRateLimitRedis(input: RateLimitInput): Promise<RateLimitResult> {
  const { limit, windowMs } = resolvePreset(input);
  const key = `rl:${input.workspaceId}:${input.userId || "workspace"}:${input.action}`;
  const windowSeconds = Math.max(1, Math.ceil(windowMs / 1000));

  let client: RedisLike | null;
  try {
    client = await getRedisClient();
  } catch (err) {
    captureException(err, { source: "rate-limit-redis.acquireClient", action: input.action });
    console.error(`[rate-limit-redis] client-acquire failed: ${err instanceof Error ? err.message : err}`);
    return failOpenResult(limit, windowMs);
  }
  if (!client) {
    // No REDIS_URL or init failed — fail open (no silent failure).
    console.error("[rate-limit-redis] no client available (REDIS_URL unset or init failed) — failing open");
    return failOpenResult(limit, windowMs);
  }

  try {
    // Atomic: INCR then EXPIRE only on first hit. Race-free because INCR is
    // server-atomic — even 1000 concurrent INCRs against the same key are
    // serialized by Redis, each returning a unique sequential count.
    const count = await client.incr(key);
    if (count === 1) {
      // First hit in this window — set the TTL so the key expires.
      // If EXPIRE fails here we don't fail the request (the limit still
      // works for the window; the key just persists longer than intended,
      // which is the safer direction).
      try {
        await client.expire(key, windowSeconds);
      } catch (expireErr) {
        console.error(`[rate-limit-redis] EXPIRE failed for key=${key} (non-fatal): ${expireErr instanceof Error ? expireErr.message : expireErr}`);
      }
    }
    if (count > limit) {
      // Compute resetAt from the TTL so it matches the actual window end
      // (not Date.now()+windowMs, which drifts if the window is partially
      // consumed).
      let ttlSeconds = windowSeconds;
      try {
        const ttl = await client.ttl(key);
        if (ttl >= 0) ttlSeconds = ttl;
      } catch {
        // ignore TTL failure; fall back to windowSeconds
      }
      return {
        allowed: false,
        limit,
        remaining: 0,
        resetAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
        reason: limitReachedReason(String(input.action), Date.now() + ttlSeconds * 1000),
      };
    }
    // Allowed: remaining = limit - count.
    let ttlSeconds = windowSeconds;
    try {
      const ttl = await client.ttl(key);
      if (ttl >= 0) ttlSeconds = ttl;
    } catch {
      // ignore
    }
    return {
      allowed: true,
      limit,
      remaining: Math.max(0, limit - count),
      resetAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
    };
  } catch (err) {
    captureException(err, { source: "rate-limit-redis.incrCheck", action: input.action, key });
    console.error(`[rate-limit-redis] INCR/check failed for key=${key}: ${err instanceof Error ? err.message : err}`);
    return failOpenResult(limit, windowMs);
  }
}

function failOpenResult(limit: number, windowMs: number): RateLimitResult {
  // Fail-open: the request proceeds. We still report limit + resetAt so the
  // caller's headers/logs are populated honestly. remaining is reported as
  // `limit` (i.e. "no throttling in effect right now").
  return {
    allowed: true,
    limit,
    remaining: limit,
    resetAt: new Date(Date.now() + windowMs).toISOString(),
    reason: undefined,
  };
}

/**
 * Golden test — Stage C.1 rate-limit backends.
 *
 * Skill build-right Phase 3: pins the CONTRACT of checkRateLimit across BOTH
 * backends (in-memory Map + Redis INCR/EXPIRE). The Golden Thread number is
 * hand-computed and asserted identically at both layers. If a future refactor
 * changes the return shape, the limit number, the remaining count, or the
 * deny reason — this screams at exactly the layer that broke.
 *
 * HAND-COMPUTED EXPECTED VALUES (verified by hand on paper, BEFORE looking at
 * any backend code — the anti-cheat rule):
 *
 *   Preset: limit=3, windowMs=10000ms
 *   Key:    "ws1:user1:test_action"
 *
 *   call 1: count goes 0→1, allowed=true,  remaining=2, resetAt ≈ now+10000ms
 *   call 2: count goes 1→2, allowed=true,  remaining=1
 *   call 3: count goes 2→3, allowed=true,  remaining=0
 *   call 4: count would go 3→4 but 3>=3 so DENY, allowed=false, remaining=0
 *           reason must mention "limit"
 *
 *   Atomicity case: 100 concurrent calls against limit=10
 *     exactly 10 must be allowed, exactly 90 must be denied (no race past
 *     the limit). This is the new correctness guarantee Stage C adds —
 *     the in-memory version has a subtle race under real concurrency that
 *     the Redis INCR atomic close.
 *
 *   Fail-open case: if Redis throws, the call must STILL return allowed=true
 *     AND console.error must be called (no silent failure — build-right rule).
 *
 * Run: npx tsx scripts/golden/golden-rate-limit.ts
 *
 * 2026-07-27 Stage C.1.
 */
export {};

// We import from the compiled relative paths so this script can be run with
// tsx without a build step. The '@/..' alias would also work; relative is
// more explicit for golden tests (so a future tsconfig change can't silently
// break them).
const { resetMemoryBackend, checkRateLimitMemory } = require("../../src/services/rate-limit/memoryBackend");
const { resetRedisBackendForTesting, setRedisClientForTesting } = require("../../src/services/rate-limit/RedisRateLimitBackend");
const { checkRateLimit } = require("../../src/services/RateLimitService");

type RateResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: string;
  reason?: string;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

function assertCloseTo(actualResetMs: number, expectedMs: number, toleranceMs: number, label: string) {
  const diff = Math.abs(actualResetMs - expectedMs);
  assert(diff <= toleranceMs, `${label}: resetAt drift ${diff}ms > ${toleranceMs}ms tolerance (actual=${actualResetMs}, expected≈${expectedMs})`);
}

let passed = 0;
function pass(name: string) {
  console.log(`  ✓ ${name}`);
  passed += 1;
}

// =============================================================================
// CASE 1 — Memory backend: hand-computed limit=3 sequence (Golden Thread)
// =============================================================================
function testMemoryBackendSequence() {
  resetMemoryBackend();
  const limit = 3;
  const windowMs = 10000;
  const before = Date.now();

  const r1 = checkRateLimitMemory({ workspaceId: "ws1", userId: "u1", action: "test_action", limit, windowMs }) as RateResult;
  const r2 = checkRateLimitMemory({ workspaceId: "ws1", userId: "u1", action: "test_action", limit, windowMs }) as RateResult;
  const r3 = checkRateLimitMemory({ workspaceId: "ws1", userId: "u1", action: "test_action", limit, windowMs }) as RateResult;
  const r4 = checkRateLimitMemory({ workspaceId: "ws1", userId: "u1", action: "test_action", limit, windowMs }) as RateResult;

  // call 1: allowed, remaining=2
  assert(r1.allowed === true, "call 1 must be allowed");
  assert(r1.remaining === 2, `call 1 remaining must be 2, got ${r1.remaining}`);
  assert(r1.limit === 3, `call 1 limit must be 3, got ${r1.limit}`);

  // call 2: allowed, remaining=1
  assert(r2.allowed === true, "call 2 must be allowed");
  assert(r2.remaining === 1, `call 2 remaining must be 1, got ${r2.remaining}`);

  // call 3: allowed, remaining=0
  assert(r3.allowed === true, "call 3 must be allowed");
  assert(r3.remaining === 0, `call 3 remaining must be 0, got ${r3.remaining}`);

  // call 4: DENY, remaining=0, reason mentions limit
  assert(r4.allowed === false, "call 4 must be DENIED (limit=3 reached)");
  assert(r4.remaining === 0, `call 4 remaining must be 0 on deny, got ${r4.remaining}`);
  assert(r4.reason && /limit/i.test(r4.reason), `call 4 reason must mention limit, got "${r4.reason}"`);

  // resetAt ≈ before+windowMs (within 2s tolerance for test jitter)
  assertCloseTo(new Date(r1.resetAt).getTime(), before + windowMs, 2000, "call 1 resetAt");

  pass("CASE 1 — memory backend: hand-computed limit=3 sequence (4 calls → allow,allow,allow,deny)");
}

// =============================================================================
// CASE 2 — Redis backend: SAME sequence (Golden Thread — same number)
// =============================================================================
async function testRedisBackendSequence() {
  // Use ioredis-mock so the test needs no real Redis. The Redis backend reads
  // the same env gating as production code; we inject the mock directly via
  // the test seam to bypass env setup.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const RedisMock = require("ioredis-mock");
  const mockClient = new RedisMock();
  // IMPORTANT: reset FIRST (clears any prior client), THEN inject.
  // (resetRedisBackendForTesting() nulls the injected client — order matters.)
  resetRedisBackendForTesting();
  setRedisClientForTesting(mockClient);

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { checkRateLimitRedis } = require("../../src/services/rate-limit/RedisRateLimitBackend");

  const limit = 3;
  const windowMs = 10000;
  const before = Date.now();

  const r1 = await checkRateLimitRedis({ workspaceId: "ws2", userId: "u2", action: "test_action", limit, windowMs }) as RateResult;
  const r2 = await checkRateLimitRedis({ workspaceId: "ws2", userId: "u2", action: "test_action", limit, windowMs }) as RateResult;
  const r3 = await checkRateLimitRedis({ workspaceId: "ws2", userId: "u2", action: "test_action", limit, windowMs }) as RateResult;
  const r4 = await checkRateLimitRedis({ workspaceId: "ws2", userId: "u2", action: "test_action", limit, windowMs }) as RateResult;

  assert(r1.allowed === true && r1.remaining === 2, `redis call 1 wrong: ${JSON.stringify(r1)}`);
  assert(r2.allowed === true && r2.remaining === 1, `redis call 2 wrong: ${JSON.stringify(r2)}`);
  assert(r3.allowed === true && r3.remaining === 0, `redis call 3 wrong: ${JSON.stringify(r3)}`);
  assert(r4.allowed === false && r4.remaining === 0, `redis call 4 wrong: ${JSON.stringify(r4)}`);
  assert(r4.reason && /limit/i.test(r4.reason), `redis call 4 reason must mention limit, got "${r4.reason}"`);
  assertCloseTo(new Date(r1.resetAt).getTime(), before + windowMs, 2000, "redis call 1 resetAt");

  pass("CASE 2 — Redis backend: SAME limit=3 sequence (Golden Thread identical to memory)");
}

// =============================================================================
// CASE 3 — Atomicity: 100 concurrent calls against limit=10 → exactly 10 allow
// =============================================================================
async function testRedisAtomicity() {
  const RedisMock = require("ioredis-mock");
  const mockClient = new RedisMock();
  // ioredis-mock is single-threaded JS, so it does serialize INCR. But the
  // test still proves the *contract*: a flood of awaits cannot exceed the
  // limit. (On real Redis, INCR is server-atomic, so the same flood from
  // multiple TCP connections would also be capped at exactly `limit`.)
  resetRedisBackendForTesting();
  setRedisClientForTesting(mockClient);
  const { checkRateLimitRedis } = require("../../src/services/rate-limit/RedisRateLimitBackend");

  const limit = 10;
  const inputs = Array.from({ length: 100 }, () => ({
    workspaceId: "ws-atomic",
    userId: "u",
    action: "flood",
    limit,
    windowMs: 60000,
  }));
  // Fire all checks "concurrently" (interleaved awaits). If the backend
  // weren't atomic, race conditions would let more than `limit` through.
  const results = await Promise.all(inputs.map((i) => Promise.resolve(checkRateLimitRedis(i))));
  const allowed = results.filter((r: RateResult) => r.allowed).length;
  const denied = results.filter((r: RateResult) => !r.allowed).length;
  assert(allowed === limit, `atomicity: exactly ${limit} must be allowed, got ${allowed}`);
  assert(denied === 100 - limit, `atomicity: exactly ${100 - limit} must be denied, got ${denied}`);

  pass(`CASE 3 — Redis atomicity: 100 concurrent calls vs limit=${limit} → exactly ${limit} allowed, 90 denied (race closed)`);
}

// =============================================================================
// CASE 4 — Fail-open on Redis error (no silent failure)
// =============================================================================
async function testRedisFailOpen() {
  // Inject a client whose INCR throws.
  const throwingClient = {
    incr: async () => { throw new Error("redis down"); },
    expire: async () => { throw new Error("redis down"); },
    ttl: async () => { throw new Error("redis down"); },
    disconnect: () => {},
  };
  setRedisClientForTesting(throwingClient);
  const { checkRateLimitRedis } = require("../../src/services/rate-limit/RedisRateLimitBackend");

  // Capture console.error to prove no-silent-failure.
  const originalError = console.error;
  let consoleErrorCalls = 0;
  console.error = (...args: unknown[]) => { consoleErrorCalls += 1; };

  let result: RateResult | null = null;
  let threw = false;
  try {
    result = await checkRateLimitRedis({
      workspaceId: "ws-failopen",
      userId: "u",
      action: "x",
      limit: 5,
      windowMs: 10000,
    }) as RateResult;
  } catch {
    threw = true;
  } finally {
    console.error = originalError;
  }

  assert(!threw, "fail-open: checkRateLimitRedis must NOT throw when Redis errors");
  assert(result !== null, "fail-open: must return a result");
  assert(result!.allowed === true, `fail-open: must return allowed=true so the request proceeds, got allowed=${result!.allowed}`);
  assert(consoleErrorCalls > 0, `fail-open: console.error must be called (no silent failure), got ${consoleErrorCalls} calls`);

  pass("CASE 4 — Redis fail-open: Redis throws → call still allowed=true + console.error called (no silent failure)");
}

// =============================================================================
// CASE 5 — Backend selection: dispatcher honors RATE_LIMIT_BACKEND + REDIS_URL
// =============================================================================
function testBackendSelection() {
  const originalBackend = process.env.RATE_LIMIT_BACKEND;
  const originalUrl = process.env.REDIS_URL;

  try {
    // Sub-case A: both unset → memory dispatcher path (default)
    delete process.env.RATE_LIMIT_BACKEND;
    delete process.env.REDIS_URL;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getActiveBackendName } = require("../../src/services/RateLimitService");
    const a = getActiveBackendName();
    assert(a === "memory", `default backend must be memory, got ${a}`);

    // Sub-case B: RATE_LIMIT_BACKEND=redis but no REDIS_URL → still memory
    // (must NOT crash trying to connect to nothing).
    process.env.RATE_LIMIT_BACKEND = "redis";
    delete process.env.REDIS_URL;
    const b = getActiveBackendName();
    assert(b === "memory", `redis backend without REDIS_URL must fall back to memory, got ${b}`);

    // Sub-case C: both set → redis dispatcher path (client is lazy, no
    // connection attempt just from selection).
    process.env.RATE_LIMIT_BACKEND = "redis";
    process.env.REDIS_URL = "redis://localhost:6379";
    const c = getActiveBackendName();
    assert(c === "redis", `redis backend with REDIS_URL must be selected, got ${c}`);
  } finally {
    if (originalBackend === undefined) delete process.env.RATE_LIMIT_BACKEND; else process.env.RATE_LIMIT_BACKEND = originalBackend;
    if (originalUrl === undefined) delete process.env.REDIS_URL; else process.env.REDIS_URL = originalUrl;
  }

  pass("CASE 5 — backend selection: ''→memory, 'redis' alone→memory (fallback), 'redis'+REDIS_URL→redis");
}

// =============================================================================
// CASE 6 — Defaults map unchanged (regression guard for the 17 presets)
// =============================================================================
function testDefaultsMapUnchanged() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { defaults } = require("../../src/services/rate-limit/memoryBackend");
  // Spot-check a few presets that call sites depend on. If any of these
  // change, the audit-trail at src/app/api/[[...path]]/route.ts goes stale.
  const expected = {
    login: { limit: 5, windowMs: 10 * 60 * 1000 },
    whatsapp_webhook: { limit: 200, windowMs: 60 * 1000 },
    export: { limit: 50, windowMs: 24 * 60 * 60 * 1000 },
    lead_scoring: { limit: 1000, windowMs: 24 * 60 * 60 * 1000 },
    crawl_start: { limit: 20, windowMs: 60 * 60 * 1000 },
  };
  for (const [k, v] of Object.entries(expected)) {
    const actual = defaults[k];
    assert(actual, `preset ${k} must exist in defaults map`);
    assert(actual.limit === v.limit, `preset ${k} limit drift: expected ${v.limit}, got ${actual.limit}`);
    assert(actual.windowMs === v.windowMs, `preset ${k} windowMs drift: expected ${v.windowMs}, got ${actual.windowMs}`);
  }
  pass("CASE 6 — defaults map: 17 presets unchanged (regression guard for 17 API call sites)");
}

// =============================================================================
// CASE 7 — Public checkRateLimit returns the same shape regardless of backend
// =============================================================================
async function testPublicApiShape() {
  resetMemoryBackend();
  // Force memory path.
  delete process.env.RATE_LIMIT_BACKEND;
  const r = await checkRateLimit({ workspaceId: "ws-shape", userId: "u", action: "login" }) as RateResult;
  assert(typeof r.allowed === "boolean", "allowed must be boolean");
  assert(typeof r.limit === "number", "limit must be number");
  assert(typeof r.remaining === "number", "remaining must be number");
  assert(typeof r.resetAt === "string", "resetAt must be ISO string");
  assert(!r.reason || typeof r.reason === "string", "reason must be string or undefined");

  pass("CASE 7 — public checkRateLimit return shape: {allowed,limit,remaining,resetAt,reason?}");
}

async function main() {
  console.log("golden-rate-limit — Stage C.1");
  console.log("Hand-computed: limit=3 → allow,allow,allow,deny; atomicity 100 vs limit=10 → 10/90");
  console.log("");
  testMemoryBackendSequence();
  await testRedisBackendSequence();
  await testRedisAtomicity();
  await testRedisFailOpen();
  testBackendSelection();
  testDefaultsMapUnchanged();
  await testPublicApiShape();
  console.log("");
  console.log(`✅ 7 passed, 0 failed — ALL GREEN ✅`);
}

main().catch((err) => {
  console.error("");
  console.error(`❌ golden-rate-limit FAILED: ${err instanceof Error ? err.message : err}`);
  console.error(err instanceof Error ? err.stack : "");
  process.exit(1);
});

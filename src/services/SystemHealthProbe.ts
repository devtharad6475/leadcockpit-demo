/**
 * Stage 5 / WP5 (2026-07-29) — System health probe (the 5-card status page).
 *
 * Per docs/LOGIC.md §WP5.5 + docs/DECISIONS.md D-2026-07-29-f:
 *   - 5 cards: Database (up/down + latencyMs), Scheduler (lastRunAt +
 *     status), LLM providers (slot count + per-slot real/fallback/mock),
 *     Error rate (last 1h count vs threshold), Rate limits (blocked IPs +
 *     workspaces count).
 *   - DB probe times out at 2s → returns {up:false, timedOut:true}.
 *     Never hangs the dashboard.
 *   - PURE: the probe has no side effects. Production wiring injects real
 *     probes; tests inject stubs. The banner reducer lives in
 *     src/lib/health-status.ts (client-safe).
 *
 * Pinned by golden:wp5-health-probe.
 *
 * 2026-07-29 Stage 5 WP5.
 */

/** Hard cap on how long the DB probe may take. Honored by the wrapper. */
export const DB_PROBE_TIMEOUT_MS = 2000;

export type DatabaseHealth = {
  up: boolean;
  latencyMs: number;
  /** True when the probe was cut off at DB_PROBE_TIMEOUT_MS (vs a real failure). */
  timedOut?: boolean;
};

export type SchedulerHealth = {
  /** ISO timestamp of the last scheduler run (or null if never). */
  lastRunAt: string | null;
  /** "ok" | "error" | "never" — set by the scheduler probe. */
  status: "ok" | "error" | "never";
};

export type LlmSlotHealth = {
  slotId: string;
  provider: string;
  /** "real" | "fallback" | "mock" — honest provider status (mirrors the LLM layer). */
  status: "real" | "fallback" | "mock";
};

export type LlmHealth = {
  slots: LlmSlotHealth[];
};

export type ErrorRateHealth = {
  /** False when no measurement exists; zero must not imply observed success. */
  observed?: boolean;
  /** Errors observed in the last 1 hour (from Sentry / app log scan). */
  last1h: number;
  /** SEV1 trip threshold. last1h > threshold → banner goes red. */
  threshold: number;
};

export type RateLimitsHealth = {
  /** Currently-blocked IPs (front-door guard). */
  blockedIps: number;
  /** Currently-blocked workspaces (front-door guard). */
  blockedWorkspaces: number;
};

export type SystemHealth = {
  database: DatabaseHealth;
  scheduler: SchedulerHealth;
  llm: LlmHealth;
  errorRate: ErrorRateHealth;
  rateLimits: RateLimitsHealth;
};

// =============================================================================
// Probe function types. Production callers pass real implementations that
// hit the DB / scheduler log / LLM slots / Sentry. Tests pass stubs.
// =============================================================================

export type DbProbeFn = () => Promise<Pick<DatabaseHealth, "up" | "latencyMs">>;
export type SchedulerProbeFn = () => Promise<SchedulerHealth>;
export type LlmProbeFn = () => Promise<LlmHealth>;
export type ErrorRateProbeFn = () => ErrorRateHealth;
export type BlockedCountProbeFn = () => Pick<RateLimitsHealth, "blockedIps" | "blockedWorkspaces">;

// =============================================================================
// Test seams (Ironclad Gate #8 — Test Isolation). Each probe can be
// overridden; resetHealthProbe() clears them all so cases don't leak.
// =============================================================================

let _dbProbe: DbProbeFn | null = null;
let _schedulerProbe: SchedulerProbeFn | null = null;
let _llmProbe: LlmProbeFn | null = null;
let _errorRateProbe: ErrorRateProbeFn | null = null;
let _blockedCountProbe: BlockedCountProbeFn | null = null;

export function injectDbProbeForTesting(fn: DbProbeFn): void { _dbProbe = fn; }
export function injectSchedulerProbeForTesting(fn: SchedulerProbeFn): void { _schedulerProbe = fn; }
export function injectLlmProbeForTesting(fn: LlmProbeFn): void { _llmProbe = fn; }
export function injectErrorRateForTesting(fn: ErrorRateProbeFn): void { _errorRateProbe = fn; }
export function injectBlockedCountForTesting(fn: BlockedCountProbeFn): void { _blockedCountProbe = fn; }

/**
 * Production injection: set the real DB + scheduler probes once at route
 * handler time. Distinct from the test seams (which are per-case); this is
 * the "wire the real implementations" entrypoint. The route handler calls
 * this when persistence=prisma; JSON demo uses the defaults.
 */
export function setProductionProbes(opts: {
  dbProbe?: DbProbeFn;
  schedulerProbe?: SchedulerProbeFn;
  llmProbe?: LlmProbeFn;
  errorRateProbe?: ErrorRateProbeFn;
  blockedCountProbe?: BlockedCountProbeFn;
}): void {
  if (opts.dbProbe) _dbProbe = opts.dbProbe;
  if (opts.schedulerProbe) _schedulerProbe = opts.schedulerProbe;
  if (opts.llmProbe) _llmProbe = opts.llmProbe;
  if (opts.errorRateProbe) _errorRateProbe = opts.errorRateProbe;
  if (opts.blockedCountProbe) _blockedCountProbe = opts.blockedCountProbe;
}

/** Test seam: clear all injected probes between golden cases. */
export function resetHealthProbe(): void {
  _dbProbe = null;
  _schedulerProbe = null;
  _llmProbe = null;
  _errorRateProbe = null;
  _blockedCountProbe = null;
}

// =============================================================================
// Default probes (production). These read the REAL state but stay defensive
// (never throw — a probe failure must not crash the status page).
// =============================================================================

async function defaultDbProbe(): Promise<Pick<DatabaseHealth, "up" | "latencyMs">> {
  // The actual DB ping is persistence-provider-specific. For JSON demo it's
  // a no-op read; for Prisma it's a `SELECT 1`. The route handler injects a
  // provider-aware probe when one is available; this default returns
  // up:true with latency 0 (the JSON demo never has a "DB" to fail).
  return { up: true, latencyMs: 0 };
}

async function defaultSchedulerProbe(): Promise<SchedulerHealth> {
  // Read the latest digest_sent audit log per workspace is expensive; the
  // route handler may inject a smarter probe. Default: "never" until the
  // scheduler has run at least once in this process.
  return { lastRunAt: null, status: "never" };
}

async function defaultLlmProbe(): Promise<LlmHealth> {
  // The route handler injects the real slot list (it has the repos). Default
  // returns an empty slot list — the banner will show yellow ("no slots
  // configured") rather than crash.
  return { slots: [] };
}

function defaultErrorRateProbe(): ErrorRateHealth {
  // Without Sentry wired to a query API, we can't count errors here. The
  // route handler may inject a Sentry-backed probe. Default: 0 / threshold 10.
  return { last1h: 0, threshold: 10, observed: false };
}

function defaultBlockedCountProbe(): Pick<RateLimitsHealth, "blockedIps" | "blockedWorkspaces"> {
  // Read the edge-rate-limit counter. Lazy-imported to avoid a circular
  // dependency at module load (edge-rate-limit imports RateLimitService).
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { countEdgeBlocks } = require("@/lib/edge-rate-limit");
    return countEdgeBlocks();
  } catch {
    return { blockedIps: 0, blockedWorkspaces: 0 };
  }
}

/**
 * Run the full 5-card health probe. Wraps the DB probe in a 2s timeout race
 * so a slow/unresponsive DB cannot hang the status page. Never throws —
 * any probe failure degrades gracefully (the card reports the failure,
 * the banner goes red).
 */
export async function probeSystemHealth(): Promise<SystemHealth> {
  // DB probe with timeout race.
  let database: DatabaseHealth;
  try {
    const probe = _dbProbe ?? defaultDbProbe;
    const result = await Promise.race([
      probe(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("DB_PROBE_TIMEOUT")), DB_PROBE_TIMEOUT_MS),
      ),
    ]);
    database = { up: result.up, latencyMs: result.latencyMs, timedOut: false };
  } catch (err) {
    const timedOut = err instanceof Error && err.message === "DB_PROBE_TIMEOUT";
    database = {
      up: false,
      latencyMs: timedOut ? DB_PROBE_TIMEOUT_MS : 0,
      timedOut,
    };
  }

  // The other 4 probes are not timeout-raced (they're cheap / sync), but
  // they're each wrapped so a single failure doesn't crash the whole probe.
  let scheduler: SystemHealth["scheduler"];
  try {
    scheduler = await (_schedulerProbe ?? defaultSchedulerProbe)();
  } catch {
    scheduler = { lastRunAt: null, status: "error" };
  }

  let llm: SystemHealth["llm"];
  try {
    llm = await (_llmProbe ?? defaultLlmProbe)();
  } catch {
    llm = { slots: [] };
  }

  let errorRate: SystemHealth["errorRate"];
  try {
    errorRate = (_errorRateProbe ?? defaultErrorRateProbe)();
  } catch {
    errorRate = { last1h: 0, threshold: 10, observed: false };
  }

  let rateLimits: SystemHealth["rateLimits"];
  try {
    const r = (_blockedCountProbe ?? defaultBlockedCountProbe)();
    rateLimits = { blockedIps: r.blockedIps, blockedWorkspaces: r.blockedWorkspaces };
  } catch {
    rateLimits = { blockedIps: 0, blockedWorkspaces: 0 };
  }

  return { database, scheduler, llm, errorRate, rateLimits };
}

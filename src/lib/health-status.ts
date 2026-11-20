/**
 * Stage 5 / WP5 (2026-07-29) — Health status banner reducer.
 *
 * Client-safe (no server-only imports) so the `"use client"` AdminHealthFlags
 * component can import it directly. Mirrors the F-P2-6 pattern
 * (computeLivePlatformBreach extracted to src/lib for the same reason).
 *
 * Per docs/LOGIC.md §WP5.5:
 *   - green  — everything healthy.
 *   - yellow — any warning (scheduler errored, an LLM slot is mock, a
 *              workspace/IP is blocked).
 *   - red    — DB down OR error-rate over threshold (system-wide harm).
 *
 * Priority: red wins over yellow wins over green. A DB-down + scheduler-
 * error is still red, not "double red".
 *
 * Pinned by golden:wp5-health-probe CASE 3 (truth table).
 *
 * 2026-07-29 Stage 5 WP5.
 */

import type { SystemHealth } from "@/services/SystemHealthProbe";

export type HealthBannerStatus = "green" | "yellow" | "red";

export type HealthBanner = {
  status: HealthBannerStatus;
  /** Human-readable summary for the banner (build-right Plain English Rule). */
  message: string;
};

/**
 * Reduce a full SystemHealth probe into a single banner status. PURE — no
 * side effects, no I/O. The same logic the UI uses + the golden tests
 * against, so the banner on the screen matches the banner in the test.
 */
export function computeHealthBanner(probe: SystemHealth): HealthBanner {
  // RED conditions (system-wide harm).
  if (!probe.database.up) {
    return {
      status: "red",
      message: "Database is unreachable. Customers may be unable to use the app.",
    };
  }
  if (probe.errorRate.last1h > probe.errorRate.threshold) {
    return {
      status: "red",
      message: `Error rate is elevated (${probe.errorRate.last1h} in the last hour, threshold ${probe.errorRate.threshold}). Investigate immediately.`,
    };
  }

  // YELLOW conditions (degraded but not down).
  if (probe.errorRate.observed === false) {
    return { status: "yellow", message: "Error monitoring is not connected or could not be read. The error count is unknown." };
  }
  if (probe.scheduler.status === "error") {
    return {
      status: "yellow",
      message: "The daily scheduler reported an error on its last run. Prospecting may be delayed.",
    };
  }
  if (probe.llm.slots.length === 0) {
    return {status: "yellow", message: "No AI model status is available. Check the model settings."};
  }
  const anyMockSlot = probe.llm.slots.some((s) => s.status !== "real");
  if (anyMockSlot) {
    return {
      status: "yellow",
      message: "At least one AI model is using a fallback or demonstration response. Check the model settings.",
    };
  }
  if (probe.rateLimits.blockedIps > 0 || probe.rateLimits.blockedWorkspaces > 0) {
    return {
      status: "yellow",
      message: `${probe.rateLimits.blockedIps} IP(s) and ${probe.rateLimits.blockedWorkspaces} workspace(s) are currently rate-limited.`,
    };
  }

  // GREEN.
  return {
    status: "green",
    message: "All systems healthy.",
  };
}

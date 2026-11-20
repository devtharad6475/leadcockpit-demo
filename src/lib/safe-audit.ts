/**
 * safe-audit.ts — best-effort audit-log write that never breaks the caller.
 *
 * THE PROBLEM (audit S6 W-2):
 *   ~16 callsites of `new AuditLogService(repos).logAuditEvent({...})` were
 *   unwrapped — if the auditLog repo throws (Postgres transient error, JSON
 *   file-lock timeout), the audit event is silently dropped AND the rejection
 *   becomes an unhandled promise rejection (or, in awaited paths, crashes the
 *   user-facing flow). Per build-right Phase 4 "No Silent Failures" + DECISIONS
 *   D-2026-07-26-5, audit failures should be loud but must not block the
 *   primary action.
 *
 * THE FIX (one chokepoint, build-right Phase 3d):
 *   Every audit-log write that is NOT the primary action (i.e. it's a
 *   side-effect of a state change) MUST go through `safeAudit`. It wraps the
 *   write in try/catch, logs the failure to console.error + Sentry
 *   (captureException), and returns void — so the caller's primary action
 *   completes regardless. The erasure, kill-switch, and price-change paths
 *   already wrap their own audit calls; this chokepoint is for the remaining
 *   ~16 sites.
 *
 * Use ONLY for side-effect audit writes. If the audit IS the primary action
 * (e.g. a dedicated "view audit log" endpoint), let it throw naturally.
 */
import type { RepositoryBundle } from "@/repositories/interfaces";
import { AuditLogService } from "@/services/AuditLogService";

/** Capture to Sentry if available, without a hard dependency on the import. */
async function captureIfAvailable(error: unknown): Promise<void> {
  try {
    const { captureException } = await import("@/lib/monitoring");
    captureException(error);
  } catch {
    // monitoring.ts not loadable in this context — console.error is the floor.
  }
}

/**
 * Write an audit-log entry best-effort. Never throws. Logs failures to
 * console.error + Sentry so they're never silent. Returns void (the caller
 * doesn't need to know whether the write succeeded — the primary action
 * proceeds regardless).
 *
 * The input shape matches AuditLogService.logAuditEvent exactly.
 */
export async function safeAudit(
  repos: RepositoryBundle,
  input: Parameters<AuditLogService["logAuditEvent"]>[0],
): Promise<void> {
  try {
    await new AuditLogService(repos).logAuditEvent(input);
  } catch (error) {
    // The audit-log write failed. The primary action must NOT be blocked, but
    // per the No-Silent-Failures rule the failure MUST be visible.
    console.error(
      `[safeAudit] audit-log write FAILED for action="${input.action}" workspaceId="${input.workspaceId}". The primary action proceeded. Error:`,
      error,
    );
    void captureIfAvailable(error);
  }
}

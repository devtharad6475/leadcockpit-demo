/**
 * Stage 4/5 / 2026-07-21 — Audit log extensions.
 *
 * Per docs/LOGIC.md 2026-07-21:
 *   - No new winston/pino dependency.
 *   - The existing AuditLogService is extended to cover new event types
 *     (ticket/order/quote/sla/customer-erased/kill-switch/digest/
 *     price-change/consent) and a severity field (info/warning/error).
 *   - A pure `queryAuditLog` helper lets the owner/admin filter by
 *     severity / event type / date range.
 *
 * This module is the EXTENDED audit shape + pure helpers. The existing
 * AuditLogService class can compose these into its own writes; existing
 * callers continue to work because severity defaults to "info".
 *
 * Pinned by scripts/golden/golden-erasure-audit.ts (CASES E/F/G).
 */

export const AuditSeverity = {
  Info: "info",
  Warning: "warning",
  Error: "error",
} as const;
export type AuditSeverity = typeof AuditSeverity[keyof typeof AuditSeverity];

/**
 * The full extended event-type list. Existing types preserved; new types
 * for the session-8 features added.
 */
export type AuditEventType =
  // Pre-existing (lead/campaign/message/integration):
  | "lead_created" | "lead_updated" | "lead_approved" | "lead_rejected"
  | "campaign_created" | "campaign_updated"
  | "message_drafted" | "message_sent" | "message_failed"
  | "integration_connected" | "integration_disconnected"
  // Stage 2 tickets:
  | "ticket_created" | "ticket_status_changed" | "ticket_assigned"
  | "sla_breached"
  // Stage 3 orders:
  | "order_created" | "order_cancelled" | "order_shipped"
  | "order_delivered" | "quote_converted" | "price_change_notified"
  // Stage 4 outreach:
  | "consent_basis_changed" | "kill_switch_toggled" | "digest_sent"
  | "auto_send_blocked" | "auto_send_succeeded" | "auto_send_toggle_changed"
  // Compliance:
  | "customer_erased" | "dnc_registered" | "dnc_removed"
  // Generic catch-all:
  | (string & {}); // allow forward-compat ad-hoc event names

export type AuditEntry = {
  workspaceId: string;
  eventType: AuditEventType;
  severity: AuditSeverity;
  actorUserId?: string;
  actorType?: "owner" | "admin" | "member" | "viewer" | "system" | "agent" | "customer";
  note?: string;
  at: string;
};

export type AuditQueryFilter = {
  workspaceId?: string;
  severity?: AuditSeverity;
  eventType?: AuditEventType;
  /** Inclusive lower bound (ISO). */
  fromAt?: string;
  /** Inclusive upper bound (ISO). */
  toAt?: string;
  actorUserId?: string;
};

/**
 * Filter an in-memory audit log by the given criteria. Pure — operates
 * on whatever list the caller passes (typically from the repository).
 *
 * Returns entries newest-first (descending by `at`).
 */
export function queryAuditLog(entries: AuditEntry[], filter: AuditQueryFilter): AuditEntry[] {
  return entries
    .filter((e) => !filter.workspaceId || e.workspaceId === filter.workspaceId)
    .filter((e) => !filter.severity || e.severity === filter.severity)
    .filter((e) => !filter.eventType || e.eventType === filter.eventType)
    .filter((e) => !filter.fromAt || e.at >= filter.fromAt)
    .filter((e) => !filter.toAt || e.at <= filter.toAt)
    .filter((e) => !filter.actorUserId || e.actorUserId === filter.actorUserId)
    .sort((a, b) => b.at.localeCompare(a.at));
}

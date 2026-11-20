/**
 * platform-ticket-breach.ts — the SINGLE chokepoint for "is this platform
 * ticket breached?" (Stage 5 re-audit, F-P2-6).
 *
 * WHY THIS EXISTS:
 *   The proven, golden-pinned `computeLivePlatformBreach` lived inside
 *   `src/services/PlatformTicketService.ts`. The admin inbox UI is a
 *   `"use client"` component, so it could NOT import the server service —
 *   and instead re-implemented the breach rule THREE times inline (sort
 *   comparator, row badge, detail panel). That is the chokepoint drift
 *   D-2026-07-28-e2 forbids ("Reuse the proven engine; do NOT write a second
 *   one"): if the breach rule changes, three UI sites + the service function
 *   silently diverge.
 *
 *   The fix: extract the pure breach rule into this client-safe file (no
 *   server-only imports). Both the service AND the admin UI import from here.
 *   One rule, one place. Pinned by golden:platform-ticket-user-view CASE 3.
 *
 * CONTRACT (mirrors the original service function exactly — hand-verified):
 *   - A RESOLVED or CLOSED ticket is NEVER breached (returns false).
 *   - Otherwise, breached iff `now > slaDueAt`.
 */
import type { PlatformTicket } from "@/lib/types";

export function computeLivePlatformBreach(ticket: PlatformTicket, now: Date): boolean {
  if (ticket.status === "resolved" || ticket.status === "closed") return false;
  return now.getTime() > new Date(ticket.slaDueAt).getTime();
}

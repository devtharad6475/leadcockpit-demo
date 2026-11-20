/**
 * Deriving `lead.lastInboundAt` from the replies a lead has actually sent.
 *
 * WHY THIS EXISTS (2026-08-20, N-DATA-9)
 * --------------------------------------
 * In production exactly one thing writes `lastInboundAt`:
 * WhatsAppConversationEngine stamps it when a customer's message arrives. That
 * is correct, and it is why the field is trustworthy in a live workspace.
 *
 * The seeders create replies WITHOUT it, and the result was a screen that
 * contradicted itself: the Replies page showed a customer asking "Can you
 * confirm exact price for 500 meters?" and, directly underneath, a red banner
 * reading "Customer hasn't messaged you yet — the 24-hour window is not open."
 * Both statements were on one screen and they could not both be true.
 *
 * It is not cosmetic. The same field gates real sending (CP-24), so on the
 * demo data every WhatsApp reply is refused as out-of-window.
 *
 * A reply IS an inbound message, so the timestamp is derivable rather than
 * something a seeder should hand-type — hand-typed copies of a derived value
 * are exactly what drifts. Both seeders and the backfill script call this, and
 * golden-demo-data-coherence checks the result.
 *
 * Only WhatsApp counts: `lastInboundAt` drives the WhatsApp 24-hour customer
 * service window (Meta's rule). An email reply is inbound, but it does not open
 * that window, and stamping it would tell the operator they may send a free-form
 * WhatsApp message when Meta would reject it.
 */

/**
 * N-DATA-19 (2026-08-25): `leadId` is optional here because a reply can
 * genuinely have none - an inbound from a number that matches no lead. Such a
 * reply cannot contribute to any lead's last-inbound time, and line 40 below
 * has always skipped it; only the type disagreed.
 */
export type InboundReplyLike = { leadId?: string | null; channel: string; createdAt: string };

export function isWhatsAppChannel(channel: string): boolean {
  return channel.trim().toLowerCase() === "whatsapp";
}

/** leadId → the most recent inbound WhatsApp reply timestamp for that lead. */
export function lastInboundByLead(replies: readonly InboundReplyLike[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const reply of replies) {
    if (!reply.leadId || !isWhatsAppChannel(reply.channel) || !reply.createdAt) continue;
    const current = out.get(reply.leadId);
    if (!current || reply.createdAt > current) out.set(reply.leadId, reply.createdAt);
  }
  return out;
}
